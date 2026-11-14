/**
 * Standalone Web / Docker entrypoint for Deemix Remastered (headless, zero Electron/X11/VNC).
 *
 * Wraps the upstream DeemixServer on an internal loopback port and exposes a clean,
 * optional Basic-Auth-protected web server that:
 *   1. Serves the Vite production SPA (`dist/`),
 *   2. Proxies `/api/*` and `/info-spotify` to DeemixServer over 127.0.0.1 (preserving all upstream security invariants),
 *   3. Provides `/api/web-storage/*` + `/api/events` (SSE) + `/api/deezer-public/*` (CORS proxy for browser clients),
 *   4. Auto-restores Deezer ARL / Spotify / Qobuz credentials and persisted settings at boot,
 *   5. Optionally invokes `DEEMIX_POST_DOWNLOAD_WEBHOOK` when downloads finish.
 */
import * as http from 'http'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app } from './electron-shim'
import { DeemixServer } from './server'
import { deezerAuth } from './services/deezerAuth'
import { spotifyAPI } from './services/spotifyAPI'
import { qobuzAuth } from './services/qobuzAuth'
import { playlistSync } from './services/playlistSync'
import { artistSync } from './services/artistSync'
import { downloader } from './services/downloader'

const PUBLIC_HOST = process.env.DEEMIX_HOST || '0.0.0.0'
const PUBLIC_PORT = parseInt(process.env.DEEMIX_PORT || '6595', 10)
const INTERNAL_PORT = parseInt(process.env.DEEMIX_INTERNAL_PORT || '16595', 10)
const DATA_DIR = app.getPath('userData')
const DEFAULT_DOWNLOAD_PATH = process.env.DEEMIX_MUSIC_DIR || '/downloads'
const WEB_USER = process.env.DEEMIX_WEB_USER || ''
const WEB_PASSWORD = process.env.DEEMIX_WEB_PASSWORD || ''
const POST_WEBHOOK = process.env.DEEMIX_POST_DOWNLOAD_WEBHOOK || ''
const POST_WEBHOOK_SECRET = process.env.DEEMIX_POST_DOWNLOAD_SECRET || ''

const DIST_DIR = path.resolve(process.cwd(), 'dist')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json'
}

function storagePath(file: string): string {
  return path.join(DATA_DIR, file)
}

function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    const p = storagePath(file)
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as T
    }
  } catch (err) {
    console.warn(`[WebServer] Could not read ${file}:`, (err as Error).message)
  }
  return fallback
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const target = storagePath(file)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, target)
}

function checkBasicAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!WEB_PASSWORD) return true
  const expectedUser = WEB_USER || 'admin'
  const header = req.headers.authorization || ''
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8')
    const sep = decoded.indexOf(':')
    if (sep >= 0) {
      const u = decoded.slice(0, sep)
      const p = decoded.slice(sep + 1)
      const uOk = u.length === expectedUser.length && crypto.timingSafeEqual(Buffer.from(u), Buffer.from(expectedUser))
      const pOk = p.length === WEB_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(WEB_PASSWORD))
      if (uOk && pOk) return true
    }
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Deemix Remastered Web"',
    'Content-Type': 'text/plain; charset=utf-8'
  })
  res.end('Authentication required')
  return false
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > 15 * 1024 * 1024) {
        req.destroy()
        reject(new Error('Payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

function triggerPostDownloadWebhook(payload: Record<string, unknown>): void {
  if (!POST_WEBHOOK) return
  try {
    const target = new URL(POST_WEBHOOK)
    const body = Buffer.from(JSON.stringify(payload))
    const mod = target.protocol === 'https:' ? https : http
    const req = mod.request(
      target,
      {
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          ...(POST_WEBHOOK_SECRET ? { 'X-Hook-Secret': POST_WEBHOOK_SECRET } : {})
        }
      },
      (r) => r.resume()
    )
    req.on('error', () => {})
    req.write(body)
    req.end()
  } catch {
    // Ignore malformed webhook URL
  }
}

async function main() {
  // Seed initial settings & optional DEEZER_ARL env var on first run
  const existingSettings = readJsonSafe<Record<string, any>>('settings.json', {})
  if (!existingSettings.downloadPath) {
    existingSettings.downloadPath = DEFAULT_DOWNLOAD_PATH
    writeJsonAtomic('settings.json', existingSettings)
  }

  const creds = readJsonSafe<Record<string, string>>('credentials.json', {})
  if (process.env.DEEZER_ARL && !creds.arl) {
    creds.arl = process.env.DEEZER_ARL.trim()
    writeJsonAtomic('credentials.json', creds)
  }

  // 1. Start upstream DeemixServer on loopback
  const coreServer = new DeemixServer('127.0.0.1', INTERNAL_PORT)
  await coreServer.start()
  const actualInternalPort = coreServer.getPort()

  // Apply persisted settings to coreServer at boot
  coreServer.updateSettings({
    downloadPath: existingSettings.downloadPath || DEFAULT_DOWNLOAD_PATH,
    ...(existingSettings as any)
  })

  // Restore credentials at boot (Deezer ARL, Spotify, Qobuz)
  if (creds.arl) {
    deezerAuth.login(creds.arl).then((ok) => {
      console.log(`[WebServer] Boot ARL auto-login: ${ok ? 'authenticated' : 'failed'}`)
    }).catch((e) => console.warn('[WebServer] Boot ARL auto-login error:', e?.message))
  }
  if (creds.spotifyClientId && creds.spotifyClientSecret) {
    spotifyAPI.setCredentials(creds.spotifyClientId, creds.spotifyClientSecret)
  }
  if (creds.qobuzAppId && creds.qobuzAppSecret) {
    qobuzAuth.setManualCredentials(creds.qobuzAppId, creds.qobuzAppSecret)
  }
  if (creds.qobuzUserId && creds.qobuzToken) {
    qobuzAuth.restoreSession(creds.qobuzToken, Number(creds.qobuzUserId))
  }

  // Initialize playlist & artist sync providers (mirroring electron/main.ts)
  const buildSyncSettings = () => {
    const s = coreServer.getSettings()
    return {
      downloadPath: s.downloadPath || DEFAULT_DOWNLOAD_PATH,
      quality: s.quality,
      bitrateFallback: s.bitrateFallback,
      isrcFallback: s.isrcFallback,
      createArtistFolder: s.createArtistFolder,
      createAlbumFolder: s.createAlbumFolder,
      saveArtwork: s.saveArtwork,
      embedArtwork: s.embedArtwork,
      saveLyrics: s.saveLyrics,
      syncedLyrics: s.syncedLyrics,
      preferSyncedLyrics: s.preferSyncedLyrics,
      deleteSupersededLyrics: s.deleteSupersededLyrics,
      createErrorLog: s.createErrorLog,
      savePlaylistAsCompilation: s.savePlaylistAsCompilation,
      createPlaylistFile: s.createPlaylistFile,
      createAlbumPlaylistFile: s.createAlbumPlaylistFile,
      overwriteFiles: s.overwriteFiles,
      skipDuplicateTracks: s.skipDuplicateTracks,
      maxConcurrentDownloads: s.maxConcurrentDownloads,
      folderSettings: {
        createPlaylistFolder: s.createPlaylistFolder,
        createArtistFolder: s.createArtistFolder,
        createAlbumFolder: s.createAlbumFolder,
        createCDFolder: s.createCDFolder,
        createPlaylistStructure: s.createPlaylistStructure,
        createSinglesStructure: s.createSinglesStructure,
        createShortReleaseFolder: s.createShortReleaseFolder,
        playlistFolderTemplate: s.playlistFolderTemplate,
        albumFolderTemplate: s.albumFolderTemplate,
        artistFolderTemplate: s.artistFolderTemplate
      },
      trackTemplates: {
        trackNameTemplate: s.trackNameTemplate,
        albumTrackTemplate: s.albumTrackTemplate,
        playlistTrackTemplate: s.playlistTrackTemplate
      },
      metadataSettings: {
        tags: s.tags,
        albumCovers: s.albumCovers,
        useNullSeparator: s.useNullSeparator,
        saveID3v1: s.saveID3v1,
        saveOnlyMainArtist: s.saveOnlyMainArtist,
        artistSeparator: s.artistSeparator,
        dateFormatFlac: s.dateFormatFlac,
        titleCasing: s.titleCasing,
        artistCasing: s.artistCasing,
        removeAlbumVersion: s.removeAlbumVersion,
        featuredArtistsHandling: s.featuredArtistsHandling,
        keepVariousArtists: s.keepVariousArtists,
        removeArtistCombinations: s.removeArtistCombinations
      }
    }
  }
  playlistSync.setSettingsProvider(buildSyncSettings as any)
  artistSync.setSettingsProvider(buildSyncSettings as any)
  await playlistSync.init().catch((e) => console.warn('[WebServer] playlistSync init:', e?.message))
  await artistSync.init().catch((e) => console.warn('[WebServer] artistSync init:', e?.message))

  // Server-Sent Events (SSE) bus replacing Electron ipcRenderer push events
  const sseClients = new Set<http.ServerResponse>()
  const broadcastEvent = (channel: string, data: unknown) => {
    const msg = `data: ${JSON.stringify({ channel, data })}\n\n`
    for (const client of sseClients) {
      try {
        client.write(msg)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  coreServer.on('auth-expired', (d) => broadcastEvent('auth:expired', d))
  coreServer.on('qobuz-auth-expired', (d) => broadcastEvent('qobuz-auth:expired', d))
  coreServer.on('session-health', (d) => broadcastEvent('session:health', d))
  playlistSync.on('sync:start', (playlistId: string) => broadcastEvent('sync:start', { playlistId }))
  playlistSync.on('sync:progress', (playlistId: string, d: any) => broadcastEvent('sync:progress', { playlistId, ...d }))
  playlistSync.on('sync:complete', (playlistId: string, d: any) => broadcastEvent('sync:complete', { playlistId, ...d }))
  playlistSync.on('sync:error', (playlistId: string, error: string) => broadcastEvent('sync:error', { playlistId, error }))
  artistSync.on('artistSync:start', (artistId: string) => broadcastEvent('artistSync:start', { artistId }))
  artistSync.on('artistSync:progress', (artistId: string, d: any) => broadcastEvent('artistSync:progress', { artistId, ...d }))
  artistSync.on('artistSync:complete', (artistId: string, d: any) => broadcastEvent('artistSync:complete', { artistId, ...d }))
  artistSync.on('artistSync:error', (artistId: string, error: string) => broadcastEvent('artistSync:error', { artistId, error }))

  downloader.on('complete', (progress: any) => {
    const filePath = progress?.path || progress?.filePath || progress?.outputPath || ''
    const folderPath = progress?.albumRootFolder || progress?.albumFolder || (filePath ? path.dirname(filePath) : DEFAULT_DOWNLOAD_PATH)
    triggerPostDownloadWebhook({
      folder: folderPath,
      file: filePath,
      type: progress?.type || (progress?.albumFolder ? 'album' : 'track'),
      skipped: Boolean(progress?.skippedAsDuplicate || progress?.retagSkipped)
    })
  })

  // 2. Public HTTP gateway
  const gateway = http.createServer(async (req, res) => {
    const rawUrl = req.url || '/'
    if (rawUrl === '/api/health') {
      return sendJson(res, { status: 'ok', mode: 'docker-web', version: app.getVersion() })
    }
    if (!checkBasicAuth(req, res)) return

    const parsed = new URL(rawUrl, 'http://localhost')
    const pathname = parsed.pathname

    // A. Server-Sent Events stream
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write('data: {"channel":"connected"}\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    // B. CORS proxy for public Deezer API (`https://api.deezer.com/*`)
    if (pathname.startsWith('/api/deezer-public/')) {
      const upstreamPath = pathname.slice('/api/deezer-public'.length) + parsed.search
      const dzReq = https.get(`https://api.deezer.com${upstreamPath}`, { timeout: 15000 }, (dzRes) => {
        res.writeHead(dzRes.statusCode || 200, {
          'Content-Type': dzRes.headers['content-type'] || 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        dzRes.pipe(res)
      })
      dzReq.on('error', (err) => sendJson(res, { error: { message: err.message } }, 502))
      return
    }

    // C. Persistent web storage API (replaces Electron ipcMain storage handlers)
    if (pathname.startsWith('/api/web-storage/')) {
      const key = pathname.slice('/api/web-storage/'.length)
      if (key === 'runtime' && req.method === 'GET') {
        return sendJson(res, {
          version: app.getVersion(),
          defaultDownloadPath: DEFAULT_DOWNLOAD_PATH,
          runtime: {
            electron: 'docker-web',
            chromium: 'browser',
            node: process.versions.node,
            v8: process.versions.v8,
            os: `${process.platform} (${process.arch})`
          }
        })
      }
      if (key === 'credentials') {
        if (req.method === 'GET') {
          const c = readJsonSafe<Record<string, string>>('credentials.json', {})
          return sendJson(res, { success: true, credentials: c })
        }
        if (req.method === 'POST') {
          const body = await parseBody(req)
          const current = readJsonSafe<Record<string, string>>('credentials.json', {})
          const merged = { ...current, ...(body || {}) }
          writeJsonAtomic('credentials.json', merged)
          return sendJson(res, { success: true })
        }
      }
      if (key === 'settings') {
        if (req.method === 'GET') {
          const s = readJsonSafe<Record<string, any> | null>('settings.json', null)
          if (s && !s.downloadPath) s.downloadPath = DEFAULT_DOWNLOAD_PATH
          return sendJson(res, { success: true, settings: s })
        }
        if (req.method === 'POST') {
          const body = await parseBody(req)
          if (body && !body.downloadPath) body.downloadPath = DEFAULT_DOWNLOAD_PATH
          writeJsonAtomic('settings.json', body || {})
          return sendJson(res, { success: true })
        }
      }
      if (key === 'downloads') {
        if (req.method === 'GET') {
          return sendJson(res, readJsonSafe('downloads-state.json', null))
        }
        if (req.method === 'POST') {
          const body = await parseBody(req)
          writeJsonAtomic('downloads-state.json', body || { downloads: [], downloadHistory: [] })
          return sendJson(res, { success: true })
        }
      }
      if (key === 'profiles') {
        if (req.method === 'GET') {
          return sendJson(res, { success: true, data: readJsonSafe('profiles.json', null) })
        }
        if (req.method === 'POST') {
          const body = await parseBody(req)
          writeJsonAtomic('profiles.json', body || {})
          return sendJson(res, { success: true })
        }
      }
      return sendJson(res, { error: 'Unknown storage key' }, 404)
    }

    // D. Proxy all `/api/*`, `/res/*`, `/info-spotify` calls to internal loopback DeemixServer
    if (pathname.startsWith('/api/') || pathname.startsWith('/res/') || pathname === '/info-spotify') {
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: actualInternalPort,
          path: rawUrl,
          method: req.method,
          headers: {
            ...req.headers,
            host: `127.0.0.1:${actualInternalPort}`,
            origin: `http://127.0.0.1:${actualInternalPort}`
          }
        },
        (proxyRes) => {
          const outHeaders = { ...proxyRes.headers }
          delete outHeaders['access-control-allow-origin']
          res.writeHead(proxyRes.statusCode || 200, outHeaders)
          proxyRes.pipe(res)
        }
      )
      proxyReq.on('error', (err) => sendJson(res, { error: err.message }, 502))
      req.pipe(proxyReq)
      return
    }

    // E. Static SPA (`dist/`)
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const candidate = path.resolve(DIST_DIR, rel)
    const safeCandidate = candidate.startsWith(DIST_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(DIST_DIR, 'index.html')

    if (!fs.existsSync(safeCandidate)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Frontend build not found in ./dist')
      return
    }
    const ext = path.extname(safeCandidate).toLowerCase()
    const isImmutable = pathname.startsWith('/assets/')
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': isImmutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    })
    fs.createReadStream(safeCandidate).pipe(res)
  })

  gateway.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    console.log(`[Deemix Remastered Web] Listening on http://${PUBLIC_HOST}:${PUBLIC_PORT} (downloads -> ${DEFAULT_DOWNLOAD_PATH})`)
  })
}

main().catch((err) => {
  console.error('[Deemix Remastered Web] Fatal startup error:', err)
  process.exit(1)
})
