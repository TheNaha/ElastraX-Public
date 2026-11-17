ARG BUN_IMAGE=oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

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
# ffmpeg/ffprobe come from Debian's signed archive. They used to be copied from
# a pinned BtbN static build, but that project deletes old `autobuild-*`
# releases: the pinned URL started returning 404 and the image could no longer
# be built. The distro package is architecture-aware, signature-verified and
# carries every encoder this app uses (libx264, aac, libvpx-vp9, libwebp,
# libmp3lame, libopus).
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip zlib1g; \
    rm -rf /var/lib/apt/lists/*; \
    update-ca-certificates; \
    pip3 install --no-cache-dir --break-system-packages "yt-dlp==${YTDLP_VERSION}"; \
    mkdir -p /app/data; \
    chown -R bun:bun /app/data
WORKDIR /app
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
