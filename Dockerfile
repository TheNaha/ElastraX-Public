# ───────────────────────────────────────────────────────────────────────
# ElastraX v7 — Multi-stage Dockerfile
# ───────────────────────────────────────────────────────────────────────
# Stage 1: fetch     — download yt-dlp + ffmpeg static binaries
# Stage 2: install   — bun install (dev + prod) with native build tools
# Stage 3: prerelease — copy source + dev node_modules for optional tests
# Stage 4: release   — minimal runtime image
# ───────────────────────────────────────────────────────────────────────

# ── Stage 1: Fetch external binaries ────────────────────────────────────
FROM oven/bun:1 AS fetch
ARG TARGETARCH
RUN set -eux; \
	export DEBIAN_FRONTEND=noninteractive; \
	apt-get update; \
	apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
	rm -rf /var/lib/apt/lists/*; \
	# ── Resolve architecture ──────────────────────────────────────────── \
	ARCH="${TARGETARCH:-}"; \
	if [ -z "$ARCH" ]; then ARCH="$(dpkg --print-architecture)"; fi; \
	# ── yt-dlp standalone binary (no Python needed) ───────────────────── \
	case "$ARCH" in \
		amd64) YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" ;; \
		arm64) YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" ;; \
		*) echo "Unsupported architecture: $ARCH"; exit 1 ;; \
	esac; \
	curl -fsSL --retry 5 --retry-delay 2 --retry-connrefused "$YTDLP_URL" \
		-o /usr/local/bin/yt-dlp; \
	chmod a+rx /usr/local/bin/yt-dlp; \
	# ── ffmpeg + ffprobe static build ─────────────────────────────────── \
	case "$ARCH" in \
		amd64) FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" ;; \
		arm64) FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz" ;; \
	esac; \
	curl -fsSL --retry 5 --retry-delay 2 --retry-connrefused "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz; \
	tar -xJf /tmp/ffmpeg.tar.xz -C /tmp; \
	FFMPEG_DIR="$(find /tmp -maxdepth 1 -type d -name 'ffmpeg-*' | head -n1)"; \
	test -n "$FFMPEG_DIR"; \
	install -m 0755 "$FFMPEG_DIR/bin/ffmpeg"  /usr/local/bin/ffmpeg; \
	install -m 0755 "$FFMPEG_DIR/bin/ffprobe" /usr/local/bin/ffprobe; \
	rm -rf /tmp/ffmpeg.tar.xz "$FFMPEG_DIR"

# ── Stage 2: Install npm dependencies ──────────────────────────────────
FROM oven/bun:1 AS install
# No native build tools needed: the project uses Bun's built-in `bun:sqlite`
# (no better-sqlite3/node-gyp), and bunfig.toml disables optional-peer
# auto-install so no native packages sneak in via drizzle-orm.

# Dev install (includes devDependencies for testing/linting)
RUN mkdir -p /temp/dev
COPY package.json bun.lock bunfig.toml /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# Production install (excludes devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock bunfig.toml /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# ── Stage 3: Pre-release (source + dev deps for optional tests) ────────
FROM oven/bun:1 AS prerelease
WORKDIR /usr/src/app
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

ENV NODE_ENV=production
# RUN bun test
# RUN bun run build

# ── Stage 4: Final runtime image ──────────────────────────────────────
FROM oven/bun:1 AS release
RUN set -eux; \
	export DEBIAN_FRONTEND=noninteractive; \
	apt-get update; \
	apt-get install -y --no-install-recommends ca-certificates; \
	rm -rf /var/lib/apt/lists/*; \
	update-ca-certificates
WORKDIR /usr/src/app

# Copy external binaries from the fetch stage
COPY --from=fetch /usr/local/bin/yt-dlp   /usr/local/bin/yt-dlp
COPY --from=fetch /usr/local/bin/ffmpeg   /usr/local/bin/ffmpeg
COPY --from=fetch /usr/local/bin/ffprobe  /usr/local/bin/ffprobe

# Copy production node_modules and source
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src src
COPY --from=prerelease /usr/src/app/drizzle drizzle
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=prerelease /usr/src/app/drizzle.config.ts .

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD bun -e "fetch('http://127.0.0.1:' + (process.env.WEBHOOK_PORT || 3500) + '/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# run the app
USER bun
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
