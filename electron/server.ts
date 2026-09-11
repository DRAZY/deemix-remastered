import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import * as http from 'http'
import { EventEmitter } from 'events'
import * as https from 'https'
import * as fs from 'fs'
import { normalize, resolve, join, dirname } from 'path'
import { app } from 'electron'
import { deezerAuth, DeezerSession } from './services/deezerAuth'
import { urlHasHost } from './utils/urlHost'
import { downloader, DownloadProgress } from './services/downloader'
import { spotifyAPI, describeSpotifyError, SpotifyContentsUnavailableError } from './services/spotifyAPI'
import { spotifyConverter } from './services/spotifyConverter'
import { qobuzAuth, QOBUZ_FORMAT } from './services/qobuzAuth'
import { playlistSync } from './services/playlistSync'
import { artistSync, type FirstSyncMode, type ArtistSyncFilters } from './services/artistSync'
import { scanFolder, retagFile, retagFileInFolder, type RetagFields } from './services/retagger'
import { libraryIndex } from './services/libraryIndex'
import { buildAlbumContext } from './services/albumContext'
import { fetchDeezerPublicJson, fetchDeezerPublicPaginated } from './services/deezerPublicApi'

/** Collapse newlines so remote-supplied text cannot forge extra log lines. */
const logSafe = (v: unknown): string => String(v ?? '').replace(/[\r\n]+/g, ' ')

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

// Bulk-sync batch cap — protects against megabatches that could push the
// body over MAX_BODY_SIZE. 500 favorites ≈ 100KB, well under both ceilings;
// libraries above this can chunk client-side without losing the bulk efficiency.
const MAX_BULK_ITEMS = 500

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

// Security: SSRF-safe redirect follower for share link resolution
// Only follows redirects to whitelisted domains, rejects private IPs and non-HTTP protocols
// 'deezer.page.link' is a legit Deezer share-link host that is NOT a .deezer.com
// subdomain — it must be allowlisted so the initial-URL check below doesn't reject
// real share links once we validate the first request (not just redirects).
const ALLOWED_REDIRECT_DOMAINS = ['.deezer.com', '.spotify.com', '.dzcdn.net', 'deezer.page.link']

function isRedirectSafe(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl)
    // Only allow http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    // Default ports only — an allowlisted host can't be used to poke at
    // arbitrary services on non-standard ports.
    if (parsed.port && parsed.port !== '80' && parsed.port !== '443') return false
    const hostname = parsed.hostname.toLowerCase()
    // Block private/internal IPs
    if (hostname === 'localhost' || hostname.startsWith('127.') ||
        hostname.startsWith('10.') || hostname.startsWith('192.168.') ||
        hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]' ||
        hostname.startsWith('169.254.') || hostname.startsWith('172.') ||
        hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return false
    }
    // Check 172.16-31.x range more precisely
    const parts = hostname.split('.')
    if (parts[0] === '172') {
      const second = parseInt(parts[1], 10)
      if (second >= 16 && second <= 31) return false
    }
    // Must match an allowed domain
    // Dotted entries ('.deezer.com') match subdomains via suffix; undotted
    // entries ('deezer.page.link') must match EXACTLY, so a hostile
    // 'evildeezer.page.link' can't satisfy the check.
    return ALLOWED_REDIRECT_DOMAINS.some(domain =>
      domain.startsWith('.') ? hostname.endsWith(domain) : hostname === domain
    )
  } catch {
    return false
  }
}

async function followRedirectsSafely(startUrl: string, maxRedirects: number = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const doRequest = (targetUrl: string, redirectCount: number) => {
      if (redirectCount > maxRedirects) {
        reject(new Error('Too many redirects'))
        return
      }
      // Validate EVERY hop including the initial request — the first URL is
      // user-provided (a pasted share link), so it must pass the allowlist too,
      // not just subsequent redirects. Closes the SSRF where a crafted initial
      // URL could be fetched server-side against localhost/LAN.
      if (!isRedirectSafe(targetUrl)) {
        reject(new Error('Request to disallowed destination blocked'))
        return
      }
      const protocol = targetUrl.startsWith('https') ? https : http
      protocol.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response: any) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          doRequest(response.headers.location, redirectCount + 1)
        } else {
          resolve(targetUrl)
        }
        response.resume()
      }).on('error', reject)
    }
    doRequest(startUrl, 0)
  })
}

// Security: Sanitize error messages to prevent internal detail leakage
// Preserves known user-facing messages, replaces unknown errors with generic text
const SAFE_ERROR_PATTERNS = [
  'Authentication required', 'Login failed', 'Invalid', 'not found',
  'not configured', 'required', 'expired', 'CAPTCHA', 'Rate limit',
  'not available', 'Failed to resolve', 'Too many redirects',
  'Redirect to disallowed', 'Unsupported', 'already', 'Maximum',
  'No Deezer match', 'Download failed', 'Conversion failed',
  'No tracks found', 'Album not available', 'data is not iterable',
  'Cannot read properties', 'Track not available', 'rights',
  // qobuzAuth crafts all its user-facing errors with a 'Qobuz' prefix
  // (e.g. 'Qobuz session expired — reconnect…') — pass them through intact
  // so the sanitizer only swallows raw system/network errors.
  'Qobuz'
]

function sanitizeErrorMessage(error: any, fallback: string = 'Internal server error'): string {
  const msg = error?.message || ''
  // If the message matches a known safe pattern, return it
  if (SAFE_ERROR_PATTERNS.some(pattern => msg.includes(pattern))) {
    return msg.substring(0, 200) // Truncate to prevent huge messages
  }
  // Log the real error server-side, return generic message to client
  console.error('[Server] Internal error (sanitized):', logSafe(msg))
  return fallback
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

// Qobuz ids are NOT numeric — album ids are alphanumeric slugs (e.g.
// 'aaflw06d21nuc'), track/artist/playlist ids are digits. Accept word chars +
// hyphens only, rejecting anything that could smuggle into a query string.
function validateQobuzId(id: any): string | null {
  const s = String(id ?? '').trim()
  return /^[\w-]{1,64}$/.test(s) ? s : null
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
      console.warn('[Security] Path is not absolute:', logSafe(pathStr))
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
      console.warn('[Security] Path is in blocked system directory:', logSafe(pathStr))
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
type ArtistSeparator = 'standard' | 'comma' | 'slash' | 'semicolon' | 'semicolonSpace' | 'ampersand'
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
  // Download pacing (issue #86): tiered — space out download starts to avoid bursty patterns
  downloadPacing: 'off' | 'balanced' | 'cautious'
  // Download behavior settings
  overwriteFiles: OverwriteMode
  // Opt-in: skip downloading a recording (by ISRC) already in the library (#91/#92)
  skipDuplicateTracks: boolean
  bitrateFallback: boolean
  isrcFallback: boolean
  createErrorLog: boolean
  createPlaylistFile: boolean
  createAlbumPlaylistFile: boolean
  clearQueueOnClose: boolean
  // Folder settings
  createPlaylistFolder: boolean
  createArtistFolder: boolean
  createAlbumFolder: boolean
  createCDFolder: boolean
  createPlaylistStructure: boolean
  createSinglesStructure: boolean
  createShortReleaseFolder: boolean
  playlistFolderTemplate: string
  albumFolderTemplate: string
  artistFolderTemplate: string
  // Track naming templates
  trackNameTemplate: string
  albumTrackTemplate: string
  playlistTrackTemplate: string
  m3uNameTemplate: string
  // File settings
  saveArtwork: boolean
  embedArtwork: boolean
  saveLyrics: boolean
  syncedLyrics: boolean
  preferSyncedLyrics: boolean
  deleteSupersededLyrics: boolean
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
    maxConcurrentDownloads: 5,
    downloadPacing: 'off',
    // Download behavior settings
    overwriteFiles: 'no',
    skipDuplicateTracks: false,
    bitrateFallback: true,
    isrcFallback: true,
    createErrorLog: true,
    createPlaylistFile: false,
    createAlbumPlaylistFile: true,
    clearQueueOnClose: false,
    // Folder settings
    createPlaylistFolder: true,
    createArtistFolder: false,
    createAlbumFolder: true,
    createCDFolder: true,
    createPlaylistStructure: false,
    createSinglesStructure: false,
    createShortReleaseFolder: true,
    playlistFolderTemplate: '%playlist%',
    albumFolderTemplate: '%artist% - %album%',
    artistFolderTemplate: '%artist%',
    // Track naming templates
    trackNameTemplate: '%artist% - %title%',
    albumTrackTemplate: '%tracknumber% - %title%',
    playlistTrackTemplate: '%position% - %artist% - %title%',
    m3uNameTemplate: '%playlist%',
    // File settings
    saveArtwork: true,
    embedArtwork: true,
    saveLyrics: true,
    syncedLyrics: true,
    // Off by default: turning it on changes which files an existing user gets,
    // so it is opt-in rather than a silent change to their library (#141).
    preferSyncedLyrics: false,
    deleteSupersededLyrics: false,
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
      sourceId: false,
      releaseType: true
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
      console.log('[Server] Auth expired event received:', logSafe(data.reason))
      this.emit('auth-expired', data)
    })

    // Forward Qobuz session expiry — separate channel from Deezer's so the
    // renderer never confuses which service died.
    qobuzAuth.on('auth-expired', (data) => {
      console.log('[Server] Qobuz auth expired event received:', data.reason)
      this.emit('qobuz-auth-expired', data)
    })

    // Forward session health updates for keep-alive monitoring
    deezerAuth.on('session-health', (data) => {
      this.emit('session-health', data)
    })
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        console.log(`[Server] ${logSafe(req.method)} ${logSafe(req.url)}`)

        this.handleRequest(req, res).catch(error => {
          console.error('[Server] Request error:', logSafe((error as any)?.message ?? error))
          // Always return JSON, even on error
          try {
            this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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
    // Note: Electron file:// sends Origin: "null" (string) or no origin header
    const origin = req.headers.origin || ''
    const allowedOrigins = [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      `http://localhost:${this.port}`,
      `http://127.0.0.1:${this.port}`
    ]
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    } else if (origin === '' || origin === 'null' || origin.startsWith('file://')) {
      // Electron production mode: file:// pages send "null" or empty origin
      // Safe because localhost binding already restricts access
      res.setHeader('Access-Control-Allow-Origin', '*')
    }
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

      case '/api/album/check':
        await this.handleCheckAlbumExists(url, res)
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

      case '/api/download/mixed-batch':
        await this.handleMixedBatchDownload(req, res)
        break

      case '/api/library/reindex':
        await this.handleLibraryReindex(req, res)
        break

      case '/api/queue':
        this.handleGetQueue(res)
        break

      case '/api/queue/cancel':
        await this.handleCancelDownload(req, res)
        break

      case '/api/queue/priority':
        await this.handleQueuePriority(req, res)
        break

      case '/api/queue/reorder':
        await this.handleQueueReorder(req, res)
        break

      case '/api/queue/clear':
        downloader.clearAll()
        this.sendJSON(res, { success: true })
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

      case '/api/new-releases':
        await this.handleNewReleases(url, res)
        break

      case '/api/user/playlists':
        await this.handleUserPlaylists(url, res)
        break

      case '/api/analyze':
        await this.handleAnalyze(url, res)
        break

      case '/api/user/favorites':
        await this.handleGetUserFavorites(url, res)
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

      case '/api/spotify/convert-progress':
        this.handleConversionProgress(url, res)
        break

      case '/info-spotify':
        this.handleInfoSpotify(res)
        break

      // --- Qobuz (WIP) ---
      case '/api/qobuz/session':
        await this.handleQobuzSession(req, res)
        break
      case '/api/qobuz/status':
        this.handleQobuzStatus(res)
        break
      case '/api/qobuz/search':
        await this.handleQobuzSearch(url, res)
        break
      case '/api/qobuz/analyze':
        await this.handleQobuzAnalyze(req, res)
        break
      case '/api/qobuz/artist':
        await this.handleQobuzArtist(url, res)
        break
      case '/api/qobuz/artist-top-tracks':
        await this.handleQobuzArtistTopTracks(url, res)
        break
      case '/api/qobuz/album':
        await this.handleQobuzAlbum(url, res)
        break
      case '/api/qobuz/playlist':
        await this.handleQobuzPlaylist(url, res)
        break
      case '/api/qobuz/discover':
        await this.handleQobuzDiscover(url, res)
        break
      case '/api/qobuz/genres':
        await this.handleQobuzGenres(url, res)
        break
      case '/api/qobuz/featured':
        await this.handleQobuzFeatured(url, res)
        break
      case '/api/deezer/genres':
        await this.handleDeezerGenres(res)
        break
      case '/api/deezer/genre-browse':
        await this.handleDeezerGenreBrowse(url, res)
        break
      case '/api/deezer/genre-chart':
        await this.handleDeezerGenreChart(url, res)
        break
      case '/api/qobuz/preview':
        await this.handleQobuzPreview(url, res)
        break
      case '/api/qobuz/download':
        await this.handleQobuzDownload(req, res)
        break
      case '/api/qobuz/download-batch':
        await this.handleQobuzDownloadBatch(req, res)
        break
      case '/api/qobuz/download-album':
        await this.handleQobuzDownloadAlbum(req, res)
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

      case '/api/sync/playlists/bulk':
        if (req.method === 'POST') {
          await this.handleAddSyncPlaylistsBulk(req, res)
        } else {
          res.writeHead(405)
          res.end('Method Not Allowed')
        }
        break

      case '/api/sync/playlists/restore':
        if (req.method === 'POST') {
          await this.handleRestoreSyncPlaylists(req, res)
        } else {
          res.writeHead(405)
          res.end('Method Not Allowed')
        }
        break

      case '/api/sync/run':
        await this.handleRunSync(req, res)
        break

      case '/api/sync/reset':
        await this.handleResetSync(req, res)
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

      // Artist Sync routes
      case '/api/sync/artists':
        if (req.method === 'GET') {
          this.handleGetSyncArtists(res)
        } else if (req.method === 'POST') {
          await this.handleAddSyncArtist(req, res)
        } else if (req.method === 'PUT') {
          await this.handleUpdateSyncArtist(req, res)
        } else if (req.method === 'DELETE') {
          await this.handleDeleteSyncArtist(req, res)
        }
        break

      case '/api/sync/artists/bulk':
        if (req.method === 'POST') {
          await this.handleAddSyncArtistsBulk(req, res)
        } else {
          res.writeHead(405)
          res.end('Method Not Allowed')
        }
        break

      case '/api/sync/artists/restore':
        if (req.method === 'POST') {
          await this.handleRestoreSyncArtists(req, res)
        } else {
          res.writeHead(405)
          res.end('Method Not Allowed')
        }
        break

      case '/api/sync/artists/run':
        await this.handleRunSyncArtist(req, res)
        break

      case '/api/sync/artists/run-all':
        await this.handleRunSyncArtistAll(res)
        break

      case '/api/sync/artists/reset':
        await this.handleResetSyncArtist(req, res)
        break

      case '/api/sync/artists/cancel':
        await this.handleCancelSyncArtist(req, res)
        break

      case '/api/sync/refresh-favorites':
        await this.handleRefreshFavoriteMembership(req, res)
        break

      // Retag routes — metadata-only rewrite of existing local files
      case '/api/retag/scan':
        await this.handleRetagScan(req, res)
        break

      case '/api/retag/file':
        await this.handleRetagFile(req, res)
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
      console.error('[Server] Login error:', logSafe(error.message))
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
      console.log('[Server] Attempting login with email:', logSafe(maskedEmail))
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
      console.error('[Server] Email login error:', logSafe(error.message))
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
      console.error('[Server] CAPTCHA login error:', logSafe(error.message))
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
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  private async handleCheckAlbumExists(url: URL, res: ServerResponse): Promise<void> {
    const rawId = url.searchParams.get('id')
    const id = validateNumericId(rawId)

    if (id === null) {
      this.sendJSON(res, { error: 'Valid Album ID is required' }, 400)
      return
    }

    try {
      const album = await this.deezerPublicAPI(`/album/${id}`)
      if (album.error) {
        this.sendJSON(res, { exists: false })
        return
      }

      // Build the expected folder path using the same logic as downloads
      const artistName = downloader.sanitizeFilename(album.artist?.name || 'Unknown Artist')
      const albumTitle = downloader.sanitizeFilename(album.title || 'Unknown Album')
      const basePath = this.settings.downloadPath

      // Check common folder patterns
      const candidatePaths = [
        join(basePath, `${artistName} - ${albumTitle}`),
        join(basePath, artistName, `${artistName} - ${albumTitle}`),
        join(basePath, `${artistName} - ${albumTitle} (Explicit)`),
        join(basePath, artistName, `${artistName} - ${albumTitle} (Explicit)`)
      ]

      let existingPath: string | null = null
      let existingTrackCount = 0

      for (const candidate of candidatePaths) {
        if (fs.existsSync(candidate)) {
          existingPath = candidate
          // Count audio files in the folder
          try {
            const files = fs.readdirSync(candidate)
            existingTrackCount = files.filter(f =>
              f.endsWith('.flac') || f.endsWith('.mp3')
            ).length
          } catch { /* ignore read errors */ }
          break
        }
      }

      this.sendJSON(res, {
        exists: !!existingPath,
        path: existingPath,
        trackCount: existingTrackCount,
        albumTracks: album.nb_tracks || 0
      })
    } catch (error: any) {
      this.sendJSON(res, { exists: false })
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
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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
    // Optional album context — the "Retry failed tracks" path for an album (#94)
    // sends the parent albumId so the retried track returns to its original album
    // folder instead of the root download folder. Playlist context takes precedence.
    const retryAlbumId = validateNumericId(body.albumId)

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
    // Rebuild album context for an album-track retry (skipped for playlist tracks,
    // which use playlist folders). Null-safe: an unavailable album falls back to
    // standalone-single behavior. albumTrackDisc preserves CD folders on multi-disc
    // albums by reusing the track's disk_number from the album's track list.
    let albumCtx: any = null
    let albumTrackDisc: number | undefined
    if (!isPlaylistTrack && retryAlbumId !== null) {
      const fetched = await this.fetchAlbumContext(retryAlbumId)
      if (fetched) {
        albumCtx = fetched.context
        albumTrackDisc = fetched.tracks.find((t: any) => t.id === trackId)?.disk_number
      }
    }
    console.log(`[Server] Download request - trackId: ${logSafe(trackId)}, quality: ${this.settings.quality}, path: ${this.settings.downloadPath}${isPlaylistTrack ? `, playlist: "${logSafe(playlistName)}"` : ''}${albumCtx ? `, album-retry: "${logSafe(albumCtx.albumTitle)}"` : ''}`)
    console.log(`[Server] Settings - embedArtwork: ${this.settings.embedArtwork}, saveArtwork: ${this.settings.saveArtwork}`)
    console.log(`[Server] Settings - tags.cover: ${this.settings.tags?.cover}, tags.title: ${this.settings.tags?.title}`)
    console.log(`[Server] Settings - albumCovers.embeddedArtworkSize: ${this.settings.albumCovers?.embeddedArtworkSize}`)
    console.log(`[Server] Settings - createArtistFolder: ${this.settings.createArtistFolder}, createAlbumFolder: ${this.settings.createAlbumFolder}, createSinglesStructure: ${this.settings.createSinglesStructure}, createShortReleaseFolder: ${this.settings.createShortReleaseFolder}`)

    try {
      // When playlistName is provided, treat as a playlist track (enables playlist
      // folders and playlist track naming). Otherwise treat as a standalone single.
      const downloadId = await downloader.download({
        trackId,
        outputPath: this.settings.downloadPath,
        quality: this.settings.quality,
        bitrateFallback: this.settings.bitrateFallback,
        isrcFallback: this.settings.isrcFallback,
        createFolders: true,
        artistFolder: this.settings.createArtistFolder,
        albumFolder: this.settings.createAlbumFolder,
        saveArtwork: this.settings.saveArtwork,
        embedArtwork: this.settings.embedArtwork,
        saveLyrics: this.settings.saveLyrics,
        syncedLyrics: this.settings.syncedLyrics,
        preferSyncedLyrics: this.settings.preferSyncedLyrics,
        deleteSupersededLyrics: this.settings.deleteSupersededLyrics,
        // An album retry is NOT a single — clear isSingle so the album folder and
        // album track template apply, matching the original album download (#94).
        isSingle: !isPlaylistTrack && !albumCtx,
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
          createShortReleaseFolder: this.settings.createShortReleaseFolder,
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
        // Album-retry context (#94): present only when albumId was supplied and the
        // album resolved. discNumber keeps multi-disc albums in their CD subfolder.
        albumContext: albumCtx || undefined,
        discNumber: albumCtx ? albumTrackDisc : undefined,
        skipDuplicateTracks: this.settings.skipDuplicateTracks,
        createErrorLog: this.settings.createErrorLog,
        overwriteMode: this.settings.overwriteFiles
      })

      this.sendJSON(res, { id: downloadId, status: 'queued' })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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

    // Per-request "Refresh tags" action: rewrite tags on existing files only,
    // no re-download. Overrides the global overwrite setting for this request.
    const overwriteMode = body.refreshTags === true ? 'refresh-tags' : this.settings.overwriteFiles

    // Security: Validate download path
    if (!validateDownloadPath(this.settings.downloadPath)) {
      this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
      return
    }

    try {
      // Get album info first (for consistent folder structure)
      const albumInfo = await this.deezerPublicAPI(`/album/${albumId}`)

      if (albumInfo.error) {
        this.sendJSON(res, { error: `Album not available: ${albumInfo.error.message || 'unknown error'}` }, 404)
        return
      }

      // Get album tracks — paginated to support albums with >500 tracks
      // (rare but possible for large compilations). Mirrors handlePlaylist.
      let allAlbumTracks: any[] = []
      let albumIndex = 0
      const albumBatchSize = 100
      while (albumIndex < 10000) {
        const tracksPage = await this.deezerPublicAPI(`/album/${albumId}/tracks?limit=${albumBatchSize}&index=${albumIndex}`)
        if (!tracksPage.data || tracksPage.data.length === 0) break
        allAlbumTracks = [...allAlbumTracks, ...tracksPage.data]
        if (!tracksPage.next) break
        albumIndex += albumBatchSize
      }

      if (allAlbumTracks.length === 0) {
        this.sendJSON(res, { error: 'No tracks found for this album' }, 404)
        return
      }

      const albumTracks = { data: allAlbumTracks }

      const downloadIds: string[] = []

      // Build album context for consistent folder naming. Single source of truth —
      // the per-track "Retry failed tracks" path (handleDownload, #94) rebuilds the
      // same context via fetchAlbumContext so retried tracks land in the same folder.
      const albumContext = buildAlbumContext(albumId, albumInfo, albumTracks.data)

      // Album M3U (#121, legacy deemix parity): when "create playlist file" is
      // on, generate an .m3u8 for the album too, written into the album folder.
      // Reuses the playlist M3U tracker; recording keys off _m3uTrackerId.
      //
      // Gated separately from playlists (#131). One checkbox used to mean both,
      // but the two are not equally useful: a playlist's M3U is the only record
      // of its ordering and selection, while an album's just restates the folder
      // and tags. Downloading a full discography wrote one file per album folder,
      // and library managers ingest each as its own playlist.
      const albumM3uId = `album_${albumId}_${Date.now()}`
      if (this.settings.createPlaylistFile && this.settings.createAlbumPlaylistFile) {
        downloader.registerPlaylistForM3U(albumM3uId, albumInfo.title || 'Album', this.settings.downloadPath, albumTracks.data.length, this.settings.m3uNameTemplate, 'album')
      }

      for (const track of albumTracks.data) {
        const downloadId = await downloader.download({
          trackId: track.id,
          outputPath: this.settings.downloadPath,
          quality: this.settings.quality,
          bitrateFallback: this.settings.bitrateFallback,
          isrcFallback: this.settings.isrcFallback,
          createFolders: true,
          artistFolder: this.settings.createArtistFolder,
          albumFolder: this.settings.createAlbumFolder,
          saveArtwork: this.settings.saveArtwork,
          embedArtwork: this.settings.embedArtwork,
          saveLyrics: this.settings.saveLyrics,
          syncedLyrics: this.settings.syncedLyrics,
          preferSyncedLyrics: this.settings.preferSyncedLyrics,
          deleteSupersededLyrics: this.settings.deleteSupersededLyrics,
          folderSettings: {
            createPlaylistFolder: this.settings.createPlaylistFolder,
            createArtistFolder: this.settings.createArtistFolder,
            createAlbumFolder: this.settings.createAlbumFolder,
            createCDFolder: this.settings.createCDFolder,
            createPlaylistStructure: this.settings.createPlaylistStructure,
            createSinglesStructure: this.settings.createSinglesStructure,
            createShortReleaseFolder: this.settings.createShortReleaseFolder,
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
          // #102/#103: authoritative position backstop for FALLBACK/ISRC
          // substitution — see DownloadOptions.trackNumber.
          trackNumber: track.track_position,
          albumContext: albumContext,
          skipDuplicateTracks: this.settings.skipDuplicateTracks,
          createErrorLog: this.settings.createErrorLog,
          overwriteMode,
          // Album M3U tracking (#121). playlistPosition orders the M3U entries;
          // for an album that's the track position. isFromPlaylist stays false
          // so no playlist folder is created.
          _m3uTrackerId: albumM3uId,
          playlistPosition: track.track_position
        })
        downloadIds.push(downloadId)
      }

      this.sendJSON(res, { ids: downloadIds, count: downloadIds.length })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  // Fetch an album and build its context + track list for the per-track retry
  // path (#94). Returns null when the album can't be fetched so the caller falls
  // back to standalone-single behavior rather than failing the retry.
  private async fetchAlbumContext(albumId: number): Promise<{ context: any; tracks: any[] } | null> {
    try {
      const albumInfo = await this.deezerPublicAPI(`/album/${albumId}`)
      if (!albumInfo || albumInfo.error) return null
      let tracks: any[] = []
      let index = 0
      const batchSize = 100
      while (index < 10000) {
        const page = await this.deezerPublicAPI(`/album/${albumId}/tracks?limit=${batchSize}&index=${index}`)
        if (!page.data || page.data.length === 0) break
        tracks = [...tracks, ...page.data]
        if (!page.next) break
        index += batchSize
      }
      if (tracks.length === 0) return null
      return { context: buildAlbumContext(albumId, albumInfo, tracks), tracks }
    } catch {
      return null
    }
  }

  // One-time backfill for the "skip duplicates by ISRC" feature: scan the download
  // folder, read each audio file's ISRC, and populate the library index so the
  // feature works against files downloaded before it was enabled.
  private async handleLibraryReindex(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!validateDownloadPath(this.settings.downloadPath)) {
        this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
        return
      }
      const result = await libraryIndex.buildFromFolder(this.settings.downloadPath)
      this.sendJSON(res, { ...result, total: libraryIndex.count() })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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

    // Per-request "Refresh tags" action: rewrite tags on existing files only.
    const overwriteMode = body.refreshTags === true ? 'refresh-tags' : this.settings.overwriteFiles

    // Security: Validate download path
    if (!validateDownloadPath(this.settings.downloadPath)) {
      this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
      return
    }

    try {
      // Get playlist info first for the name
      const playlistInfo = await this.deezerPublicAPI(`/playlist/${playlistId}`)

      if (playlistInfo.error) {
        this.sendJSON(res, { error: `Playlist not available: ${playlistInfo.error.message || 'unknown error'}` }, 404)
        return
      }

      // Paginated fetch — Deezer caps each /playlist/{id}/tracks page at ~500.
      // A single non-paginated call silently truncates large playlists (issue #58).
      // Mirrors the loop already used in handlePlaylist for browse.
      let allPlaylistTracks: any[] = []
      let playlistIndex = 0
      const playlistBatchSize = 100
      while (playlistIndex < 10000) {
        const tracksPage = await this.deezerPublicAPI(`/playlist/${playlistId}/tracks?limit=${playlistBatchSize}&index=${playlistIndex}`)
        if (!tracksPage?.data || !Array.isArray(tracksPage.data) || tracksPage.data.length === 0) break
        allPlaylistTracks = [...allPlaylistTracks, ...tracksPage.data]
        if (!tracksPage.next) break
        playlistIndex += playlistBatchSize
      }

      if (allPlaylistTracks.length === 0) {
        this.sendJSON(res, { error: 'No tracks found for this playlist — it may be empty, private, or unavailable' }, 404)
        return
      }

      const playlist = { data: allPlaylistTracks }

      // Filter out null/undefined track entries (deleted tracks still appear in some playlists)
      const validTracks = playlist.data.filter((t: any) => t && t.id)

      if (validTracks.length === 0) {
        this.sendJSON(res, { error: 'All tracks in this playlist are unavailable' }, 404)
        return
      }

      const downloadIds: string[] = []
      const playlistName = playlistInfo.title || 'Playlist'
      const playlistOwner = playlistInfo.creator?.name || playlistInfo.user?.name || ''
      const playlistCoverUrl = playlistInfo.picture_xl || playlistInfo.picture_big || playlistInfo.picture_medium || ''

      // Register playlist for automatic M3U generation from actual file paths
      // The downloader collects real paths as tracks complete, then generates
      // the M3U — this guarantees paths match what's on disk
      const m3uTrackerId = `playlist_${playlistId}_${Date.now()}`
      if (this.settings.createPlaylistFile) {
        downloader.registerPlaylistForM3U(m3uTrackerId, playlistName, this.settings.downloadPath, validTracks.length, this.settings.m3uNameTemplate)
      }

      for (let i = 0; i < validTracks.length; i++) {
        const track = validTracks[i]
        const downloadId = await downloader.download({
          trackId: track.id,
          outputPath: this.settings.downloadPath,
          quality: this.settings.quality,
          bitrateFallback: this.settings.bitrateFallback,
          isrcFallback: this.settings.isrcFallback,
          createFolders: true,
          artistFolder: this.settings.createArtistFolder,
          albumFolder: this.settings.createAlbumFolder,
          saveArtwork: this.settings.saveArtwork,
          embedArtwork: this.settings.embedArtwork,
          saveLyrics: this.settings.saveLyrics,
          syncedLyrics: this.settings.syncedLyrics,
          preferSyncedLyrics: this.settings.preferSyncedLyrics,
          deleteSupersededLyrics: this.settings.deleteSupersededLyrics,
          folderSettings: {
            createPlaylistFolder: this.settings.createPlaylistFolder,
            createArtistFolder: this.settings.createArtistFolder,
            createAlbumFolder: this.settings.createAlbumFolder,
            createCDFolder: this.settings.createCDFolder,
            createPlaylistStructure: this.settings.createPlaylistStructure,
            createSinglesStructure: this.settings.createSinglesStructure,
            createShortReleaseFolder: this.settings.createShortReleaseFolder,
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
          playlistOwner: playlistOwner,
          playlistCoverUrl: playlistCoverUrl || undefined,
          _m3uTrackerId: m3uTrackerId,
          isFromPlaylist: true,
          playlistPosition: i + 1,
          playlistContext: {
            playlistId: playlistId,
            playlistName: playlistName
          },
          savePlaylistAsCompilation: this.settings.savePlaylistAsCompilation,
          skipDuplicateTracks: this.settings.skipDuplicateTracks,
          createErrorLog: this.settings.createErrorLog,
          overwriteMode
        })
        downloadIds.push(downloadId)
      }

      // M3U is now generated automatically by the downloader as tracks complete
      // using actual file paths — no manual path reconstruction needed

      this.sendJSON(res, { ids: downloadIds, count: downloadIds.length })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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
    const playlistCoverUrl = typeof body.playlistCoverUrl === 'string' ? body.playlistCoverUrl.trim() : ''

    if (trackIds.length === 0) {
      this.sendJSON(res, { error: 'At least one valid track ID is required' }, 400)
      return
    }

    if (!validateDownloadPath(this.settings.downloadPath)) {
      this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
      return
    }

    const isPlaylist = !!playlistName
    console.log(`[Server] Batch download: ${trackIds.length} tracks${isPlaylist ? `, playlist: "${logSafe(playlistName)}"` : ''}`)
    console.log(`[Server] Batch settings - quality: ${this.settings.quality}, path: ${this.settings.downloadPath}, createPlaylistFolder: ${this.settings.createPlaylistFolder}, createAlbumFolder: ${this.settings.createAlbumFolder}`)

    try {
      const downloadIds: string[] = []

      for (let i = 0; i < trackIds.length; i++) {
        const downloadId = await downloader.download({
          trackId: trackIds[i],
          outputPath: this.settings.downloadPath,
          quality: this.settings.quality,
          bitrateFallback: this.settings.bitrateFallback,
          isrcFallback: this.settings.isrcFallback,
          createFolders: true,
          artistFolder: this.settings.createArtistFolder,
          albumFolder: this.settings.createAlbumFolder,
          saveArtwork: this.settings.saveArtwork,
          embedArtwork: this.settings.embedArtwork,
          saveLyrics: this.settings.saveLyrics,
          syncedLyrics: this.settings.syncedLyrics,
          preferSyncedLyrics: this.settings.preferSyncedLyrics,
          deleteSupersededLyrics: this.settings.deleteSupersededLyrics,
          isSingle: !isPlaylist,
          isFromPlaylist: isPlaylist || undefined,
          playlistName: playlistName || undefined,
          playlistCoverUrl: (isPlaylist && playlistCoverUrl) ? playlistCoverUrl : undefined,
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
            createShortReleaseFolder: this.settings.createShortReleaseFolder,
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
          skipDuplicateTracks: this.settings.skipDuplicateTracks,
          createErrorLog: this.settings.createErrorLog,
          overwriteMode: this.settings.overwriteFiles
        })
        downloadIds.push(downloadId)
      }

      // Note: M3U generation skipped for batch downloads — track metadata isn't
      // available at this point (only track IDs). The actual downloaded files
      // will have correct names via the downloader's template engine.

      this.sendJSON(res, { ids: downloadIds, count: downloadIds.length })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  /** Deezer download options for a single track, matching the batch path exactly.
   *  Extracted so the mixed-source (both-services) batch queues Deezer tracks
   *  identically to the pure-Deezer batch. */
  private buildDeezerDownloadOptions(
    trackId: number,
    ctx: { isPlaylist?: boolean; playlistName?: string; playlistCoverUrl?: string; playlistPosition?: number } = {}
  ): any {
    const isPlaylist = !!ctx.isPlaylist
    const playlistName = ctx.playlistName || ''
    const playlistCoverUrl = ctx.playlistCoverUrl || ''
    return {
      trackId,
      outputPath: this.settings.downloadPath,
      quality: this.settings.quality,
      bitrateFallback: this.settings.bitrateFallback,
      isrcFallback: this.settings.isrcFallback,
      createFolders: true,
      artistFolder: this.settings.createArtistFolder,
      albumFolder: this.settings.createAlbumFolder,
      saveArtwork: this.settings.saveArtwork,
      embedArtwork: this.settings.embedArtwork,
      saveLyrics: this.settings.saveLyrics,
      syncedLyrics: this.settings.syncedLyrics,
      preferSyncedLyrics: this.settings.preferSyncedLyrics,
      deleteSupersededLyrics: this.settings.deleteSupersededLyrics,
      isSingle: !isPlaylist,
      isFromPlaylist: isPlaylist || undefined,
      playlistName: playlistName || undefined,
      playlistCoverUrl: (isPlaylist && playlistCoverUrl) ? playlistCoverUrl : undefined,
      playlistPosition: isPlaylist ? ctx.playlistPosition : undefined,
      playlistContext: isPlaylist ? { playlistId: 0, playlistName } : undefined,
      savePlaylistAsCompilation: isPlaylist ? this.settings.savePlaylistAsCompilation : undefined,
      folderSettings: {
        createPlaylistFolder: this.settings.createPlaylistFolder,
        createArtistFolder: this.settings.createArtistFolder,
        createAlbumFolder: this.settings.createAlbumFolder,
        createCDFolder: this.settings.createCDFolder,
        createPlaylistStructure: this.settings.createPlaylistStructure,
        createSinglesStructure: this.settings.createSinglesStructure,
        createShortReleaseFolder: this.settings.createShortReleaseFolder,
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
      skipDuplicateTracks: this.settings.skipDuplicateTracks,
      createErrorLog: this.settings.createErrorLog,
      overwriteMode: this.settings.overwriteFiles
    }
  }

  /** Download a mixed set of tracks, each from its chosen service, as ONE
   *  playlist row (2.4 both-services matrix). Body: { tracks: [{ id, service }],
   *  playlistName, playlistCoverUrl }. Each track routes to its service's
   *  download options; expanded rows show per-track D/Q chips. */
  private async handleMixedBatchDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req)
    const rawTracks = Array.isArray(body.tracks) ? body.tracks : []
    const tracks = rawTracks
      .map((t: any) => ({ id: validateNumericId(t?.id), service: t?.service === 'qobuz' ? 'qobuz' as const : 'deezer' as const }))
      .filter((t): t is { id: number; service: 'deezer' | 'qobuz' } => t.id !== null)
    const playlistName = typeof body.playlistName === 'string' ? body.playlistName.trim() : ''
    const playlistCoverUrl = typeof body.playlistCoverUrl === 'string' ? body.playlistCoverUrl.trim() : ''

    if (tracks.length === 0) {
      this.sendJSON(res, { error: 'At least one valid track is required' }, 400)
      return
    }

    const usesDeezer = tracks.some(t => t.service === 'deezer')
    const usesQobuz = tracks.some(t => t.service === 'qobuz')
    if (usesDeezer && !deezerAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Deezer not connected' }, 401)
      return
    }
    if (usesQobuz && !qobuzAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Qobuz not connected' }, 401)
      return
    }
    if (!validateDownloadPath(this.settings.downloadPath)) {
      this.sendJSON(res, { error: 'Invalid download path configured' }, 400)
      return
    }

    const isPlaylist = !!playlistName
    console.log(`[Server] Mixed batch: ${tracks.length} tracks${isPlaylist ? `, playlist: "${logSafe(playlistName)}"` : ''}`)

    try {
      const downloadIds: string[] = []
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]
        const opts = t.service === 'qobuz'
          ? this.buildQobuzDownloadOptions(t.id, {
              playlistName: isPlaylist ? playlistName : undefined,
              playlistPosition: isPlaylist ? i + 1 : undefined
            })
          : this.buildDeezerDownloadOptions(t.id, {
              isPlaylist,
              playlistName,
              playlistCoverUrl,
              playlistPosition: i + 1
            })
        const downloadId = await downloader.download(opts)
        downloadIds.push(downloadId)
      }
      this.sendJSON(res, { ids: downloadIds, count: downloadIds.length })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  private handleGetQueue(res: ServerResponse): void {
    // No per-poll logging here (#113): this endpoint fires every 1-2s and the
    // old status-summary reduce over a 1,000-row queue was pure overhead.
    this.sendJSON(res, { queue: downloader.getAllProgress() })
  }

  private async handleCancelDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req)
    // Single {id} or batch {ids: []} — album/playlist rows cancel every one of
    // their per-track server ids in one request (#118).
    const ids: unknown[] = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : [])
    const valid = ids.filter((i): i is string => typeof i === 'string' && i.length > 0 && i.length < 128)

    if (valid.length === 0) {
      this.sendJSON(res, { error: 'Download ID is required' }, 400)
      return
    }

    for (const id of valid) downloader.cancelDownload(id)
    this.sendJSON(res, { success: true, cancelled: valid.length })
  }

  private async handleQueuePriority(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req)
    const { id } = body

    if (!id) {
      this.sendJSON(res, { error: 'Download ID is required' }, 400)
      return
    }

    const moved = downloader.moveToFront(id)
    this.sendJSON(res, { success: moved })
  }

  private async handleQueueReorder(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req)
    const ids = Array.isArray(body.ids) ? body.ids.map((x: any) => String(x)) : null
    if (!ids) {
      this.sendJSON(res, { error: 'ids array is required' }, 400)
      return
    }
    const matched = downloader.reorderPending(ids)
    this.sendJSON(res, { success: true, matched })
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
          console.warn('[Security] Invalid download path rejected:', logSafe(body.downloadPath))
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

      // Validate downloadPacing (issue #86) — must be one of the known tiers
      if (body.downloadPacing !== undefined) {
        const validPacing = ['off', 'balanced', 'cautious']
        if (validPacing.includes(body.downloadPacing)) {
          validatedSettings.downloadPacing = body.downloadPacing
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
        'skipDuplicateTracks',
        'bitrateFallback', 'isrcFallback',
        'createErrorLog', 'createPlaylistFile', 'createAlbumPlaylistFile', 'clearQueueOnClose',
        // Folder settings
        'createPlaylistFolder', 'createArtistFolder', 'createAlbumFolder',
        'createCDFolder', 'createPlaylistStructure', 'createSinglesStructure',
        'createShortReleaseFolder',
        // File settings
        'saveArtwork', 'embedArtwork', 'saveLyrics', 'syncedLyrics',
        'preferSyncedLyrics', 'deleteSupersededLyrics'
      ]

      for (const key of booleanSettings) {
        if (body[key] !== undefined && typeof body[key] === 'boolean') {
          (validatedSettings as any)[key] = body[key]
        }
      }

      // Validate folder and track template strings (only allow safe template patterns)
      const templateSettings: (keyof ServerSettings)[] = [
        'playlistFolderTemplate', 'albumFolderTemplate', 'artistFolderTemplate',
        'trackNameTemplate', 'albumTrackTemplate', 'playlistTrackTemplate',
        'm3uNameTemplate'
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
          'composer', 'involvedPeople', 'sourceId', 'releaseType'
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
        const validSeparators: ArtistSeparator[] = ['standard', 'comma', 'slash', 'semicolon', 'semicolonSpace', 'ampersand']
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

      // Apply download pacing setting to downloader (issue #86)
      if (validatedSettings.downloadPacing !== undefined) {
        downloader.setPacing(this.settings.downloadPacing)
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
        // Deezer's public chart album objects have no nb_tracks (verified: the
        // payload carries 15 fields and no track total), so the count is filled
        // in from the cached GW lookup. No-ops when signed out.
        if (type === 'albums') await deezerAuth.hydrateAlbumTrackCounts(response?.data)
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
      console.error('[Server] Chart fetch error:', logSafe(error.message))
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
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

  private async handleNewReleases(url: URL, res: ServerResponse): Promise<void> {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10)

    try {
      // Deezer retired the public /editorial/{genre}/releases endpoint (empty now),
      // so genuine date-stamped new releases come from the private gw-light-api home
      // feed via deezerAuth. Works for guests — no login required.
      const albums = await deezerAuth.getNewReleases(limit)
      this.sendJSON(res, { data: albums, total: albums.length })
    } catch (error: any) {
      console.error('[Server] New releases fetch error:', logSafe(error.message))
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  /**
   * Public playlists belonging to one Deezer user (#135).
   *
   * Deezer returns a flat error for a profile that isn't public, rather than an
   * empty list, so that case is surfaced as 404 with a readable message instead
   * of a 500. Most private profiles display as "Anonymous" and the UI declines
   * to link those at all, but the name is not a guarantee, so this still has to
   * handle a private profile arriving here.
   */
  private async handleUserPlaylists(url: URL, res: ServerResponse): Promise<void> {
    const userId = (url.searchParams.get('id') || '').trim()

    if (!/^\d+$/.test(userId)) {
      this.sendJSON(res, { error: 'A numeric Deezer user id is required' }, 400)
      return
    }

    try {
      const playlists = await fetchDeezerPublicPaginated<any>(
        `https://api.deezer.com/user/${userId}/playlists?limit=100`,
        `user ${userId} playlists`
      )
      const user = await fetchDeezerPublicJson<any>(
        `https://api.deezer.com/user/${userId}`,
        { label: `user ${userId}` }
      ).catch(() => null)

      this.sendJSON(res, {
        user: user ? { id: user.id, name: user.name, picture: user.picture_medium || user.picture || '' } : { id: Number(userId), name: '', picture: '' },
        data: playlists,
        total: playlists.length
      })
    } catch (error: any) {
      const msg = String(error?.message || '')
      // Deezer answers a private profile and a non-existent one identically:
      // {"type":"DataException","message":"no data","code":800}. There is no way
      // to tell them apart from here, so the message says what is observable
      // rather than asserting a reason the API never gave us.
      if (/no data|DataException/i.test(msg)) {
        this.sendJSON(res, { error: "This profile has no public playlists. It's either private or has none shared." }, 404)
        return
      }
      console.error('[Server] User playlists fetch error:', logSafe(msg))
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  // #149: the renderer may ask for one section at a time (?type=tracks|albums|
  // artists|playlists) so a large tracks list no longer holds the other three
  // hostage. With no type the legacy all-in-one response is returned.
  private async handleGetUserFavorites(url: URL, res: ServerResponse): Promise<void> {
    if (!deezerAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Authentication required' }, 401)
      return
    }

    const session = deezerAuth.getSession()
    const userId = session?.user?.id
    if (!userId) {
      this.sendJSON(res, { error: 'User ID not available' }, 400)
      return
    }

    try {
      console.log(`[Server] Fetching Deezer favorites for user ${userId}`)

      // Paginated fetch — Deezer API returns max 200 per request.
      // Follow the 'next' URL until all favorites are fetched.
      const fetchAllPages = async (endpoint: string): Promise<any[]> => {
        const allItems: any[] = []
        let url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}limit=200`
        while (url) {
          const response = await this.deezerPublicAPI(url.replace('https://api.deezer.com', ''))
          if (response?.data) {
            allItems.push(...response.data)
          }
          url = response?.next || null
        }
        return allItems
      }

      const sections = ['tracks', 'albums', 'artists', 'playlists'] as const
      type Section = typeof sections[number]
      const requested = url.searchParams.get('type')
      if (requested !== null && !(sections as readonly string[]).includes(requested)) {
        this.sendJSON(res, { error: `Unknown favorites type: ${requested}` }, 400)
        return
      }

      const fetchSection = async (section: Section): Promise<any[]> => {
        const items = await fetchAllPages(`/user/${userId}/${section}`)
        return section === 'playlists' ? items.filter((p: any) => !p.is_loved_track) : items
      }

      if (requested !== null) {
        const section = requested as Section
        const items = await fetchSection(section)
        console.log(`[Server] Fetched favorites: ${items.length} ${section}`)
        this.sendJSON(res, { [section]: items })
        return
      }

      const [tracks, albums, artists, playlists] = await Promise.all(sections.map(fetchSection))
      const result = { tracks, albums, artists, playlists }

      console.log(`[Server] Fetched favorites: ${result.tracks.length} tracks, ${result.albums.length} albums, ${result.artists.length} artists, ${result.playlists.length} playlists`)
      this.sendJSON(res, result)
    } catch (error: any) {
      console.error('[Server] Failed to fetch user favorites:', error.message)
      this.sendJSON(res, { error: error.message || 'Failed to fetch favorites' }, 500)
    }
  }

  /**
   * Map Deezer gateway album response (UPPERCASE keys) to public-REST shape so
   * downstream code (LinkAnalyzerView, etc.) can treat both sources uniformly.
   * Used as a fallback when public API returns no data for region-restricted
   * content but the user's authenticated session can still reach it.
   */
  private normalizeGatewayAlbum(g: any): any {
    if (!g) return null
    const md5 = g.ALB_PICTURE || ''
    const cover = (size: string) => md5 ? `https://e-cdns-images.dzcdn.net/images/cover/${md5}/${size}.jpg` : ''
    return {
      id: parseInt(g.ALB_ID, 10) || g.ALB_ID,
      title: g.ALB_TITLE || '',
      upc: g.UPC || g.PHYSICAL_RELEASE_DATE_UPC || null,
      label: g.LABEL_NAME || null,
      nb_tracks: parseInt(g.NUMBER_TRACK, 10) || (Array.isArray(g.SONGS?.data) ? g.SONGS.data.length : 0),
      duration: parseInt(g.DURATION, 10) || 0,
      release_date: g.PHYSICAL_RELEASE_DATE || g.DIGITAL_RELEASE_DATE || g.ORIGINAL_RELEASE_DATE || null,
      explicit_lyrics: g.EXPLICIT_ALBUM_CONTENT?.EXPLICIT_LYRICS_STATUS === 1 || false,
      cover_xl: cover('1000x1000-000000-80-0-0'),
      cover_big: cover('500x500-000000-80-0-0'),
      cover_medium: cover('250x250-000000-80-0-0'),
      cover_small: cover('56x56-000000-80-0-0'),
      artist: {
        id: parseInt(g.ART_ID, 10) || g.ART_ID,
        name: g.ART_NAME || 'Unknown'
      },
      genres: { data: Array.isArray(g.GENRES?.data) ? g.GENRES.data.map((x: any) => ({ name: x.GENRE_NAME || x.name || '' })) : [] }
    }
  }

  /**
   * Map Deezer gateway track response (UPPERCASE keys) to public-REST shape.
   */
  private normalizeGatewayTrack(g: any): any {
    if (!g) return null
    const md5 = g.ALB_PICTURE || ''
    const cover = (size: string) => md5 ? `https://e-cdns-images.dzcdn.net/images/cover/${md5}/${size}.jpg` : ''
    return {
      id: parseInt(g.SNG_ID, 10) || g.SNG_ID,
      title: g.SNG_TITLE || '',
      title_short: g.SNG_TITLE || '',
      isrc: g.ISRC || null,
      readable: true,
      duration: parseInt(g.DURATION, 10) || 0,
      track_position: parseInt(g.TRACK_NUMBER, 10) || 0,
      disk_number: parseInt(g.DISK_NUMBER, 10) || 1,
      explicit_lyrics: g.EXPLICIT_LYRICS === '1' || g.EXPLICIT_LYRICS === 1,
      bpm: g.BPM ? parseFloat(g.BPM) : null,
      gain: g.GAIN ? parseFloat(g.GAIN) : null,
      album: {
        id: parseInt(g.ALB_ID, 10) || g.ALB_ID,
        title: g.ALB_TITLE || '',
        cover_xl: cover('1000x1000-000000-80-0-0'),
        cover_big: cover('500x500-000000-80-0-0'),
        cover_medium: cover('250x250-000000-80-0-0'),
        cover_small: cover('56x56-000000-80-0-0')
      },
      artist: {
        id: parseInt(g.ART_ID, 10) || g.ART_ID,
        name: g.ART_NAME || 'Unknown'
      }
    }
  }

  private async handleAnalyze(url: URL, res: ServerResponse): Promise<void> {
    const rawUrl = url.searchParams.get('url')

    if (!rawUrl) {
      this.sendJSON(res, { error: 'URL parameter is required' }, 400)
      return
    }

    // Resolve share/short links (link.deezer.com, deezer.page.link) to full URLs
    let resolvedUrl = rawUrl.trim()
    if (urlHasHost(resolvedUrl, ['link.deezer.com', 'deezer.page.link'])) {
      try {
        resolvedUrl = await followRedirectsSafely(resolvedUrl)
        console.log(`[Server] Resolved share link: ${logSafe(rawUrl)} -> ${logSafe(resolvedUrl)}`)
      } catch (err: any) {
        console.error('[Server] Failed to resolve share link:', err.message)
        this.sendJSON(res, { error: 'Failed to resolve share link' }, 400)
        return
      }
    }

    // Parse the Deezer URL to extract type and ID
    const parsed = this.parseDeezerUrl(resolvedUrl)

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
          // Region-restricted fallback: public REST returns "no data" for
          // tracks not in the server's IP region. The authenticated session
          // can still reach them via the gateway when the user's account region
          // is permitted. Use it as the canonical track source in that case.
          if (data?.error && deezerAuth.isLoggedIn()) {
            try {
              const gatewayTrack = await deezerAuth.getTrackInfo(parsed.id)
              const normalized = this.normalizeGatewayTrack(gatewayTrack)
              if (normalized) {
                console.log('[Server] Track analyze: public API returned no data, gateway fallback succeeded')
                data = normalized
              }
            } catch (gwErr: any) {
              console.log('[Server] Track analyze: gateway fallback also failed:', logSafe(gwErr.message))
              // fall through — data still has .error, handled below
            }
          }
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
                console.log('[Server] song.getListData failed:', logSafe((listErr as any)?.message ?? listErr))
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
                  console.log('[Server] deezer.pageTrack failed:', logSafe((pageErr as any)?.message ?? pageErr))
                }
              }

              additionalInfo.countries = countries
              console.log('[Server] Final countries array length:', countries.length)
            } catch (err) {
              console.log('[Server] Could not fetch private track info:', logSafe((err as any)?.message ?? err))
            }
          } else {
            console.log('[Server] Not logged in, skipping private API call for countries')
          }
          break

        case 'album': {
          data = await this.deezerPublicAPI(`/album/${parsed.id}`)
          // Region-restricted fallback: public REST returns "no data" for albums
          // not catalogued in the server's IP region. Authenticated session may
          // still reach them via the gateway.
          if (data?.error && deezerAuth.isLoggedIn()) {
            try {
              const gateway = await deezerAuth.getAlbumInfo(parsed.id)
              const normalized = this.normalizeGatewayAlbum(gateway)
              if (normalized) {
                console.log('[Server] Album analyze: public API returned no data, gateway fallback succeeded')
                data = normalized
              }
            } catch (gwErr: any) {
              console.log('[Server] Album analyze: gateway fallback also failed:', logSafe(gwErr.message))
              // fall through — data still has .error, handled below
            }
          }
          // Album-specific fields: UPC, label, track count
          additionalInfo = {
            upc: data.upc || null,
            label: data.label || null,
            trackCount: data.nb_tracks || 0,
            genres: data.genres?.data?.map((g: any) => g.name) || []
          }
          break
        }

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

      // Check if content was found. Map common Deezer error codes to copy
      // that tells the user what they can do about it. errorCode is surfaced
      // to the client so the UI can offer a contextual CTA (e.g. "Sign in").
      if (data.error) {
        const code = data.error.code
        let msg: string
        if (code === 800) {
          msg = deezerAuth.isLoggedIn()
            ? 'This content isn\'t available in your region.'
            : 'Sign in to Deezer for access to region-restricted content.'
        } else if (code === 4) {
          msg = 'Invalid Deezer URL or content ID.'
        } else {
          msg = data.error.message || 'Content not found on Deezer'
        }
        this.sendJSON(res, { error: msg, errorCode: code ?? null }, 404)
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

  private async deezerPublicAPI(endpoint: string, opts?: { timeoutMs?: number }): Promise<any> {
    const timeoutMs = opts?.timeoutMs ?? 15000
    return new Promise((resolve, reject) => {
      // Build from a fixed base and assert the host so a crafted `endpoint`
      // (e.g. starting with `@` or `//`) can't re-point the request off Deezer.
      const target = new URL(endpoint, 'https://api.deezer.com')
      // Full-origin pin, not just hostname: a crafted endpoint can't switch
      // scheme (protocol-relative //host) or smuggle a non-default port.
      if (target.protocol !== 'https:' || target.hostname !== 'api.deezer.com' || target.port !== '') {
        reject(new Error('Invalid Deezer API endpoint'))
        return
      }
      const url = target.toString()

      const req = https.get(url, (response) => {
        let data = ''
        response.on('data', chunk => data += chunk)
        response.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error('Failed to parse Deezer API response'))
          }
        })
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new Error(`Deezer API request timed out after ${timeoutMs}ms`))
      })
      req.on('error', reject)
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
    // Single chokepoint for responses: error payloads never carry stack traces
    // to the client (CodeQL #16). Handlers already send message-only errors;
    // this guarantees it for every current and future handler, including any
    // Error object serialized wholesale or nested `stack` fields.
    if (status >= 400 && data && typeof data === 'object') {
      if (data instanceof Error) {
        data = { error: data.message }
      } else {
        data = JSON.parse(JSON.stringify(data, (key, value) => (key === 'stack' ? undefined : value)))
      }
    }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  // ==================== Retag Handlers ====================

  // Scan a folder for .mp3/.flac files and read each one's ISRC. The frontend
  // then drives retagging one file at a time (natural progress + cancel) via
  // /api/retag/file, so there is no long-lived server-side job to track.
  private async handleRetagScan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
    try {
      const { folder } = await this.parseBody(req)
      if (!folder || typeof folder !== 'string') {
        this.sendJSON(res, { error: 'folder is required' }, 400)
        return
      }
      const files = await scanFolder(folder)
      this.sendJSON(res, { files })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  // Retag (or dry-run preview) a single file. Public Deezer API only — no ARL.
  private async handleRetagFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return }
    try {
      const { path: filePath, folder, fields, dryRun } = await this.parseBody(req)
      if (!filePath || typeof filePath !== 'string') {
        this.sendJSON(res, { error: 'path is required' }, 400)
        return
      }
      // Album-aware when a folder is supplied (resolves the whole folder against
      // its one authoritative Deezer album); per-file ISRC lookup otherwise.
      const result = folder && typeof folder === 'string'
        ? await retagFileInFolder(filePath, folder, (fields || {}) as RetagFields, dryRun === true)
        : await retagFile(filePath, (fields || {}) as RetagFields, dryRun === true)
      this.sendJSON(res, result)
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
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

      // Set credentials and test authentication. The token exchange alone is
      // not proof of a working setup: it succeeds even when the app owner
      // lacks the Premium subscription Spotify began requiring on 9 March
      // 2026, so a read is performed too before reporting success (#137).
      spotifyAPI.setCredentials(clientId, clientSecret)
      const success = await spotifyAPI.authenticate()

      if (!success) {
        this.sendJSON(res, { error: 'Invalid Spotify credentials' }, 401)
        return
      }

      const readable = await spotifyAPI.verifyReadAccess()
      if (!readable.ok) {
        this.sendJSON(res, { error: readable.message }, 403)
        return
      }

      this.sendJSON(res, { success: true, message: 'Spotify authentication successful' })
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

  // --- Qobuz (WIP) ---

  /** Push a browser-captured token into the backend session (called by the
   *  renderer right after Connect so Qobuz is usable without an app restart). */
  private async handleQobuzSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const userId = Number(body.userId)
      const token = String(body.token || '')
      if (!token) {
        this.sendJSON(res, { success: false, error: 'token required' }, 400)
        return
      }
      // Advanced connect: user-supplied app_id + app_secret override the
      // auto-scrape so a token minted under a different Qobuz app_id validates
      // and downloads sign correctly. Empty values revert to auto-scrape.
      qobuzAuth.setManualCredentials(String(body.appId || ''), String(body.appSecret || ''))
      // userId present → login-window path (id captured alongside the token),
      // or the advanced path where the user pasted their own user id.
      // userId absent → token-paste path (#114): Qobuz identifies the account.
      const session = userId
        ? await qobuzAuth.loginWithToken(userId, token)
        : await qobuzAuth.connectWithToken(token)
      this.sendJSON(res, { success: true, userId: session.userId, plan: session.credentialLabel })
    } catch (error: any) {
      this.sendJSON(res, { success: false, error: sanitizeErrorMessage(error, 'Qobuz login failed') }, 401)
    }
  }

  private handleQobuzStatus(res: ServerResponse): void {
    const s = qobuzAuth.getSession()
    this.sendJSON(res, {
      connected: qobuzAuth.isLoggedIn(),
      // True when a working session died to a 401 (token expiry) — lets the UI
      // say 'session expired, reconnect' instead of 'not connected'.
      expired: qobuzAuth.isAuthExpired(),
      userId: s?.userId,
      plan: s?.credentialLabel,
    })
  }

  private async handleQobuzAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const link = String(body.url || '')
      if (!link) {
        this.sendJSON(res, { error: 'url required' }, 400)
        return
      }
      if (!qobuzAuth.isLoggedIn()) {
        this.sendJSON(res, { error: 'Qobuz not connected' }, 401)
        return
      }
      const result = await qobuzAuth.analyzeUrl(link)
      this.sendJSON(res, result)
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error, 'Failed to analyze Qobuz link') }, 400)
    }
  }

  private async handleQobuzArtist(url: URL, res: ServerResponse): Promise<void> {
    const id = validateQobuzId(url.searchParams.get('id'))
    if (!id) { this.sendJSON(res, { error: 'Valid id required' }, 400); return }
    if (!qobuzAuth.isLoggedIn()) { this.sendJSON(res, { error: 'Qobuz not connected' }, 401); return }
    try {
      this.sendJSON(res, await qobuzAuth.getArtist(id))
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  private async handleQobuzArtistTopTracks(url: URL, res: ServerResponse): Promise<void> {
    const id = validateQobuzId(url.searchParams.get('id'))
    if (!id) { this.sendJSON(res, { error: 'Valid id required' }, 400); return }
    if (!qobuzAuth.isLoggedIn()) { this.sendJSON(res, { error: 'Qobuz not connected' }, 401); return }
    try {
      this.sendJSON(res, { items: await qobuzAuth.getArtistTopTracks(id) })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  private async handleQobuzAlbum(url: URL, res: ServerResponse): Promise<void> {
    const id = validateQobuzId(url.searchParams.get('id'))
    if (!id) { this.sendJSON(res, { error: 'Valid id required' }, 400); return }
    if (!qobuzAuth.isLoggedIn()) { this.sendJSON(res, { error: 'Qobuz not connected' }, 401); return }
    try {
      this.sendJSON(res, await qobuzAuth.getAlbum(id))
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  private async handleQobuzPlaylist(url: URL, res: ServerResponse): Promise<void> {
    const id = validateQobuzId(url.searchParams.get('id'))
    if (!id) { this.sendJSON(res, { error: 'Valid id required' }, 400); return }
    if (!qobuzAuth.isLoggedIn()) { this.sendJSON(res, { error: 'Qobuz not connected' }, 401); return }
    try {
      this.sendJSON(res, await qobuzAuth.getPlaylist(id))
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  // Discover-tab cache (keyed per genre filter) — Qobuz's editorial feeds
  // change daily; 30 min keeps tab revisits instant without hammering their API.
  private qobuzDiscoverCache = new Map<string, { data: any; timestamp: number }>()
  private readonly QOBUZ_DISCOVER_CACHE_TTL = 30 * 60 * 1000

  /** Aggregated Qobuz editorial feeds for the Discover tab, optionally genre-
   *  filtered (?genre=<id> — Qobuz's own genre_ids Discover filter). Each row
   *  fetches independently — a failed feed degrades to an empty row, never a
   *  broken page. Personal rows (favorites/purchases) can't be genre-filtered
   *  server-side, so they only appear on the unfiltered view. */
  private async handleQobuzDiscover(url: URL, res: ServerResponse): Promise<void> {
    if (!qobuzAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Qobuz not connected' }, 401)
      return
    }
    const genreId = Number(url.searchParams.get('genre')) || undefined
    const cacheKey = String(genreId || 'all')
    const cached = this.qobuzDiscoverCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < this.QOBUZ_DISCOVER_CACHE_TTL) {
      this.sendJSON(res, cached.data)
      return
    }
    // Small parallel waves (3-wide): full-sequential pacing made every fresh
    // load take 2-3s (measured); a bounded wave keeps loads ~0.7s without the
    // 7-wide burst that may have looked abusive to the gateway. Every row's
    // failure is RECORDED in the response (_rowErrors) — observable fault
    // tolerance instead of silent empty rows.
    const rowErrors: Record<string, string> = {}
    const safe = async (fn: () => Promise<any>, label: string): Promise<any> => {
      try {
        return await fn()
      } catch (e: any) {
        console.log(`[Server] Qobuz discover row '${label}' failed:`, e.message)
        rowErrors[label] = e.message
        return null
      }
    }
    const [newReleases, pressAwards, editorPicks] = await Promise.all([
      safe(() => qobuzAuth.getFeaturedAlbums('new-releases-full', 20, 0, genreId), 'new-releases-full'),
      safe(() => qobuzAuth.getFeaturedAlbums('press-awards', 20, 0, genreId), 'press-awards'),
      safe(() => qobuzAuth.getFeaturedAlbums('editor-picks', 20, 0, genreId), 'editor-picks'),
    ])
    const [mostStreamed, playlists] = await Promise.all([
      safe(() => qobuzAuth.getFeaturedAlbums('most-streamed', 20, 0, genreId), 'most-streamed'),
      safe(() => qobuzAuth.getFeaturedPlaylists('editor-picks', 20, 0, genreId), 'playlists-editor-picks'),
    ])
    const [favorites, purchases] = genreId ? [null, null] : await Promise.all([
      safe(() => qobuzAuth.getUserFavorites('albums', 20), 'user-favorites'),
      safe(() => qobuzAuth.getUserPurchases(50), 'user-purchases'),
    ])
    const data = {
      newReleases: newReleases?.albums?.items || [],
      pressAwards: pressAwards?.albums?.items || [],
      editorPicks: editorPicks?.albums?.items || [],
      mostStreamed: mostStreamed?.albums?.items || [],
      playlists: playlists?.playlists?.items || [],
      // Personal rows — favorites the user hearted in Qobuz, and purchased albums.
      myFavorites: favorites?.albums?.items || [],
      myPurchases: purchases?.albums?.items || [],
      // Feed totals — the UI shows LOAD MORE while items < total.
      totals: {
        newReleases: newReleases?.albums?.total ?? 0,
        pressAwards: pressAwards?.albums?.total ?? 0,
        editorPicks: editorPicks?.albums?.total ?? 0,
        mostStreamed: mostStreamed?.albums?.total ?? 0,
        playlists: playlists?.playlists?.total ?? 0,
        myFavorites: favorites?.albums?.total ?? 0,
        myPurchases: purchases?.albums?.total ?? 0,
      },
      _rowErrors: Object.keys(rowErrors).length ? rowErrors : undefined,
    }
    // Don't cache a fully-failed result — a transient outage would otherwise
    // pin empty rows for 30 minutes.
    const anyContent = data.newReleases.length || data.editorPicks.length || data.pressAwards.length
      || data.mostStreamed.length || data.playlists.length || data.myFavorites.length || data.myPurchases.length
    if (anyContent) this.qobuzDiscoverCache.set(cacheKey, { data, timestamp: Date.now() })
    this.sendJSON(res, data)
  }

  // Genre lists + Deezer genre browse — cached; genres barely ever change.
  // Keyed by parent id ('root' for the top level) so the full genre tree —
  // subgenres included — is browsable and cached per level.
  private qobuzGenresCache = new Map<string, { data: any; timestamp: number }>()
  private deezerGenreBrowseCache = new Map<string, { data: any; timestamp: number }>()

  private async handleQobuzGenres(url: URL, res: ServerResponse): Promise<void> {
    if (!qobuzAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Qobuz not connected' }, 401)
      return
    }
    const parentId = Number(url.searchParams.get('parent')) || undefined
    const cacheKey = parentId ? String(parentId) : 'root'
    const cached = this.qobuzGenresCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
      this.sendJSON(res, cached.data)
      return
    }
    try {
      const g = await qobuzAuth.getGenres(parentId)
      const items = (g?.genres?.items || g?.items || []).map((x: any) => ({ id: x.id, name: x.name }))
      const data = { genres: items }
      this.qobuzGenresCache.set(cacheKey, { data, timestamp: Date.now() })
      this.sendJSON(res, data)
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  /** Single-feed pagination for the Discover rows' LOAD MORE (#106 follow-up).
   *  type: new-releases-full|press-awards|editor-picks|most-streamed|playlists */
  private async handleQobuzFeatured(url: URL, res: ServerResponse): Promise<void> {
    if (!qobuzAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Qobuz not connected' }, 401)
      return
    }
    const type = url.searchParams.get('type') || ''
    const allowed = ['new-releases-full', 'press-awards', 'editor-picks', 'most-streamed', 'playlists']
    if (!allowed.includes(type)) {
      this.sendJSON(res, { error: 'Invalid feed type' }, 400)
      return
    }
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20))
    const genreId = Number(url.searchParams.get('genre')) || undefined
    try {
      if (type === 'playlists') {
        const r = await qobuzAuth.getFeaturedPlaylists('editor-picks', limit, offset, genreId)
        this.sendJSON(res, { items: r?.playlists?.items || [], total: r?.playlists?.total ?? 0 })
      } else {
        const r = await qobuzAuth.getFeaturedAlbums(type, limit, offset, genreId)
        this.sendJSON(res, { items: r?.albums?.items || [], total: r?.albums?.total ?? 0 })
      }
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  private async handleDeezerGenres(res: ServerResponse): Promise<void> {
    try {
      const g = await this.deezerPublicAPI('/genre')
      // Drop the 'All' pseudo-genre (id 0) — the UI models 'All' itself.
      const genres = (g?.data || []).filter((x: any) => x.id !== 0).map((x: any) => ({ id: x.id, name: x.name }))
      this.sendJSON(res, { genres })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  /** Deezer per-genre browse: editorial picks + genre charts. Built only from
   *  the endpoints verified working (the per-genre artists endpoint is broken
   *  upstream — ignores the filter — and is deliberately excluded, #106). */
  private async handleDeezerGenreBrowse(url: URL, res: ServerResponse): Promise<void> {
    const id = url.searchParams.get('id')
    if (!id || !/^\d+$/.test(id)) {
      this.sendJSON(res, { error: 'Valid genre id required' }, 400)
      return
    }
    const cached = this.deezerGenreBrowseCache.get(id)
    if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) {
      this.sendJSON(res, cached.data)
      return
    }
    const safe = (p: Promise<any>, label: string): Promise<any> =>
      p.catch((e: any) => {
        console.log(`[Server] Deezer genre row '${label}' failed:`, e.message)
        return null
      })
    const [selection, charts] = await Promise.all([
      safe(this.deezerPublicAPI(`/editorial/${id}/selection`), 'selection'),
      safe(this.deezerPublicAPI(`/editorial/${id}/charts`), 'charts'),
    ])
    const data = {
      picks: selection?.data || [],
      chartTracks: charts?.tracks?.data || [],
      chartAlbums: charts?.albums?.data || [],
    }
    // Same gap as the worldwide chart: the editorial endpoints omit nb_tracks.
    // Hydrate before caching so the 30 minute cache stores the counts too.
    await Promise.all([
      deezerAuth.hydrateAlbumTrackCounts(data.picks),
      deezerAuth.hydrateAlbumTrackCounts(data.chartAlbums),
    ])
    this.deezerGenreBrowseCache.set(id, { data, timestamp: Date.now() })
    this.sendJSON(res, data)
  }

  /** Paginated per-genre chart — the only per-genre catalog surface Deezer's
   *  public API exposes with real pagination (/chart/{id}/{albums|tracks},
   *  hard-capped at 100 by Deezer; /editorial/{id}/releases is dead upstream —
   *  verified returning {data:[],total:0} for every genre, 2026-07-19). */
  private async handleDeezerGenreChart(url: URL, res: ServerResponse): Promise<void> {
    const id = url.searchParams.get('id')
    const kind = url.searchParams.get('kind')
    if (!id || !/^\d+$/.test(id) || (kind !== 'albums' && kind !== 'tracks')) {
      this.sendJSON(res, { error: 'Valid genre id and kind (albums|tracks) required' }, 400)
      return
    }
    const index = Math.max(0, Number(url.searchParams.get('index')) || 0)
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50))
    try {
      const r = await this.deezerPublicAPI(`/chart/${id}/${kind}?index=${index}&limit=${limit}`)
      if (kind === 'albums') await deezerAuth.hydrateAlbumTrackCounts(r?.data)
      this.sendJSON(res, { items: r?.data || [], total: r?.total ?? (r?.data?.length || 0) })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error, 'Failed to load genre chart') }, 500)
    }
  }

  /** Resolve a playable stream URL for a Qobuz track preview. Qobuz has no
   *  static 30s preview clips like Deezer — the renderer requests a signed
   *  MP3 stream URL on demand and caps playback client-side. */
  private async handleQobuzPreview(url: URL, res: ServerResponse): Promise<void> {
    const id = validateQobuzId(url.searchParams.get('id'))
    if (!id) {
      this.sendJSON(res, { error: 'Valid id required' }, 400)
      return
    }
    if (!qobuzAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Qobuz not connected' }, 401)
      return
    }
    try {
      // Optional format override (diagnostic + future use): 5|6|7|27.
      const fmtParam = Number(url.searchParams.get('format'))
      const fmt = ([5, 6, 7, 27].includes(fmtParam) ? fmtParam : QOBUZ_FORMAT.MP3_320) as any
      const file = await qobuzAuth.getFileUrl(id, fmt)
      if (!file.url) {
        this.sendJSON(res, { error: 'No stream available for this track', restrictionCode: file.restrictionCode }, 404)
        return
      }
      this.sendJSON(res, { url: file.url, formatId: file.formatId })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error) }, 500)
    }
  }

  private async handleQobuzSearch(url: URL, res: ServerResponse): Promise<void> {
    const query = url.searchParams.get('q')
    const limit = Number(url.searchParams.get('limit') || '25')
    const offset = Number(url.searchParams.get('offset') || '0')
    if (!query) {
      this.sendJSON(res, { error: 'q parameter required' }, 400)
      return
    }
    if (!qobuzAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Qobuz not connected' }, 401)
      return
    }
    try {
      const results = await qobuzAuth.search(query, limit, offset)
      this.sendJSON(res, results)
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error, 'Qobuz search failed') }, 500)
    }
  }

  /** Download a single Qobuz track to the library folder (no-decrypt path).
   *  Full queue/UI + folder-template integration is the next slice; this writes
   *  a sanitized "Artist - Title.flac" so the mechanic is usable and testable. */
  private async handleQobuzDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const trackId = validateQobuzId(body.trackId)
      if (!trackId) {
        this.sendJSON(res, { success: false, error: 'Valid trackId required' }, 400)
        return
      }
      if (!qobuzAuth.isLoggedIn()) {
        this.sendJSON(res, { success: false, error: 'Qobuz not connected' }, 401)
        return
      }
      if (!validateDownloadPath(this.settings.downloadPath)) {
        this.sendJSON(res, { success: false, error: 'Invalid download path' }, 400)
        return
      }
      // Enqueue through the shared download queue so the item appears in the
      // Transfer Rack with live progress (Qobuz items route to the no-decrypt
      // path via the service discriminator). Returns the queue id immediately.
      const downloadId = await downloader.download(
        this.buildQobuzDownloadOptions(trackId, { partOfAlbum: body.partOfAlbum === true, album: body.album })
      )
      this.sendJSON(res, { success: true, downloadId })
    } catch (error: any) {
      this.sendJSON(res, { success: false, error: sanitizeErrorMessage(error, 'Qobuz download failed') }, 500)
    }
  }

  /** Batch-download a set of Qobuz track IDs as one playlist item. Mirrors the
   *  Deezer batch path field-for-field but routes each track through the Qobuz
   *  no-decrypt options builder. Used by the Link Analyzer when the target
   *  service is Qobuz. Same request/response shape as /api/download/batch. */
  private async handleQobuzDownloadBatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!qobuzAuth.isLoggedIn()) {
      this.sendJSON(res, { error: 'Qobuz not connected' }, 401)
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
    console.log(`[Server] Qobuz batch download: ${trackIds.length} tracks${isPlaylist ? `, playlist: "${logSafe(playlistName)}"` : ''}`)

    try {
      const downloadIds: string[] = []
      for (let i = 0; i < trackIds.length; i++) {
        const downloadId = await downloader.download(
          this.buildQobuzDownloadOptions(trackIds[i], {
            playlistName: isPlaylist ? playlistName : undefined,
            playlistPosition: isPlaylist ? i + 1 : undefined
          })
        )
        downloadIds.push(downloadId)
      }
      this.sendJSON(res, { ids: downloadIds, count: downloadIds.length })
    } catch (error: any) {
      this.sendJSON(res, { error: sanitizeErrorMessage(error, 'Qobuz batch download failed') }, 500)
    }
  }

  /** Shared Qobuz download options — mirrors the Deezer download options field-for-
   *  field (same quality, folder/template, artwork, tagging, duplicate/overwrite
   *  settings) so Qobuz downloads follow the app's settings exactly. Deezer-only
   *  concepts (isrcFallback alternate-release lookup, lyrics — Qobuz's API exposes
   *  none) are intentionally absent. */
  private buildQobuzDownloadOptions(
    trackId: string | number,
    ctx: {
      partOfAlbum?: boolean
      album?: { title?: string; artist?: string; totalTracks?: number }
      playlistName?: string
      playlistPosition?: number
      playlistOwner?: string
      m3uTrackerId?: string
      qobuzMeta?: any
    } = {}
  ): any {
    const isFromPlaylist = !!ctx.playlistName
    return {
      service: 'qobuz',
      trackId,
      // Track metadata already held from the album/playlist listing (#112) —
      // saves the per-track track/get round-trip; the downloader falls back to
      // a live fetch when essentials are missing.
      qobuzMeta: ctx.qobuzMeta,
      outputPath: this.settings.downloadPath,
      // settings.quality is already server-format ('MP3_128'|'MP3_320'|'FLAC') —
      // pass it through. (A renderer-format map here once made every Qobuz
      // download silently fall back to MP3_320.)
      quality: validateQuality(this.settings.quality),
      bitrateFallback: this.settings.bitrateFallback,
      createFolders: true,
      artistFolder: this.settings.createArtistFolder,
      albumFolder: this.settings.createAlbumFolder,
      saveArtwork: this.settings.saveArtwork,
      embedArtwork: this.settings.embedArtwork,
      // Part of an album or playlist → NOT-single, so the album/playlist folder
      // and matching track template apply.
      isSingle: !ctx.partOfAlbum && !isFromPlaylist,
      isFromPlaylist: isFromPlaylist || undefined,
      playlistName: ctx.playlistName || undefined,
      playlistPosition: ctx.playlistPosition,
      playlistOwner: ctx.playlistOwner || undefined,
      _m3uTrackerId: ctx.m3uTrackerId || undefined,
      savePlaylistAsCompilation: isFromPlaylist ? this.settings.savePlaylistAsCompilation : undefined,
      // totalTracks feeds the short-release folder rule (#129) — without it a
      // Qobuz single would keep its one-file folder while the Deezer one didn't.
      albumContext: ctx.album
        ? { albumTitle: ctx.album.title, albumArtist: ctx.album.artist, totalTracks: ctx.album.totalTracks }
        : undefined,
      folderSettings: {
        createPlaylistFolder: this.settings.createPlaylistFolder,
        createArtistFolder: this.settings.createArtistFolder,
        createAlbumFolder: this.settings.createAlbumFolder,
        createCDFolder: this.settings.createCDFolder,
        createPlaylistStructure: this.settings.createPlaylistStructure,
        createSinglesStructure: this.settings.createSinglesStructure,
        createShortReleaseFolder: this.settings.createShortReleaseFolder,
        playlistFolderTemplate: this.settings.playlistFolderTemplate,
        albumFolderTemplate: this.settings.albumFolderTemplate,
        artistFolderTemplate: this.settings.artistFolderTemplate,
      },
      trackTemplates: {
        trackNameTemplate: this.settings.trackNameTemplate,
        albumTrackTemplate: this.settings.albumTrackTemplate,
        playlistTrackTemplate: this.settings.playlistTrackTemplate,
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
        removeArtistCombinations: this.settings.removeArtistCombinations,
      },
      skipDuplicateTracks: this.settings.skipDuplicateTracks,
      createErrorLog: this.settings.createErrorLog,
      overwriteMode: this.settings.overwriteFiles,
    }
  }

  /** Enqueue every track of a Qobuz album/playlist and return their queue ids,
   *  so the store can group them under one Transfer Rack row (like Deezer). */
  private async handleQobuzDownloadAlbum(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const albumId = body.albumId != null ? validateQobuzId(body.albumId) : null
      const playlistId = body.playlistId != null ? validateQobuzId(body.playlistId) : null
      if (!albumId && !playlistId) {
        this.sendJSON(res, { success: false, error: 'Valid albumId or playlistId required' }, 400)
        return
      }
      if (!qobuzAuth.isLoggedIn()) {
        this.sendJSON(res, { success: false, error: 'Qobuz not connected' }, 401)
        return
      }
      if (!validateDownloadPath(this.settings.downloadPath)) {
        this.sendJSON(res, { success: false, error: 'Invalid download path' }, 400)
        return
      }
      const data = albumId ? await qobuzAuth.getAlbum(albumId) : await qobuzAuth.getPlaylist(playlistId)
      const tracks = data?.tracks?.items || []
      const album = albumId ? { title: data?.title, artist: data?.artist?.name } : undefined
      // Playlist downloads carry playlist context so the playlist folder,
      // playlist track template, and compilation tagging settings apply —
      // matching the Deezer playlist path (previously they were treated as
      // album tracks and scattered across per-album folders).
      const playlistName = playlistId ? (data?.name || data?.title || 'Playlist') : undefined
      const playlistOwner = playlistId ? (data?.owner?.name || '') : undefined

      // M3U generation from real on-disk paths — same registration the Deezer
      // playlist path uses, honoring the createPlaylistFile setting.
      const validTracks = tracks.filter((t: any) => t?.id)
      let m3uTrackerId: string | undefined
      if (this.settings.createPlaylistFile) {
        // Album M3U (#121) mirrors the playlist path: register a tracker so an
        // .m3u8 is written into the folder. Album gets its own tracker keyed by
        // album id; playlist keeps its existing one.
        if (playlistName) {
          m3uTrackerId = `qobuzplaylist_${playlistId}_${Date.now()}`
          downloader.registerPlaylistForM3U(m3uTrackerId, playlistName, this.settings.downloadPath, validTracks.length, this.settings.m3uNameTemplate)
        } else if (albumId && this.settings.createAlbumPlaylistFile) {
          // Album M3U is opt-out independently of playlists (#131) — same split
          // the Deezer album path makes.
          m3uTrackerId = `qobuzalbum_${albumId}_${Date.now()}`
          downloader.registerPlaylistForM3U(m3uTrackerId, album?.title || 'Album', this.settings.downloadPath, validTracks.length, this.settings.m3uNameTemplate, 'album')
        }
      }

      // Listing metadata reuse (#112): album/get track items carry no per-track
      // `album` object (the container IS the album) — graft it on so the shim
      // has everything track/get would have returned. Playlist items already
      // carry their own per-track album.
      const albumForMeta = albumId ? { ...data, tracks: undefined } : undefined

      const ids: string[] = []
      let position = 0
      for (const t of validTracks) {
        position++
        const id = await downloader.download(this.buildQobuzDownloadOptions(t.id, {
          partOfAlbum: !!albumId,
          // Track count only means "release size" for an album download; on a
          // playlist it would be the playlist length, which must not drive the
          // short-release rule.
          album: albumId && album ? { ...album, totalTracks: validTracks.length } : album,
          playlistName,
          // Position drives M3U ordering for both albums and playlists.
          playlistPosition: position,
          playlistOwner,
          m3uTrackerId,
          qobuzMeta: albumId ? { ...t, album: albumForMeta } : t,
        }))
        ids.push(id)
      }
      this.sendJSON(res, { ids, count: ids.length })
    } catch (error: any) {
      this.sendJSON(res, { success: false, error: sanitizeErrorMessage(error, 'Qobuz album download failed') }, 500)
    }
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
    let parsedUrl: { type: string; id: string } | null = null
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
      parsedUrl = parsed
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
      const msg = error.message || 'Failed to analyze Spotify URL'
      const status: number = typeof error.status === 'number' ? error.status : 0
      const notFound = status === 404 || msg.toLowerCase().includes('not found')
      // Checked before the 404 branches because this one is a 200: since the
      // February 2026 Web API change a developer app is served playlist
      // metadata without its contents, which used to surface here as a raw
      // "Cannot read properties of undefined" (reported by @alex5908).
      if (error instanceof SpotifyContentsUnavailableError) {
        this.sendJSON(res, { error: describeSpotifyError(error, parsedUrl?.id) }, 422)
        return
      }
      // Spotify answers 404 for two very different playlist cases, and we only
      // get to tell them apart by the ID. Its own editorial + algorithmic
      // playlists (Today's Top Hits, RapCaviar, Discover Weekly) all carry the
      // 37i9 prefix and stopped being reachable without user-level OAuth after
      // Spotify's Nov-2024 Client-Credentials deprecation. Any other 404 is a
      // user-owned playlist that is private or deleted: client-credentials
      // tokens have no user context, so a private playlist is invisible even to
      // the person who owns it. Blaming the editorial change for that case told
      // people the opposite of the truth ("playlists by regular users still
      // work") while they stared at their own playlist failing.
      if (notFound && parsedUrl?.type === 'playlist') {
        this.sendJSON(res, {
          error: parsedUrl.id.startsWith('37i9')
            ? "This playlist can't be opened. Spotify's own editorial and algorithmic playlists (Today's Top Hits, RapCaviar, Discover Weekly — links starting with 37i9) require a personal Spotify login that this app doesn't use, following a Spotify API change in late 2024. Playlists created by regular users still work."
            : "This playlist can't be opened. It's either private or no longer exists. Spotify credentials identify this app, not you, so only public playlists can be read, and a private playlist stays invisible even when it's your own. In Spotify, open the playlist, choose Make public, then analyze the link again."
        }, 404)
      } else if (status === 429 || status >= 500) {
        // Transient — makeRequest already retried; tell the user to retry.
        this.sendJSON(res, {
          error: status === 429
            ? 'Spotify is rate-limiting requests right now. Wait a moment and try again.'
            : 'Spotify is temporarily unavailable. Please try again in a moment.'
        }, 503)
      } else {
        this.sendJSON(res, { error: msg }, status >= 400 ? status : 500)
      }
    }
  }

  // Live per-conversion progress, keyed by a client-supplied token. The convert
  // request itself stays a normal request/response; the client polls
  // /api/spotify/convert-progress against this map so a long playlist match
  // shows real "N / total" movement instead of a motionless "Converting...".
  private conversionProgress = new Map<string, { current: number; total: number }>()

  private handleConversionProgress(url: URL, res: ServerResponse): void {
    const token = url.searchParams.get('token') || ''
    const p = this.conversionProgress.get(token)
    this.sendJSON(res, p || { current: 0, total: 0 })
  }

  private async handleSpotifyConvert(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let progressToken = ''
    try {
      const body = await this.parseBody(req)
      const { type, id, fallbackSearch = true } = body
      progressToken = typeof body.progressToken === 'string' ? body.progressToken : ''
      // 2.4: the Link Analyzer can resolve a Spotify link against Deezer (the
      // default), Qobuz, or 'both' (the cross-service availability matrix).
      const targetService: 'deezer' | 'qobuz' | 'both' =
        body.targetService === 'qobuz' ? 'qobuz'
        : body.targetService === 'both' ? 'both'
        : 'deezer'

      if (!type || !id) {
        this.sendJSON(res, { error: 'Type and ID are required' }, 400)
        return
      }

      if (!spotifyAPI.hasCredentials()) {
        this.sendJSON(res, { error: 'Spotify credentials not configured' }, 401)
        return
      }

      // Each target service needs its own live session. Guard whichever one we
      // are actually converting to, with a clear message for the Qobuz case.
      // 'both' compares the two, so it needs both connected (Qobuz matching
      // needs a session, and downloading from either needs that service live).
      if (targetService === 'both' && (!deezerAuth.isLoggedIn() || !qobuzAuth.isLoggedIn())) {
        this.sendJSON(res, { error: 'Comparing both services needs Deezer and Qobuz both connected. Connect them in Settings, or pick a single service.' }, 401)
        return
      }
      if (targetService === 'deezer' && !deezerAuth.isLoggedIn()) {
        this.sendJSON(res, { error: 'Deezer authentication required' }, 401)
        return
      }
      if (targetService === 'qobuz' && !qobuzAuth.isLoggedIn()) {
        this.sendJSON(res, { error: 'Connect Qobuz first to convert to Qobuz. Add your Qobuz credentials in Settings.' }, 401)
        return
      }

      // Configure converter
      spotifyConverter.setFallbackSearch(fallbackSearch)

      // Resolve the Spotify link to a flat track list, uniformly for both
      // services. The Deezer convertAlbum/convertPlaylist helpers did this same
      // extraction internally; hoisting it here lets one path feed either
      // service's matcher.
      let tracks: any[] = []
      switch (type) {
        case 'track':
          tracks = [await spotifyAPI.getTrack(id)]
          break
        case 'album': {
          const album = await spotifyAPI.getAlbum(id)
          tracks = (album.tracks?.items || []).filter((t: any) => t && t.id)
          break
        }
        case 'playlist': {
          const playlist = await spotifyAPI.getPlaylist(id)
          tracks = (playlist.tracks?.items || []).map((i: any) => i.track).filter((t: any) => t && t.id)
          break
        }
        case 'artist':
          tracks = await spotifyAPI.getArtistTopTracks(id)
          break
        default:
          this.sendJSON(res, { error: 'Unsupported content type' }, 400)
          return
      }

      // Neutralize a raw Deezer track into the shared match shape the
      // multi-service UI reads, while we still return the legacy `deezer` field
      // so the existing download path keeps working unchanged.
      const deezerToNeutral = (d: any) => ({
        service: 'deezer',
        id: d.id,
        title: d.title,
        artist: d.artist || { id: 0, name: 'Unknown Artist' },
        album: { id: d.album?.id || 0, title: d.album?.title || '', cover: d.album?.cover_medium || '' },
        duration: d.duration || 0
      })
      const spotifyBrief = (t: any) => ({
        id: t.id,
        name: t.name,
        artist: t.artists?.[0]?.name,
        album: t.album?.name
      })

      // Publish live progress to the poll map if the client sent a token.
      if (progressToken) this.conversionProgress.set(progressToken, { current: 0, total: tracks.length })
      const onProgress = progressToken
        ? (current: number, total: number) => this.conversionProgress.set(progressToken, { current, total })
        : undefined

      // 'both' returns a per-track availability matrix (Deezer + Qobuz) plus a
      // summary tally, rather than a single-service matched list.
      if (targetService === 'both') {
        const result = await spotifyConverter.convertTracksBoth(tracks, onProgress)
        this.sendJSON(res, {
          service: 'both',
          matched: result.matched.map(m => ({
            spotify: spotifyBrief(m.spotifyTrack),
            deezer: m.deezer, // service-neutral MatchInfo | null
            qobuz: m.qobuz
          })),
          unmatched: result.unmatched.map((t: any) => ({
            id: t.id,
            name: t.name,
            artist: t.artists?.[0]?.name,
            album: t.album?.name
          })),
          summary: result.summary,
          matchRate: result.matchRate,
          total: result.matched.length + result.unmatched.length
        })
        return
      }

      let matched: any[]
      let unmatched: any[]
      let matchRate: number

      if (targetService === 'qobuz') {
        const result = await spotifyConverter.convertTracksToQobuz(tracks, onProgress)
        matchRate = result.matchRate
        unmatched = result.unmatched
        matched = result.matched.map(m => ({
          spotify: spotifyBrief(m.spotifyTrack),
          service: 'qobuz',
          match: m.track, // already service-neutral
          deezer: null,   // legacy field stays null on the Qobuz path
          matchType: m.matchType,
          confidence: m.confidence
        }))
      } else {
        const result = await spotifyConverter.convertTracks(tracks, onProgress)
        matchRate = result.matchRate
        unmatched = result.unmatched
        matched = result.matched.map(m => ({
          spotify: spotifyBrief(m.spotifyTrack),
          service: 'deezer',
          match: m.deezerTrack ? deezerToNeutral(m.deezerTrack) : null,
          deezer: m.deezerTrack ? {
            id: m.deezerTrack.id,
            title: m.deezerTrack.title,
            artist: m.deezerTrack.artist || { id: 0, name: 'Unknown Artist' },
            album: m.deezerTrack.album || { id: 0, title: '', cover_medium: '' },
            duration: m.deezerTrack.duration || 0
          } : null,
          matchType: m.matchType,
          confidence: m.confidence
        }))
      }

      this.sendJSON(res, {
        service: targetService,
        matched,
        unmatched: unmatched.map((t: any) => ({
          id: t.id,
          name: t.name,
          artist: t.artists?.[0]?.name,
          album: t.album?.name
        })),
        matchRate,
        total: matched.length + unmatched.length
      })
    } catch (error: any) {
      console.error('[Server] Spotify convert error:', error.message)
      // A Deezer rate-limit surviving the converter's retries means the matches
      // are incomplete, not absent — say so, so the user retries instead of
      // concluding Deezer doesn't have the playlist.
      if (error?.name === 'DeezerQuotaError') {
        this.sendJSON(res, {
          error: 'Deezer is rate-limiting matching requests right now. Wait a moment and try the conversion again.'
        }, 503)
        return
      }
      // Spotify served the playlist without its contents (February 2026 Web API
      // change). A 200 carrying no songs is not a conversion failure, so it
      // gets its own explanation rather than "Conversion failed".
      if (error instanceof SpotifyContentsUnavailableError) {
        this.sendJSON(res, { error: describeSpotifyError(error, id) }, 422)
        return
      }
      this.sendJSON(res, { error: error.message || 'Conversion failed' }, 500)
    } finally {
      if (progressToken) this.conversionProgress.delete(progressToken)
    }
  }

  // ==================== End Spotify Handlers ====================

  // ==================== Playlist Sync Handlers ====================

  private handleGetSyncPlaylists(res: ServerResponse): void {
    const playlists = playlistSync.getPlaylists()
    const activeSyncIds = playlistSync.getActiveSyncIds()
    const lastFavoritesRefreshAt = playlistSync.getLastFavoritesRefreshAt()
    this.sendJSON(res, { playlists, activeSyncIds, lastFavoritesRefreshAt })
  }

  private async handleAddSyncPlaylist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { source, sourcePlaylistId, sourcePlaylistName, sourcePlaylistUrl, schedule, downloadPath, origin } = body

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
        downloadPath: downloadPath || this.settings.downloadPath || '',
        // Preserve favorites-origin tagging so the "no longer in your Deezer
        // favorites" prompt fires for entries pinned from the Favorites view
        // (was silently dropped by the destructure before).
        ...(origin === 'favorites' || origin === 'manual' ? { origin } : {})
      })

      this.sendJSON(res, { success: true, playlist })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to add playlist' }, 500)
    }
  }

  // Bulk add — one HTTP call adds N playlists in one engine pass, one save,
  // one rate-limit budget hit. Replaces the N-roundtrip favorites-sync loop
  // that got truncated by the 120/60s 'sync' rate limit (issue #70).
  private async handleAddSyncPlaylistsBulk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const items = Array.isArray(body?.items) ? body.items : null
      if (!items) {
        this.sendJSON(res, { error: 'Missing or invalid items array' }, 400)
        return
      }
      // Sanity cap — protects against accidental megabatch + the 1MB body
      // limit. 500 favorites per call is well under both ceilings; larger
      // libraries can chunk client-side without losing the bulk efficiency.
      if (items.length > MAX_BULK_ITEMS) {
        this.sendJSON(res, { error: `Bulk batch too large; chunk to <=${MAX_BULK_ITEMS} items per request` }, 400)
        return
      }
      const normalized = items.map((it: any) => ({
        source: it.source,
        sourcePlaylistId: String(it.sourcePlaylistId ?? ''),
        sourcePlaylistName: String(it.sourcePlaylistName ?? ''),
        sourcePlaylistUrl: String(it.sourcePlaylistUrl ?? ''),
        schedule: it.schedule || '24h',
        downloadPath: it.downloadPath || this.settings.downloadPath || '',
        origin: (it.origin === 'favorites' || it.origin === 'manual') ? it.origin : 'manual'
      }))
      const results = await playlistSync.addPlaylistsBulk(normalized)
      const added = results.filter(r => r.ok).length
      const failed = results.length - added
      this.sendJSON(res, { success: true, added, failed, results })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to bulk-add playlists' }, 500)
    }
  }

  // Restore — replaces the entire playlist sync state from a backup file.
  // Used by the backup/restore feature (#72). CRITICAL: does NOT fire initial
  // syncs for restored entries; the backup carries `knownTrackIds` and
  // `lastSyncAt`, so the engine should treat restored entries as already-known.
  private async handleRestoreSyncPlaylists(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const playlists = Array.isArray(body?.playlists) ? body.playlists : null
      if (!playlists) {
        this.sendJSON(res, { error: 'Missing or invalid playlists array' }, 400)
        return
      }
      // Same MAX_BULK_ITEMS ceiling as the bulk-add path — guards against
      // megabatches pushing past MAX_BODY_SIZE.
      if (playlists.length > MAX_BULK_ITEMS) {
        this.sendJSON(res, { error: `Restore batch too large; chunk to <=${MAX_BULK_ITEMS} items per request` }, 400)
        return
      }
      const result = await playlistSync.replaceState(playlists)
      this.sendJSON(res, { success: true, ...result })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to restore playlists' }, 500)
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
        // Request-supplied id passed as an argument, not interpolated into the
        // format string (CodeQL #19: tainted format string / log forgery).
        console.error('[Server] Sync failed for playlist:', logSafe(id), logSafe((err as any)?.message ?? err))
      )

      this.sendJSON(res, { success: true, message: 'Sync started' })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to start sync' }, 500)
    }
  }

  private async handleResetSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id } = body

      if (!id) {
        this.sendJSON(res, { error: 'Missing playlist id' }, 400)
        return
      }

      const success = await playlistSync.resetPlaylist(id)
      if (success) {
        this.sendJSON(res, { success: true, message: 'Playlist reset — next sync will re-download all tracks' })
      } else {
        this.sendJSON(res, { error: 'Playlist not found' }, 404)
      }
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to reset playlist' }, 500)
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
    const lastFavoritesRefreshAt = playlistSync.getLastFavoritesRefreshAt()
    this.sendJSON(res, { playlists, activeSyncIds, lastFavoritesRefreshAt })
  }

  private async handleResolveShareUrl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { url } = body
      if (!url) {
        this.sendJSON(res, { error: 'URL is required' }, 400)
        return
      }

      // Follow redirects to resolve share links to their final URL (SSRF-safe)
      const resolvedUrl = await followRedirectsSafely(url)

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

  // ==================== Artist Sync Handlers ====================

  private handleGetSyncArtists(res: ServerResponse): void {
    const artists = artistSync.getArtists()
    const activeSyncIds = artistSync.getActiveSyncIds()
    const lastFavoritesRefreshAt = artistSync.getLastFavoritesRefreshAt()
    this.sendJSON(res, { artists, activeSyncIds, lastFavoritesRefreshAt })
  }

  private async handleAddSyncArtist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { sourceArtistId, sourceArtistName, sourceArtistUrl, schedule, downloadPath, firstSyncMode, filters, origin } = body
      if (!sourceArtistId || !sourceArtistName) {
        this.sendJSON(res, { error: 'Missing required fields: sourceArtistId, sourceArtistName' }, 400)
        return
      }
      const validModes: FirstSyncMode[] = ['subscribe-forward', 'download-backlog', 'date-threshold']
      const mode: FirstSyncMode = validModes.includes(firstSyncMode) ? firstSyncMode : 'subscribe-forward'

      const artist = await artistSync.addArtist({
        sourceArtistId: String(sourceArtistId),
        sourceArtistName: String(sourceArtistName),
        sourceArtistUrl: String(sourceArtistUrl || `https://www.deezer.com/artist/${sourceArtistId}`),
        schedule: schedule || '24h',
        downloadPath: downloadPath || this.settings.downloadPath || '',
        firstSyncMode: mode,
        filters: filters as Partial<ArtistSyncFilters> | undefined,
        // Preserve favorites-origin tagging — same fix as the playlist handler.
        ...(origin === 'favorites' || origin === 'manual' ? { origin } : {})
      })
      this.sendJSON(res, { success: true, artist })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to add artist' }, 500)
    }
  }

  private async handleAddSyncArtistsBulk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const items = Array.isArray(body?.items) ? body.items : null
      if (!items) {
        this.sendJSON(res, { error: 'Missing or invalid items array' }, 400)
        return
      }
      if (items.length > MAX_BULK_ITEMS) {
        this.sendJSON(res, { error: `Bulk batch too large; chunk to <=${MAX_BULK_ITEMS} items per request` }, 400)
        return
      }
      const validModes: FirstSyncMode[] = ['subscribe-forward', 'download-backlog', 'date-threshold']
      const normalized = items.map((it: any) => ({
        sourceArtistId: String(it.sourceArtistId ?? ''),
        sourceArtistName: String(it.sourceArtistName ?? ''),
        sourceArtistUrl: String(it.sourceArtistUrl || `https://www.deezer.com/artist/${it.sourceArtistId ?? ''}`),
        schedule: it.schedule || '24h',
        downloadPath: it.downloadPath || this.settings.downloadPath || '',
        firstSyncMode: (validModes.includes(it.firstSyncMode) ? it.firstSyncMode : 'subscribe-forward') as FirstSyncMode,
        filters: it.filters as Partial<ArtistSyncFilters> | undefined,
        origin: (it.origin === 'favorites' || it.origin === 'manual') ? it.origin : 'manual'
      }))
      const results = await artistSync.addArtistsBulk(normalized)
      const added = results.filter(r => r.ok).length
      const failed = results.length - added
      this.sendJSON(res, { success: true, added, failed, results })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to bulk-add artists' }, 500)
    }
  }

  // Restore — see handleRestoreSyncPlaylists for the contract; same shape for
  // artists (#72).
  private async handleRestoreSyncArtists(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const artists = Array.isArray(body?.artists) ? body.artists : null
      if (!artists) {
        this.sendJSON(res, { error: 'Missing or invalid artists array' }, 400)
        return
      }
      if (artists.length > MAX_BULK_ITEMS) {
        this.sendJSON(res, { error: `Restore batch too large; chunk to <=${MAX_BULK_ITEMS} items per request` }, 400)
        return
      }
      const result = await artistSync.replaceState(artists)
      this.sendJSON(res, { success: true, ...result })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to restore artists' }, 500)
    }
  }

  private async handleUpdateSyncArtist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id, ...updates } = body
      if (!id) {
        this.sendJSON(res, { error: 'Missing artist id' }, 400)
        return
      }
      const artist = await artistSync.updateArtist(id, updates)
      if (!artist) {
        this.sendJSON(res, { error: 'Artist not found' }, 404)
        return
      }
      this.sendJSON(res, { success: true, artist })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to update artist' }, 500)
    }
  }

  private async handleDeleteSyncArtist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id } = body
      if (!id) {
        this.sendJSON(res, { error: 'Missing artist id' }, 400)
        return
      }
      await artistSync.removeArtist(id)
      this.sendJSON(res, { success: true })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to delete artist' }, 500)
    }
  }

  private async handleRunSyncArtist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id } = body
      if (!id) {
        this.sendJSON(res, { error: 'Missing artist id' }, 400)
        return
      }
      artistSync.syncArtist(id).catch(err =>
        // Request-supplied id passed as an argument, not interpolated (CodeQL #20).
        console.error('[Server] Artist sync failed for artist:', logSafe(id), logSafe((err as any)?.message ?? err))
      )
      this.sendJSON(res, { success: true, message: 'Artist sync started' })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to start artist sync' }, 500)
    }
  }

  private async handleRunSyncArtistAll(res: ServerResponse): Promise<void> {
    artistSync.syncAll().catch(err =>
      console.error('[Server] Artist sync all failed:', err)
    )
    this.sendJSON(res, { success: true, message: 'Artist sync all started' })
  }

  private async handleResetSyncArtist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id } = body
      if (!id) {
        this.sendJSON(res, { error: 'Missing artist id' }, 400)
        return
      }
      const success = await artistSync.resetArtist(id)
      if (success) {
        this.sendJSON(res, { success: true, message: 'Artist reset — next sync will re-download all matching albums' })
      } else {
        this.sendJSON(res, { error: 'Artist not found' }, 404)
      }
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to reset artist' }, 500)
    }
  }

  private async handleCancelSyncArtist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const { id } = body
      if (!id) {
        this.sendJSON(res, { error: 'Missing artist id' }, 400)
        return
      }
      artistSync.cancelSync(id)
      this.sendJSON(res, { success: true })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to cancel artist sync' }, 500)
    }
  }

  // ==================== End Artist Sync Handlers ====================

  // Cross-engine refresh: takes the renderer's already-fetched Deezer favorites
  // IDs and asks each engine to mark which favorites-origin entries are still
  // present. The renderer is the natural caller because it just made the
  // /api/user/favorites call as part of importDeezerFavorites — no second
  // round trip to Deezer here.
  private async handleRefreshFavoriteMembership(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req)
      const playlistIds: string[] = Array.isArray(body.playlistIds) ? body.playlistIds.map(String) : []
      const artistIds: string[] = Array.isArray(body.artistIds) ? body.artistIds.map(String) : []
      const [playlistsResult, artistsResult] = await Promise.all([
        playlistSync.markFavoriteMembership(playlistIds),
        artistSync.markFavoriteMembership(artistIds)
      ])
      this.sendJSON(res, {
        success: true,
        playlists: playlistsResult,
        artists: artistsResult
      })
    } catch (error: any) {
      this.sendJSON(res, { error: error.message || 'Failed to refresh favorite membership' }, 500)
    }
  }

  updateSettings(settings: Partial<ServerSettings>): void {
    this.settings = { ...this.settings, ...settings }
    // Keep the downloader's global concurrency gate and pacing in sync with the
    // settings (issue #97). The downloader otherwise stays at its constructor
    // default (5 / off) until the renderer's first /api/settings push, so a
    // launch-triggered sync that races startup could briefly run at the default
    // instead of a user-lowered value. Applying here closes that window when the
    // persisted settings are loaded at boot.
    if (settings.maxConcurrentDownloads !== undefined) {
      downloader.setMaxConcurrent(this.settings.maxConcurrentDownloads)
    }
    if (settings.downloadPacing !== undefined) {
      downloader.setPacing(this.settings.downloadPacing)
    }
  }

  getSettings(): ServerSettings {
    return this.settings
  }
}
