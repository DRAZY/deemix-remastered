/**
 * Qobuz authentication + API client (WIP — feature/qobuz-integration).
 *
 * Native-downloader counterpart to deezerAuth.ts. Unlike Deezer, Qobuz serves
 * UNENCRYPTED files: `track/getFileUrl` returns a direct, time-limited CDN link
 * to the real FLAC/MP3, so there is no Blowfish/decrypt stage downstream.
 *
 * Auth model (reverse-engineered, same surface the Qobuz web player uses):
 *   - app_id + app_secret  → scraped from play.qobuz.com's bundle.js (see
 *     fetchAppCredentials). app_secret is used ONLY to sign requests, never sent.
 *   - user_auth_token      → obtained from a real browser login session (see below).
 *
 * IMPORTANT — auth changed April 2026 (confirmed via live probe + streamrip PR
 * #955 / issues #954/#956): Qobuz put api.json/0.2 behind a gateway and moved web
 * login to OAuth+reCAPTCHA. Posting email+password to `user/login` now returns
 * 401 "User authentication is required" for everyone — the classic OSS flow is
 * dead. The working path is TOKEN-based: get a `user_auth_token` (+ numeric
 * user id) from a genuine logged-in play.qobuz.com session, then call api.json
 * with `X-App-Id` + `X-User-Auth-Token`. The token must be minted under the same
 * app_id you send, and expires in days (needs re-capture).
 *
 * In-app plan: render play.qobuz.com/login in a sandboxed BrowserWindow, let the
 * user complete the real OAuth login, and intercept the api.json `user/login`
 * response (or read localStorage) to lift id + token — the EXACT pattern this app
 * already uses to capture the Deezer ARL. loginWithToken() is that endpoint.
 *
 * SECURITY: credentials/tokens are NEVER hardcoded or committed. Auth values come
 * from the caller (safeStorage / env), same posture as the Deezer ARL.
 *
 * STATUS: scaffold. fetchAppCredentials + signRequest verified against the live
 * 8.2.0 bundle. Token auth + getFileUrl/catalog pending end-to-end validation
 * with a real browser-minted token.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { app } from 'electron'
import { logSafe } from './logSafe'

const QOBUZ_API_BASE = 'https://www.qobuz.com/api.json/0.2'
const QOBUZ_LOGIN_PAGE = 'https://play.qobuz.com/login'
const QOBUZ_PLAY_BASE = 'https://play.qobuz.com'

// Qobuz format_id → quality. 6/7/27 are all FLAC; 5 is lossy.
export const QOBUZ_FORMAT = {
  MP3_320: 5,
  FLAC_CD: 6, // 16-bit / 44.1 kHz
  FLAC_HIRES_96: 7, // 24-bit / ≤96 kHz
  FLAC_HIRES_192: 27, // 24-bit / ≤192 kHz
} as const

export type QobuzFormatId = (typeof QOBUZ_FORMAT)[keyof typeof QOBUZ_FORMAT]

export interface QobuzAppCredentials {
  appId: string
  appSecret: string
}

export interface QobuzSession {
  userAuthToken: string
  userId: number
  credentialLabel?: string // subscription label, e.g. "Studio"
  isValid: boolean
}

export interface QobuzFileUrl {
  url: string
  formatId: number
  mimeType?: string
  bitDepth?: number
  samplingRate?: number
  restricted?: boolean // true when the account isn't eligible at the requested quality
  restrictionCode?: string // Qobuz's restriction code when no url was returned
}

class QobuzAuth extends EventEmitter {
  private appCreds: QobuzAppCredentials | null = null
  // The bundle carries several candidate app_secrets (per-timezone obfuscated
  // splits + literals); only ONE signs valid, and it is NOT the production
  // literal (verified 2026-07-16: the working secret was a timezone-derived
  // candidate). We collect all candidates and resolve the winner by trial on
  // the first getFileUrl, then cache it.
  private secretCandidates: string[] = []
  // Advanced connect (#117 follow-up): user-supplied app_id + app_secret that
  // OVERRIDE the auto-scraped web-player credentials. Needed for tokens minted
  // under a different Qobuz app_id (Qobuz runs separate app_ids per client —
  // web/iOS/Android/desktop — and tokens pulled from other tools are bound to
  // theirs, so validating against ours returns a false "expired"). When set,
  // every credential fetch returns these and signing uses this secret.
  private manualCreds: QobuzAppCredentials | null = null
  private session: QobuzSession | null = null

  isLoggedIn(): boolean {
    return this.session?.isValid === true
  }

  /** True when a previously-working session was invalidated by a 401 —
   *  distinguishes 'token expired, reconnect' from 'never connected'. */
  private authExpired = false

  isAuthExpired(): boolean {
    return this.authExpired
  }

  /** Qobuz tokens expire after days. On the first authenticated 401, mark the
   *  session invalid so isLoggedIn() flips false and every existing
   *  not-connected surface (Qobuz tab connect CTA, download errors, status
   *  endpoint) activates — instead of raw HTTP 401s behind a lit Q:LINKED LED.
   *  Mirrors deezerAuth.handleAuthExpired. */
  private handleAuthExpired(): void {
    if (this.session?.isValid) {
      console.log('[QobuzAuth] Session token rejected (401) — marking session expired')
      this.session.isValid = false
      this.authExpired = true
      // One proactive event per expiry (the isValid guard makes this fire once):
      // forwarded server → main → renderer for the toast + Q:OFFLINE indicator.
      this.emit('auth-expired', { reason: 'Qobuz session expired — reconnect your Qobuz account in Settings' })
    }
  }

  getSession(): QobuzSession | null {
    return this.session
  }

  /**
   * Scrape app_id + app_secret from the web-player bundle. This is the single
   * most fragile dependency: Qobuz reships bundle.js periodically, so we try the
   * cheapest signal first and keep the seed-reconstruction fallback documented.
   *
   * Verified 2026-07-16 against bundle 8.2.0-b034: appId 798273057, and a literal
   * appSecret is present in-bundle (older bundles only carried the obfuscated
   * per-timezone seed split — kept as fallback below).
   */
  // In-flight scrape memoized so concurrent cold-start callers (search, discover,
  // detail views firing together at boot) share one bundle download instead of
  // each triggering their own.
  private credsInFlight: Promise<QobuzAppCredentials> | null = null
  private readonly CREDS_CACHE_TTL = 24 * 60 * 60 * 1000 // 24h

  // app_id/secret candidates are public client credentials scraped from Qobuz's
  // own public web bundle — not user secrets — so a plain JSON cache is fine.
  private credsCachePath(): string {
    return path.join(app.getPath('userData'), 'qobuz-app-creds.json')
  }

  /** Set (or clear) user-supplied app credentials that override the auto-scrape.
   *  Both empty → revert to auto-scrape (forces a re-fetch on next use). */
  setManualCredentials(appId?: string, appSecret?: string): void {
    const id = (appId || '').trim()
    const secret = (appSecret || '').trim()
    if (id && secret) {
      this.manualCreds = { appId: id, appSecret: secret }
      this.appCreds = this.manualCreds
      this.secretCandidates = [secret]
      console.log('[QobuzAuth] Using user-supplied app credentials')
    } else {
      this.manualCreds = null
      this.appCreds = null
      this.secretCandidates = []
    }
  }

  hasManualCredentials(): boolean {
    return this.manualCreds !== null
  }

  async fetchAppCredentials(force = false): Promise<QobuzAppCredentials> {
    // User-supplied credentials always win and never get re-scraped over.
    if (this.manualCreds) return this.manualCreds
    if (this.appCreds && !force) return this.appCreds
    if (this.credsInFlight && !force) return this.credsInFlight
    this.credsInFlight = this.fetchAppCredentialsInternal(force)
      .finally(() => { this.credsInFlight = null })
    return this.credsInFlight
  }

  private async fetchAppCredentialsInternal(force: boolean): Promise<QobuzAppCredentials> {
    // Disk cache (24h TTL): skips the multi-second login-page + bundle.js scrape
    // on every app boot — the single biggest Qobuz cold-start delay.
    if (!force) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.credsCachePath(), 'utf8'))
        if (raw?.appId && Array.isArray(raw.secretCandidates) && raw.secretCandidates.length > 0 &&
            Date.now() - (raw.timestamp || 0) < this.CREDS_CACHE_TTL) {
          this.secretCandidates = raw.secretCandidates
          this.appCreds = { appId: raw.appId, appSecret: raw.secretCandidates[0] }
          console.log('[QobuzAuth] App credentials loaded from disk cache')
          return this.appCreds
        }
      } catch { /* missing/invalid cache — fall through to scrape */ }
    }

    const loginHtml = await this.httpText(QOBUZ_LOGIN_PAGE)
    const bundlePath = loginHtml.match(/\/resources\/[0-9.]+-[a-z0-9]+\/bundle\.js/)?.[0]
    if (!bundlePath) throw new Error('Qobuz: could not locate bundle.js in login page')

    const bundle = await this.httpText(QOBUZ_PLAY_BASE + bundlePath)

    const appId = bundle.match(/production:\{api:\{appId:"(\d+)"/)?.[1]
    if (!appId) throw new Error('Qobuz: could not extract app_id from bundle')

    this.secretCandidates = this.extractSecretCandidates(bundle)
    if (this.secretCandidates.length === 0) {
      throw new Error('Qobuz: could not extract any app_secret candidates from bundle')
    }

    // appSecret here is the first candidate as a placeholder; the real one is
    // resolved by trial in getFileUrl (see resolveSecret).
    this.appCreds = { appId, appSecret: this.secretCandidates[0] }

    try {
      fs.writeFileSync(this.credsCachePath(), JSON.stringify({
        appId,
        secretCandidates: this.secretCandidates,
        timestamp: Date.now()
      }))
    } catch (e: any) {
      console.log('[QobuzAuth] Could not persist creds cache:', e.message)
    }

    return this.appCreds
  }

  /**
   * Collect every candidate app_secret from the bundle. The working secret is
   * split across per-timezone `initialSeed("<seed>", window.utimezone.<tz>)`
   * plus `name:"Region/City",info:"<b64>",extras:"<b64>"` blocks: concatenate
   * seed+info+extras, drop the trailing 44 chars, base64-decode → utf8. We also
   * include any literal appSecret values as fallbacks. Only one candidate signs
   * valid (resolved at call time), so we return all of them.
   */
  private extractSecretCandidates(bundle: string): string[] {
    const seeds: Record<string, string> = {}
    for (const m of bundle.matchAll(/initialSeed\("([\w=]+)",window\.utimezone\.([a-z]+)\)/g)) {
      seeds[m[2]] = m[1]
    }
    const info: Record<string, { info: string; extras: string }> = {}
    for (const m of bundle.matchAll(/name:"[A-Za-z]+\/([A-Za-z_]+)",info:"([\w=]+)",extras:"([\w=]+)"/g)) {
      info[m[1].toLowerCase()] = { info: m[2], extras: m[3] }
    }
    const candidates: string[] = []
    for (const tz of Object.keys(seeds)) {
      if (!info[tz]) continue
      const combined = seeds[tz] + info[tz].info + info[tz].extras
      try {
        const secret = Buffer.from(combined.slice(0, -44), 'base64').toString('utf-8')
        if (/^[a-z0-9]{32}$/.test(secret)) candidates.push(secret)
      } catch {
        /* skip malformed */
      }
    }
    for (const m of bundle.matchAll(/appSecret:"([a-z0-9]{32})"/g)) candidates.push(m[1])
    return [...new Set(candidates)]
  }

  /**
   * Sign a request. Per Qobuz's own docs only track/getFileUrl needs signing.
   * sig = md5(object + method + <params sorted, minus app_id/user_auth_token> + ts + app_secret)
   * Params must be concatenated as `key + value` in alphabetical key order.
   */
  private signRequest(
    objectName: string,
    methodName: string,
    params: Record<string, string | number>,
    timestamp: number,
    appSecret: string
  ): string {
    const serialized = Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join('')
    const raw = `${objectName}${methodName}${serialized}${timestamp}${appSecret}`
    // MD5 is mandated by Qobuz's API contract — their gateway validates exactly
    // this digest. It is a request-authentication token for THEIR service, not a
    // confidentiality or password-storage mechanism of ours; a stronger hash
    // would simply be rejected. (CodeQL js/weak-cryptographic-algorithm #23 —
    // dismissed as protocol-mandated.)
    return crypto.createHash('md5').update(raw).digest('hex')
  }

  /**
   * DEAD PATH (kept only to fail loudly). Qobuz's gateway rejects raw
   * email+password logins since April 2026 — this will 401. Use loginWithToken.
   */
  async login(_email: string, _password: string): Promise<QobuzSession> {
    throw new Error(
      'Qobuz: email/password login is no longer accepted by Qobuz (OAuth-gated since 2026-04). ' +
        'Use loginWithToken() with a user_auth_token captured from a browser session.'
    )
  }

  /**
   * Authenticate with a browser-minted user_auth_token (the current working
   * path). Validates the token with one authenticated call and reads the
   * subscription label so we can reject free accounts (which can't download).
   */
  async loginWithToken(userId: number, userAuthToken: string): Promise<QobuzSession> {
    await this.fetchAppCredentials()
    this.session = { userAuthToken, userId, isValid: true }

    // Validate + fetch subscription entitlement.
    const me = await this.apiGet(`user/get?user_id=${userId}&app_id=${this.appCreds!.appId}`, true)
    const params = me?.credential?.parameters
    if (!params) {
      this.session = null
      throw new Error('Qobuz: token invalid, or account has no active subscription (downloads need a paid plan)')
    }
    this.session.credentialLabel = params.short_label
    return this.session
  }

  /**
   * Token-paste login (#114): authenticate from a bare user_auth_token alone —
   * for users who only hold a token (e.g. from another tool's config) or whose
   * region blocks the embedded login window. Asks Qobuz who the token belongs
   * to (user/get with no user_id returns the authenticated user), then runs the
   * normal loginWithToken validation (plan check included). Never touches the
   * current session until the token proves valid.
   */
  async connectWithToken(userAuthToken: string): Promise<QobuzSession> {
    const token = userAuthToken.trim()
    if (!token) throw new Error('Qobuz: token required')
    const { appId } = await this.fetchAppCredentials()
    // Raw fetch, not apiGet: this must not read this.session, and a 401 here
    // means "bad pasted token" — it must never expire the existing session.
    const res = await this.fetchWithRetry(
      `${QOBUZ_API_BASE}/user/get?app_id=${appId}`,
      { headers: { 'X-App-Id': appId, 'X-User-Auth-Token': token } },
      15000
    )
    if (res.status === 401) {
      throw new Error('Qobuz rejected this token — it may be expired, revoked, or mistyped')
    }
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 200) } catch { /* body unreadable */ }
      throw new Error(`Qobuz token validation failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
    }
    const me = await res.json()
    const userId = Number(me?.id)
    if (!userId) {
      throw new Error('Qobuz accepted the token but did not identify the account — cannot complete token login')
    }
    const session = await this.loginWithToken(userId, token)
    this.authExpired = false
    return session
  }

  restoreSession(userAuthToken: string, userId: number): void {
    this.session = { userAuthToken, userId, isValid: true }
  }

  logout(): void {
    this.session = null
  }

  /** Resolve a signed, direct download URL for a track at a requested format. */
  // intent 'stream' is the normal delivery; 'download' is the purchase-credential
  // path — required for purchased mixed albums whose [Mix Cut] tracks refuse
  // stream delivery even though the catalog marks them streamable.
  async getFileUrl(trackId: string | number, formatId: QobuzFormatId, intent: 'stream' | 'download' = 'stream'): Promise<QobuzFileUrl> {
    let { appId } = await this.fetchAppCredentials()
    if (!this.session) throw new Error('Qobuz: not logged in')

    // Two passes: if every cached candidate fails to sign (Qobuz rotated its
    // bundle since the creds were cached), force a fresh scrape and try once
    // more before giving up.
    for (let pass = 0; pass < 2; pass++) {
      const result = await this.tryFileUrlCandidates(trackId, formatId, appId, intent)
      if (result) return result
      if (pass === 0) {
        console.log('[QobuzAuth] All cached secret candidates failed — refreshing app credentials')
        ;({ appId } = await this.fetchAppCredentials(true))
      }
    }
    throw new Error('Qobuz: no app_secret candidate produced a valid signature (after credential refresh)')
  }

  /** One trial pass over the current secret candidates; null if all fail to sign. */
  private async tryFileUrlCandidates(trackId: string | number, formatId: QobuzFormatId, appId: string, intent: 'stream' | 'download' = 'stream'): Promise<QobuzFileUrl | null> {
    // Try candidate secrets in order; cache the first that signs valid (moves it
    // to the front so subsequent calls hit it immediately). A signature failure
    // is the only reason to advance — any other response (incl. a restrictions
    // payload) means the secret was accepted.
    let lastMessage = ''
    for (const secret of this.secretCandidates) {
      const ts = Math.floor(Date.now() / 1000)
      const sig = this.signRequest(
        'track',
        'getFileUrl',
        { format_id: formatId, intent, track_id: trackId },
        ts,
        secret
      )
      const params = new URLSearchParams({
        request_ts: String(ts),
        request_sig: sig,
        track_id: String(trackId),
        format_id: String(formatId),
        intent,
        app_id: appId,
      })
      const json = await this.apiGetRaw(`track/getFileUrl?${params.toString()}`, true)

      if (json?.status === 'error' && /signature/i.test(json?.message ?? '')) {
        lastMessage = json.message
        continue // wrong secret — try the next candidate
      }
      // A non-signature auth failure here IS the token dying — flag it so the
      // reconnect UX takes over (apiGetRaw itself no longer flips this).
      if (json?.status === 'error' && /user.*token|token.*(invalid|expired)/i.test(json?.message ?? '')) {
        this.handleAuthExpired()
        throw new Error('Qobuz session expired — reconnect your Qobuz account in Settings')
      }
      // Secret accepted. Pin it to the front for future calls.
      this.secretCandidates = [secret, ...this.secretCandidates.filter((s) => s !== secret)]

      if (!json?.url) {
        return { url: '', formatId, restricted: true, restrictionCode: json?.restrictions?.[0]?.code }
      }
      return {
        url: json.url,
        formatId: json.format_id ?? formatId,
        mimeType: json.mime_type,
        bitDepth: json.bit_depth,
        samplingRate: json.sampling_rate,
      }
    }
    console.log(`[QobuzAuth] Candidate pass failed: ${lastMessage}`)
    return null
  }

  async search(query: string, limit = 10, offset = 0): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    return this.apiGet(`catalog/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&app_id=${appId}`, true)
  }

  /** Featured albums for the Discover tab. Known types: new-releases-full,
   *  press-awards, editor-picks, most-streamed, best-sellers, ideal-discography.
   *  Requires user auth (all Qobuz endpoints do post-April 2026). Optional
   *  genreId filters the feed (genre_ids param — Qobuz's own Discover filter). */
  async getFeaturedAlbums(type: string, limit = 20, offset = 0, genreId?: number): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    const genre = genreId ? `&genre_ids=${genreId}` : ''
    return this.apiGet(`album/getFeatured?type=${encodeURIComponent(type)}&limit=${limit}&offset=${offset}${genre}&app_id=${appId}`, true)
  }

  /** Featured (editorial) playlists for the Discover tab. Known types:
   *  editor-picks, last-created. */
  async getFeaturedPlaylists(type: string, limit = 20, offset = 0, genreId?: number): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    const genre = genreId ? `&genre_ids=${genreId}` : ''
    return this.apiGet(`playlist/getFeatured?type=${encodeURIComponent(type)}&limit=${limit}&offset=${offset}${genre}&app_id=${appId}`, true)
  }

  /** Qobuz's genre list (top-level genres) for the Discover genre chips. */
  /** Genre catalog. Top-level list by default; pass a parentId for that
   *  genre's subgenres (Qobuz nests e.g. Pop/Rock → Rock → Prog Rock). */
  async getGenres(parentId?: number): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    const parent = parentId ? `&parent_id=${parentId}` : ''
    return this.apiGet(`genre/list?app_id=${appId}${parent}`, true)
  }

  /** The user's own Qobuz favorites (hearted in Qobuz itself). type: albums|tracks|artists. */
  async getUserFavorites(type: 'albums' | 'tracks' | 'artists' = 'albums', limit = 20, offset = 0): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    return this.apiGet(`favorite/getUserFavorites?type=${type}&limit=${limit}&offset=${offset}&app_id=${appId}`, true)
  }

  /** The user's purchased Qobuz albums/tracks — the core Qobuz download workflow. */
  async getUserPurchases(limit = 50, offset = 0): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    return this.apiGet(`purchase/getUserPurchases?limit=${limit}&offset=${offset}&app_id=${appId}`, true)
  }

  /**
   * Parse a Qobuz URL into a {type, id}. Handles the web-player/open forms
   * (open.qobuz.com/track/ID, play.qobuz.com/album/ID) and the store form
   * (www.qobuz.com/us-en/album/slug/ID). Returns null if not recognized.
   */
  parseUrl(url: string): { type: 'track' | 'album' | 'playlist' | 'artist'; id: string } | null {
    const m = url.match(/(?:^|\/)(track|album|playlist|artist)\/(?:[^/]+\/)*([A-Za-z0-9]+)(?:[/?#]|$)/)
    if (!m) return null
    return { type: m[1] as any, id: m[2] }
  }

  /** Resolve a pasted Qobuz URL to its catalog object (track/album/playlist/artist). */
  async analyzeUrl(url: string): Promise<{ type: string; id: string; data: any }> {
    const parsed = this.parseUrl(url)
    if (!parsed) throw new Error('Unrecognized Qobuz URL')
    const data =
      parsed.type === 'track' ? await this.getTrack(parsed.id)
      : parsed.type === 'album' ? await this.getAlbum(parsed.id)
      : parsed.type === 'playlist' ? await this.getPlaylist(parsed.id)
      : await this.apiGet(`artist/get?artist_id=${parsed.id}&app_id=${(await this.fetchAppCredentials()).appId}`, true)
    return { type: parsed.type, id: parsed.id, data }
  }

  async getArtist(artistId: string | number, limit = 100): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    const artist = await this.apiGet(`artist/get?artist_id=${artistId}&extra=albums&limit=${limit}&app_id=${appId}`, true)

    // artist/get's albums extra carries NO release_type (verified live: all 100
    // of a 1537-release catalog come back untyped), so the discography tabs
    // can't classify from it. Qobuz's own web player uses artist/getReleasesList
    // with a release_type filter — query it PER TYPE so the classification
    // comes from the request itself and can't depend on a field the payload
    // may omit. Any failure falls back to the untyped albums list.
    try {
      const typed = await this.getTypedReleases(artistId, appId)
      if (typed.length > 0) {
        // Where an item also exists in the untyped albums extra, prefer that
        // richer known-shape object (covers, dates) and stamp the type onto it
        // — getReleasesList items only need to supply id/title/type minimum.
        const richById = new Map<string, any>(
          ((artist.albums?.items || []) as any[]).map((i: any) => [String(i.id), i])
        )
        const items = typed.map(t => {
          const rich = richById.get(String(t.id))
          return rich ? { ...rich, release_type: t.release_type } : t
        })
        artist.albums = { ...(artist.albums || {}), items, total: artist.albums?.total ?? items.length }
        console.log(`[QobuzAuth] Typed releases: ${items.length} across buckets`)
      }
    } catch (e: any) {
      console.log('[QobuzAuth] getReleasesList unavailable, using untyped albums:', e.message)
    }
    return artist
  }

  /** Artist top tracks — the list Qobuz's own artist page renders. artist/page
   *  is the primary source (popularity-ordered top_tracks); artist/get's
   *  popular-tracks extra is the fallback when the newer endpoint misses.
   *  Returns raw Qobuz track objects; callers map defensively because the two
   *  endpoints don't guarantee identical track shapes. */
  async getArtistTopTracks(artistId: string | number, limit = 10): Promise<any[]> {
    const { appId } = await this.fetchAppCredentials()
    try {
      const page = await this.apiGet(`artist/page?artist_id=${artistId}&sort=relevant&app_id=${appId}`, true)
      const top = page?.top_tracks
      if (Array.isArray(top) && top.length > 0) return top.slice(0, limit)
    } catch (e: any) {
      console.log('[QobuzAuth] artist/page unavailable, using extra=tracks:', logSafe(e.message))
    }
    const artist = await this.apiGet(`artist/get?artist_id=${artistId}&extra=tracks&limit=${limit}&app_id=${appId}`, true)
    return ((artist?.tracks?.items || []) as any[]).slice(0, limit)
  }

  /** Fetch an artist's releases per release-type bucket and stamp each item
   *  with the app's record_type. epSingle splits by track count (≤3 → single)
   *  — safe because the bucket itself guarantees ep-or-single. */
  private async getTypedReleases(artistId: string | number, appId: string): Promise<any[]> {
    const buckets: Array<{ qobuzType: string; stamp: (item: any) => string }> = [
      { qobuzType: 'album', stamp: () => 'album' },
      { qobuzType: 'epSingle', stamp: (i) => (i?.tracks_count || 0) <= 3 ? 'single' : 'ep' },
      { qobuzType: 'live', stamp: () => 'album' },
      { qobuzType: 'compilation', stamp: () => 'compilation' },
    ]
    const results = await Promise.all(buckets.map(b =>
      this.apiGet(`artist/getReleasesList?artist_id=${artistId}&release_type=${b.qobuzType}&limit=100&sort=release_date&app_id=${appId}`, true)
        .then(r => ({ b, items: (r?.items || r?.albums?.items || []) as any[] }))
        .catch((e: any) => {
          console.log(`[QobuzAuth] getReleasesList ${logSafe(b.qobuzType)} failed:`, logSafe(e.message))
          return { b, items: [] as any[] }
        })
    ))
    const merged: any[] = []
    const seen = new Set<string>()
    for (const { b, items } of results) {
      for (const item of items) {
        if (!item?.id || !item?.title || seen.has(String(item.id))) continue
        seen.add(String(item.id))
        merged.push({ ...item, release_type: b.stamp(item) })
      }
    }
    // Newest first across all buckets (the artist page re-sorts, but keep the
    // fallback ordering sane too).
    merged.sort((a, b) => String(b.release_date_original || b.released_at || '').localeCompare(String(a.release_date_original || a.released_at || '')))
    return merged
  }

  async getTrack(trackId: string | number): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    return this.apiGet(`track/get?track_id=${trackId}&app_id=${appId}`, true)
  }

  async getAlbum(albumId: string | number): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    const album = await this.apiGet(`album/get?album_id=${albumId}&app_id=${appId}`, true)
    await this.fetchAllTracks(album, `album/get?album_id=${albumId}&app_id=${appId}`)
    return album
  }

  async getPlaylist(playlistId: string | number): Promise<any> {
    const { appId } = await this.fetchAppCredentials()
    const playlist = await this.apiGet(`playlist/get?playlist_id=${playlistId}&extra=tracks&app_id=${appId}`, true)
    await this.fetchAllTracks(playlist, `playlist/get?playlist_id=${playlistId}&extra=tracks&app_id=${appId}`)
    return playlist
  }

  /** Qobuz pages `tracks` at 50 per request — a 273-track playlist silently
   *  came back with 50 items and only those were ever queued (#100). Follow
   *  tracks.total across offset pages until the container holds everything.
   *  2000-track runaway cap; a mid-pagination failure keeps what we have
   *  rather than failing the whole load. */
  private async fetchAllTracks(container: any, basePath: string): Promise<void> {
    const tracks = container?.tracks
    if (!tracks || !Array.isArray(tracks.items)) return
    const total = Math.min(Number(tracks.total) || tracks.items.length, 2000)
    const pageSize = 50
    while (tracks.items.length < total) {
      try {
        const page = await this.apiGet(`${basePath}&limit=${pageSize}&offset=${tracks.items.length}`, true)
        const items = page?.tracks?.items
        if (!Array.isArray(items) || items.length === 0) break // upstream stopped early — keep what we have
        tracks.items.push(...items)
      } catch (e: any) {
        console.log(`[QobuzAuth] Track pagination stopped at ${tracks.items.length}/${total}:`, logSafe(e.message))
        break
      }
    }
  }

  // --- transport helpers ---

  // All Qobuz calls get a hard timeout (a stalled connection must fail fast and
  // visibly, not hang a view forever) and one retry on network-level failures
  // (timeouts, DNS/socket errors). HTTP error statuses are NOT retried — those
  // are real answers. GETs only, so the retry is safe.
  private async fetchWithRetry(url: string, init: RequestInit, timeoutMs: number, attempts = 2): Promise<Response> {
    let lastError: any
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      } catch (e: any) {
        lastError = e
        console.log(`[QobuzAuth] Network failure (attempt ${i + 1}/${attempts}):`, e.message)
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 800))
      }
    }
    throw new Error(`Qobuz: network failure after ${attempts} attempts (${lastError?.name === 'TimeoutError' ? 'timed out' : lastError?.message})`)
  }

  private async apiGet(pathAndQuery: string, auth = false): Promise<any> {
    const headers: Record<string, string> = {}
    if (this.appCreds) headers['X-App-Id'] = this.appCreds.appId
    if (auth && this.session) headers['X-User-Auth-Token'] = this.session.userAuthToken

    const res = await this.fetchWithRetry(`${QOBUZ_API_BASE}/${pathAndQuery}`, { headers }, 15000)
    if (!res.ok) {
      // Token death: a 401 on an authenticated call means the session token
      // expired (they last days) — invalidate so the reconnect UX takes over.
      if (res.status === 401 && auth && this.session) {
        this.handleAuthExpired()
        throw new Error('Qobuz session expired — reconnect your Qobuz account in Settings')
      }
      // Carry Qobuz's own error body — a bare status hides exactly the message
      // that names the offending parameter (learned diagnosing a sudden 400).
      let detail = ''
      try { detail = (await res.text()).slice(0, 250) } catch { /* body unreadable */ }
      throw new Error(`Qobuz API ${pathAndQuery.split('?')[0]} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
    }
    return res.json()
  }

  /** Like apiGet but returns the parsed body regardless of HTTP status, so the
   *  caller can inspect error payloads (used by getFileUrl's secret trial).
   *
   *  Deliberately does NOT flip the session-expired flag on 401: Qobuz answers
   *  an invalid request SIGNATURE with HTTP 401 too, so during the secret-
   *  candidate trial every wrong candidate looked like token expiry and killed
   *  the whole session ("connected in Settings but 'Qobuz expired' everywhere",
   *  #100). Signature problems are app-credential problems, never session
   *  problems — real token expiry is still caught by apiGet on the ordinary
   *  authenticated endpoints, and by the explicit body check in the trial loop. */
  private async apiGetRaw(pathAndQuery: string, auth = false): Promise<any> {
    const headers: Record<string, string> = {}
    if (this.appCreds) headers['X-App-Id'] = this.appCreds.appId
    if (auth && this.session) headers['X-User-Auth-Token'] = this.session.userAuthToken

    const res = await this.fetchWithRetry(`${QOBUZ_API_BASE}/${pathAndQuery}`, { headers }, 15000)
    try {
      return await res.json()
    } catch {
      return { status: 'error', message: `HTTP ${res.status}` }
    }
  }

  private async httpText(url: string): Promise<string> {
    // Bundle.js is large — allow a longer window than API calls.
    const res = await this.fetchWithRetry(url, {}, 30000)
    if (!res.ok) throw new Error(`Qobuz: fetch ${url} failed: HTTP ${res.status}`)
    return res.text()
  }
}

export const qobuzAuth = new QobuzAuth()
