import { EventEmitter } from 'events'
import https from 'https'
import crypto from 'crypto'
import { URL } from 'url'
import dns from 'dns'

/** Collapse newlines so remote-supplied text cannot forge extra log lines. */
const logSafe = (v: unknown): string => String(v ?? '').replace(/[\r\n]+/g, ' ')

// Configure DNS to use both IPv4 and IPv6 with IPv4 preferred
// This helps with Electron's DNS resolution issues
dns.setDefaultResultOrder('ipv4first')

// Persistent HTTPS agent for connection pooling (improves performance by 20-30%)
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60000,
  // Force IPv4 to avoid some DNS resolution issues
  family: 4
})

// Helper function to retry operations with exponential backoff
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  operationName: string = 'operation'
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error: any) {
      lastError = error
      // Retry transient network errors AND Deezer rate-limit/quota responses on
      // the gateway path — mirrors the public-API client's quota awareness (#84).
      const msg = (error.message || '').toLowerCase()
      const isRetryable = error.code === 'ENOTFOUND' ||
                          error.code === 'ETIMEDOUT' ||
                          error.code === 'ECONNRESET' ||
                          error.code === 'ECONNREFUSED' ||
                          error.code === 'EAI_AGAIN' ||
                          msg.includes('quota') ||
                          msg.includes('rate limit') ||
                          msg.includes('too many requests')

      if (!isRetryable || attempt === maxRetries) {
        throw error
      }

      // Exponential backoff with jitter so a burst of quota errors doesn't retry
      // in lockstep and re-trip the limit together (issue #84).
      const target = baseDelayMs * Math.pow(2, attempt - 1)
      const delay = Math.round(target * (0.5 + Math.random()))
      console.log(`[DeezerAuth] ${logSafe(operationName)} failed (attempt ${attempt}/${maxRetries}): ${logSafe(error.code || error.message)}. Retrying in ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

export interface DeezerUser {
  id: number
  name: string
  email?: string
  picture?: string
  country?: string
  canStream: boolean
  canDownload: boolean
  subscription?: {
    type: string
    expires?: string
  }
}

export interface StreamingRights {
  canStreamLossless: boolean      // Can stream FLAC
  canStreamHQ: boolean            // Can stream MP3_320
  canDownloadLossless: boolean    // Can download FLAC
  canDownloadHQ: boolean          // Can download MP3_320
  webLossless: boolean            // Web streaming lossless flag
  mobileLossless: boolean         // Mobile streaming lossless flag
  webHQ: boolean                  // Web streaming HQ flag
  mobileHQ: boolean               // Mobile streaming HQ flag
}

export interface DeezerSession {
  arl: string
  sid?: string
  apiToken?: string
  licenseToken?: string
  user?: DeezerUser
  streamingRights?: StreamingRights  // Detailed streaming permissions
  isValid: boolean
  checkedAt: Date
}

export interface CaptchaChallenge {
  required: boolean
  siteKey?: string
  captchaUrl?: string
  captchaToken?: string
  loginToken?: string
}

const DEEZER_API = 'https://www.deezer.com/ajax/gw-light.php'

interface CacheEntry<T> {
  data: T
  expires: number
}

export class DeezerAuth extends EventEmitter {
  private session: DeezerSession | null = null
  private cookies: Map<string, string> = new Map()
  private apiToken: string = ''

  // Request cache to reduce redundant API calls (70-90% reduction for album downloads)
  private trackInfoCache: Map<string, CacheEntry<any>> = new Map()
  private albumInfoCache: Map<string, CacheEntry<any>> = new Map()
  private discographyCache: Map<string, CacheEntry<any>> = new Map()
  private readonly CACHE_TTL = 3600000 // 1 hour

  // CAPTCHA challenge state
  private pendingCaptcha: CaptchaChallenge | null = null
  private pendingLoginCredentials: { email: string; passwordHash: string } | null = null

  // Deezer's reCAPTCHA site key (visible on their login page)
  private readonly RECAPTCHA_SITE_KEY = '6LdHVXwUAAAAAFCZ7r78lwLeK0H50e7DXBdmPMvM'

  // === SESSION KEEP-ALIVE & TTL CONFIGURATION ===
  // Adaptive intervals based on activity level
  private readonly HEARTBEAT_INTERVALS = {
    active: 5 * 60 * 1000,      // 5 min during active downloads
    idle: 15 * 60 * 1000,       // 15 min when idle (original behavior)
    background: 30 * 60 * 1000  // 30 min when in background/minimal use
  }
  private readonly SESSION_VALIDATION_INTERVAL_MS = 15 * 60 * 1000 // Default interval
  private readonly SESSION_EXPIRY_WARNING_MS = 20 * 60 * 60 * 1000 // Warn at 20 hours
  private readonly ACTIVITY_THRESHOLD_MS = 5 * 60 * 1000 // Consider "active" if API call within 5 min

  private sessionValidationTimer: NodeJS.Timeout | null = null
  private currentHeartbeatInterval: number = this.HEARTBEAT_INTERVALS.idle

  // Session health tracking
  private lastActivityAt: Date | null = null
  private consecutiveValidationFailures: number = 0
  private readonly MAX_CONSECUTIVE_FAILURES = 3

  constructor() {
    super()
  }

  /**
   * Record API activity - called on each successful API request
   * This helps determine if session is actively being used
   */
  recordActivity(): void {
    this.lastActivityAt = new Date()
    // Reset failure counter on successful activity
    this.consecutiveValidationFailures = 0
  }

  /**
   * Check if the session has been recently active
   */
  private isSessionActive(): boolean {
    if (!this.lastActivityAt) return false
    return (Date.now() - this.lastActivityAt.getTime()) < this.ACTIVITY_THRESHOLD_MS
  }

  /**
   * Get the optimal heartbeat interval based on current activity
   */
  private getOptimalHeartbeatInterval(): number {
    if (!this.session) return this.HEARTBEAT_INTERVALS.idle

    // If there's been recent activity, use active interval
    if (this.isSessionActive()) {
      return this.HEARTBEAT_INTERVALS.active
    }

    // Check session age - more frequent checks as we approach expiry
    const sessionAge = this.session.checkedAt
      ? Date.now() - this.session.checkedAt.getTime()
      : 0

    // If approaching the 24h limit, check more frequently
    if (sessionAge > this.SESSION_EXPIRY_WARNING_MS) {
      console.log('[DeezerAuth] Session approaching expiry, using active heartbeat')
      return this.HEARTBEAT_INTERVALS.active
    }

    return this.HEARTBEAT_INTERVALS.idle
  }

  /**
   * Get session health information
   */
  getSessionHealth(): {
    isHealthy: boolean
    sessionAge: number | null
    lastActivity: Date | null
    consecutiveFailures: number
    expiresIn: number | null
  } {
    if (!this.session) {
      return {
        isHealthy: false,
        sessionAge: null,
        lastActivity: this.lastActivityAt,
        consecutiveFailures: this.consecutiveValidationFailures,
        expiresIn: null
      }
    }

    const sessionAge = this.session.checkedAt
      ? Date.now() - this.session.checkedAt.getTime()
      : 0

    const expiresIn = this.SESSION_TIMEOUT_MS - sessionAge

    return {
      isHealthy: this.consecutiveValidationFailures < this.MAX_CONSECUTIVE_FAILURES,
      sessionAge,
      lastActivity: this.lastActivityAt,
      consecutiveFailures: this.consecutiveValidationFailures,
      expiresIn: expiresIn > 0 ? expiresIn : 0
    }
  }

  /**
   * Start periodic session validation with adaptive keep-alive
   * Uses dynamic intervals based on activity level and session age
   */
  startPeriodicValidation(): void {
    // Clear any existing timer
    this.stopPeriodicValidation()

    if (!this.session) {
      console.log('[DeezerAuth] Not starting periodic validation - no session')
      return
    }

    // Get optimal interval based on current state
    this.currentHeartbeatInterval = this.getOptimalHeartbeatInterval()
    console.log(`[DeezerAuth] Starting session keep-alive (interval: ${this.currentHeartbeatInterval / 1000}s)`)

    const runHeartbeat = async () => {
      if (!this.session) {
        console.log('[DeezerAuth] Stopping periodic validation - session cleared')
        this.stopPeriodicValidation()
        return
      }

      // Skip validation if there was recent activity (session is already active)
      if (this.isSessionActive()) {
        console.log('[DeezerAuth] Skipping heartbeat - recent activity detected')
        this.scheduleNextHeartbeat()
        return
      }

      console.log('[DeezerAuth] Running session keep-alive heartbeat...')
      try {
        const isValid = await this.validateSession()
        if (!isValid) {
          this.consecutiveValidationFailures++
          console.log(`[DeezerAuth] Heartbeat failed (${this.consecutiveValidationFailures}/${this.MAX_CONSECUTIVE_FAILURES})`)

          if (this.consecutiveValidationFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            console.log('[DeezerAuth] Max consecutive failures reached - session expired')
            this.stopPeriodicValidation()
            return
          }
        } else {
          this.consecutiveValidationFailures = 0
          console.log('[DeezerAuth] Heartbeat successful - session alive')

          // Emit session health update
          this.emit('session-health', this.getSessionHealth())
        }

        // Schedule next heartbeat with potentially adjusted interval
        this.scheduleNextHeartbeat()
      } catch (error: any) {
        console.error('[DeezerAuth] Heartbeat error:', error.message)
        // Track failures for network errors too
        this.consecutiveValidationFailures++

        if (this.consecutiveValidationFailures < this.MAX_CONSECUTIVE_FAILURES) {
          // Retry with shorter interval after error
          this.scheduleNextHeartbeat(this.HEARTBEAT_INTERVALS.active)
        }
      }
    }

    // Initial heartbeat
    this.sessionValidationTimer = setTimeout(runHeartbeat, this.currentHeartbeatInterval)
  }

  /**
   * Schedule the next heartbeat with adaptive interval
   */
  private scheduleNextHeartbeat(overrideInterval?: number): void {
    if (this.sessionValidationTimer) {
      clearTimeout(this.sessionValidationTimer)
    }

    const interval = overrideInterval || this.getOptimalHeartbeatInterval()

    // Log if interval changed
    if (interval !== this.currentHeartbeatInterval) {
      console.log(`[DeezerAuth] Heartbeat interval adjusted: ${this.currentHeartbeatInterval / 1000}s → ${interval / 1000}s`)
      this.currentHeartbeatInterval = interval
    }

    const runHeartbeat = async () => {
      if (!this.session) {
        this.stopPeriodicValidation()
        return
      }

      if (this.isSessionActive()) {
        console.log('[DeezerAuth] Skipping heartbeat - recent activity')
        this.scheduleNextHeartbeat()
        return
      }

      console.log('[DeezerAuth] Running session keep-alive...')
      try {
        const isValid = await this.validateSession()
        if (!isValid) {
          this.consecutiveValidationFailures++
          if (this.consecutiveValidationFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            this.stopPeriodicValidation()
            return
          }
        } else {
          this.consecutiveValidationFailures = 0
          this.emit('session-health', this.getSessionHealth())
        }
        this.scheduleNextHeartbeat()
      } catch (error: any) {
        console.error('[DeezerAuth] Heartbeat error:', error.message)
        this.consecutiveValidationFailures++
        if (this.consecutiveValidationFailures < this.MAX_CONSECUTIVE_FAILURES) {
          this.scheduleNextHeartbeat(this.HEARTBEAT_INTERVALS.active)
        }
      }
    }

    this.sessionValidationTimer = setTimeout(runHeartbeat, interval)
  }

  /**
   * Stop periodic session validation
   */
  stopPeriodicValidation(): void {
    if (this.sessionValidationTimer) {
      clearTimeout(this.sessionValidationTimer)
      this.sessionValidationTimer = null
      console.log('[DeezerAuth] Stopped session keep-alive')
    }
    this.consecutiveValidationFailures = 0
  }

  private getCachedData<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const cached = cache.get(key)
    if (cached && Date.now() < cached.expires) {
      return cached.data
    }
    if (cached) {
      cache.delete(key) // Cleanup expired entry
    }
    return null
  }

  private setCachedData<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
    cache.set(key, { data, expires: Date.now() + this.CACHE_TTL })
    // Cleanup if cache grows too large (LRU-like eviction)
    if (cache.size > 500) {
      const now = Date.now()
      for (const [k, v] of cache) {
        if (now > v.expires) cache.delete(k)
        if (cache.size <= 400) break
      }
    }
  }

  /**
   * Get initial cookies from Deezer homepage
   */
  private getInitialCookies(): Promise<void> {
    return withRetry(() => this.getInitialCookiesInternal(), 3, 1000, 'getInitialCookies')
  }

  private getInitialCookiesInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[DeezerAuth] Getting initial cookies from deezer.com...')

      const req = https.request('https://www.deezer.com/', {
        method: 'GET',
        agent: httpsAgent,
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      }, (res) => {
        const setCookie = res.headers['set-cookie']
        if (setCookie) {
          setCookie.forEach(cookie => {
            const [nameValue] = cookie.split(';')
            const eqIdx = nameValue.indexOf('=')
            if (eqIdx > 0) {
              const name = nameValue.substring(0, eqIdx).trim()
              const value = nameValue.substring(eqIdx + 1).trim()
              this.cookies.set(name, value)
            }
          })
        }
        console.log('[DeezerAuth] Got cookies:', Array.from(this.cookies.keys()).join(', '))

        // Consume response body
        res.on('data', () => {})
        res.on('end', resolve)
      })

      req.on('timeout', () => {
        req.destroy()
        const error = new Error('Request timeout') as any
        error.code = 'ETIMEDOUT'
        reject(error)
      })

      req.on('error', (err) => {
        console.error('[DeezerAuth] Failed to get initial cookies:', logSafe(err?.message ?? err))
        reject(err)
      })
      req.end()
    })
  }

  async login(arl: string): Promise<DeezerSession> {
    if (!arl || arl.length < 100) {
      throw new Error('Invalid ARL token format. ARL should be at least 100 characters.')
    }

    console.log('[DeezerAuth] Starting login with ARL...')

    try {
      // Clear all existing cookies before login to prevent state conflicts
      // This is critical when re-logging in after session expiration
      // Old cookies (sid, session, etc.) can cause "Your details are incorrect" errors
      this.cookies.clear()
      this.apiToken = ''
      console.log('[DeezerAuth] Cleared existing cookies and API token')

      // Set ONLY the ARL cookie - no need to fetch initial cookies from homepage
      // This matches how deemix-gui handles login: just set ARL and make API call
      // Fetching homepage cookies can set "anonymous" state that conflicts with ARL auth
      this.cookies.set('arl', arl)
      console.log('[DeezerAuth] ARL cookie set, making API call...')

      // Make API call
      const userData = await this.rawApiCall('deezer.getUserData', {})

      if (!userData) {
        throw new Error('No response from Deezer API')
      }

      if (!userData.results) {
        // Security: Don't log full API response - may contain sensitive data
        console.error('[DeezerAuth] Unexpected API response structure (results missing)')
        throw new Error('Invalid API response from Deezer')
      }

      if (userData.results.USER?.USER_ID === 0 || !userData.results.USER?.USER_ID) {
        console.log('[DeezerAuth] USER_ID is 0 or missing - ARL invalid or expired')
        throw new Error('Invalid or expired ARL token')
      }

      const user = userData.results.USER
      const userOptions = userData.results.OFFER_INFOS

      console.log('[DeezerAuth] Login successful for user:', user.USER_ID)

      // Store the API token for subsequent calls
      if (userData.results.checkForm) {
        this.apiToken = userData.results.checkForm
      }

      // Extract license token and streaming rights from USER.OPTIONS
      const streamingOptions = userData.results.USER?.OPTIONS || {}
      const licenseToken = streamingOptions.license_token

      // Extract streaming rights - these determine what quality we can download
      // Use web_*/mobile_* flags which correctly indicate subscription tier capabilities
      const hasLossless = !!streamingOptions.web_lossless || !!streamingOptions.mobile_lossless
      const hasHQ = !!streamingOptions.web_hq || !!streamingOptions.mobile_hq

      const streamingRights: StreamingRights = {
        // Capability flags from API
        webLossless: !!streamingOptions.web_lossless,
        mobileLossless: !!streamingOptions.mobile_lossless,
        webHQ: !!streamingOptions.web_hq,
        mobileHQ: !!streamingOptions.mobile_hq,
        // Streaming/download permissions based on subscription tier
        canStreamLossless: hasLossless,
        canStreamHQ: hasHQ,
        canDownloadLossless: hasLossless,
        canDownloadHQ: hasHQ
      }

      // Log streaming rights for debugging
      console.log('[DeezerAuth] License token present:', !!licenseToken, 'length:', licenseToken?.length || 0)
      console.log('[DeezerAuth] Streaming rights:', JSON.stringify(streamingRights))
      console.log('[DeezerAuth] web_hq:', streamingOptions.web_hq, 'web_lossless:', streamingOptions.web_lossless)

      this.session = {
        arl,
        sid: userData.results.SESSION_ID,
        apiToken: this.apiToken,
        licenseToken: licenseToken,
        streamingRights,  // Store detailed streaming permissions
        user: {
          id: parseInt(user.USER_ID),
          name: user.BLOG_NAME || user.USER_ID.toString(),
          email: user.EMAIL,
          picture: user.USER_PICTURE
            ? `https://e-cdns-images.dzcdn.net/images/user/${user.USER_PICTURE}/250x250-000000-80-0-0.jpg`
            : undefined,
          country: user.SETTING?.global?.language?.country || user.COUNTRY,
          canStream: streamingRights.canStreamHQ || streamingRights.canStreamLossless,
          canDownload: true,
          subscription: {
            type: userData.results.OFFER_INFOS?.OFFER_NAME || (streamingRights.canStreamLossless ? 'HiFi' : streamingRights.canStreamHQ ? 'Premium' : 'Free'),
            expires: userData.results.OFFER_INFOS?.EXPIRE_DATE
          }
        },
        isValid: true,
        checkedAt: new Date()
      }

      // Store session cookie
      if (userData.results.SESSION_ID) {
        this.cookies.set('sid', userData.results.SESSION_ID)
      }

      // Start periodic session validation
      this.startPeriodicValidation()

      this.emit('login', this.session)
      return this.session

    } catch (error: any) {
      console.error('[DeezerAuth] Login failed:', logSafe(error.message))
      this.session = null
      this.cookies.clear()
      this.apiToken = ''
      throw error
    }
  }

  async loginWithEmail(email: string, password: string): Promise<DeezerSession | CaptchaChallenge> {
    if (!email || !password) {
      throw new Error('Email and password are required')
    }

    console.log('[DeezerAuth] Starting email login...')

    try {
      // Clear all existing cookies before login to prevent state conflicts
      // This is critical when re-logging in after session expiration
      this.cookies.clear()
      this.apiToken = ''
      console.log('[DeezerAuth] Cleared existing cookies and API token')

      // First get initial cookies from fresh state
      await this.getInitialCookies()

      // Get an initial API token
      const initialData = await this.rawApiCall('deezer.getUserData', {})
      if (initialData?.results?.checkForm) {
        this.apiToken = initialData.results.checkForm
      }

      console.log('[DeezerAuth] Got initial API token, attempting email login...')

      // Hash the password
      const passwordHash = crypto.createHash('md5').update(password, 'utf8').digest('hex')

      // Store credentials for potential CAPTCHA retry
      this.pendingLoginCredentials = { email, passwordHash }

      // Attempt email login
      const authResponse = await this.emailLogin(email, passwordHash)

      // Check if CAPTCHA is required
      if (authResponse.captchaRequired) {
        console.log('[DeezerAuth] CAPTCHA required for login')
        this.pendingCaptcha = {
          required: true,
          siteKey: this.RECAPTCHA_SITE_KEY,
          captchaUrl: 'https://www.deezer.com/login',
          captchaToken: authResponse.captchaToken,
          loginToken: authResponse.loginToken
        }
        return this.pendingCaptcha
      }

      if (authResponse.error || !authResponse.arl) {
        throw new Error(authResponse.error?.message || 'Login failed - check your email and password')
      }

      console.log('[DeezerAuth] Email login successful, got ARL')

      // Clear pending credentials on success
      this.pendingLoginCredentials = null
      this.pendingCaptcha = null

      // Use the returned ARL to complete login
      return await this.login(authResponse.arl)

    } catch (error: any) {
      console.error('[DeezerAuth] Email login failed:', logSafe(error.message))
      this.session = null
      throw error
    }
  }

  /**
   * Complete login with CAPTCHA solution
   */
  async loginWithCaptcha(captchaResponse: string): Promise<DeezerSession> {
    if (!this.pendingLoginCredentials) {
      throw new Error('No pending login - please start login process first')
    }

    const { email, passwordHash } = this.pendingLoginCredentials

    console.log('[DeezerAuth] Completing login with CAPTCHA solution...')

    try {
      // Attempt email login with CAPTCHA response
      const authResponse = await this.emailLogin(email, passwordHash, captchaResponse)

      if (authResponse.captchaRequired) {
        throw new Error('CAPTCHA verification failed - please try again')
      }

      if (authResponse.error || !authResponse.arl) {
        throw new Error(authResponse.error?.message || 'Login failed after CAPTCHA')
      }

      console.log('[DeezerAuth] Login with CAPTCHA successful, got ARL')

      // Clear pending state
      this.pendingLoginCredentials = null
      this.pendingCaptcha = null

      // Use the returned ARL to complete login
      return await this.login(authResponse.arl)

    } catch (error: any) {
      console.error('[DeezerAuth] CAPTCHA login failed:', logSafe(error.message))
      throw error
    }
  }

  /**
   * Check if there's a pending CAPTCHA challenge
   */
  getPendingCaptcha(): CaptchaChallenge | null {
    return this.pendingCaptcha
  }

  /**
   * Clear pending CAPTCHA state
   */
  clearPendingCaptcha(): void {
    this.pendingCaptcha = null
    this.pendingLoginCredentials = null
  }

  private emailLogin(
    email: string,
    passwordHash: string,
    captchaResponse?: string
  ): Promise<{
    arl?: string
    error?: { message: string }
    captchaRequired?: boolean
    captchaToken?: string
    loginToken?: string
  }> {
    return new Promise((resolve, reject) => {
      const params: Record<string, string> = {
        type: 'login',
        mail: email,
        password: passwordHash,
        checkFormLogin: this.apiToken || 'null'
      }

      // Include CAPTCHA response if provided
      if (captchaResponse) {
        params['g-recaptcha-response'] = captchaResponse
        params['recaptcha-response'] = captchaResponse
      }

      const postData = new URLSearchParams(params).toString()

      console.log('[DeezerAuth] Sending email login request...')

      const req = https.request('https://www.deezer.com/ajax/action.php', {
        method: 'POST',
        agent: httpsAgent,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'Cookie': this.getCookieString(),
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Origin': 'https://www.deezer.com',
          'Referer': 'https://www.deezer.com/login'
        }
      }, (res) => {
        let data = ''

        console.log('[DeezerAuth] Email login response status:', res.statusCode)

        // Extract cookies - importantly the ARL
        const setCookie = res.headers['set-cookie']
        let arl: string | undefined

        if (setCookie) {
          setCookie.forEach(cookie => {
            const [nameValue] = cookie.split(';')
            const eqIdx = nameValue.indexOf('=')
            if (eqIdx > 0) {
              const name = nameValue.substring(0, eqIdx).trim()
              const value = nameValue.substring(eqIdx + 1).trim()
              this.cookies.set(name, value)
              if (name === 'arl' && value && value.length > 50) {
                arl = value
              }
            }
          })
        }

        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          // Security: Don't log response content - may contain sensitive session data
          console.log('[DeezerAuth] Email login response received, status:', res.statusCode, 'length:', data.length)

          if (arl) {
            resolve({ arl })
            return
          }

          // Try to parse response to check for CAPTCHA requirement
          try {
            const json = JSON.parse(data)
            console.log('[DeezerAuth] Login response type:', typeof json, 'keys:', Object.keys(json || {}))

            // Check for CAPTCHA requirement - Deezer returns various indicators
            if (json.error) {
              const errorStr = typeof json.error === 'string' ? json.error.toLowerCase() : JSON.stringify(json.error).toLowerCase()

              // Check for CAPTCHA-related errors
              if (errorStr.includes('captcha') ||
                  errorStr.includes('recaptcha') ||
                  json.error === 'CAPTCHA_NEEDED' ||
                  json.error === 'NEED_CAPTCHA_SOLVE' ||
                  json.error?.code === 'captcha') {
                console.log('[DeezerAuth] CAPTCHA required detected from error')
                resolve({
                  captchaRequired: true,
                  captchaToken: json.captcha_token || json.token,
                  loginToken: json.login_token
                })
                return
              }

              resolve({ error: { message: typeof json.error === 'string' ? json.error : 'Login failed' } })
              return
            }

            // Check for explicit CAPTCHA fields in response
            if (json.need_captcha || json.captcha_required || json.NEED_CAPTCHA) {
              console.log('[DeezerAuth] CAPTCHA required detected from response fields')
              resolve({
                captchaRequired: true,
                captchaToken: json.captcha_token || json.token,
                loginToken: json.login_token
              })
              return
            }

            // No ARL received and no explicit error - likely CAPTCHA required
            // Deezer often silently requires CAPTCHA without clear indication
            console.log('[DeezerAuth] No ARL in JSON response without error - assuming CAPTCHA required')
            resolve({ captchaRequired: true })
          } catch {
            // Check raw response for CAPTCHA indicators
            const lowerData = data.toLowerCase()

            if (lowerData.includes('captcha') ||
                lowerData.includes('recaptcha') ||
                lowerData.includes('g-recaptcha') ||
                lowerData.includes('need_captcha')) {
              console.log('[DeezerAuth] CAPTCHA required detected from response content')
              resolve({ captchaRequired: true })
              return
            }

            if (lowerData.includes('wrong password') || lowerData.includes('invalid password') || lowerData.includes('invalid credentials')) {
              resolve({ error: { message: 'Invalid email or password' } })
            } else {
              // No ARL and no clear password error - assume CAPTCHA is required
              // This is the most common reason for no ARL without explicit error
              console.log('[DeezerAuth] No ARL received without clear error - assuming CAPTCHA required')
              resolve({ captchaRequired: true })
            }
          }
        })
      })

      req.on('error', (err) => {
        console.error('[DeezerAuth] Email login request error:', logSafe(err?.message ?? err))
        reject(err)
      })
      req.write(postData)
      req.end()
    })
  }

  logout(): void {
    console.log('[DeezerAuth] Logging out - clearing session data')

    // Stop periodic validation when logging out
    this.stopPeriodicValidation()

    // Clear session state (but preserve content caches for download history)
    this.session = null
    this.cookies.clear()
    this.apiToken = ''

    // Reset activity tracking
    this.lastActivityAt = null
    this.consecutiveValidationFailures = 0

    // NOTE: Track, album, and discography caches are intentionally NOT cleared
    // This preserves download history visibility in the Downloads tab

    this.emit('logout')
  }

  // Session timeout: 24 hours (sessions should be refreshed periodically)
  private readonly SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000

  getSession(): DeezerSession | null {
    // Check if session has timed out
    if (this.session && this.isSessionExpired()) {
      console.log('[DeezerAuth] Session expired, logging out')
      this.logout()
      return null
    }
    return this.session
  }

  private isSessionExpired(): boolean {
    if (!this.session?.checkedAt) return false
    const sessionAge = Date.now() - this.session.checkedAt.getTime()
    return sessionAge > this.SESSION_TIMEOUT_MS
  }

  isLoggedIn(): boolean {
    if (!this.session || !this.session.isValid) return false
    // Also check for session timeout
    if (this.isSessionExpired()) {
      console.log('[DeezerAuth] Session expired during login check')
      this.logout()
      return false
    }
    return true
  }

  /**
   * Validate the current session by making an API call to Deezer
   * Returns true if the session is still valid, false if expired/invalid
   * This should be called periodically or before important operations
   */
  async validateSession(): Promise<boolean> {
    if (!this.session || !this.session.arl) {
      console.log('[DeezerAuth] validateSession: No session to validate')
      return false
    }

    try {
      console.log('[DeezerAuth] Validating session with API call...')
      const userData = await this.rawApiCall('deezer.getUserData', {})

      if (!userData?.results) {
        console.log('[DeezerAuth] validateSession: Invalid API response')
        this.handleAuthExpired('Invalid API response during validation')
        return false
      }

      // Check if USER_ID is 0 or missing - this indicates expired/invalid token
      if (userData.results.USER?.USER_ID === 0 || !userData.results.USER?.USER_ID) {
        console.log('[DeezerAuth] validateSession: USER_ID is 0 or missing - token expired')
        this.handleAuthExpired('ARL token has expired')
        return false
      }

      // Update the checkedAt timestamp since we just validated
      this.session.checkedAt = new Date()
      console.log('[DeezerAuth] validateSession: Session is valid')
      return true
    } catch (error: any) {
      console.error('[DeezerAuth] validateSession error:', logSafe(error.message))
      // Don't immediately invalidate on network errors - could be temporary
      if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
        console.log('[DeezerAuth] validateSession: Network error, keeping session')
        return true // Assume valid on network error
      }
      this.handleAuthExpired(error.message)
      return false
    }
  }

  /**
   * Handle authentication expiration - logout and emit event
   * NOTE: Track/album/discography caches are intentionally preserved
   * to maintain download history across sessions
   */
  private handleAuthExpired(reason: string): void {
    console.log('[DeezerAuth] Auth expired:', logSafe(reason))
    const wasLoggedIn = this.session !== null

    // Stop periodic validation
    this.stopPeriodicValidation()

    // Clear session state (but preserve content caches for download history)
    this.session = null
    // Clear ALL cookies, not just ARL, to prevent state conflicts on re-login
    // This fixes the "Your details are incorrect" error when re-logging in
    this.cookies.clear()
    this.apiToken = ''

    // Reset activity tracking
    this.lastActivityAt = null
    this.consecutiveValidationFailures = 0

    // NOTE: Track, album, and discography caches are intentionally NOT cleared
    // This preserves download history visibility in the Downloads tab

    if (wasLoggedIn) {
      this.emit('auth-expired', { reason })
    }
  }

  /**
   * Check if an error indicates authentication failure
   * Be conservative to avoid false positives from geo-restrictions or track availability issues
   */
  isAuthError(error: any): boolean {
    if (!error) return false
    const message = (error.message || '').toLowerCase()
    return (
      // HTTP status codes
      message.includes('401') ||
      message.includes('403') ||
      // Specific auth-related phrases
      message.includes('unauthorized') ||
      message.includes('license token required') ||
      message.includes('no license token') ||
      message.includes('session expired') ||
      message.includes('token expired') ||
      message.includes('invalid arl') ||
      message.includes('expired arl') ||
      message.includes('auth_required') ||
      message.includes('please log in again') ||
      // Additional Deezer-specific auth error patterns
      message.includes('invalid_token') ||
      message.includes('token_invalid') ||
      message.includes('no valid session') ||
      message.includes('authentication failed') ||
      message.includes('not authenticated') ||
      message.includes('login required') ||
      message.includes('user_id') && message.includes('0') || // USER_ID: 0 indicates auth issue
      message.includes('invalid session') ||
      message.includes('session invalid') ||
      // Deezer API specific error codes
      message.includes('data_exception') && message.includes('session') ||
      message.includes('invalid_credential') ||
      message.includes('wrong_credentials')
    )
  }

  /**
   * Enhanced auth error detection that also validates session when errors are ambiguous
   * Call this for errors that might be auth-related but aren't clearly marked
   */
  async isAuthErrorWithValidation(error: any): Promise<boolean> {
    // First check if it's a clear auth error
    if (this.isAuthError(error)) {
      return true
    }

    // For ambiguous errors like "Failed to get track info", validate the session
    const message = (error?.message || '').toLowerCase()
    const isAmbiguousError = (
      message.includes('failed to get') ||
      message.includes('no data returned') ||
      message.includes('unexpected empty response') ||
      message.includes('invalid response')
    )

    if (isAmbiguousError && this.session) {
      console.log('[DeezerAuth] Ambiguous error detected, validating session...')
      const isValid = await this.validateSession()
      if (!isValid) {
        console.log('[DeezerAuth] Session validation failed - treating as auth error')
        return true
      }
    }

    return false
  }

  getArl(): string | null {
    return this.session?.arl || null
  }

  /**
   * Get the user's streaming rights
   * Returns null if not logged in
   */
  getStreamingRights(): StreamingRights | null {
    return this.session?.streamingRights || null
  }

  /**
   * Check if the user can download in the requested quality
   * Returns the best available quality the user can actually download
   */
  getBestAvailableQuality(requestedQuality: 'FLAC' | 'MP3_320' | 'MP3_128'): 'FLAC' | 'MP3_320' | 'MP3_128' {
    const rights = this.session?.streamingRights

    if (!rights) {
      console.log('[DeezerAuth] No streaming rights available, defaulting to MP3_128')
      return 'MP3_128'
    }

    if (requestedQuality === 'FLAC') {
      if (rights.canDownloadLossless) {
        return 'FLAC'
      }
      console.log('[DeezerAuth] User does not have lossless rights, falling back to MP3_320')
      if (rights.canDownloadHQ) {
        return 'MP3_320'
      }
      console.log('[DeezerAuth] User does not have HQ rights, falling back to MP3_128')
      return 'MP3_128'
    }

    if (requestedQuality === 'MP3_320') {
      if (rights.canDownloadHQ) {
        return 'MP3_320'
      }
      console.log('[DeezerAuth] User does not have HQ rights, falling back to MP3_128')
      return 'MP3_128'
    }

    return 'MP3_128'
  }

  getCookieString(): string {
    const cookies: string[] = []
    this.cookies.forEach((value, key) => {
      cookies.push(`${key}=${value}`)
    })
    return cookies.join('; ')
  }

  private rawApiCall(method: string, params: Record<string, any> = {}): Promise<any> {
    // Record activity on API calls to keep session alive
    // This allows heartbeat to skip when there's recent activity
    this.recordActivity()

    return withRetry(
      () => this.rawApiCallInternal(method, params),
      3,
      1000,
      `API call: ${method}`
    )
  }

  private rawApiCallInternal(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(DEEZER_API)
      url.searchParams.set('method', method)
      url.searchParams.set('input', '3')
      url.searchParams.set('api_version', '1.0')
      url.searchParams.set('api_token', this.apiToken || 'null')

      const body = JSON.stringify(params)
      const cookieStr = this.getCookieString()

      console.log('[DeezerAuth] API call:', method)
      console.log('[DeezerAuth] URL:', url.toString())

      const req = https.request(url, {
        method: 'POST',
        agent: httpsAgent,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://www.deezer.com',
          'Referer': 'https://www.deezer.com/'
        }
      }, (res) => {
        let data = ''

        console.log('[DeezerAuth] API response status:', res.statusCode)

        // Extract cookies from response
        const setCookie = res.headers['set-cookie']
        if (setCookie) {
          setCookie.forEach(cookie => {
            const [nameValue] = cookie.split(';')
            const eqIdx = nameValue.indexOf('=')
            if (eqIdx > 0) {
              const name = nameValue.substring(0, eqIdx).trim()
              const value = nameValue.substring(eqIdx + 1).trim()
              this.cookies.set(name, value)
            }
          })
        }

        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          console.log('[DeezerAuth] API response length:', data.length)

          try {
            const json = JSON.parse(data)
            resolve(json)
          } catch (e) {
            console.error('[DeezerAuth] Failed to parse API response')
            console.error('[DeezerAuth] Response starts with:', data.substring(0, 200))

            // If we got HTML, it's likely a captcha or block
            if (data.includes('<!DOCTYPE') || data.includes('<html')) {
              reject(new Error('Deezer returned a webpage instead of API data. This may be due to rate limiting or region restrictions. Please try again later.'))
            } else {
              reject(new Error(`Failed to parse API response: ${data.substring(0, 100)}`))
            }
          }
        })
      })

      req.on('timeout', () => {
        req.destroy()
        const error = new Error('Request timeout') as any
        error.code = 'ETIMEDOUT'
        reject(error)
      })

      req.on('error', (err) => {
        console.error('[DeezerAuth] API request error:', logSafe(err?.message ?? err))
        reject(err)
      })
      req.write(body)
      req.end()
    })
  }

  async apiCall(method: string, params: Record<string, any> = {}): Promise<any> {
    return this.rawApiCall(method, params)
  }

  // ---- New Releases (private gw-light-api) -----------------------------------
  //
  // Deezer retired the public /editorial/{genre}/releases endpoint (it now returns
  // an empty list), and /editorial/selection is an undated editorial grab-bag that
  // mixes in years-old catalog. The genuine, date-stamped feed — the one behind the
  // site's "New releases for you" — is only reachable via the private gw-light-api's
  // home page, so it must be read server-side. This works for guests: no ARL needed.

  // Keyed to the gw api_token: the feed is personalized when logged in, so any
  // session change (login/logout resets apiToken) self-invalidates the cache.
  private newReleasesCache: { data: any[]; timestamp: number; token: string } | null = null
  private readonly NEW_RELEASES_CACHE_TTL = 60 * 60 * 1000 // 1 hour

  // Album id -> track count. Deezer's home feed omits the count entirely (its
  // album objects carry 13 fields and none of them is a track total), so the
  // only way to show it is album.getData per album. A count never changes once
  // a release is out, so this is cached for the process lifetime; 0 is stored
  // for failures too, to stop a broken id being retried on every page load.
  private albumTrackCountCache = new Map<string, number>()

  // In-flight guest bootstrap, memoized so concurrent callers share one round-trip.
  private gwGuestBootstrap: Promise<void> | null = null

  // Ensure we have a usable gw-light session (api_token + cookies). When the user
  // is logged in this is already set; otherwise bootstrap an anonymous guest one.
  //
  // Startup race guard: at boot the renderer fires /api/login (ARL restore) and
  // /api/new-releases (Home tab) near-simultaneously. If an ARL login is mid-flight
  // (login() sets the arl cookie before its getUserData round-trip completes), we
  // wait for it instead of bootstrapping a guest session — fetching anonymous
  // homepage cookies into a logged-in session is exactly the state conflict the
  // login path's comments warn about.
  private async ensureGwSession(): Promise<void> {
    if (this.apiToken) return

    if (this.cookies.has('arl')) {
      for (let i = 0; i < 40 && !this.apiToken && this.cookies.has('arl'); i++) {
        await this.delay(250)
      }
      if (this.apiToken) return
    }

    if (!this.gwGuestBootstrap) {
      this.gwGuestBootstrap = (async () => {
        await this.getInitialCookies()
        const userData = await this.rawApiCall('deezer.getUserData', {})
        // A real login may have completed while we bootstrapped — never clobber it.
        if (!this.apiToken && userData?.results?.checkForm) {
          this.apiToken = userData.results.checkForm
        }
      })().finally(() => { this.gwGuestBootstrap = null })
    }
    await this.gwGuestBootstrap
  }

  // Best available release date across the gw date fields (originals win).
  private gwAlbumDate(d: any): string {
    return d?.ORIGINAL_RELEASE_DATE || d?.DIGITAL_RELEASE_DATE || d?.PHYSICAL_RELEASE_DATE || ''
  }

  // Map a gw-light album object to the public-API Album shape the UI consumes.
  private mapGwAlbum(d: any): any {
    const md5 = d?.ALB_PICTURE || ''
    const cover = (size: number) =>
      md5 ? `https://cdn-images.dzcdn.net/images/cover/${md5}/${size}x${size}-000000-80-0-0.jpg` : ''
    return {
      id: Number(d.ALB_ID) || d.ALB_ID,
      title: d.ALB_TITLE || '',
      cover: cover(250),
      cover_small: cover(56),
      cover_medium: cover(250),
      cover_big: cover(500),
      cover_xl: cover(1000),
      release_date: this.gwAlbumDate(d),
      record_type: String(d.TYPE) === '0' ? 'single' : 'album',
      explicit_lyrics: d?.EXPLICIT_ALBUM_CONTENT?.EXPLICIT_LYRICS_STATUS === 1,
      // GW spells the track count NB_SONG on some payloads and NUMBER_TRACK on
      // others, so read both (same order as the discography mapper in
      // server.ts). Left undefined rather than 0 when neither is present, so the
      // card hides the line instead of advertising "0 TRK".
      nb_tracks: Number(d.NB_SONG ?? d.NUMBER_TRACK) || undefined,
      artist: { id: Number(d.ART_ID) || d.ART_ID, name: d.ART_NAME || '' },
      link: `https://www.deezer.com/album/${d.ALB_ID}`
    }
  }

  /**
   * Genuine, date-sorted new album releases from Deezer's private home feed —
   * the same data behind the site's "New releases for you" module.
   *
   * Strategy: read every album section off the gw home page (when the user is
   * logged in via ARL this includes their personalized new-releases module; as a
   * guest it's the generic "freshest releases" one), keep the sections whose
   * newest item falls inside the recency window (drops evergreen modules like
   * "Live EPs"), then widen each kept section with its full /channels/module
   * page. Everything is uniformly filtered to the last 90 days — the module
   * pages pad themselves with same-artist back-catalog — deduped by album id,
   * and sorted newest first. Locale-proof: no title matching. Cached 1h.
   */
  async getNewReleases(limit: number = 100): Promise<any[]> {
    if (this.newReleasesCache &&
        this.newReleasesCache.token === this.apiToken &&
        Date.now() - this.newReleasesCache.timestamp < this.NEW_RELEASES_CACHE_TTL) {
      return this.newReleasesCache.data.slice(0, limit)
    }

    await this.ensureGwSession()

    const home = await this.rawApiCall('page.get', {
      PAGE: 'home',
      VERSION: '2.5',
      SUPPORT: { 'horizontal-grid': ['album'], 'grid': ['album'] },
      LANG: 'en',
      OPTIONS: []
    })

    const sections: any[] = (home?.results?.sections || []).filter((s: any) =>
      (s.items || []).some((i: any) => (i.data || i)?.__TYPE__ === 'album'))
    if (sections.length === 0) {
      throw new Error('No album sections on Deezer home feed')
    }

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    // Keep every album section that actually carries recent releases.
    const freshSections = sections.filter(s => {
      const newest = (s.items || []).map((i: any) => this.gwAlbumDate(i.data)).sort().reverse()[0] || ''
      return newest >= cutoff
    })
    console.log(`[DeezerAuth] New releases: ${sections.length} album sections on home, ${freshSections.length} recent`)

    const byId = new Map<string, any>()
    const addIfFresh = (d: any) => {
      if (d?.ALB_ID && !byId.has(String(d.ALB_ID)) && this.gwAlbumDate(d) >= cutoff) {
        byId.set(String(d.ALB_ID), d)
      }
    }

    for (const s of freshSections) {
      for (const it of (s.items || [])) addIfFresh(it.data)
    }

    // Widen each fresh section with its full module page (the home row is only a
    // ~11-item preview; the module holds the complete list, e.g. all ~24-30 of
    // "New releases for you").
    const slugs = freshSections
      .map(s => String(s.target || '').replace(/^\//, ''))
      .filter(Boolean)
    const moduleResults = await Promise.all(slugs.map(slug =>
      this.rawApiCall('page.get', {
        PAGE: slug,
        VERSION: '2.5',
        SUPPORT: { 'grid': ['album'], 'horizontal-grid': ['album'] },
        LANG: 'en',
        OPTIONS: []
      }).catch((error: any) => {
        console.log(`[DeezerAuth] New-releases module ${logSafe(slug)} fetch failed:`, logSafe(error.message))
        return null
      })
    ))
    for (const mod of moduleResults) {
      for (const s of (mod?.results?.sections || [])) {
        for (const it of (s.items || [])) addIfFresh(it.data)
      }
    }

    // Pure newest-first ordering — the user is here for release dates.
    const albums = Array.from(byId.values())
      .sort((a, b) => this.gwAlbumDate(b).localeCompare(this.gwAlbumDate(a)))
      .map(d => this.mapGwAlbum(d))
    console.log(`[DeezerAuth] New releases: ${albums.length} albums within 90 days`)

    await this.hydrateAlbumTrackCounts(albums)

    this.newReleasesCache = { data: albums, timestamp: Date.now(), token: this.apiToken }
    return albums.slice(0, limit)
  }

  /**
   * Fill in nb_tracks on albums that arrived without one.
   *
   * Deezer's GW home feed returns album objects with no track total on them at
   * all, and there is no batch lookup: album.getListData is not a real method
   * (the gateway rejects it), so this is one album.getData per album. Bounded
   * concurrency keeps that from turning into a hundred simultaneous requests,
   * and the cache means it happens once per album rather than once per page
   * load. Failures are swallowed on purpose: a missing count hides the line,
   * which is the same as the behaviour before this existed, so a flaky lookup
   * must never take the whole feed down with it.
   */
  async hydrateAlbumTrackCounts(albums: any[], concurrency = 10): Promise<void> {
    if (!Array.isArray(albums) || !this.apiToken) return
    const targets = albums.filter(a => a && !a.nb_tracks && a.id != null)
    if (targets.length === 0) return

    const started = Date.now()
    let cursor = 0
    let fetched = 0
    let failed = 0

    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const album = targets[cursor++]
        const key = String(album.id)
        const cached = this.albumTrackCountCache.get(key)
        if (cached !== undefined) {
          if (cached > 0) album.nb_tracks = cached
          continue
        }
        try {
          const response = await this.rawApiCall('album.getData', { alb_id: key })
          // Only a successful lookup is cached, including a genuine zero. A
          // thrown call is deliberately left uncached: an expired session or a
          // dropped connection would otherwise pin every album it touched to 0
          // for the rest of the process, and the counts would stay missing long
          // after the problem cleared.
          const count = Number(response?.results?.NUMBER_TRACK) || 0
          this.albumTrackCountCache.set(key, count)
          if (count > 0) album.nb_tracks = count
          fetched++
        } catch {
          failed++
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, targets.length) }, worker)
    )
    console.log(
      `[DeezerAuth] Track counts: ${targets.filter(a => a.nb_tracks).length}/${targets.length} resolved ` +
      `(${fetched} fetched, ${failed} failed) in ${Date.now() - started}ms`
    )
  }

  /**
   * Track metadata from the private gateway.
   *
   * `song.getData` is the primary source and always has been. It does NOT carry
   * COPYRIGHT — verified against the live gateway, whose key list runs
   * ...EXPLICIT_TRACK_CONTENT, GENRE_ID, ISRC... with no copyright field at all.
   * `deezer.pageTrack` returns a wider DATA object that does include it, which
   * is why original deemix tags copyright and this app did not (#139).
   *
   * pageTrack is a second network call, so it is only made when the caller
   * actually wants the field. Failure to enrich is never fatal: the track keeps
   * the metadata song.getData already returned.
   */
  async getTrackInfo(trackId: string | number, opts: { withCopyright?: boolean } = {}): Promise<any> {
    const cacheKey = `track_${trackId}`

    // Check cache first. Return a defensive copy — processDownload mutates the
    // returned object (TRACK_NUMBER/DISK_NUMBER restore after FALLBACK/ISRC
    // substitution, LYRICS attach). Handing out the cached reference let those
    // mutations poison the cache, so a later download of the resolved track
    // inherited another track's numbers and wrote a wrong-numbered duplicate
    // (#102/#103).
    const cached = this.getCachedData(this.trackInfoCache, cacheKey)
    if (cached) {
      console.log(`[DeezerAuth] Track ${trackId} found in cache`)
      return structuredClone(cached)
    }

    const response = await this.apiCall('song.getData', { sng_id: trackId })

    // Check for auth errors in response
    if (response.error && Object.keys(response.error).length > 0) {
      const errorMsg = response.error.message || 'Failed to get track info'
      const error = new Error(errorMsg)
      if (this.isAuthError(error)) {
        this.handleAuthExpired(errorMsg)
      }
      throw error
    }

    // Check if we got valid data
    if (!response.results || (response.results.SNG_ID === undefined && !response.results.error)) {
      console.log('[DeezerAuth] getTrackInfo: Unexpected empty response')
      throw new Error('Failed to get track info - empty response from Deezer')
    }

    const info = response.results

    // Enrich with COPYRIGHT from pageTrack when asked and song.getData lacked it.
    if (opts.withCopyright && !info.COPYRIGHT) {
      try {
        const page = await this.getTrackPage(trackId)
        const copyright = page?.DATA?.COPYRIGHT
        if (copyright) {
          info.COPYRIGHT = copyright
          console.log(`[DeezerAuth] Enriched track ${logSafe(trackId)} with COPYRIGHT from pageTrack`)
        }
      } catch (e: any) {
        // Non-fatal by design: the download proceeds without the copyright tag.
        console.log('[DeezerAuth] pageTrack copyright enrichment failed:', JSON.stringify(logSafe(e?.message ?? e)))
      }
    }

    // Cache the result — and return a copy for the same reason as above.
    this.setCachedData(this.trackInfoCache, cacheKey, info)
    return structuredClone(info)
  }

  // Try to get track info with country availability using song.getListData
  async getTrackListData(trackIds: (string | number)[]): Promise<any> {
    const response = await this.apiCall('song.getListData', { sng_ids: trackIds })
    console.log('[DeezerAuth] song.getListData response keys:', Object.keys(response || {}))
    if (response.error && Object.keys(response.error).length > 0) {
      throw new Error(response.error.message || 'Failed to get track list data')
    }
    return response.results
  }

  // Try deezer.pageTrack which may have more data
  async getTrackPage(trackId: string | number): Promise<any> {
    const response = await this.apiCall('deezer.pageTrack', { sng_id: String(trackId) })
    console.log('[DeezerAuth] deezer.pageTrack response keys:', Object.keys(response || {}))
    if (response.error && Object.keys(response.error).length > 0) {
      console.log('[DeezerAuth] deezer.pageTrack error:', response.error)
      return null
    }
    return response.results
  }

  // ---- Lyrics --------------------------------------------------------------
  //
  // Deezer's legacy gateway call (song.getLyrics) has been shedding its synced
  // block on newer catalog while still returning the plain text (#158): the
  // Deezer app shows timed lyrics for the track, the gateway answers with
  // LYRICS_TEXT and no LYRICS_SYNC_JSON. The timed lines still exist behind the
  // GraphQL lyrics API the Deezer app itself reads now, so when the gateway comes
  // back without a synced block we ask there and map the lines into the gateway
  // shape (line, milliseconds, lrc_timestamp) that every consumer already reads:
  // the .lrc writer, the SYLT frame, and the FLAC SYNCEDLYRICS comment.
  //
  // The GraphQL API needs a short-lived JWT minted from the session's arl. It is
  // cached per arl value so a login or logout self-invalidates it, and a 401/403
  // forces one re-mint before giving up. Guests have no arl and get no fallback.

  private static readonly PIPE_API_URL = 'https://pipe.deezer.com/api'
  private static readonly PIPE_AUTH_URL = 'https://auth.deezer.com/login/arl?jo=p&rto=c&i=c'
  private pipeJwt: { token: string; expiresAt: number; arl: string } | null = null

  /**
   * Get lyrics for a track
   * Returns lyrics object with LYRICS_TEXT (plain text) and LYRICS_SYNC_JSON (synced/timestamped)
   */
  async getLyrics(trackId: string | number): Promise<any> {
    let results: any = null
    try {
      const response = await this.apiCall('song.getLyrics', { sng_id: trackId })
      if (response.error && Object.keys(response.error).length > 0) {
        console.log(`[DeezerAuth] No lyrics from gateway for track ${logSafe(trackId)}:`, logSafe(JSON.stringify(response.error)))
      } else {
        results = response.results
      }
    } catch (error: any) {
      console.log(`[DeezerAuth] Failed to get lyrics for track ${logSafe(trackId)}:`, logSafe(error.message))
    }

    const gatewaySynced = Array.isArray(results?.LYRICS_SYNC_JSON) ? results.LYRICS_SYNC_JSON.length : 0
    let syncedSource: 'gateway' | 'pipe' | 'none' = gatewaySynced > 0 ? 'gateway' : 'none'

    if (gatewaySynced === 0) {
      const pipe = await this.getLyricsFromPipe(trackId)
      if (pipe) {
        results = {
          ...(results || {}),
          LYRICS_TEXT: results?.LYRICS_TEXT || pipe.text,
          ...(pipe.synced.length > 0 ? { LYRICS_SYNC_JSON: pipe.synced } : {})
        }
        if (pipe.synced.length > 0) syncedSource = 'pipe'
      }
    }

    if (!results) return null
    console.log(`[DeezerAuth] Got lyrics for track ${logSafe(trackId)}:`, {
      hasText: !!results.LYRICS_TEXT,
      hasSynced: !!results.LYRICS_SYNC_JSON,
      syncedLines: results.LYRICS_SYNC_JSON?.length || 0,
      syncedSource
    })
    return results
  }

  // Mint (or reuse) the JWT the GraphQL lyrics API expects. Returns null for
  // guest sessions, or when Deezer declines to issue one.
  private async getPipeJwt(force = false): Promise<string | null> {
    const arl = this.cookies.get('arl')
    if (!arl) return null
    const cached = this.pipeJwt
    if (!force && cached && cached.arl === arl && Date.now() < cached.expiresAt - 60_000) {
      return cached.token
    }
    const res = await this.postJson(DeezerAuth.PIPE_AUTH_URL, { Cookie: `arl=${arl}` }, '')
    const token = res.json?.jwt
    if (typeof token !== 'string' || token.length === 0) {
      console.log(`[DeezerAuth] Pipe auth issued no token (status ${res.status})`)
      return null
    }
    // Trust the token's own exp claim; fall back to a conservative half hour.
    let expiresAt = Date.now() + 30 * 60_000
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
      if (typeof payload.exp === 'number') expiresAt = payload.exp * 1000
    } catch { /* keep the fallback */ }
    this.pipeJwt = { token, expiresAt, arl }
    return token
  }

  private async getLyricsFromPipe(trackId: string | number): Promise<{
    text: string
    synced: Array<{ line: string; milliseconds: number; lrc_timestamp: string; duration?: number }>
  } | null> {
    try {
      let jwt = await this.getPipeJwt()
      if (!jwt) return null
      const body = JSON.stringify({
        operationName: 'SynchronizedTrackLyrics',
        variables: { trackId: String(trackId) },
        query: 'query SynchronizedTrackLyrics($trackId: String!) { track(trackId: $trackId) { id lyrics { id text synchronizedLines { lrcTimestamp line milliseconds duration } } } }'
      })
      let res = await this.postJson(DeezerAuth.PIPE_API_URL, { Authorization: `Bearer ${jwt}` }, body)
      if (res.status === 401 || res.status === 403) {
        jwt = await this.getPipeJwt(true)
        if (!jwt) return null
        res = await this.postJson(DeezerAuth.PIPE_API_URL, { Authorization: `Bearer ${jwt}` }, body)
      }
      const lyrics = res.json?.data?.track?.lyrics
      if (!lyrics) {
        const reason = res.json?.errors?.[0]?.message || `status ${res.status}`
        console.log(`[DeezerAuth] No lyrics from pipe for track ${logSafe(trackId)}: ${logSafe(reason)}`)
        return null
      }
      const synced = Array.isArray(lyrics.synchronizedLines)
        ? lyrics.synchronizedLines
            .filter((l: any) => l && typeof l.line === 'string' && Number.isFinite(Number(l.milliseconds)))
            .map((l: any) => ({
              line: l.line,
              milliseconds: Number(l.milliseconds),
              lrc_timestamp: typeof l.lrcTimestamp === 'string' ? l.lrcTimestamp : '',
              duration: Number.isFinite(Number(l.duration)) ? Number(l.duration) : undefined
            }))
        : []
      return { text: typeof lyrics.text === 'string' ? lyrics.text : '', synced }
    } catch (error: any) {
      console.log(`[DeezerAuth] Pipe lyrics request failed for track ${logSafe(trackId)}:`, logSafe(error.message))
      return null
    }
  }

  // Small JSON POST over the shared agent. Never throws on a non-2xx status;
  // callers read res.status. Rejects only on transport failure or unparseable
  // JSON, which the lyrics callers catch and treat as "no lyrics".
  private postJson(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        agent: httpsAgent,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Origin': 'https://www.deezer.com',
          'Referer': 'https://www.deezer.com/',
          ...headers
        }
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : null })
          } catch {
            reject(new Error(`Non-JSON response (status ${res.statusCode})`))
          }
        })
      })
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')) })
      req.on('error', reject)
      req.end(body)
    })
  }

  async getAlbumInfo(albumId: string | number): Promise<any> {
    const cacheKey = `album_${albumId}`

    // Check cache first
    const cached = this.getCachedData(this.albumInfoCache, cacheKey)
    if (cached) {
      console.log(`[DeezerAuth] Album ${albumId} found in cache`)
      return cached
    }

    const response = await this.apiCall('album.getData', { alb_id: albumId })
    if (response.error && Object.keys(response.error).length > 0) {
      throw new Error(response.error.message || 'Failed to get album info')
    }

    // Cache the result
    this.setCachedData(this.albumInfoCache, cacheKey, response.results)
    return response.results
  }

  /**
   * Get artist discography from the private Deezer API
   * Uses album.getDiscography which returns complete discography with TYPE values
   * Categories are determined by track count heuristics (Deezer industry standards)
   *
   * IMPORTANT: Only albums where ART_ID matches the searched artistId are considered
   * the artist's own releases. Albums where they're just featured go to "featured" category.
   */
  async getArtistDiscography(artistId: string | number, limit: number = 2000): Promise<{
    all: any[]
    album: any[]
    ep: any[]
    single: any[]
    compile: any[]
    featured: any[]
  }> {
    // Normalize artistId to string for comparison and cache key
    const searchedArtistId = String(artistId)
    const cacheKey = `discography_${searchedArtistId}`

    // Check cache first for consistency (discography rarely changes)
    const cached = this.getCachedData(this.discographyCache, cacheKey)
    if (cached) {
      console.log(`[DeezerAuth] Using cached discography for artist ${searchedArtistId}`)
      return cached
    }

    const result = {
      all: [] as any[],
      album: [] as any[],
      ep: [] as any[],
      single: [] as any[],
      compile: [] as any[],
      featured: [] as any[]
    }

    try {
      // Fetch discography in batches using album.getDiscography
      let index = 0
      const batchSize = 100
      const seenAlbumIds = new Set<string>()

      while (index < limit) {
        console.log(`[DeezerAuth] Fetching discography batch at index ${index} (limit: ${limit})`)
        const response = await this.apiCall('album.getDiscography', {
          art_id: artistId,
          nb: batchSize,
          start: index,
          nb_songs: 0
        })

        if (response.error && Object.keys(response.error).length > 0) {
          console.error('[DeezerAuth] Discography fetch error:', response.error)
          break
        }

        const data = response.results?.data || []
        if (data.length === 0) {
          console.log('[DeezerAuth] No more discography data')
          break
        }

        // Process each release
        for (const release of data) {
          // Skip duplicates
          if (seenAlbumIds.has(release.ALB_ID)) continue
          seenAlbumIds.add(release.ALB_ID)

          // Get track count for categorization
          const trackCount = parseInt(release.NUMBER_TRACK || '0', 10)
          const subtypes = release.SUBTYPES || {}
          const isCompilation = subtypes.isCompilation || false

          // Add to all releases
          result.all.push(release)

          // Check if this artist is the PRIMARY artist of the album
          // If ART_ID doesn't match, this is a "featured" appearance
          const albumArtistId = String(release.ART_ID)
          const isOwnRelease = albumArtistId === searchedArtistId

          if (!isOwnRelease) {
            // Artist is featured on this album, not the primary artist
            result.featured.push(release)
            continue
          }

          // Categorize based on track count (industry standard heuristics)
          // Singles: 1-2 tracks
          // EPs: 3-6 tracks (usually 4-6)
          // Albums: 7+ tracks
          // Also consider compilation flag
          if (isCompilation) {
            result.compile.push(release)
          } else if (trackCount <= 2) {
            result.single.push(release)
          } else if (trackCount >= 3 && trackCount <= 6) {
            result.ep.push(release)
          } else {
            result.album.push(release)
          }
        }

        // Check if we got fewer items than requested (end of list)
        if (data.length < batchSize) {
          console.log('[DeezerAuth] Reached end of discography')
          break
        }

        index += batchSize
      }

      // Warn if we hit the limit (might be more data)
      if (index >= limit) {
        console.warn(`[DeezerAuth] Discography fetch hit limit of ${limit} - artist may have more releases`)
      }

      console.log(`[DeezerAuth] Discography for artist ${artistId}:`, {
        total: result.all.length,
        albums: result.album.length,
        eps: result.ep.length,
        singles: result.single.length,
        compiles: result.compile.length,
        featured: result.featured.length
      })

      // Cache successful results for consistency
      if (result.all.length > 0) {
        this.setCachedData(this.discographyCache, cacheKey, result)
      }

      return result
    } catch (error: any) {
      console.error('[DeezerAuth] Failed to get artist discography:', logSafe(error.message))
      return result
    }
  }

  async getTrackUrl(trackId: string | number, quality: 'MP3_128' | 'MP3_320' | 'FLAC' = 'MP3_320', bitrateFallback: boolean = true, isrcFallback: boolean = true): Promise<{ url: string; format: string; resolvedTrackId?: string | number }> {
    console.log('[DeezerAuth] getTrackUrl called with quality:', quality, 'bitrateFallback:', bitrateFallback)

    // Build format fallback chain
    const buildFormats = (info: any): string[] => {
      if (quality === 'FLAC') {
        return bitrateFallback ? ['FLAC', 'MP3_320', 'MP3_128'] :
          (info.FILESIZE_FLAC && parseInt(info.FILESIZE_FLAC) > 0) ? ['FLAC'] :
          (() => { throw new Error('PreferredBitrateNotFound: FLAC not available') })()
      } else if (quality === 'MP3_320') {
        return bitrateFallback ? ['MP3_320', 'MP3_128'] :
          (info.FILESIZE_MP3_320 && parseInt(info.FILESIZE_MP3_320) > 0) ? ['MP3_320'] :
          (() => { throw new Error('PreferredBitrateNotFound: MP3_320 not available') })()
      }
      return ['MP3_128']
    }

    // Try to get a media URL for a specific track, with fresh token retry
    const tryGetUrl = async (id: string | number): Promise<{ url: string; format: string } | null> => {
      // Clear cache to ensure fresh token
      this.trackInfoCache.delete(`track_${id}`)
      const info = await this.getTrackInfo(id)

      if (!info.TRACK_TOKEN) return null

      const formats = buildFormats(info)
      console.log('[DeezerAuth] Trying track:', id, 'formats:', formats.join(', '))

      // Modern Media API (requires licenseToken, IP-geo enforced).
      // This is the only supported path — Deezer retired the legacy
      // e-cdns-proxy-{0-f}.dzcdn.net CDN in May 2026, so locally-signed AES
      // URLs (the path used by old Python deemix) no longer resolve. Track
      // tokens are now redeemed via media.deezer.com/v1/get_url, which
      // returns a signed URL on whichever CDN Deezer currently routes to.
      try {
        const result = await this.getMediaUrl(info.TRACK_TOKEN, formats)
        if (result) return result
      } catch (e: any) {
        // Bubble auth errors — caller needs to surface "please log in"
        if (/session expired|log in|license token/i.test(e.message || '')) {
          throw e
        }
        console.warn(`[DeezerAuth] Media API failed for track ${id}:`, e.message)
        // Non-auth failure — let the outer FALLBACK / ISRC retries try
        // alternative track IDs. There is no longer a legacy-CDN escape hatch.
      }

      return null
    }

    // Attempt 1: Try the requested track ID (always with fresh token)
    let result = await tryGetUrl(trackId)
    if (result) {
      console.log('[DeezerAuth] Got media URL for track', trackId, 'format:', result.format)
      return result
    }

    // Attempt 2: Check for FALLBACK track (alternative version that may be available)
    // Playlists often reference compilation/special edition track IDs that have restricted
    // rights. The FALLBACK field points to the original album version which is usually available.
    const trackInfo = await this.getTrackInfo(trackId)
    const fallbackId = trackInfo.FALLBACK?.SNG_ID
    if (fallbackId && String(fallbackId) !== String(trackId)) {
      console.log(`[DeezerAuth] Track ${trackId} has FALLBACK: ${fallbackId} — trying alternative version`)
      result = await tryGetUrl(fallbackId)
      if (result) {
        console.log('[DeezerAuth] Got media URL via FALLBACK track', fallbackId, 'format:', result.format)
        return { ...result, resolvedTrackId: fallbackId }
      }
    }

    // Attempt 3: Search for the same song on the original album via ISRC
    // ISRC is a universal recording identifier — same across all album versions.
    // Gated on isrcFallback: this resolves to a DIFFERENT release/master, so users
    // who want only the exact track can disable it (attempts 1-2 still run).
    if (isrcFallback && trackInfo.ISRC) {
      console.log(`[DeezerAuth] Trying ISRC lookup for: ${trackInfo.ISRC}`)
      try {
        const searchResult = await this.apiCall('song.getListByIsrc', { isrc: trackInfo.ISRC })
        const alternatives = searchResult?.results?.data || searchResult?.results || []
        if (Array.isArray(alternatives)) {
          for (const alt of alternatives) {
            if (alt.SNG_ID && String(alt.SNG_ID) !== String(trackId) && String(alt.SNG_ID) !== String(fallbackId || '')) {
              console.log(`[DeezerAuth] Trying ISRC alternative: ${alt.SNG_ID} (album: ${alt.ALB_TITLE})`)
              result = await tryGetUrl(alt.SNG_ID)
              if (result) {
                console.log('[DeezerAuth] Got media URL via ISRC alternative', alt.SNG_ID, 'format:', result.format)
                return { ...result, resolvedTrackId: alt.SNG_ID }
              }
            }
          }
        }
      } catch (isrcError: any) {
        console.warn('[DeezerAuth] ISRC lookup failed:', logSafe(isrcError.message))
      }
    }

    // Attempt 4: Public-API ISRC resolution (last resort).
    // The private song.getListByIsrc often surfaces only the restricted master
    // itself (e.g. a compilation/playlist version with limited streaming rights),
    // so attempts 1-3 all fail. Deezer's PUBLIC catalog endpoint resolves the same
    // ISRC to its canonical track ID — usually the original single — which is
    // frequently streamable when the compilation master is not. This mirrors what
    // a user does by hand: find the original single and download that instead.
    if (isrcFallback && trackInfo.ISRC) {
      const publicId = await this.resolvePublicTrackIdByIsrc(trackInfo.ISRC)
      if (publicId && String(publicId) !== String(trackId) && String(publicId) !== String(fallbackId || '')) {
        console.log(`[DeezerAuth] Trying public-API ISRC alternative: ${publicId}`)
        result = await tryGetUrl(publicId)
        if (result) {
          console.log('[DeezerAuth] Got media URL via public-API ISRC alternative', publicId, 'format:', result.format)
          return { ...result, resolvedTrackId: publicId }
        }
      }
    }

    throw new Error(
      'Track unavailable on Deezer. The Media API rejected the original track, ' +
      'its FALLBACK version, and every ISRC-matched alternative — this usually means ' +
      'the release is geo-restricted for your account region, requires a Premium subscription, ' +
      'or has been removed from Deezer\'s catalog.'
    )
  }

  private async getMediaUrl(trackToken: string, formats: string[]): Promise<{ url: string; format: string }> {
    // Build format list for the API
    const formatList = formats.map(f => {
      switch (f) {
        case 'FLAC': return { cipher: 'BF_CBC_STRIPE', format: 'FLAC' }
        case 'MP3_320': return { cipher: 'BF_CBC_STRIPE', format: 'MP3_320' }
        case 'MP3_128': return { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' }
        default: return { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' }
      }
    })

    const licenseToken = this.session?.licenseToken

    if (!licenseToken) {
      console.log('[DeezerAuth] No license token - session likely expired')
      console.log('[DeezerAuth] Session exists:', !!this.session)
      console.log('[DeezerAuth] Session licenseToken:', this.session?.licenseToken)
      this.handleAuthExpired('No license token - session expired')
      throw new Error('License token required for downloads - please log in again')
    }

    console.log('[DeezerAuth] getMediaUrl - licenseToken length:', licenseToken.length)
    console.log('[DeezerAuth] getMediaUrl - cookies:', Array.from(this.cookies.keys()).join(', '))

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        license_token: licenseToken,
        media: [{
          type: 'FULL',
          formats: formatList
        }],
        track_tokens: [trackToken]
      })

      console.log('[DeezerAuth] Media API request - trackToken length:', trackToken.length, 'formats:', formatList.map(f => f.format).join(','))

      const req = https.request('https://media.deezer.com/v1/get_url', {
        method: 'POST',
        agent: httpsAgent,
        // TLS certificate validation left ON (default). Verified media.deezer.com
        // presents a valid cert chain, so the old rejectUnauthorized:false (copied
        // from deemix-gui) was unnecessary and is removed to prevent MITM.
        timeout: 30000, // 30s timeout for media URL retrieval
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Cookie': this.getCookieString(),
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            console.log('[DeezerAuth] Media API response status:', res.statusCode)
            console.log('[DeezerAuth] Media API response:', data.substring(0, 300))

            // Only treat 401 as auth error - 403 can mean geo-restriction or license issues
            if (res.statusCode === 401) {
              console.log('[DeezerAuth] Media API returned 401 Unauthorized')
              this.handleAuthExpired('Media API returned 401')
              reject(new Error('Session expired - please log in again'))
              return
            }

            // 403 usually means geo-restriction or license issue, NOT auth expiration
            if (res.statusCode === 403) {
              console.log('[DeezerAuth] Media API returned 403 - response body:', data)
              // Try to parse the error for more details
              try {
                const errorJson = JSON.parse(data)
                console.log('[DeezerAuth] 403 error details:', JSON.stringify(errorJson))
                reject(new Error(`Track not available: ${JSON.stringify(errorJson).substring(0, 200)}`))
              } catch {
                reject(new Error('Track not available - may be geo-restricted or require Premium subscription'))
              }
              return
            }

            const json = JSON.parse(data)

            // Check for errors in response
            if (json.data && json.data[0] && json.data[0].errors) {
              const errors = json.data[0].errors
              console.error('[DeezerAuth] Media API error:', errors)

              // Only trigger auth-expired for specific auth failure patterns
              const errorStr = JSON.stringify(errors).toLowerCase()
              const isAuthError = (
                errorStr.includes('auth_required') ||
                errorStr.includes('invalid_token') ||
                errorStr.includes('token_expired') ||
                errorStr.includes('session_expired') ||
                (errorStr.includes('user') && errorStr.includes('not') && errorStr.includes('auth'))
              )

              if (isAuthError) {
                this.handleAuthExpired('Media API auth error: ' + errorStr.substring(0, 100))
                reject(new Error('Session expired - please log in again'))
                return
              }

              // For non-auth errors, just reject with the error message
              reject(new Error('Track not available: ' + JSON.stringify(errors).substring(0, 200)))
              return
            }

            if (json.data && json.data[0] && json.data[0].media && json.data[0].media[0]) {
              const media = json.data[0].media[0]
              if (media.sources && media.sources[0]) {
                const url = media.sources[0].url
                const format = media.format || formats[0]
                console.log('[DeezerAuth] Got media URL, format:', format, 'url:', url.substring(0, 80) + '...')
                resolve({ url, format })
                return
              }
            }

            reject(new Error('No media URL in response'))
          } catch (e: any) {
            console.error('[DeezerAuth] Failed to parse media response:', e.message)
            reject(new Error('Failed to parse media response'))
          }
        })
      })

      req.on('timeout', () => {
        console.error('[DeezerAuth] Media URL request timed out')
        req.destroy(new Error('Media URL request timed out — Deezer may be slow or the track unavailable'))
      })
      req.on('error', reject)
      req.write(postData)
      req.end()
    })
  }

  /**
   * Resolve an ISRC to its canonical track ID via Deezer's PUBLIC catalog API
   * (no auth required). Last-resort fallback for getTrackUrl: when the private
   * song.getListByIsrc lookup surfaces no streamable alternative, the public
   * endpoint reliably returns the original-single master, which is often
   * downloadable even when a compilation/playlist master is rights-restricted.
   * Never throws — resolves to null on any error, timeout, or no-match so the
   * caller falls through to the final "Track unavailable" error unchanged.
   */
  private resolvePublicTrackIdByIsrc(isrc: string): Promise<string | number | null> {
    return new Promise((resolve) => {
      const req = https.request(
        `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`,
        { method: 'GET', agent: httpsAgent, timeout: 15000 },
        (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            try {
              const json = JSON.parse(data)
              resolve(json && json.id && !json.error ? json.id : null)
            } catch {
              resolve(null)
            }
          })
        }
      )
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.on('error', () => resolve(null))
      req.end()
    })
  }

}

export const deezerAuth = new DeezerAuth()
