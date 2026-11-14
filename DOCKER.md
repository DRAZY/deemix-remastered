# Running Deemix Remastered in Docker (Headless Web Server)

Deemix Remastered can run as a lightweight, self-hosted web server in Docker (**~210 MB**, pure Node.js + Vue 3 SPA — **no Electron, no X11, no VNC/Kasm**).

## Quick Start (Docker Compose)

```yaml
services:
  deemix-remastered:
    build: .
    container_name: deemix-remastered
    restart: unless-stopped
    ports:
      - "6595:6595"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Paris
      - DEEMIX_WEB_USER=admin
      - DEEMIX_WEB_PASSWORD=change-me-please
      # Optional: pre-seed your Deezer ARL on first start
      # - DEEZER_ARL=your_arl_cookie
    volumes:
      - ./config:/config
      - /path/to/music:/downloads
```

```bash
docker compose up -d --build
```

Then open `http://localhost:6595` in any desktop or mobile browser.

## Architecture Notes

- **Zero modification to Electron desktop builds**: `npm run build` / `electron:dev` work identically as before.
- **Security preserved**: the upstream `DeemixServer` still binds strictly to `127.0.0.1` inside the container (`16595`), while `electron/web-server.ts` provides an optional timing-safe HTTP Basic Auth gate, static SPA hosting (`dist/`), a `/api/deezer-public/*` CORS proxy for browser clients, `/api/events` (SSE) for real-time Playlist/Artist sync events, and `/api/web-storage/*` so credentials, settings, profiles, and queue history persist across devices in `/config`.
- **Optional media-server webhook**: set `DEEMIX_POST_DOWNLOAD_WEBHOOK` (and optional `DEEMIX_POST_DOWNLOAD_SECRET`) to notify Navidrome, Jellyfin, or Plex when tracks complete.
