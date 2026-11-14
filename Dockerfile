# =============================================================================
# Deemix Remastered — Official-ready Headless Web / Docker Image (multi-arch)
# Zero Electron / Zero X11 / Zero VNC — pure Node.js + Vue 3 SPA
# =============================================================================
FROM oven/bun:1-alpine AS builder

WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
RUN bun run build:web && rm -rf node_modules && bun install --frozen-lockfile --production --ignore-scripts

# -----------------------------------------------------------------------------
FROM node:22-alpine

RUN apk add --no-cache su-exec shadow tzdata curl ffmpeg

WORKDIR /app
ENV NODE_ENV=production \
    DEEMIX_HOST=0.0.0.0 \
    DEEMIX_PORT=6595 \
    DEEMIX_DATA_DIR=/config \
    DEEMIX_MUSIC_DIR=/downloads \
    PUID=1000 \
    PGID=1000

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-web ./dist-web
COPY --from=builder /app/public ./public
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && mkdir -p /config /downloads

VOLUME ["/config", "/downloads"]
EXPOSE 6595

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${DEEMIX_PORT:-6595}/api/health >/dev/null || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
