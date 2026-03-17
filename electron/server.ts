import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import * as http from 'http'
import { EventEmitter } from 'events'
import * as https from 'https'
import * as fs from 'fs'
import { normalize, resolve, join, dirname } from 'path'
import { app } from 'electron'
import { deezerAuth, DeezerSession } from './services/deezerAuth'
import { downloader, DownloadProgress } from './services/downloader'
import { spotifyAPI } from './services/spotifyAPI'
import { spotifyConverter } from './services/spotifyConverter'
import { playlistSync } from './services/playlistSync'

// File-based cache for discography (persists across app restarts)
const DISCOGRAPHY_FILE_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

// Lazy-evaluate cache path (app.getPath() only works after 'ready' event)
let _discographyCacheFile: string | null = null
function getDiscographyCacheFile(): string {
  if (!_discographyCacheFile) {
    _discographyCacheFile = join(app.getPath('userData'), 'discography-cache.json')
    console.log(`[Server] Discography cache file location: ${_discographyCacheFile}`)
  }
  return _discographyCacheFile
}

interface FileCache {
  [artistId: string]: {
    data: any
    timestamp: number
  }
}

// Lazy-loaded file cache
let _discographyFileCache: FileCache | null = null
function getFileCache(): FileCache {
  if (_discographyFileCache === null) {
    _discographyFileCache = loadFileCache()
    console.log(`[Server] Loaded discography file cache with ${Object.keys(_discographyFileCache).length} entries`)
  }
  return _discographyFileCache
}

function loadFileCache(): FileCache {
  try {
    const cacheFile = getDiscographyCacheFile()
    if (fs.existsSync(cacheFile)) {
      const content = fs.readFileSync(cacheFile, 'utf-8')
      return JSON.parse(content)
    }
  } catch (error) {
    console.error('[Server] Failed to load discography cache file:', error)
  }
  return {}
}

function saveFileCache(cache: FileCache): void {
  try {
    const cacheFile = getDiscographyCacheFile()
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2))
  } catch (error) {
    console.error('[Server] Failed to save discography cache file:', error)
  }
}

// Security: Per-operation rate limiting
type OperationType = 'auth' | 'search' | 'download' | 'api' | 'sync' | 'default'

interface RateLimitConfig {
  window: number     // Time window in ms
  maxRequests: number // Max requests per window
}

// Different limits for different operation types
const RATE_LIMIT_CONFIGS: Record<OperationType, RateLimitConfig> = {
  auth: { window: 60000, maxRequests: 5 },       // 5 auth attempts per minute
  search: { window: 60000, maxRequests: 30 },    // 30 searches per minute
  download: { window: 60000, maxRequests: 500 },  // 500 download starts per minute (local API, batch support)
  api: { window: 60000, maxRequests: 500 },       // 500 API calls per minute (local API)
  sync: { window: 60000, maxRequests: 120 },     // 120 sync operations per minute (local API)
  default: { window: 60000, maxRequests: 100 }   // 100 general requests per minute
}

interface RateLimitRecord {
  counts: Map<OperationType, { count: number; resetTime: number }>
}

const rateLimitMap = new Map<string, RateLimitRecord>()
const RATE_LIMIT_CLEANUP_INTERVAL = 300000 // Clean up every 5 minutes
const RATE_LIMIT_MAX_ENTRIES = 10000 // Max entries to prevent memory exhaustion

// Security: Request body size limit (1MB)
const MAX_BODY_SIZE = 1024 * 1024

// Security: Request timeout (30 seconds)
const REQUEST_TIMEOUT = 30000

// Periodic cleanup of expired rate limit entries (prevents memory leak)
setInterval(() => {
  const now = Date.now()
  let cleaned = 0
  for (const [ip, record] of rateLimitMap) {
    let allExpired = true
    for (const [opType, opRecord] of record.counts) {
      if (now <= opRecord.resetTime) {
        allExpired = false
      } else {
        record.counts.delete(opType)
      }
    }
    if (allExpired || record.counts.size === 0) {
      rateLimitMap.delete(ip)
      cleaned++
    }
  }
  if (cleaned > 0) {
    console.log(`[Security] Rate limit cleanup: removed ${cleaned} expired entries`)
  }
}, RATE_LIMIT_CLEANUP_INTERVAL)

function checkRateLimit(ip: string, operation: OperationType = 'default'): boolean {
  const now = Date.now()
  const config = RATE_LIMIT_CONFIGS[operation]

  // Emergency cleanup if map grows too large (DoS prevention)
  if (rateLimitMap.size > RATE_LIMIT_MAX_ENTRIES) {
    console.warn(`[Security] Rate limit map exceeded ${RATE_LIMIT_MAX_ENTRIES} entries, performing emergency cleanup`)
    for (const [entryIp, entryRecord] of rateLimitMap) {
      let allExpired = true
      for (const [, opRecord] of entryRecord.counts) {
        if (now <= opRecord.resetTime) allExpired = false
      }
      if (allExpired) rateLimitMap.delete(entryIp)
    }
  }

  let record = rateLimitMap.get(ip)
  if (!record) {
    record = { counts: new Map() }
    rateLimitMap.set(ip, record)
  }

  const opRecord = record.counts.get(operation)

  if (!opRecord || now > opRecord.resetTime) {
    record.counts.set(operation, { count: 1, resetTime: now + config.window })
    return true
  }

  if (opRecord.count >= config.maxRequests) {
    console.warn(`[Security] Rate limit exceeded for ${operation}: ${ip}`)
    return false
  }

  opRecord.count++
  return true
}

// Security: Input validation helpers
function sanitizeString(input: string, maxLength: number = 500): string {
  if (typeof input !== 'string') return ''
  return input.trim().substring(0, maxLength)
}

function validateNumericId(id: any): number | null {
  const num = parseInt(String(id), 10)
  if (isNaN(num) || num < 0 || num > Number.MAX_SAFE_INTEGER) {
    return null
  }
  return num
}

function validateQuality(quality: any): 'MP3_128' | 'MP3_320' | 'FLAC' {
  const validQualities = ['MP3_128', 'MP3_320', 'FLAC']
  return validQualities.includes(quality) ? quality : 'MP3_320'
}

function validateDownloadPath(pathStr: string): boolean {
  if (!pathStr || typeof pathStr !== 'string') return false

  // Check for path traversal patterns
  if (pathStr.includes('..')) return false

  try {
    // Resolve the path (handles relative paths)
    const normalizedPath = normalize(resolve(pathStr))

    // Check if it's an absolute path
    // Windows: starts with drive letter (e.g., C:\, D:\)
    // Unix: starts with /
    const isWindowsAbsolute = /^[A-Za-z]:[\\\/]/.test(normalizedPath)
    const isUnixAbsolute = normalizedPath.startsWith('/')

    if (!isWindowsAbsolute && !isUnixAbsolute) {
      console.warn('[Security] Path is not absolute:', pathStr)
      return false
    }

    // Block sensitive system directories
    const blockedPaths = process.platform === 'win32'
      ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\System']
      : ['/bin', '/sbin', '/usr', '/etc', '/var', '/System', '/Library']

    const isBlocked = blockedPaths.some(blocked => {
      const normalizedBlocked = normalize(resolve(blocked))
      return normalizedPath.toLowerCase().startsWith(normalizedBlocked.toLowerCase())
    })

    if (isBlocked) {
      console.warn('[Security] Path is in blocked system directory:', pathStr)
      return false
    }

    return true
  } catch {
    // If path resolution fails, reject it
    return false
  }
}

type OverwriteMode = 'no' | 'overwrite' | 'rename'

// Other settings types
type ArtistSeparator = 'standard' | 'comma' | 'slash' | 'semicolon' | 'ampersand'
type DateFormat = 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY'
type FeaturedArtistsHandling = 'nothing' | 'remove' | 'moveToTitle' | 'removeFromTitle'
type CasingOption = 'unchanged' | 'lowercase' | 'uppercase' | 'titlecase' | 'sentencecase'
type LocalArtworkFormat = 'jpeg' | 'png' | 'both'

interface AlbumCoverSettings {
  saveCovers: boolean
  coverNameTemplate: string
  saveArtistImage: boolean
  localArtworkSize: number
  embeddedArtworkSize: number
  localArtworkFormat: LocalArtworkFormat
  saveEmbeddedArtworkAsPNG: boolean
  coverDescriptionUTF8: boolean
  jpegImageQuality: number
}

interface TagSettings {
  title: boolean
  artist: boolean
  album: boolean
  cover: boolean
  trackNumber: boolean
  trackTotal: boolean
  discNumber: boolean
  discTotal: boolean
  albumArtist: boolean
  genre: boolean
  year: boolean
  date: boolean
  explicitLyrics: boolean
  isrc: boolean
  trackLength: boolean
  albumBarcode: boolean
  bpm: boolean
  replayGain: boolean
  albumLabel: boolean
  unsyncLyrics: boolean
  syncLyrics: boolean
  copyright: boolean
  composer: boolean
  involvedPeople: boolean
  sourceId: boolean
}

interface ServerSettings {
  downloadPath: string
  quality: 'MP3_128' | 'MP3_320' | 'FLAC'
  maxConcurrentDownloads: number
  // Download behavior settings
  overwriteFiles: OverwriteMode
  bitrateFallback: boolean
  searchFallback: boolean
  isrcFallback: boolean
  createErrorLog: boolean
  createSearchLog: boolean
  gambleCDNs: boolean
  createLrcFiles: boolean
  createPlaylistFile: boolean
  clearQueueOnClose: boolean
  // Folder settings
  createPlaylistFolder: boolean
  createArtistFolder: boolean
  createAlbumFolder: boolean
  createCDFolder: boolean
  createPlaylistStructure: boolean
  createSinglesStructure: boolean
  playlistFolderTemplate: string
  albumFolderTemplate: string
  artistFolderTemplate: string
  // Track naming templates
  trackNameTemplate: string
  albumTrackTemplate: string
  playlistTrackTemplate: string
  // File settings
  saveArtwork: boolean
  embedArtwork: boolean
  saveLyrics: boolean
  syncedLyrics: boolean
  // Tag settings
  tags: TagSettings
  // Album cover settings
  albumCovers: AlbumCoverSettings
  // Other settings
  checkForUpdates: boolean
  savePlaylistAsCompilation: boolean
  useNullSeparator: boolean
  saveID3v1: boolean
  saveOnlyMainArtist: boolean
  keepVariousArtists: boolean
  removeAlbumVersion: boolean
  removeArtistCombinations: boolean
  artistSeparator: ArtistSeparator
  dateFormatFlac: DateFormat
  featuredArtistsHandling: FeaturedArtistsHandling
  titleCasing: CasingOption
  artistCasing: CasingOption
  previewVolume: number
  // executeAfterDownload removed - security risk (arbitrary command execution)
}

export class DeemixServer extends EventEmitter {
  private host: string
  private port: number
  private server: Server | null = null
  private settings: ServerSettings = {
    downloadPath: (process.env.HOME || process.env.USERPROFILE || '.') + (process.platform === 'win32' ? '\\Music\\Deemix' : '/Music/Deemix'),
    quality: 'MP3_320',
    maxConcurrentDownloads: 3,
    // Download behavior settings
    overwriteFiles: 'no',
    bitrateFallback: true,
    searchFallback: true,
    isrcFallback: false,
    createErrorLog: true,
    createSearchLog: false,
    gambleCDNs: false,
    createLrcFiles: false,
    createPlaylistFile: false,
    clearQueueOnClose: false,
    // Folder settings
    createPlaylistFolder: true,
    createArtistFolder: false,
    createAlbumFolder: true,
    createCDFolder: true,
    createPlaylistStructure: false,
    createSinglesStructure: false,
    playlistFolderTemplate: '%playlist%',
    albumFolderTemplate: '%artist% - %album%',
    artistFolderTemplate: '%artist%',
    // Track naming templates
    trackNameTemplate: '%artist% - %title%',
    albumTrackTemplate: '%tracknumber% - %title%',
    playlistTrackTemplate: '%position% - %artist% - %title%',
    // File settings
    saveArtwork: true,
    embedArtwork: true,
    saveLyrics: true,
    syncedLyrics: true,
    // Tag settings
    tags: {
      title: true,
      artist: true,
      album: true,
      cover: true,
      trackNumber: true,
      trackTotal: false,
      discNumber: true,
      discTotal: false,
      albumArtist: true,
      genre: true,
      year: true,
      date: true,
      explicitLyrics: false,
      isrc: true,
      trackLength: true,
      albumBarcode: true,
      bpm: true,
      replayGain: false,
      albumLabel: true,
      unsyncLyrics: false,
      syncLyrics: false,
      copyright: false,
      composer: false,
      involvedPeople: false,
      sourceId: false
    },
    // Album cover settings
    albumCovers: {
      saveCovers: true,
      coverNameTemplate: 'cover',
      saveArtistImage: false,
      localArtworkSize: 1200,
      embeddedArtworkSize: 800,
      localArtworkFormat: 'jpeg',
      saveEmbeddedArtworkAsPNG: false,
      coverDescriptionUTF8: false,
      jpegImageQuality: 90
    },
    // Other settings
    checkForUpdates: true,
    savePlaylistAsCompilation: false,
    useNullSeparator: false,
    saveID3v1: false,
    saveOnlyMainArtist: false,
    keepVariousArtists: true,
    removeAlbumVersion: false,
    removeArtistCombinations: false,
    artistSeparator: 'standard',
    dateFormatFlac: 'YYYY-MM-DD',
    featuredArtistsHandling: 'nothing',
    titleCasing: 'unchanged',
    artistCasing: 'unchanged',
    previewVolume: 80
    // executeAfterDownload removed - security risk (arbitrary command execution)
  }

  // Response-level cache for discography (ensures exact same response on repeated requests)
  private discographyResponseCache = new Map<string, { data: any; timestamp: number }>()
  private readonly DISCOGRAPHY_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  constructor(host: string, port: number) {
    super()
    this.host = host
    this.port = port

    // Forward downloader events
    downloader.on('queued', (progress) => this.emit('download:queued', progress))
    downloader.on('start', (progress) => this.emit('download:start', progress))
    downloader.on('progress', (progress) => this.emit('download:progress', progress))
    downloader.on('complete', (progress) => this.emit('download:complete', progress))
    downloader.on('error', (progress) => this.emit('download:error', progress))

    // Forward auth events from deezerAuth
    deezerAuth.on('auth-expired', (data) => {
      console.log('[Server] Auth expired event received:', data.reason)
      this.emit('auth-expired', data)
    })

    // Forward session health updates for keep-alive monitoring
    deezerAuth.on('session-health', (data) => {
      this.emit('session-health', data)
    })
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        console.log(`[Server] ${req.method} ${req.url}`)

        this.handleRequest(req, res).catch(error => {
          console.error('[Server] Request error:', error)
          // Always return JSON, even on error
          try {
            this.sendJSON(res, { error: error.message || 'Internal server error' }, 500)
          } catch (e) {
            console.error('[Server] Failed to send error response:', e)
          }
        })
      })

      this.server.listen(this.port, this.host, () => {
        console.log(`[Server] Deemix server running on http://${this.host}:${this.port}`)
        resolve()
      })

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          // Port in use, try next port
          console.log(`[Server] Port ${this.port} in use, trying ${this.port + 1}`)
          this.port++
          this.server?.close()
          this.start().then(resolve).catch(reject)
        } else {
          console.error('[Server] Server error:', error)
          reject(error)
        }
      })
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  getPort(): number {
    return this.port
  }

  // Security: Determine operation type for per-operation rate limiting
  private getOperationType(path: string): OperationType {
    if (path.startsWith('/api/auth/')) {
      return 'auth'
    }
    if (path === '/api/search') {
      return 'search'
    }
    if (path.startsWith('/api/download')) {
      return 'download'
    }
    if (path.startsWith('/api/sync/')) {
      return 'sync'
    }
    if (path.startsWith('/api/')) {
      return 'api'
    }
    return 'default'
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Security: Only allow requests from localhost
    const remoteAddress = req.socket.remoteAddress || ''
    const isLocalhost = remoteAddress === '127.0.0.1' ||
                        remoteAddress === '::1' ||
                        remoteAddress === '::ffff:127.0.0.1'

    if (!isLocalhost) {
      console.warn('[Security] Blocked request from non-localhost:', remoteAddress)
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    // Enable CORS - restrict to known localhost origins only
    // This prevents DNS rebinding attacks even though we restrict to localhost connections
    const origin = req.headers.origin || ''
    const allowedOrigins = [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      `http://localhost:${this.port}`,
      `http://127.0.0.1:${this.port}`,
      'file://'  // Electron production mode
    ]
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
    res.setHeader('Access-Control-Allow-Origin', corsOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Credentials', 'true')

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('X-XSS-Protection', '1; mode=block')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Cache-Control', 'no-store')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`)
    const path = url.pathname

    // Security: Per-operation rate limiting
    const operationType = this.getOperationType(path)
    if (!checkRateLimit(remoteAddress, operationType)) {
      console.warn(`[Security] Rate limit exceeded for ${operationType}:`, remoteAddress)
      res.writeHead(429)
      res.end('Too Many Requests')
      return
    }

    // Static file serving for /res/ path
    if (path.startsWith('/res/')) {
      await this.handleStaticFile(path, res)
      return
    }

    // Route handling
    switch (path) {
      case '/api/health':
        this.sendJSON(res, {
          status: 'ok',
          version: '1.0.0',
          authenticated: deezerAuth.isLoggedIn()
        })
        break

      case '/api/auth/login':
        await this.handleLogin(req, res)
        break

      case '/api/auth/login-email':
        await this.handleLoginEmail(req, res)
        break

      case '/api/auth/login-captcha':
        await this.handleLoginCaptcha(req, res)
        break

      case '/api/auth/captcha-status':
        this.handleCaptchaStatus(res)
        break

      case '/api/auth/captcha-clear':
        this.handleCaptchaClear(res)
        break

      case '/api/auth/logout':
        this.handleLogout(res)
        break

      case '/api/auth/status':
        this.handleAuthStatus(res)
        break

      case '/api/auth/health':
        this.handleSessionHealth(res)
        break

      case '/api/search':
        await this.handleSearch(url, res)
        break

      case '/api/track':
        await this.handleGetTrack(url, res)
        break

      case '/api/album':
        await this.handleGetAlbum(url, res)
        break

      case '/api/artist':
        await this.handleGetArtist(url, res)
        break

      case '/api/artist/discography':
        await this.handleGetArtistDiscography(url, res)
        break

      case '/api/playlist':
        await this.handleGetPlaylist(url, res)
        break

      case '/api/download':
        await this.handleDownload(req, res)
        break

      case '/api/download/album':
        await this.handleDownloadAlbum(req, res)
        break

      case '/api/download/playlist':
        await this.handleDownloadPlaylist(req, res)
        break

      case '/api/download/batch':
        await this.handleDownloadBatch(req, res)
        break

      case '/api/queue':
        this.handleGetQueue(res)
        break

      case '/api/queue/cancel':
        await this.handleCancelDownload(req, res)
        break

      case '/api/queue/pause':
        this.handlePauseQueue(res)
        break

      case '/api/queue/resume':
        this.handleResumeQueue(res)
        break

      case '/api/queue/status':
        this.handleQueueStatus(res)
        break

      case '/api/settings':
        await this.handleSettings(req, res)
        break

      case '/api/chart':
        await this.handleChart(url, res)
        break

      case '/api/chart/countries':
        await this.handleChartCountries(res)
        break

      case '/api/editorial/releases':
        await this.handleEditorialReleases(url, res)
        break

      case '/api/analyze':
        await this.handleAnalyze(url, res)
        break

      // Spotify endpoints
      case '/api/spotify/auth':
        await this.handleSpotifyAuth(req, res)
        break

      case '/api/spotify/status':
        this.handleSpotifyStatus(res)
        break

      case '/api/spotify/analyze':
        await this.handleSpotifyAnalyze(req, res)
        break

      case '/api/spotify/convert':
        await this.handleSpotifyConvert(req, res)
        break

      case '/info-spotify':
        this.handleInfoSpotify(res)
        break

      // Playlist Sync routes
      case '/api/sync/playlists':
        if (req.method === 'GET') {
          this.handleGetSyncPlaylists(res)
        } else if (req.method === 'POST') {
          await this.handleAddSyncPlaylist(req, res)
        } else if (req.method === 'PUT') {
          await this.handleUpdateSyncPlaylist(req, res)
        } else if (req.method === 'DELETE') {
          await this.handleDeleteSyncPlaylist(req, res)
        }
        break

      case '/api/sync/run':
        await this.handleRunSync(req, res)
        break

      case '/api/sync/run-all':
        await this.handleRunSyncAll(res)
        break

      case '/api/sync/cancel':
        await this.handleCancelSync(req, res)
        break

      case '/api/sync/status':
        this.handleGetSyncStatus(res)
        break

      case '/api/sync/resolve-url':
        await this.handleResolveShareUrl(req, res)
        break

      default:
        res.writeHead(404)
        res.end('Not Found')
    }
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    console.log('[Server] Handling ARL login request')

    try {
      const body = await this.parseBody(req)
      const { arl } = body

      if (!arl) {
        console.log('[Server] ARL token missing')
        this.sendJSON(res, { error: 'ARL token is required' }, 400)
        return
      }

      console.log('[Server] Attempting login with ARL (length:', arl.length, ')')
      const session = await deezerAuth.login(arl)
      console.log('[Server] Login successful for user:', session.user?.id)

      this.sendJSON(res, {
        success: true,
        user: session.user,
        arl: session.arl
      })
    } catch (error: any) {
      console.error('[Server] Login error:', error.message)
      this.sendJSON(res, { error: error.message || 'Login failed' }, 401)
    }
  }

  private async handleLoginEmail(req: IncomingMessage, res: ServerResponse): Promise<void> {
    console.log('[Server] Handling email login request')

    try {
      const body = await this.parseBody(req)
      const { email, password } = body

      if (!email || !password) {
        console.log('[Server] Email or password missing')
        this.sendJSON(res, { error: 'Email and password are required' }, 400)
        return
      }

      // Security: Mask email in logs (only show domain)
      const maskedEmail = email.includes('@') ? `***@${email.split('@')[1]}` : '***'
      console.log('[Server] Attempting login with email:', maskedEmail)
      const result = await deezerAuth.loginWithEmail(email, password)

      // Check if CAPTCHA is required
      if ('required' in result && result.required) {
        console.log('[Server] CAPTCHA required for login')
        this.sendJSON(res, {
          captchaRequired: true,
          siteKey: result.siteKey,
          captchaUrl: result.captchaUrl
        })
        return
      }

      // Login successful
      const session = result as any
      console.log('[Server] Email login successful for user ID:', session.user?.id)

      this.sendJSON(res, {
        success: true,
        user: session.user,
        arl: session.arl
      })
    } catch (error: any) {
      console.error('[Server] Email login error:', error.message)
      this.sendJSON(res, { error: error.message || 'Login failed' }, 401)
    }
  }

  private async handleLoginCaptcha(req: IncomingMessage, res: ServerResponse): Promise<void> {
    console.log('[Server] Handling CAPTCHA login request')

    try {
      const body = await this.parseBody(req)
      const { captchaResponse } = body

      if (!captchaResponse) {
        console.log('[Server] CAPTCHA response missing')
        this.sendJSON(res, { error: 'CAPTCHA response is required' }, 400)
        return
      }

      // Check if there's a pending CAPTCHA challenge
      const pendingCaptcha = deezerAuth.getPendingCaptcha()
      if (!pendingCaptcha) {
        console.log('[Server] No pending CAPTCHA challenge')
        this.sendJSON(res, { error: 'No pending CAPTCHA challenge. Please start login again.' }, 400)
        return
      }

      console.log('[Server] Completing login with CAPTCHA solution')
      const session = await deezerAuth.loginWithCaptcha(captchaResponse)
      console.log('[Server] CAPTCHA login successful for user ID:', session.user?.id)

      this.sendJSON(res, {
        success: true,
        user: session.user,
        arl: session.arl
      })
    } catch (error: any) {
      console.error('[Server] CAPTCHA login error:', error.message)
      this.sendJSON(res, { error: error.message || 'CAPTCHA verification failed' }, 401)
    }
  }

  private handleCaptchaStatus(res: ServerResponse): void {
    const pendingCaptcha = deezerAuth.getPendingCaptcha()
    this.sendJSON(res, {
      pending: !!pendingCaptcha,
      siteKey: pendingCaptcha?.siteKey,
      captchaUrl: pendingCaptcha?.captchaUrl
    })
  }

  private handleCaptchaClear(res: ServerResponse): void {
    deezerAuth.clearPendingCaptcha()
    this.sendJSON(res, { success: true })
  }

  private handleLogout(res: ServerResponse): void {
    deezerAuth.logout()
    this.sendJSON(res, { success: true })
  }

  private handleAuthStatus(res: ServerResponse): void {
    const session = deezerAuth.getSession()
    this.sendJSON(res, {
      authenticated: deezerAuth.isLoggedIn(),
      user: session?.user || null
    })
  }

  /**
   * Get session health information for the frontend
   * Includes TTL, activity status, and health metrics
   */
  private handleSessionHealth(res: ServerResponse): void {
    const health = deezerAuth.getSessionHealth()
    this.sendJSON(res, {
      ...health,
      // Convert dates to ISO strings for JSON
      lastActivity: health.lastActivity?.toISOString() || null
    })
  }

  private async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const rawQuery = url.searchParams.get('q')
    const rawType = url.searchParams.get('type') || 'track'
    const rawLimit = url.searchParams.get('limit') || '50'
    const rawIndex = url.searchParams.get('index') || '0'

    // Security: Validate and sanitize inputs
    const query = sanitizeString(rawQuery || '', 200)
    if (!query || query.length < 1) {
      this.sendJSON(res, { error: 'Query parameter is required' }, 400)
      return
    }

    // Validate search type
    const validTypes = ['track', 'album', 'artist', 'playlist']
    const type = validTypes.includes(rawType) ? rawType : 'track'

    // Validate limit (increased max to 100 for better pagination)
    let limit = parseInt(rawLimit, 10)
    if (isNaN(limit) || limit < 1) limit = 50
    if (limit > 100) limit = 100 // Deezer API max per request

    // Validate index for pagination
    let index = parseInt(rawIndex, 10)
    if (isNaN(index) || index < 0) index = 0
    if (index > 10000) index = 10000 // Reasonable upper limit

    try {
      const response = await this.deezerPublicAPI(`/search/${type}?q=${encodeURIComponent(query)}&limit=${limit}&index=${index}`)
      this.sendJSON(res, response)
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private async handleGetTrack(url: URL, res: ServerResponse): Promise<void> {
    const rawId = url.searchParams.get('id')
    const id = validateNumericId(rawId)

    if (id === null) {
      this.sendJSON(res, { error: 'Valid Track ID is required' }, 400)
      return
    }

    try {
      const response = await this.deezerPublicAPI(`/track/${id}`)
      this.sendJSON(res, response)
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private async handleGetAlbum(url: URL, res: ServerResponse): Promise<void> {
    const rawId = url.searchParams.get('id')
    const id = validateNumericId(rawId)

    if (id === null) {
      this.sendJSON(res, { error: 'Valid Album ID is required' }, 400)
      return
    }

    try {
      // Get album info first
      const album = await this.deezerPublicAPI(`/album/${id}`)

      // Fetch all tracks (some albums like compilations can have many tracks)
      let allTracks: any[] = []
      let index = 0
      const batchSize = 100

      while (index < 1000) { // Safety limit
        const tracksPage = await this.deezerPublicAPI(`/album/${id}/tracks?limit=${batchSize}&index=${index}`)
        if (!tracksPage.data || tracksPage.data.length === 0) break
        allTracks = [...allTracks, ...tracksPage.data]
        if (!tracksPage.next) break
        index += batchSize
      }

      this.sendJSON(res, { ...album, tracks: allTracks })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private async handleGetArtist(url: URL, res: ServerResponse): Promise<void> {
    const rawId = url.searchParams.get('id')
    const id = validateNumericId(rawId)

    if (id === null) {
      this.sendJSON(res, { error: 'Valid Artist ID is required' }, 400)
      return
    }

    try {
      // Get artist info and initial data
      const [artist, topTracks, albumsPage1] = await Promise.all([
        this.deezerPublicAPI(`/artist/${id}`),
        this.deezerPublicAPI(`/artist/${id}/top?limit=100`),
        this.deezerPublicAPI(`/artist/${id}/albums?limit=100`)
      ])

      // Fetch all albums if there are more (exhaustive)
      let allAlbums = albumsPage1.data || []
      if (albumsPage1.next) {
        let index = 100
        while (index < 1000) { // Safety limit
          const moreAlbums = await this.deezerPublicAPI(`/artist/${id}/albums?limit=100&index=${index}`)
          if (!moreAlbums.data || moreAlbums.data.length === 0) break
          allAlbums = [...allAlbums, ...moreAlbums.data]
          if (!moreAlbums.next) break
          index += 100
        }
      }

      // Inject artist info into albums (Deezer API doesn't include it for artist albums)
      const albumsWithArtist = allAlbums.map((album: any) => ({
        ...album,
        artist: album.artist || {
          id: artist.id,
          name: artist.name,
          picture: artist.picture,
          picture_small: artist.picture_small,
          picture_medium: artist.picture_medium,
          picture_big: artist.picture_big,
          picture_xl: artist.picture_xl
        }
      }))

      this.sendJSON(res, {
        ...artist,
        topTracks: topTracks.data,
        albums: albumsWithArtist
      })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  /**
   * Get artist discography from private Deezer API with proper categorization
   * Returns albums, eps, singles, etc. properly separated (unlike public API)
   */
  private async handleGetArtistDiscography(url: URL, res: ServerResponse): Promise<void> {
    const rawId = url.searchParams.get('id')
    const id = validateNumericId(rawId)

    if (id === null) {
      this.sendJSON(res, { error: 'Valid Artist ID is required' }, 400)
      return
    }

    // Require authentication for private API
    if (!deezerAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Authentication required for discography' }, 401)
      return
    }

    // Check file-based cache first (persists across app restarts)
    const cacheKey = String(id)
    const fileCache = getFileCache()
    const fileCached = fileCache[cacheKey]
    if (fileCached && Date.now() - fileCached.timestamp < DISCOGRAPHY_FILE_CACHE_TTL) {
      console.log(`[Server] Using FILE-CACHED discography for artist ${id} (${fileCached.data.counts.total} releases)`)
      this.sendJSON(res, fileCached.data)
      return
    }

    // Check in-memory cache second
    const memCached = this.discographyResponseCache.get(`discography_${id}`)
    if (memCached && Date.now() - memCached.timestamp < this.DISCOGRAPHY_CACHE_TTL) {
      console.log(`[Server] Using memory-cached discography for artist ${id}`)
      this.sendJSON(res, memCached.data)
      return
    }

    try {
      // Get discography from private API
      const discography = await deezerAuth.getArtistDiscography(id)

      // Convert private API format to public API-like format for consistency
      // Record type is determined by which category the release was placed in
      const convertRelease = (release: any, recordType: string) => ({
        id: parseInt(release.ALB_ID, 10),
        title: release.ALB_TITLE,
        cover: release.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${release.ALB_PICTURE}/250x250-000000-80-0-0.jpg` : '',
        cover_small: release.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${release.ALB_PICTURE}/56x56-000000-80-0-0.jpg` : '',
        cover_medium: release.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${release.ALB_PICTURE}/250x250-000000-80-0-0.jpg` : '',
        cover_big: release.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${release.ALB_PICTURE}/500x500-000000-80-0-0.jpg` : '',
        cover_xl: release.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${release.ALB_PICTURE}/1000x1000-000000-80-0-0.jpg` : '',
        nb_tracks: release.NB_SONG || release.NUMBER_TRACK || 0,
        release_date: release.DIGITAL_RELEASE_DATE || release.PHYSICAL_RELEASE_DATE || '',
        record_type: recordType,
        explicit_lyrics: release.EXPLICIT_ALBUM_CONTENT?.EXPLICIT_LYRICS_STATUS === 1,
        artist: {
          id: parseInt(release.ART_ID, 10),
          name: release.ART_NAME
        }
      })

      // Helper to determine the record type for each release in 'all'
      // based on which category it belongs to
      const albumIds = new Set(discography.album.map((r: any) => r.ALB_ID))
      const epIds = new Set(discography.ep.map((r: any) => r.ALB_ID))
      const singleIds = new Set(discography.single.map((r: any) => r.ALB_ID))
      const compileIds = new Set(discography.compile.map((r: any) => r.ALB_ID))
      const featuredIds = new Set(discography.featured.map((r: any) => r.ALB_ID))

      const getRecordType = (albumId: string): string => {
        if (singleIds.has(albumId)) return 'single'
        if (epIds.has(albumId)) return 'ep'
        if (compileIds.has(albumId)) return 'compile'
        if (featuredIds.has(albumId)) return 'featured'
        if (albumIds.has(albumId)) return 'album'
        return 'album' // default
      }

      const responseData = {
        all: discography.all.map((r: any) => convertRelease(r, getRecordType(r.ALB_ID))),
        albums: discography.album.map((r: any) => convertRelease(r, 'album')),
        eps: discography.ep.map((r: any) => convertRelease(r, 'ep')),
        singles: discography.single.map((r: any) => convertRelease(r, 'single')),
        compilations: discography.compile.map((r: any) => convertRelease(r, 'compile')),
        featured: discography.featured.map((r: any) => convertRelease(r, 'featured')),
        counts: {
          total: discography.all.length,
          albums: discography.album.length,
          eps: discography.ep.length,
          singles: discography.single.length,
          compilations: discography.compile.length,
          featured: discography.featured.length
        }
      }

      // Cache the response for consistency (both memory and file)
      const now = Date.now()
      this.discographyResponseCache.set(`discography_${id}`, { data: responseData, timestamp: now })

      // Save to file-based cache (persists across app restarts)
      const fileCacheToUpdate = getFileCache()
      fileCacheToUpdate[cacheKey] = { data: responseData, timestamp: now }
      saveFileCache(fileCacheToUpdate)
      console.log(`[Server] Cached discography for artist ${id} (memory + file):`, responseData.counts)

      this.sendJSON(res, responseData)
    } catch (error: any) {
      console.error('[Server] Discography fetch error:', error.message)
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private async handleGetPlaylist(url: URL, res: ServerResponse): Promise<void> {
    const rawId = url.searchParams.get('id')
    const id = validateNumericId(rawId)

    if (id === null) {
      this.sendJSON(res, { error: 'Valid Playlist ID is required' }, 400)
      return
    }

    try {
      // Get playlist info first
      const playlist = await this.deezerPublicAPI(`/playlist/${id}`)

      // Fetch all tracks (playlists can be very large)
      let allTracks: any[] = []
      let index = 0
      const batchSize = 100

      while (index < 10000) { // Safety limit for very large playlists
        const tracksPage = await this.deezerPublicAPI(`/playlist/${id}/tracks?limit=${batchSize}&index=${index}`)
        if (!tracksPage.data || tracksPage.data.length === 0) break
        allTracks = [...allTracks, ...tracksPage.data]
        if (!tracksPage.next) break
        index += batchSize
      }

      this.sendJSON(res, { ...playlist, tracks: allTracks })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private async handleDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deezerAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Authentication required' }, 401)
      return
    }

    // Note: We don't call validateSession() here as it can cause issues
    // The login already validates, and auth errors during download are caught by the downloader

    const body = await this.parseBody(req)
    const trackId = validateNumericId(body.trackId)
    // Optional playlist context — when provided, the track is treated as part of
    // a playlist (e.g. converted Spotify playlist from Link Analyzer) instead of
    // a standalone single. This enables playlist folder creation and playlist
    // track naming templates from the user's settings.
    const playlistName = typeof body.playlistName === 'string' ? body.playlistName.trim() : ''

    if (trackId === null) {
      this.sendJSON(res, { error: 'Valid Track ID is required' }, 400)
      return
    }

    // Security: Validate download path
    if (!validateDownloadPath(this.settings.downloadPath)) {
      this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
      return
    }

    const isPlaylistTrack = !!playlistName
    console.log(`[Server] Download request - trackId: ${trackId}, quality: ${this.settings.quality}, path: ${this.settings.downloadPath}${isPlaylistTrack ? `, playlist: "${playlistName}"` : ''}`)
    console.log(`[Server] Settings - embedArtwork: ${this.settings.embedArtwork}, saveArtwork: ${this.settings.saveArtwork}`)
    console.log(`[Server] Settings - tags.cover: ${this.settings.tags?.cover}, tags.title: ${this.settings.tags?.title}`)
    console.log(`[Server] Settings - albumCovers.embeddedArtworkSize: ${this.settings.albumCovers?.embeddedArtworkSize}`)
    console.log(`[Server] Settings - createArtistFolder: ${this.settings.createArtistFolder}, createAlbumFolder: ${this.settings.createAlbumFolder}, createSinglesStructure: ${this.settings.createSinglesStructure}`)

    try {
      // When playlistName is provided, treat as a playlist track (enables playlist
      // folders and playlist track naming). Otherwise treat as a standalone single.
      const downloadId = await downloader.download({
        trackId,
        outputPath: this.settings.downloadPath,
        quality: this.settings.quality,
        bitrateFallback: this.settings.bitrateFallback,
        createFolders: true,
        artistFolder: this.settings.createArtistFolder,
        albumFolder: this.settings.createAlbumFolder,
        saveArtwork: this.settings.saveArtwork,
        embedArtwork: this.settings.embedArtwork,
        saveLyrics: this.settings.saveLyrics,
        syncedLyrics: this.settings.syncedLyrics,
        isSingle: !isPlaylistTrack,
        isFromPlaylist: isPlaylistTrack || undefined,
        playlistName: playlistName || undefined,
        savePlaylistAsCompilation: isPlaylistTrack ? this.settings.savePlaylistAsCompilation : undefined,
        folderSettings: {
          createPlaylistFolder: this.settings.createPlaylistFolder,
          createArtistFolder: this.settings.createArtistFolder,
          createAlbumFolder: this.settings.createAlbumFolder,
          createCDFolder: this.settings.createCDFolder,
          createPlaylistStructure: this.settings.createPlaylistStructure,
          createSinglesStructure: this.settings.createSinglesStructure,
          playlistFolderTemplate: this.settings.playlistFolderTemplate,
          albumFolderTemplate: this.settings.albumFolderTemplate,
          artistFolderTemplate: this.settings.artistFolderTemplate
        },
        trackTemplates: {
          trackNameTemplate: this.settings.trackNameTemplate,
          albumTrackTemplate: this.settings.albumTrackTemplate,
          playlistTrackTemplate: this.settings.playlistTrackTemplate
        },
        metadataSettings: {
          tags: this.settings.tags,
          albumCovers: this.settings.albumCovers,
          useNullSeparator: this.settings.useNullSeparator,
          saveID3v1: this.settings.saveID3v1,
          saveOnlyMainArtist: this.settings.saveOnlyMainArtist,
          artistSeparator: this.settings.artistSeparator,
          dateFormatFlac: this.settings.dateFormatFlac,
          // Text processing settings
          titleCasing: this.settings.titleCasing,
          artistCasing: this.settings.artistCasing,
          removeAlbumVersion: this.settings.removeAlbumVersion,
          featuredArtistsHandling: this.settings.featuredArtistsHandling,
          keepVariousArtists: this.settings.keepVariousArtists,
          removeArtistCombinations: this.settings.removeArtistCombinations
        },
        createErrorLog: this.settings.createErrorLog
      })

      this.sendJSON(res, { id: downloadId, status: 'queued' })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private async handleDownloadAlbum(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deezerAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Authentication required' }, 401)
      return
    }

    // Note: We don't call validateSession() here as it can cause issues
    // The login already validates, and auth errors during download are caught by the downloader

    const body = await this.parseBody(req)
    const albumId = validateNumericId(body.albumId)

    if (albumId === null) {
      this.sendJSON(res, { error: 'Valid Album ID is required' }, 400)
      return
    }

    // Security: Validate download path
    if (!validateDownloadPath(this.settings.downloadPath)) {
      this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
      return
    }

    try {
      // Get album info first (for consistent folder structure)
      const albumInfo = await this.deezerPublicAPI(`/album/${albumId}`)

      // Get album tracks
      const albumTracks = await this.deezerPublicAPI(`/album/${albumId}/tracks?limit=500`)
      const downloadIds: string[] = []

      // Calculate total number of discs in the album
      const totalDiscs = Math.max(...albumTracks.data.map((t: any) => t.disk_number || 1), 1)

      // Build album context for consistent folder naming
      const albumContext = {
        albumId: albumId,
        albumTitle: albumInfo.title || 'Unknown Album',
        albumArtist: albumInfo.artist?.name || 'Unknown Artist',
        artistPicture: albumInfo.artist?.picture_xl || albumInfo.artist?.picture_big || albumInfo.artist?.picture_medium || undefined,
        totalDiscs: totalDiscs
      }

      for (const track of albumTracks.data) {
        const downloadId = await downloader.download({
          trackId: track.id,
          outputPath: this.settings.downloadPath,
          quality: this.settings.quality,
          bitrateFallback: this.settings.bitrateFallback,
          createFolders: true,
          artistFolder: this.settings.createArtistFolder,
          albumFolder: this.settings.createAlbumFolder,
          saveArtwork: this.settings.saveArtwork,
          embedArtwork: this.settings.embedArtwork,
          saveLyrics: this.settings.saveLyrics,
          syncedLyrics: this.settings.syncedLyrics,
          folderSettings: {
            createPlaylistFolder: this.settings.createPlaylistFolder,
            createArtistFolder: this.settings.createArtistFolder,
            createAlbumFolder: this.settings.createAlbumFolder,
            createCDFolder: this.settings.createCDFolder,
            createPlaylistStructure: this.settings.createPlaylistStructure,
            createSinglesStructure: this.settings.createSinglesStructure,
            playlistFolderTemplate: this.settings.playlistFolderTemplate,
            albumFolderTemplate: this.settings.albumFolderTemplate,
            artistFolderTemplate: this.settings.artistFolderTemplate
          },
          trackTemplates: {
            trackNameTemplate: this.settings.trackNameTemplate,
            albumTrackTemplate: this.settings.albumTrackTemplate,
            playlistTrackTemplate: this.settings.playlistTrackTemplate
          },
          metadataSettings: {
            tags: this.settings.tags,
            albumCovers: this.settings.albumCovers,
            useNullSeparator: this.settings.useNullSeparator,
            saveID3v1: this.settings.saveID3v1,
            saveOnlyMainArtist: this.settings.saveOnlyMainArtist,
            artistSeparator: this.settings.artistSeparator,
            dateFormatFlac: this.settings.dateFormatFlac,
            // Text processing settings
            titleCasing: this.settings.titleCasing,
            artistCasing: this.settings.artistCasing,
            removeAlbumVersion: this.settings.removeAlbumVersion,
            featuredArtistsHandling: this.settings.featuredArtistsHandling,
            keepVariousArtists: this.settings.keepVariousArtists,
            removeArtistCombinations: this.settings.removeArtistCombinations
          },
          discNumber: track.disk_number,
          albumContext: albumContext,
          createErrorLog: this.settings.createErrorLog
        })
        downloadIds.push(downloadId)
      }

      this.sendJSON(res, { ids: downloadIds, count: downloadIds.length })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private async handleDownloadPlaylist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deezerAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Authentication required' }, 401)
      return
    }

    // Note: We don't call validateSession() here as it can cause issues
    // The login already validates, and auth errors during download are caught by the downloader

    const body = await this.parseBody(req)
    const playlistId = validateNumericId(body.playlistId)

    if (playlistId === null) {
      this.sendJSON(res, { error: 'Valid Playlist ID is required' }, 400)
      return
    }

    // Security: Validate download path
    if (!validateDownloadPath(this.settings.downloadPath)) {
      this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
      return
    }

    try {
      // Get playlist info first for the name
      const playlistInfo = await this.deezerPublicAPI(`/playlist/${playlistId}`)
      const playlist = await this.deezerPublicAPI(`/playlist/${playlistId}/tracks?limit=500`)
      const downloadIds: string[] = []
      const playlistName = playlistInfo.title || 'Playlist'

      // Collect track info for M3U generation
      const m3uTracks: Array<{
        duration: number
        artist: string
        title: string
        relativePath: string
      }> = []

      // Determine file extension based on quality
      const fileExt = this.settings.quality === 'FLAC' ? '.flac' : '.mp3'

      for (let i = 0; i < playlist.data.length; i++) {
        const track = playlist.data[i]
        const downloadId = await downloader.download({
          trackId: track.id,
          outputPath: this.settings.downloadPath,
          quality: this.settings.quality,
          bitrateFallback: this.settings.bitrateFallback,
          createFolders: true,
          artistFolder: this.settings.createArtistFolder,
          albumFolder: this.settings.createAlbumFolder,
          saveArtwork: this.settings.saveArtwork,
          embedArtwork: this.settings.embedArtwork,
          saveLyrics: this.settings.saveLyrics,
          syncedLyrics: this.settings.syncedLyrics,
          folderSettings: {
            createPlaylistFolder: this.settings.createPlaylistFolder,
            createArtistFolder: this.settings.createArtistFolder,
            createAlbumFolder: this.settings.createAlbumFolder,
            createCDFolder: this.settings.createCDFolder,
            createPlaylistStructure: this.settings.createPlaylistStructure,
            createSinglesStructure: this.settings.createSinglesStructure,
            playlistFolderTemplate: this.settings.playlistFolderTemplate,
            albumFolderTemplate: this.settings.albumFolderTemplate,
            artistFolderTemplate: this.settings.artistFolderTemplate
          },
          trackTemplates: {
            trackNameTemplate: this.settings.trackNameTemplate,
            albumTrackTemplate: this.settings.albumTrackTemplate,
            playlistTrackTemplate: this.settings.playlistTrackTemplate
          },
          metadataSettings: {
            tags: this.settings.tags,
            albumCovers: this.settings.albumCovers,
            useNullSeparator: this.settings.useNullSeparator,
            saveID3v1: this.settings.saveID3v1,
            saveOnlyMainArtist: this.settings.saveOnlyMainArtist,
            artistSeparator: this.settings.artistSeparator,
            dateFormatFlac: this.settings.dateFormatFlac,
            // Text processing settings
            titleCasing: this.settings.titleCasing,
            artistCasing: this.settings.artistCasing,
            removeAlbumVersion: this.settings.removeAlbumVersion,
            featuredArtistsHandling: this.settings.featuredArtistsHandling,
            keepVariousArtists: this.settings.keepVariousArtists,
            removeArtistCombinations: this.settings.removeArtistCombinations
          },
          playlistName: playlistName,
          isFromPlaylist: true,
          playlistPosition: i + 1,
          playlistContext: {
            playlistId: playlistId,
            playlistName: playlistName
          },
          savePlaylistAsCompilation: this.settings.savePlaylistAsCompilation,
          createErrorLog: this.settings.createErrorLog
        })
        downloadIds.push(downloadId)

        // Build M3U track entry using the playlist track template
        const position = String(i + 1).padStart(2, '0')
        const artistName = track.artist?.name || 'Unknown Artist'
        const trackTitle = track.title || 'Unknown Track'
        const template = this.settings.playlistTrackTemplate || '%position% - %artist% - %title%'
        const fileName = template
          .replace(/%position%/g, position)
          .replace(/%artist%/g, artistName)
          .replace(/%title%/g, trackTitle)
          .replace(/[<>:"/\\|?*]/g, '_') // Remove invalid filename chars

        m3uTracks.push({
          duration: track.duration || 0,
          artist: artistName,
          title: trackTitle,
          relativePath: `${playlistName}/${fileName}${fileExt}`
        })
      }

      // Generate M3U playlist file if setting is enabled
      if (this.settings.createPlaylistFile && m3uTracks.length > 0) {
        try {
          downloader.generateM3U(playlistName, this.settings.downloadPath, m3uTracks)
        } catch (err: any) {
          console.error('[Server] M3U generation failed:', err.message)
          // Don't fail the whole request, just log the error
        }
      }

      this.sendJSON(res, { ids: downloadIds, count: downloadIds.length })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  /**
   * Batch download endpoint — accepts an array of Deezer track IDs with optional
   * playlist context. Used by the Link Analyzer when downloading converted Spotify
   * playlists. Returns a single set of download IDs that the client tracks as one
   * playlist-like download item, avoiding hundreds of individual API calls.
   */
  private async handleDownloadBatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deezerAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Authentication required' }, 401)
      return
    }

    const body = await this.parseBody(req)
    const trackIds: number[] = (Array.isArray(body.trackIds) ? body.trackIds : [])
      .map((id: any) => validateNumericId(id))
      .filter((id: number | null): id is number => id !== null)
    const playlistName = typeof body.playlistName === 'string' ? body.playlistName.trim() : ''

    if (trackIds.length === 0) {
      this.sendJSON(res, { error: 'At least one valid track ID is required' }, 400)
      return
    }

    if (!validateDownloadPath(this.settings.downloadPath)) {
      this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
      return
    }

    const isPlaylist = !!playlistName
    console.log(`[Server] Batch download: ${trackIds.length} tracks${isPlaylist ? `, playlist: "${playlistName}"` : ''}`)

    try {
      const downloadIds: string[] = []

      for (let i = 0; i < trackIds.length; i++) {
        const downloadId = await downloader.download({
          trackId: trackIds[i],
          outputPath: this.settings.downloadPath,
          quality: this.settings.quality,
          bitrateFallback: this.settings.bitrateFallback,
          createFolders: true,
          artistFolder: this.settings.createArtistFolder,
          albumFolder: this.settings.createAlbumFolder,
          saveArtwork: this.settings.saveArtwork,
          embedArtwork: this.settings.embedArtwork,
          saveLyrics: this.settings.saveLyrics,
          syncedLyrics: this.settings.syncedLyrics,
          isSingle: !isPlaylist,
          isFromPlaylist: isPlaylist || undefined,
          playlistName: playlistName || undefined,
          playlistPosition: isPlaylist ? i + 1 : undefined,
          playlistContext: isPlaylist ? { playlistId: 0, playlistName } : undefined,
          savePlaylistAsCompilation: isPlaylist ? this.settings.savePlaylistAsCompilation : undefined,
          folderSettings: {
            createPlaylistFolder: this.settings.createPlaylistFolder,
            createArtistFolder: this.settings.createArtistFolder,
            createAlbumFolder: this.settings.createAlbumFolder,
            createCDFolder: this.settings.createCDFolder,
            createPlaylistStructure: this.settings.createPlaylistStructure,
            createSinglesStructure: this.settings.createSinglesStructure,
            playlistFolderTemplate: this.settings.playlistFolderTemplate,
            albumFolderTemplate: this.settings.albumFolderTemplate,
            artistFolderTemplate: this.settings.artistFolderTemplate
          },
          trackTemplates: {
            trackNameTemplate: this.settings.trackNameTemplate,
            albumTrackTemplate: this.settings.albumTrackTemplate,
            playlistTrackTemplate: this.settings.playlistTrackTemplate
          },
          metadataSettings: {
            tags: this.settings.tags,
            albumCovers: this.settings.albumCovers,
            useNullSeparator: this.settings.useNullSeparator,
            saveID3v1: this.settings.saveID3v1,
            saveOnlyMainArtist: this.settings.saveOnlyMainArtist,
            artistSeparator: this.settings.artistSeparator,
            dateFormatFlac: this.settings.dateFormatFlac,
            titleCasing: this.settings.titleCasing,
            artistCasing: this.settings.artistCasing,
            removeAlbumVersion: this.settings.removeAlbumVersion,
            featuredArtistsHandling: this.settings.featuredArtistsHandling,
            keepVariousArtists: this.settings.keepVariousArtists,
            removeArtistCombinations: this.settings.removeArtistCombinations
          },
          createErrorLog: this.settings.createErrorLog
        })
        downloadIds.push(downloadId)
      }

      // Generate M3U playlist file if setting is enabled and this is a playlist
      if (isPlaylist && this.settings.createPlaylistFile && downloadIds.length > 0) {
        try {
          const fileExt = this.settings.quality === 'FLAC' ? '.flac' : '.mp3'
          const m3uTracks = trackIds.map((_, i) => {
            const position = String(i + 1).padStart(2, '0')
            const template = this.settings.playlistTrackTemplate || '%position% - %artist% - %title%'
            const fileName = template
              .replace(/%position%/g, position)
              .replace(/%artist%/g, 'Unknown Artist')
              .replace(/%title%/g, 'Unknown Track')
              .replace(/[<>:"/\\|?*]/g, '_')
            return {
              duration: 0,
              artist: 'Unknown Artist',
              title: 'Unknown Track',
              relativePath: `${playlistName}/${fileName}${fileExt}`
            }
          })
          downloader.generateM3U(playlistName, this.settings.downloadPath, m3uTracks)
        } catch (err: any) {
          console.error('[Server] M3U generation failed:', err.message)
        }
      }

      this.sendJSON(res, { ids: downloadIds, count: downloadIds.length })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private handleGetQueue(res: ServerResponse): void {
    const queue = downloader.getAllProgress()
    // Debug: Log status summary
    const statusSummary = queue.reduce((acc: any, q) => {
      acc[q.status] = (acc[q.status] || 0) + 1
      return acc
    }, {})
    console.log(`[Server] /api/queue: returning ${queue.length} items, statuses:`, statusSummary)
    this.sendJSON(res, { queue })
  }

  private async handleCancelDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req)
    const { id } = body

    if (!id) {
      this.sendJSON(res, { error: 'Download ID is required' }, 400)
      return
    }

    downloader.cancelDownload(id)
    this.sendJSON(res, { success: true })
  }

  private handlePauseQueue(res: ServerResponse): void {
    downloader.pauseQueue()
    const status = downloader.getQueueStatus()
    console.log('[Server] Queue paused:', status)
    this.sendJSON(res, { success: true, ...status })
  }

  private handleResumeQueue(res: ServerResponse): void {
    downloader.resumeQueue()
    const status = downloader.getQueueStatus()
    console.log('[Server] Queue resumed:', status)
    this.sendJSON(res, { success: true, ...status })
  }

  private handleQueueStatus(res: ServerResponse): void {
    const status = downloader.getQueueStatus()
    this.sendJSON(res, status)
  }

  private async handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      this.sendJSON(res, this.settings)
    } else if (req.method === 'POST' || req.method === 'PUT') {
      const body = await this.parseBody(req)

      // Security: Validate and sanitize settings
      const validatedSettings: Partial<ServerSettings> = {}

      // Validate download path
      if (body.downloadPath !== undefined && body.downloadPath !== null && body.downloadPath !== '') {
        if (typeof body.downloadPath === 'string' && validateDownloadPath(body.downloadPath)) {
          validatedSettings.downloadPath = body.downloadPath
        } else {
          console.warn('[Security] Invalid download path rejected:', body.downloadPath)
        }
      }

      // Validate quality
      if (body.quality !== undefined) {
        validatedSettings.quality = validateQuality(body.quality)
      }

      // Validate maxConcurrentDownloads (must be between 1 and 50)
      if (body.maxConcurrentDownloads !== undefined) {
        const concurrent = parseInt(body.maxConcurrentDownloads, 10)
        if (!isNaN(concurrent) && concurrent >= 1 && concurrent <= 50) {
          validatedSettings.maxConcurrentDownloads = concurrent
        }
      }

      // Validate overwriteFiles setting
      if (body.overwriteFiles !== undefined) {
        const validModes = ['no', 'overwrite', 'rename']
        if (validModes.includes(body.overwriteFiles)) {
          validatedSettings.overwriteFiles = body.overwriteFiles
        }
      }

      // Validate boolean settings
      const booleanSettings: (keyof ServerSettings)[] = [
        // Download behavior
        'bitrateFallback', 'searchFallback', 'isrcFallback',
        'createErrorLog', 'createSearchLog', 'gambleCDNs',
        'createLrcFiles', 'createPlaylistFile', 'clearQueueOnClose',
        // Folder settings
        'createPlaylistFolder', 'createArtistFolder', 'createAlbumFolder',
        'createCDFolder', 'createPlaylistStructure', 'createSinglesStructure',
        // File settings
        'saveArtwork', 'embedArtwork', 'saveLyrics', 'syncedLyrics'
      ]

      for (const key of booleanSettings) {
        if (body[key] !== undefined && typeof body[key] === 'boolean') {
          (validatedSettings as any)[key] = body[key]
        }
      }

      // Validate folder and track template strings (only allow safe template patterns)
      const templateSettings: (keyof ServerSettings)[] = [
        'playlistFolderTemplate', 'albumFolderTemplate', 'artistFolderTemplate',
        'trackNameTemplate', 'albumTrackTemplate', 'playlistTrackTemplate'
      ]

      for (const key of templateSettings) {
        if (body[key] !== undefined && typeof body[key] === 'string') {
          // Sanitize template - only allow alphanumeric, spaces, dashes, and %variable% patterns
          const template = sanitizeString(body[key], 100)
          // Ensure no path traversal in templates
          if (!template.includes('..') && !template.includes('/') && !template.includes('\\')) {
            (validatedSettings as any)[key] = template
          }
        }
      }

      // Validate tags settings (nested object with boolean values)
      if (body.tags !== undefined && typeof body.tags === 'object' && body.tags !== null) {
        const tagKeys: (keyof TagSettings)[] = [
          'title', 'artist', 'album', 'cover', 'trackNumber', 'trackTotal',
          'discNumber', 'discTotal', 'albumArtist', 'genre', 'year', 'date',
          'explicitLyrics', 'isrc', 'trackLength', 'albumBarcode', 'bpm',
          'replayGain', 'albumLabel', 'unsyncLyrics', 'syncLyrics', 'copyright',
          'composer', 'involvedPeople', 'sourceId'
        ]
        const validatedTags: Partial<TagSettings> = {}
        for (const key of tagKeys) {
          if (body.tags[key] !== undefined && typeof body.tags[key] === 'boolean') {
            validatedTags[key] = body.tags[key]
          }
        }
        if (Object.keys(validatedTags).length > 0) {
          validatedSettings.tags = { ...this.settings.tags, ...validatedTags }
        }
      }

      // Validate albumCovers settings (nested object)
      if (body.albumCovers !== undefined && typeof body.albumCovers === 'object' && body.albumCovers !== null) {
        const validatedAlbumCovers: Partial<AlbumCoverSettings> = {}

        // Boolean settings
        const albumCoverBooleans: (keyof AlbumCoverSettings)[] = [
          'saveCovers', 'saveArtistImage', 'saveEmbeddedArtworkAsPNG', 'coverDescriptionUTF8'
        ]
        for (const key of albumCoverBooleans) {
          if (body.albumCovers[key] !== undefined && typeof body.albumCovers[key] === 'boolean') {
            (validatedAlbumCovers as any)[key] = body.albumCovers[key]
          }
        }

        // String settings
        if (body.albumCovers.coverNameTemplate !== undefined && typeof body.albumCovers.coverNameTemplate === 'string') {
          validatedAlbumCovers.coverNameTemplate = sanitizeString(body.albumCovers.coverNameTemplate, 100)
        }

        // Number settings
        if (body.albumCovers.localArtworkSize !== undefined) {
          const size = parseInt(body.albumCovers.localArtworkSize, 10)
          if (!isNaN(size) && size >= 100 && size <= 3000) {
            validatedAlbumCovers.localArtworkSize = size
          }
        }
        if (body.albumCovers.embeddedArtworkSize !== undefined) {
          const size = parseInt(body.albumCovers.embeddedArtworkSize, 10)
          if (!isNaN(size) && size >= 100 && size <= 3000) {
            validatedAlbumCovers.embeddedArtworkSize = size
          }
        }
        if (body.albumCovers.jpegImageQuality !== undefined) {
          const quality = parseInt(body.albumCovers.jpegImageQuality, 10)
          if (!isNaN(quality) && quality >= 1 && quality <= 100) {
            validatedAlbumCovers.jpegImageQuality = quality
          }
        }

        // Enum settings
        if (body.albumCovers.localArtworkFormat !== undefined) {
          const validFormats: LocalArtworkFormat[] = ['jpeg', 'png', 'both']
          if (validFormats.includes(body.albumCovers.localArtworkFormat)) {
            validatedAlbumCovers.localArtworkFormat = body.albumCovers.localArtworkFormat
          }
        }

        if (Object.keys(validatedAlbumCovers).length > 0) {
          validatedSettings.albumCovers = { ...this.settings.albumCovers, ...validatedAlbumCovers }
        }
      }

      // Validate Other settings - boolean checkboxes
      const otherBooleanSettings: (keyof ServerSettings)[] = [
        'checkForUpdates', 'savePlaylistAsCompilation', 'useNullSeparator',
        'saveID3v1', 'saveOnlyMainArtist', 'keepVariousArtists',
        'removeAlbumVersion', 'removeArtistCombinations'
      ]

      for (const key of otherBooleanSettings) {
        if (body[key] !== undefined && typeof body[key] === 'boolean') {
          (validatedSettings as any)[key] = body[key]
        }
      }

      // Validate artistSeparator
      if (body.artistSeparator !== undefined) {
        const validSeparators: ArtistSeparator[] = ['standard', 'comma', 'slash', 'semicolon', 'ampersand']
        if (validSeparators.includes(body.artistSeparator)) {
          validatedSettings.artistSeparator = body.artistSeparator
        }
      }

      // Validate dateFormatFlac
      if (body.dateFormatFlac !== undefined) {
        const validFormats: DateFormat[] = ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY']
        if (validFormats.includes(body.dateFormatFlac)) {
          validatedSettings.dateFormatFlac = body.dateFormatFlac
        }
      }

      // Validate featuredArtistsHandling
      if (body.featuredArtistsHandling !== undefined) {
        const validHandling: FeaturedArtistsHandling[] = ['nothing', 'remove', 'moveToTitle', 'removeFromTitle']
        if (validHandling.includes(body.featuredArtistsHandling)) {
          validatedSettings.featuredArtistsHandling = body.featuredArtistsHandling
        }
      }

      // Validate titleCasing
      if (body.titleCasing !== undefined) {
        const validCasing: CasingOption[] = ['unchanged', 'lowercase', 'uppercase', 'titlecase', 'sentencecase']
        if (validCasing.includes(body.titleCasing)) {
          validatedSettings.titleCasing = body.titleCasing
        }
      }

      // Validate artistCasing
      if (body.artistCasing !== undefined) {
        const validCasing: CasingOption[] = ['unchanged', 'lowercase', 'uppercase', 'titlecase', 'sentencecase']
        if (validCasing.includes(body.artistCasing)) {
          validatedSettings.artistCasing = body.artistCasing
        }
      }

      // Validate previewVolume (0-100)
      if (body.previewVolume !== undefined) {
        const volume = parseInt(body.previewVolume, 10)
        if (!isNaN(volume) && volume >= 0 && volume <= 100) {
          validatedSettings.previewVolume = volume
        }
      }

      // NOTE: executeAfterDownload has been removed for security reasons
      // Arbitrary command execution is a significant security risk

      console.log('[Server] Updating settings (validated):', validatedSettings)
      this.settings = { ...this.settings, ...validatedSettings }
      console.log('[Server] Current download path:', this.settings.downloadPath)

      // Apply concurrent downloads setting to downloader
      if (validatedSettings.maxConcurrentDownloads !== undefined) {
        downloader.setMaxConcurrent(this.settings.maxConcurrentDownloads)
      }

      this.sendJSON(res, { success: true, settings: this.settings })
    }
  }

  /**
   * Handles chart requests
   * Country ID "0" uses /chart/0/{type} for worldwide charts
   * Country ID "playlist:{id}" uses playlist tracks for country-specific charts
   */
  private async handleChart(url: URL, res: ServerResponse): Promise<void> {
    const type = url.searchParams.get('type') || 'tracks'
    const countryId = url.searchParams.get('country') || '0' // 0 = worldwide
    const limit = parseInt(url.searchParams.get('limit') || '100', 10)

    try {
      // For worldwide charts (ID 0), use the public chart API
      if (countryId === '0') {
        const response = await this.deezerPublicAPI(`/chart/0/${type}?limit=${limit}`)
        this.sendJSON(res, response)
        return
      }

      // For country-specific charts, the countryId is actually a playlist ID
      // Fetch tracks from the country's chart playlist
      if (type === 'tracks') {
        const response = await this.deezerPublicAPI(`/playlist/${countryId}/tracks?limit=${limit}`)
        this.sendJSON(res, response)
      } else {
        // For albums/artists/playlists, country charts only have tracks
        // Return empty array for non-track types on country charts
        this.sendJSON(res, { data: [], total: 0 })
      }
    } catch (error: any) {
      console.error('[Server] Chart fetch error:', error.message)
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  // Cache for chart countries (refreshed every 24 hours)
  private chartCountriesCache: { data: any[]; timestamp: number } | null = null
  private readonly CHART_COUNTRIES_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

  /**
   * Returns the list of countries with chart playlist IDs
   * Fetches from Deezer Charts user's playlists (user ID 637006841)
   */
  private async handleChartCountries(res: ServerResponse): Promise<void> {
    try {
      // Check cache first
      if (this.chartCountriesCache &&
          Date.now() - this.chartCountriesCache.timestamp < this.CHART_COUNTRIES_CACHE_TTL) {
        this.sendJSON(res, this.chartCountriesCache.data)
        return
      }

      // Fetch playlists from Deezer Charts user
      const DEEZER_CHARTS_USER_ID = 637006841
      const response = await this.deezerPublicAPI(`/user/${DEEZER_CHARTS_USER_ID}/playlists?limit=200`)

      if (!response?.data) {
        throw new Error('Failed to fetch chart playlists')
      }

      // Country code mapping for common countries
      const countryCodeMap: Record<string, string> = {
        'Algeria': 'DZ', 'Argentina': 'AR', 'Australia': 'AU', 'Austria': 'AT',
        'Belgium': 'BE', 'Brazil': 'BR', 'Bulgaria': 'BG', 'Canada': 'CA',
        'Chile': 'CL', 'Colombia': 'CO', 'Costa Rica': 'CR', 'Croatia': 'HR',
        'Czech Republic': 'CZ', 'Denmark': 'DK', 'Ecuador': 'EC', 'Egypt': 'EG',
        'Finland': 'FI', 'France': 'FR', 'Germany': 'DE', 'Greece': 'GR',
        'Guatemala': 'GT', 'Honduras': 'HN', 'Hungary': 'HU', 'India': 'IN',
        'Indonesia': 'ID', 'Ireland': 'IE', 'Israel': 'IL', 'Italy': 'IT',
        'Japan': 'JP', 'Jordan': 'JO', 'Kuwait': 'KW', 'Lebanon': 'LB',
        'Malaysia': 'MY', 'Mexico': 'MX', 'Morocco': 'MA', 'Netherlands': 'NL',
        'New Zealand': 'NZ', 'Norway': 'NO', 'Panama': 'PA', 'Peru': 'PE',
        'Philippines': 'PH', 'Poland': 'PL', 'Portugal': 'PT', 'Qatar': 'QA',
        'Romania': 'RO', 'Russia': 'RU', 'Saudi Arabia': 'SA', 'Serbia': 'RS',
        'Singapore': 'SG', 'Slovakia': 'SK', 'Slovenia': 'SI', 'South Africa': 'ZA',
        'South Korea': 'KR', 'Spain': 'ES', 'Sweden': 'SE', 'Switzerland': 'CH',
        'Taiwan': 'TW', 'Thailand': 'TH', 'Tunisia': 'TN', 'Turkey': 'TR',
        'Ukraine': 'UA', 'United Arab Emirates': 'AE', 'UK': 'GB',
        'United Kingdom': 'GB', 'USA': 'US', 'United States': 'US', 'Vietnam': 'VN',
        'Ivory Coast': 'CI', 'Senegal': 'SN', 'Cameroon': 'CM', 'Nigeria': 'NG',
        'Kenya': 'KE', 'Ghana': 'GH', 'Tanzania': 'TZ', 'Uganda': 'UG'
      }

      // Parse playlists to extract country charts
      // Filter for "Top [Country]" pattern, excluding year-specific ones like "Top USA 2025"
      const countries: { id: string; name: string; code: string }[] = [
        { id: '0', name: 'Worldwide', code: 'WW' }
      ]

      for (const playlist of response.data) {
        const title = playlist.title as string

        // Match "Top [Country]" pattern but not "Top [Country] [Year]" or other variations
        const topMatch = title.match(/^Top\s+(.+?)$/i)
        if (topMatch) {
          const countryName = topMatch[1].trim()

          // Skip if it contains a year (like "Top USA 2025") or special chars
          if (/\d{4}/.test(countryName) || countryName.includes('|') || countryName.includes('-')) {
            continue
          }

          // Get country code
          const code = countryCodeMap[countryName] || countryName.substring(0, 2).toUpperCase()

          // Avoid duplicates
          if (!countries.find(c => c.name === countryName)) {
            countries.push({
              id: String(playlist.id), // Playlist ID
              name: countryName,
              code
            })
          }
        }
      }

      // Sort by name (keeping Worldwide first)
      const sortedCountries = [
        countries[0], // Worldwide stays first
        ...countries.slice(1).sort((a, b) => a.name.localeCompare(b.name))
      ]

      // Cache the result
      this.chartCountriesCache = {
        data: sortedCountries,
        timestamp: Date.now()
      }

      console.log(`[Server] Loaded ${sortedCountries.length} chart countries from Deezer`)
      this.sendJSON(res, sortedCountries)
    } catch (error: any) {
      console.error('[Server] Failed to fetch chart countries:', error.message)

      // Fallback to just worldwide
      this.sendJSON(res, [{ id: '0', name: 'Worldwide', code: 'WW' }])
    }
  }

  private async handleEditorialReleases(url: URL, res: ServerResponse): Promise<void> {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10)
    const genre = url.searchParams.get('genre') || '0' // 0 = all genres

    try {
      // Deezer editorial releases endpoint returns new album releases
      const response = await this.deezerPublicAPI(`/editorial/${genre}/releases?limit=${limit}`)
      this.sendJSON(res, response)
    } catch (error: any) {
      this.sendJSON(res, { error: error.message }, 500)
    }
  }

  private async handleAnalyze(url: URL, res: ServerResponse): Promise<void> {
    const rawUrl = url.searchParams.get('url')

    if (!rawUrl) {
      this.sendJSON(res, { error: 'URL parameter is required' }, 400)
      return
    }

    // Parse the Deezer URL to extract type and ID
    const parsed = this.parseDeezerUrl(rawUrl)

    if (!parsed) {
      this.sendJSON(res, { error: 'Invalid or unsupported Deezer URL' }, 400)
      return
    }

    try {
      let data: any = null
      let additionalInfo: any = {}

      switch (parsed.type) {
        case 'track':
          data = await this.deezerPublicAPI(`/track/${parsed.id}`)
          // Track-specific fields: ISRC, readable, available
          additionalInfo = {
            isrc: data.isrc || null,
            readable: data.readable ?? null,
            available: data.readable ?? null, // In public API, readable indicates availability
            bpm: data.bpm || null,
            gain: data.gain || null,
            countries: [] as string[]
          }

          // If authenticated, fetch additional data from private API (includes countries)
          console.log('[Server] Auth status for analyze:', deezerAuth.isLoggedIn())
          if (deezerAuth.isLoggedIn()) {
            try {
              const privateTrackInfo = await deezerAuth.getTrackInfo(parsed.id)
              let countries: string[] = []

              // More accurate availability info from file sizes
              if (privateTrackInfo) {
                if (privateTrackInfo.FILESIZE_MP3_128 || privateTrackInfo.FILESIZE_MP3_320 || privateTrackInfo.FILESIZE_FLAC) {
                  additionalInfo.available = true
                }
              }

              // Try song.getListData which may have country data
              try {
                const listData = await deezerAuth.getTrackListData([parsed.id])
                console.log('[Server] song.getListData result keys:', Object.keys(listData || {}))
                if (listData?.data?.[0]) {
                  const trackData = listData.data[0]
                  console.log('[Server] Track from getListData keys:', Object.keys(trackData))
                  // Check for country fields
                  if (Array.isArray(trackData.AVAILABLE_COUNTRIES)) {
                    countries = trackData.AVAILABLE_COUNTRIES
                    console.log('[Server] Found countries from getListData:', countries.length)
                  }
                }
              } catch (listErr) {
                console.log('[Server] song.getListData failed:', listErr)
              }

              // If still no countries, try deezer.pageTrack
              if (countries.length === 0) {
                try {
                  const pageData = await deezerAuth.getTrackPage(parsed.id)
                  if (pageData) {
                    console.log('[Server] deezer.pageTrack result keys:', Object.keys(pageData))
                    // Log DATA keys to find country field
                    if (pageData.DATA) {
                      console.log('[Server] pageTrack.DATA keys:', Object.keys(pageData.DATA))
                      // Log any key that might be country-related
                      const dataKeys = Object.keys(pageData.DATA)
                      const countryKeys = dataKeys.filter(k =>
                        k.includes('COUNTRY') || k.includes('AVAILABLE') || k.includes('TERRIT') || k.includes('REGION')
                      )
                      console.log('[Server] Country-related keys in DATA:', countryKeys)
                      for (const key of countryKeys) {
                        console.log(`[Server] DATA.${key}:`, JSON.stringify(pageData.DATA[key])?.substring(0, 500))
                      }
                    }
                    // Look for country data in various locations
                    // AVAILABLE_COUNTRIES is an object with STREAM_ADS and STREAM_SUB_ONLY arrays
                    if (pageData.DATA?.AVAILABLE_COUNTRIES) {
                      const availCountries = pageData.DATA.AVAILABLE_COUNTRIES
                      if (typeof availCountries === 'object' && !Array.isArray(availCountries)) {
                        // Combine STREAM_ADS and STREAM_SUB_ONLY arrays
                        const streamAds = Array.isArray(availCountries.STREAM_ADS) ? availCountries.STREAM_ADS : []
                        const streamSub = Array.isArray(availCountries.STREAM_SUB_ONLY) ? availCountries.STREAM_SUB_ONLY : []
                        countries = [...new Set([...streamAds, ...streamSub])] // Remove duplicates
                        console.log('[Server] Found countries from pageTrack.DATA (combined):', countries.length)
                      } else if (Array.isArray(availCountries)) {
                        countries = availCountries
                        console.log('[Server] Found countries from pageTrack.DATA (array):', countries.length)
                      }
                    } else if (pageData.AVAILABLE_COUNTRIES) {
                      const availCountries = pageData.AVAILABLE_COUNTRIES
                      if (typeof availCountries === 'object' && !Array.isArray(availCountries)) {
                        const streamAds = Array.isArray(availCountries.STREAM_ADS) ? availCountries.STREAM_ADS : []
                        const streamSub = Array.isArray(availCountries.STREAM_SUB_ONLY) ? availCountries.STREAM_SUB_ONLY : []
                        countries = [...new Set([...streamAds, ...streamSub])]
                      } else if (Array.isArray(availCountries)) {
                        countries = availCountries
                      }
                      console.log('[Server] Found countries from pageTrack:', countries.length)
                    }
                  }
                } catch (pageErr) {
                  console.log('[Server] deezer.pageTrack failed:', pageErr)
                }
              }

              additionalInfo.countries = countries
              console.log('[Server] Final countries array length:', countries.length)
            } catch (err) {
              console.log('[Server] Could not fetch private track info:', err)
            }
          } else {
            console.log('[Server] Not logged in, skipping private API call for countries')
          }
          break

        case 'album':
          data = await this.deezerPublicAPI(`/album/${parsed.id}`)
          // Album-specific fields: UPC, label, track count
          additionalInfo = {
            upc: data.upc || null,
            label: data.label || null,
            trackCount: data.nb_tracks || 0,
            genres: data.genres?.data?.map((g: any) => g.name) || []
          }
          break

        case 'artist':
          data = await this.deezerPublicAPI(`/artist/${parsed.id}`)
          // Artist-specific fields: fan count, album count
          additionalInfo = {
            fanCount: data.nb_fan || 0,
            albumCount: data.nb_album || 0
          }
          break

        case 'playlist':
          data = await this.deezerPublicAPI(`/playlist/${parsed.id}`)
          // Playlist-specific fields: track count, duration, creator
          additionalInfo = {
            trackCount: data.nb_tracks || 0,
            totalDuration: data.duration || 0,
            creator: data.creator?.name || 'Unknown',
            isPublic: data.public ?? true
          }
          break

        default:
          this.sendJSON(res, { error: 'Unsupported content type' }, 400)
          return
      }

      // Check if content was found
      if (data.error) {
        this.sendJSON(res, { error: data.error.message || 'Content not found on Deezer' }, 404)
        return
      }

      // Build response with all metadata
      this.sendJSON(res, {
        type: parsed.type,
        id: parsed.id,
        data: data,
        ...additionalInfo
      })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to analyze link' }, 500)
    }
  }

  /**
   * Parse a Deezer URL to extract content type and ID
   * Supports formats:
   * - https://www.deezer.com/track/123456
   * - https://deezer.com/en/album/123456
   * - https://www.deezer.com/us/artist/123456
   * - deezer.page.link short URLs (returns null - would need redirect follow)
   */
  private parseDeezerUrl(url: string): { type: string; id: number } | null {
    try {
      // Clean and parse the URL
      const cleanUrl = url.trim()

      // Match standard Deezer URLs
      // Pattern: https://(www.)deezer.com(/lang)?/(track|album|artist|playlist)/ID
      const deezerPattern = /(?:https?:\/\/)?(?:www\.)?deezer\.com(?:\/[a-z]{2})?\/(track|album|artist|playlist)\/(\d+)/i
      const match = cleanUrl.match(deezerPattern)

      if (match) {
        return {
          type: match[1].toLowerCase(),
          id: parseInt(match[2], 10)
        }
      }

      // Also support bare IDs with type prefix (e.g., "track:123456")
      const barePattern = /^(track|album|artist|playlist):(\d+)$/i
      const bareMatch = cleanUrl.match(barePattern)

      if (bareMatch) {
        return {
          type: bareMatch[1].toLowerCase(),
          id: parseInt(bareMatch[2], 10)
        }
      }

      return null
    } catch {
      return null
    }
  }

  private async deezerPublicAPI(endpoint: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = `https://api.deezer.com${endpoint}`

      https.get(url, (response) => {
        let data = ''
        response.on('data', chunk => data += chunk)
        response.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error('Failed to parse API response'))
          }
        })
      }).on('error', reject)
    })
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = ''
      let size = 0

      // Security: Timeout for body parsing
      const timeout = setTimeout(() => {
        req.destroy()
        reject(new Error('Request timeout'))
      }, REQUEST_TIMEOUT)

      req.on('data', (chunk: Buffer) => {
        size += chunk.length

        // Security: Enforce body size limit
        if (size > MAX_BODY_SIZE) {
          clearTimeout(timeout)
          req.destroy()
          reject(new Error('Request body too large'))
          return
        }

        body += chunk
      })

      req.on('end', () => {
        clearTimeout(timeout)
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch (e) {
          resolve({})
        }
      })

      req.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private sendJSON(res: ServerResponse, data: any, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  // ==================== Spotify Handlers ====================

  private async handleSpotifyAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { clientId, clientSecret } = body

      if (!clientId || !clientSecret) {
        this.sendJSON(res, { error: 'Client ID and Client Secret are required' }, 400)
        return
      }

      // Set credentials and test authentication
      spotifyAPI.setCredentials(clientId, clientSecret)
      const success = await spotifyAPI.authenticate()

      if (success) {
        this.sendJSON(res, { success: true, message: 'Spotify authentication successful' })
      } else {
        this.sendJSON(res, { error: 'Invalid Spotify credentials' }, 401)
      }
    } catch (error: any) {
      console.error('[Server] Spotify auth error:', error.message)
      this.sendJSON(res, { error: error.message || 'Authentication failed' }, 500)
    }
  }

  private handleSpotifyStatus(res: ServerResponse): void {
    this.sendJSON(res, {
      configured: spotifyAPI.hasCredentials(),
      message: spotifyAPI.hasCredentials() ? 'Spotify is configured' : 'Spotify credentials not set'
    })
  }

  private async handleStaticFile(path: string, res: ServerResponse): Promise<void> {
    // Security: Prevent directory traversal
    const safePath = normalize(path).replace(/^(\.\.(\/|\\|$))+/, '')
    if (safePath !== path || path.includes('..')) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    // Map MIME types
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    }

    const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
    const contentType = mimeTypes[ext] || 'application/octet-stream'

    // Try multiple locations for the file
    // In production (asar), __dirname is like /path/to/app.asar/dist-electron
    // So we need to go up one level to get to app.asar root, then into public
    const appRoot = dirname(__dirname) // Goes from dist-electron to app root (or app.asar)
    const possiblePaths = [
      // In production (asar): app.asar/public/res/...
      join(appRoot, 'public', path),
      // In development: project root/public
      join(process.cwd(), 'public', path),
      // Also check dist folder (vite may copy public assets there)
      join(appRoot, 'dist', path)
    ]

    for (const filePath of possiblePaths) {
      try {
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath)
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400' // Cache for 1 day
          })
          res.end(data)
          return
        }
      } catch (e) {
        // Try next path
      }
    }

    res.writeHead(404)
    res.end('File not found')
  }

  private handleInfoSpotify(res: ServerResponse): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>How to Enable Spotify Features - Deemix Remastered</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e0e0e0;
      line-height: 1.6;
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      color: #1DB954;
      font-size: 2rem;
      margin-bottom: 30px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    h1 svg { width: 36px; height: 36px; }
    h2 {
      color: #fff;
      font-size: 1.4rem;
      margin: 30px 0 15px;
      padding-bottom: 8px;
      border-bottom: 2px solid #1DB954;
    }
    p { margin-bottom: 15px; color: #b0b0b0; }
    .info-box {
      background: rgba(29, 185, 84, 0.1);
      border-left: 4px solid #1DB954;
      padding: 15px 20px;
      margin: 20px 0;
      border-radius: 0 8px 8px 0;
    }
    .step {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 20px;
      margin: 15px 0;
    }
    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      background: #1DB954;
      color: #000;
      font-weight: bold;
      border-radius: 50%;
      margin-right: 10px;
    }
    .step img {
      max-width: 100%;
      border-radius: 8px;
      margin-top: 15px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    a {
      color: #1DB954;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 40px;
      padding: 10px 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 8px;
      transition: background 0.2s;
    }
    .back-link:hover {
      background: rgba(255,255,255,0.15);
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      <svg viewBox="0 0 24 24" fill="#1DB954">
        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
      </svg>
      How to Enable Spotify Features
    </h1>

    <p>"Spotify Features" is a set of features that lets you convert Spotify tracks and album links into Deezer ones.</p>
    <p>If you provide a Spotify Playlist link, the app will automatically convert all the tracks inside it into Deezer tracks.</p>
    <p>Enabling this set of features will let you see your public Spotify playlists in the favorites tab as well.</p>

    <div class="info-box">
      <strong>Note:</strong> For security reasons, you will need to provide your own Client ID and Client Secret.
    </div>

    <h2>How do I get my Client ID and Client Secret?</h2>

    <div class="step">
      <p><span class="step-number">1</span> Connect to <a href="https://developer.spotify.com/dashboard" target="_blank">Spotify for Developers Dashboard</a> and login with your Spotify account.</p>
    </div>

    <div class="step">
      <p><span class="step-number">2</span> Click on "Create app".</p>
      <img src="/res/InfoSpotifyFeatures/CreateApp.png" alt="Create an App button on Spotify for Developers Dashboard">
    </div>

    <div class="step">
      <p><span class="step-number">3</span> Fill out the "App name" and "App description" fields. For Redirect URI, enter <code>http://localhost</code>. Check the Web API checkbox, then click on the "Save" button.</p>
      <img src="/res/InfoSpotifyFeatures/CreateAppForm.png" alt="Create an app form">
    </div>

    <div class="step">
      <p><span class="step-number">4</span> Now you can see the Client ID. Click on "Settings" then "View client secret" to reveal the client secret.</p>
      <img src="/res/InfoSpotifyFeatures/ClientIdSecret.png" alt="Screen showing Client ID and Secret">
    </div>

    <div class="step">
      <p><span class="step-number">5</span> Now you can copy-paste those results into the appropriate fields in the Settings.</p>
    </div>

    <h2>How do I get my Spotify Username?</h2>

    <div class="step">
      <p><span class="step-number">1</span> You can get your Spotify Username from the <a href="https://www.spotify.com/account/overview/" target="_blank">Overview page</a> on Spotify's website.</p>
    </div>

    <a href="javascript:window.close()" class="back-link">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7"/>
      </svg>
      Close this page
    </a>
  </div>
</body>
</html>`

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  private async handleSpotifyAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { url } = body

      if (!url) {
        this.sendJSON(res, { error: 'URL is required' }, 400)
        return
      }

      if (!spotifyAPI.hasCredentials()) {
        this.sendJSON(res, { error: 'Spotify credentials not configured' }, 401)
        return
      }

      // Parse the URL
      const parsed = spotifyAPI.parseSpotifyUrl(url)
      if (!parsed) {
        this.sendJSON(res, { error: 'Invalid Spotify URL' }, 400)
        return
      }

      // Fetch content from Spotify
      let data: any
      let tracks: any[] = []

      switch (parsed.type) {
        case 'track':
          data = await spotifyAPI.getTrack(parsed.id)
          tracks = [data]
          break

        case 'album':
          data = await spotifyAPI.getAlbum(parsed.id)
          tracks = data.tracks?.items || []
          break

        case 'playlist':
          data = await spotifyAPI.getPlaylist(parsed.id)
          tracks = data.tracks?.items?.map((item: any) => item.track).filter(Boolean) || []
          break

        case 'artist':
          data = await spotifyAPI.getArtist(parsed.id)
          // Also get top tracks
          const topTracks = await spotifyAPI.getArtistTopTracks(parsed.id)
          tracks = topTracks
          data.topTracks = topTracks
          break

        default:
          this.sendJSON(res, { error: 'Unsupported content type' }, 400)
          return
      }

      this.sendJSON(res, {
        type: parsed.type,
        id: parsed.id,
        data,
        trackCount: tracks.length
      })
    } catch (error: any) {
      console.error('[Server] Spotify analyze error:', error.message)
      this.sendJSON(res, { error: error.message || 'Failed to analyze Spotify URL' }, 500)
    }
  }

  private async handleSpotifyConvert(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { type, id, fallbackSearch = true } = body

      if (!type || !id) {
        this.sendJSON(res, { error: 'Type and ID are required' }, 400)
        return
      }

      if (!spotifyAPI.hasCredentials()) {
        this.sendJSON(res, { error: 'Spotify credentials not configured' }, 401)
        return
      }

      if (!deezerAuth.isLoggedIn()) {
        this.sendJSON(res, { error: 'Deezer authentication required' }, 401)
        return
      }

      // Configure converter
      spotifyConverter.setFallbackSearch(fallbackSearch)

      let result: any

      switch (type) {
        case 'track': {
          const track = await spotifyAPI.getTrack(id)
          const match = await spotifyConverter.convertTrack(track)
          result = {
            matched: match.deezerTrack ? [match] : [],
            unmatched: match.deezerTrack ? [] : [track],
            matchRate: match.deezerTrack ? 100 : 0
          }
          break
        }

        case 'album': {
          const album = await spotifyAPI.getAlbum(id)
          result = await spotifyConverter.convertAlbum(album)
          break
        }

        case 'playlist': {
          const playlist = await spotifyAPI.getPlaylist(id)
          result = await spotifyConverter.convertPlaylist(playlist)
          break
        }

        case 'artist': {
          const topTracks = await spotifyAPI.getArtistTopTracks(id)
          result = await spotifyConverter.convertTracks(topTracks)
          break
        }

        default:
          this.sendJSON(res, { error: 'Unsupported content type' }, 400)
          return
      }

      this.sendJSON(res, {
        matched: result.matched.map((m: any) => ({
          spotify: {
            id: m.spotifyTrack.id,
            name: m.spotifyTrack.name,
            artist: m.spotifyTrack.artists[0]?.name,
            album: m.spotifyTrack.album?.name
          },
          deezer: m.deezerTrack ? {
            id: m.deezerTrack.id,
            title: m.deezerTrack.title,
            artist: m.deezerTrack.artist || { id: 0, name: 'Unknown Artist' },
            album: m.deezerTrack.album || { id: 0, title: '', cover_medium: '' },
            duration: m.deezerTrack.duration || 0
          } : null,
          matchType: m.matchType,
          confidence: m.confidence
        })),
        unmatched: result.unmatched.map((t: any) => ({
          id: t.id,
          name: t.name,
          artist: t.artists[0]?.name,
          album: t.album?.name
        })),
        matchRate: result.matchRate,
        total: result.matched.length + result.unmatched.length
      })
    } catch (error: any) {
      console.error('[Server] Spotify convert error:', error.message)
      this.sendJSON(res, { error: error.message || 'Conversion failed' }, 500)
    }
  }

  // ==================== End Spotify Handlers ====================

  // ==================== Playlist Sync Handlers ====================

  private handleGetSyncPlaylists(res: ServerResponse): void {
    const playlists = playlistSync.getPlaylists()
    const activeSyncIds = playlistSync.getActiveSyncIds()
    this.sendJSON(res, { playlists, activeSyncIds })
  }

  private async handleAddSyncPlaylist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { source, sourcePlaylistId, sourcePlaylistName, sourcePlaylistUrl, schedule, downloadPath } = body

      if (!source || !sourcePlaylistId || !sourcePlaylistName) {
        this.sendJSON(res, { error: 'Missing required fields: source, sourcePlaylistId, sourcePlaylistName' }, 400)
        return
      }

      if (!['spotify', 'deezer'].includes(source)) {
        this.sendJSON(res, { error: 'Invalid source. Must be "spotify" or "deezer"' }, 400)
        return
      }

      const playlist = await playlistSync.addPlaylist({
        source,
        sourcePlaylistId: String(sourcePlaylistId),
        sourcePlaylistName: String(sourcePlaylistName),
        sourcePlaylistUrl: String(sourcePlaylistUrl || ''),
        schedule: schedule || '6h',
        downloadPath: downloadPath || this.settings.downloadPath || ''
      })

      this.sendJSON(res, { success: true, playlist })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to add playlist' }, 500)
    }
  }

  private async handleUpdateSyncPlaylist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id, ...updates } = body

      if (!id) {
        this.sendJSON(res, { error: 'Missing playlist id' }, 400)
        return
      }

      const playlist = await playlistSync.updatePlaylist(id, updates)
      if (!playlist) {
        this.sendJSON(res, { error: 'Playlist not found' }, 404)
        return
      }

      this.sendJSON(res, { success: true, playlist })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to update playlist' }, 500)
    }
  }

  private async handleDeleteSyncPlaylist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id } = body

      if (!id) {
        this.sendJSON(res, { error: 'Missing playlist id' }, 400)
        return
      }

      await playlistSync.removePlaylist(id)
      this.sendJSON(res, { success: true })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to delete playlist' }, 500)
    }
  }

  private async handleRunSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id } = body

      if (!id) {
        this.sendJSON(res, { error: 'Missing playlist id' }, 400)
        return
      }

      // Run sync in background, return immediately
      playlistSync.syncPlaylist(id).catch(err =>
        console.error(`[Server] Sync failed for ${id}:`, err)
      )

      this.sendJSON(res, { success: true, message: 'Sync started' })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to start sync' }, 500)
    }
  }

  private async handleRunSyncAll(res: ServerResponse): Promise<void> {
    playlistSync.syncAll().catch(err =>
      console.error('[Server] Sync all failed:', err)
    )
    this.sendJSON(res, { success: true, message: 'Sync all started' })
  }

  private async handleCancelSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id } = body

      if (!id) {
        this.sendJSON(res, { error: 'Missing playlist id' }, 400)
        return
      }

      playlistSync.cancelSync(id)
      this.sendJSON(res, { success: true })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to cancel sync' }, 500)
    }
  }

  private handleGetSyncStatus(res: ServerResponse): void {
    const playlists = playlistSync.getPlaylists()
    const activeSyncIds = playlistSync.getActiveSyncIds()
    this.sendJSON(res, { playlists, activeSyncIds })
  }

  private async handleResolveShareUrl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { url } = body
      if (!url) {
        this.sendJSON(res, { error: 'URL is required' }, 400)
        return
      }

      // Follow redirects to resolve share links to their final URL
      const resolvedUrl = await new Promise<string>((resolve, reject) => {
        const doRequest = (targetUrl: string, redirectCount: number) => {
          if (redirectCount > 5) {
            reject(new Error('Too many redirects'))
            return
          }
          const protocol = targetUrl.startsWith('https') ? https : http
          protocol.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response: any) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
              doRequest(response.headers.location, redirectCount + 1)
            } else {
              resolve(targetUrl)
            }
            response.resume() // Consume response to free memory
          }).on('error', reject)
        }
        doRequest(url, 0)
      })

      // Extract playlist ID from resolved URL
      const deezerMatch = resolvedUrl.match(/deezer\.com\/(?:\w+\/)?playlist\/(\d+)/)
      if (deezerMatch) {
        this.sendJSON(res, { playlistId: deezerMatch[1], source: 'deezer', resolvedUrl })
        return
      }

      const spotifyMatch = resolvedUrl.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/)
      if (spotifyMatch) {
        this.sendJSON(res, { playlistId: spotifyMatch[1], source: 'spotify', resolvedUrl })
        return
      }

      this.sendJSON(res, { error: 'Could not resolve URL to a playlist', resolvedUrl }, 400)
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to resolve URL' }, 500)
    }
  }

  // ==================== End Playlist Sync Handlers ====================

  updateSettings(settings: Partial<ServerSettings>): void {
    this.settings = { ...this.settings, ...settings }
  }

  getSettings(): ServerSettings {
    return this.settings
  }
}
