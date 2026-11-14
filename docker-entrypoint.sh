#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

GROUP_NAME=$(getent group "$PGID" | cut -d: -f1 || true)
if [ -z "$GROUP_NAME" ]; then
  addgroup -g "$PGID" deemix
  GROUP_NAME=deemix
fi

USER_NAME=$(getent passwd "$PUID" | cut -d: -f1 || true)
if [ -z "$USER_NAME" ]; then
  adduser -D -u "$PUID" -G "$GROUP_NAME" -h /config deemix
  USER_NAME=deemix
fi

mkdir -p "${DEEMIX_DATA_DIR:-/config}" "${DEEMIX_MUSIC_DIR:-/downloads}"
chown -R "$PUID:$PGID" "${DEEMIX_DATA_DIR:-/config}"

exec su-exec "$PUID:$PGID" node /app/dist-web/web-server.cjs
