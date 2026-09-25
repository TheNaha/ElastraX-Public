ARG BUN_IMAGE=oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

FROM ${BUN_IMAGE} AS fetch
ARG TARGETARCH
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256_AMD64=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG YTDLP_SHA256_ARM64=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc
ARG FFMPEG_RELEASE=autobuild-2026-09-12-13-12
ARG FFMPEG_BUILD=8.1.2-52-g5a03dfa0f6
ARG FFMPEG_SHA256_AMD64=682dba33847c14b496b51bb4f8bd6601a180295d038928c68c558ab8978d6fa8
ARG FFMPEG_SHA256_ARM64=c575dc71e07878219de9f9f5a3e2387697524f58b2e8de6dca03086eb7925d68
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$ARCH" in \
      amd64) YTDLP_FILE="yt-dlp_linux"; YTDLP_SHA256="$YTDLP_SHA256_AMD64"; FFMPEG_ARCH="linux64";; \
      arm64) YTDLP_FILE="yt-dlp_linux_aarch64"; YTDLP_SHA256="$YTDLP_SHA256_ARM64"; FFMPEG_ARCH="linuxarm64";; \
      *) echo "Unsupported architecture: $ARCH"; exit 1;; \
    esac; \
    YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_FILE}"; \
    curl -fsSL --proto '=https' --tlsv1.2 --retry 5 --retry-delay 2 --retry-connrefused "$YTDLP_URL" -o "/tmp/$YTDLP_FILE"; \
    printf '%s  %s\n' "$YTDLP_SHA256" "/tmp/$YTDLP_FILE" | sha256sum -c -; \
    install -m 0755 "/tmp/$YTDLP_FILE" /usr/local/bin/yt-dlp; \
    FFMPEG_FILE="ffmpeg-n${FFMPEG_BUILD}-${FFMPEG_ARCH}-gpl-8.1.tar.xz"; \
    if [ "$ARCH" = amd64 ]; then FFMPEG_SHA256="$FFMPEG_SHA256_AMD64"; else FFMPEG_SHA256="$FFMPEG_SHA256_ARM64"; fi; \
    FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${FFMPEG_FILE}"; \
    curl -fsSL --proto '=https' --tlsv1.2 --retry 5 --retry-delay 2 --retry-connrefused "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz; \
    printf '%s  %s\n' "$FFMPEG_SHA256" /tmp/ffmpeg.tar.xz | sha256sum -c -; \
    mkdir -p /tmp/ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz --strip-components=1 -C /tmp/ffmpeg \
      "ffmpeg-n${FFMPEG_BUILD}-${FFMPEG_ARCH}-gpl-8.1/bin/ffmpeg" \
      "ffmpeg-n${FFMPEG_BUILD}-${FFMPEG_ARCH}-gpl-8.1/bin/ffprobe"; \
    install -m 0755 /tmp/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg; \
    install -m 0755 /tmp/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe; \
    rm -rf "/tmp/$YTDLP_FILE" /tmp/ffmpeg.tar.xz /tmp/ffmpeg

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
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    update-ca-certificates; \
    mkdir -p /app/data; \
    chown -R bun:bun /app/data
WORKDIR /app
COPY --from=fetch /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
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
