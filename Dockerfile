# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
ARG TARGETARCH
RUN set -eux; \
	export DEBIAN_FRONTEND=noninteractive; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		xz-utils; \
	rm -rf /var/lib/apt/lists/*; \
	update-ca-certificates; \
	curl -fsSL --retry 5 --retry-delay 2 --retry-connrefused \
		"https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
		-o /usr/local/bin/yt-dlp; \
	chmod a+rx /usr/local/bin/yt-dlp; \
	ARCH="${TARGETARCH:-}"; \
	if [ -z "$ARCH" ]; then \
		ARCH="$(dpkg --print-architecture)"; \
	fi; \
	case "$ARCH" in \
		amd64) FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" ;; \
		arm64) FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz" ;; \
		*) echo "Unsupported architecture: $ARCH"; exit 1 ;; \
	esac; \
	curl -fsSL --retry 5 --retry-delay 2 --retry-connrefused "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz; \
	tar -xJf /tmp/ffmpeg.tar.xz -C /tmp; \
	FFMPEG_DIR="$(find /tmp -maxdepth 1 -type d -name 'ffmpeg-*' | head -n1)"; \
	test -n "$FFMPEG_DIR"; \
	test -f "$FFMPEG_DIR/bin/ffmpeg"; \
	test -f "$FFMPEG_DIR/bin/ffprobe"; \
	install -m 0755 "$FFMPEG_DIR/bin/ffmpeg" /usr/local/bin/ffmpeg; \
	install -m 0755 "$FFMPEG_DIR/bin/ffprobe" /usr/local/bin/ffprobe; \
	rm -rf /tmp/ffmpeg.tar.xz "$FFMPEG_DIR"
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN apt-get update && apt-get install -y python3 build-essential pkg-config
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# [optional] tests & build
ENV NODE_ENV=production
# RUN bun test
# RUN bun run build

# copy production dependencies and source code into final image
FROM base AS release
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
