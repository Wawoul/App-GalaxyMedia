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
RUN npm ci
COPY server/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
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
