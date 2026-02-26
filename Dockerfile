# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 as base
RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		xz-utils \
	&& rm -rf /var/lib/apt/lists/* \
	&& update-ca-certificates \
	&& curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /usr/local/bin/yt-dlp \
	&& chmod a+rx /usr/local/bin/yt-dlp \
	&& curl -L "https://johnvansickle.com/ffmpeg/releases/ffmpeg-git-amd64-static.tar.xz" -o /tmp/ffmpeg.tar.xz \
	&& tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
	&& cp /tmp/ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg \
	&& cp /tmp/ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ffprobe \
	&& chmod a+rx /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
	&& rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-*-amd64-static
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD bun -e "fetch('http://127.0.0.1:' + (process.env.WEBHOOK_PORT || 3500) + '/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# run the app
USER bun
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
