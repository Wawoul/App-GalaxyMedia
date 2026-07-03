# Galaxy Media - single image serving the API and the admin UI.
# TLS is NOT handled here: put a reverse proxy (Caddy, nginx, Traefik,
# Cloudflare Tunnel) in front and point BASE_URL at its public URL.

FROM node:22-bookworm-slim AS admin-build
WORKDIR /build
COPY admin/package*.json ./
RUN npm ci
COPY admin/ ./
RUN npm run build

FROM node:22-bookworm-slim AS server-build
WORKDIR /build
COPY server/package*.json ./
# See the final stage below for why python3/make/g++ are here (argon2's
# native-compile fallback) - this stage's `npm ci` needs it too.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm ci
COPY server/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./
# argon2's native module ships prebuilt binaries for most platforms; python3/
# make/g++ are the fallback if that lookup fails (notably on ARM boards, e.g.
# a Raspberry Pi). Installed and removed in one layer so the final image
# doesn't carry a compiler toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force
COPY --from=server-build /build/dist ./dist
COPY --from=admin-build /build/dist ./admin

ENV HOST=0.0.0.0 \
    PORT=8080 \
    MEDIA_DIR=/data/media \
    ADMIN_DIR=/app/admin
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
