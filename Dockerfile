ARG BUN_IMAGE=oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

# ffmpeg/ffprobe: BtbN's static build of the newest FFmpeg *release branch*
# (n9.0 today, i.e. 9.0.x), not a dated autobuild. Old `autobuild-*` releases are
# deleted upstream, which is what broke the previous pin; the `latest` tag's
# per-branch assets are replaced in place with each new build of that branch.
# Because the content moves, the download is checked against the sha256 GitHub
# publishes for the asset at build time instead of a hardcoded digest, and the
# resolved version is printed into the build log. Docker caches this layer: a
# machine that already built the image keeps its ffmpeg until `--no-cache`
# (CI runners start clean on every run).
# Override the branch (e.g. n8.1, master) with --build-arg FFMPEG_BRANCH=...
FROM ${BUN_IMAGE} AS fetch
ARG TARGETARCH
ARG FFMPEG_BRANCH=n9.0
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$ARCH" in \
      amd64) FFMPEG_ARCH="linux64";; \
      arm64) FFMPEG_ARCH="linuxarm64";; \
      *) echo "Unsupported architecture: $ARCH"; exit 1;; \
    esac; \
    FFMPEG_FILE="ffmpeg-${FFMPEG_BRANCH}-latest-${FFMPEG_ARCH}-gpl-${FFMPEG_BRANCH#n}.tar.xz"; \
    FFMPEG_URL="https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/${FFMPEG_FILE}"; \
    curl -fsSL --proto '=https' --tlsv1.2 --retry 5 --retry-delay 2 --retry-connrefused "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz; \
    digest=""; \
    for attempt in 1 2 3; do \
      digest="$(FFMPEG_FILE="$FFMPEG_FILE" bun -e 'const file = process.env.FFMPEG_FILE; const res = await fetch("https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/tags/latest", { headers: { Accept: "application/vnd.github+json", "User-Agent": "elastrax-docker" } }); if (!res.ok) { console.error(`GitHub API returned ${res.status}`); process.exit(1); } const data = await res.json(); const asset = (data.assets || []).find((entry) => entry.name === file); const digest = asset && typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : ""; if (!/^[a-f0-9]{64}$/.test(digest)) { console.error(`No sha256 digest published for ${file}`); process.exit(1); } process.stdout.write(digest);')" || true; \
      if [ -n "$digest" ]; then break; fi; \
      if [ "$attempt" -ge 3 ]; then echo "Could not obtain the release asset digest" >&2; exit 1; fi; \
      sleep $((attempt * 2)); \
    done; \
    printf '%s  %s\n' "$digest" /tmp/ffmpeg.tar.xz | sha256sum -c -; \
    mkdir -p /tmp/ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz --strip-components=1 -C /tmp/ffmpeg \
      "ffmpeg-${FFMPEG_BRANCH}-latest-${FFMPEG_ARCH}-gpl-${FFMPEG_BRANCH#n}/bin/ffmpeg" \
      "ffmpeg-${FFMPEG_BRANCH}-latest-${FFMPEG_ARCH}-gpl-${FFMPEG_BRANCH#n}/bin/ffprobe"; \
    install -m 0755 /tmp/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg; \
    install -m 0755 /tmp/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe; \
    ffmpeg -version | head -1; \
    rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg

FROM ${BUN_IMAGE} AS install
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN set -eu; \
    attempt=1; \
    until bun install --frozen-lockfile --production; do \
      if [ "$attempt" -ge 3 ]; then exit 1; fi; \
      attempt=$((attempt + 1)); \
      rm -rf node_modules; \
      sleep $((attempt * 2)); \
    done

FROM ${BUN_IMAGE} AS release
ARG YTDLP_VERSION=2026.08.19
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates python3 python3-pip zlib1g; \
    rm -rf /var/lib/apt/lists/*; \
    update-ca-certificates; \
    pip3 install --no-cache-dir --break-system-packages "yt-dlp==${YTDLP_VERSION}"; \
    mkdir -p /app/data; \
    chown -R bun:bun /app/data
WORKDIR /app
COPY --from=fetch /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=fetch /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=install --chown=bun:bun /app/node_modules node_modules
COPY --chown=bun:bun package.json bun.lock bunfig.toml drizzle.config.ts ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun drizzle ./drizzle
ENV NODE_ENV=production \
    BUN_CONFIG_DISABLE_DOTENV=1 \
    ELASTRAX_DB_PATH=/app/data/bot.db \
    WEBHOOK_HOST=127.0.0.1 \
    WEBHOOK_PORT=3500
VOLUME ["/app/data"]
EXPOSE 3500
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.WEBHOOK_PORT || '3500') + '/ready').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
USER bun
ENTRYPOINT ["bun", "run", "src/index.ts"]
