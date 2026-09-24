# ComfyFed self-host image: the same Worker that runs on Cloudflare, executed
# by Miniflare (Cloudflare's workerd wrapper) on one machine. See
# cloud/scripts/selfhost.mjs and docs/SELF-HOSTING.*.md.
#
#   docker run -d --name comfyfed -p 8388:8388 -v comfyfed-data:/data \
#     ghcr.io/aiinpocket/comfyfed:latest
#
# Build context is the REPO ROOT (the console lives in ../web and the agent
# wheel is packaged from ../agent):
#
#   docker build -f cloud/Dockerfile -t comfyfed .

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY . .
RUN cd web && npm ci \
 && cd ../cloud && npm ci \
 && node scripts/build-selfhost.mjs

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/cloud/package.json /src/cloud/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/cloud/dist-selfhost ./dist-selfhost
COPY --from=build /src/cloud/assets ./assets
COPY --from=build /src/cloud/scripts/selfhost.mjs ./scripts/selfhost.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8388
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8388/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/selfhost.mjs", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "8388"]
