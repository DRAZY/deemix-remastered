import * as https from 'https'

export interface SpotifyTrack {
  id: string
  name: string
  artists: Array<{ id: string; name: string }>
  album: {
    id: string
    name: string
    images: Array<{ url: string; width: number; height: number }>
    release_date: string
  }
  duration_ms: number
  explicit: boolean
  external_ids?: {
    isrc?: string
  }
  preview_url: string | null
  popularity: number
}

export interface SpotifyAlbum {
  id: string
  name: string
  artists: Array<{ id: string; name: string }>
  images: Array<{ url: string; width: number; height: number }>
  release_date: string
  total_tracks: number
  tracks: {
    items: SpotifyTrack[]
    total: number
  }
  label: string
  genres: string[]
}

export interface SpotifyPlaylist {
  id: string
  name: string
  description: string
  owner: { id: string; display_name: string }
  images: Array<{ url: string; width: number; height: number }>
  tracks: {
    items: Array<{ track: SpotifyTrack }>
    total: number
  }
  public: boolean
}

export interface SpotifyArtist {
  id: string
  name: string
  images: Array<{ url: string; width: number; height: number }>
  genres: string[]
  followers: { total: number }
  popularity: number
}

class SpotifyAPI {
  private accessToken: string | null = null
  private tokenExpiry: number = 0
  private clientId: string = ''
  private clientSecret: string = ''

  /**
   * Set credentials for Spotify API
   */
  setCredentials(clientId: string, clientSecret: string): void {
    this.clientId = clientId
    this.clientSecret = clientSecret
    // Reset token when credentials change
    this.accessToken = null
    this.tokenExpiry = 0
  }

  /**
   * Check if credentials are configured
   */
  hasCredentials(): boolean {
    return !!(this.clientId && this.clientSecret)
  }

  /**
   * Authenticate with Spotify using Client Credentials flow
   */
  async authenticate(): Promise<boolean> {
    if (!this.clientId || !this.clientSecret) {
      console.error('[SpotifyAPI] No credentials configured')
      return false
    }

    try {
      const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')

      const response = await this.makeRequest<{
        access_token: string
        token_type: string
        expires_in: number
      }>({
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      })

      this.accessToken = response.access_token
      // Set expiry 5 minutes before actual expiry to ensure we refresh in time
      this.tokenExpiry = Date.now() + (response.expires_in - 300) * 1000
      console.log('[SpotifyAPI] Successfully authenticated')
      return true
    } catch (error: any) {
      console.error('[SpotifyAPI] Authentication failed:', error.message)
      this.accessToken = null
      this.tokenExpiry = 0
      return false
    }
  }

  /**
   * Ensure we have a valid token, refreshing if needed
   */
  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      const success = await this.authenticate()
      if (!success) {
        throw new Error('Failed to authenticate with Spotify')
      }
    }
  }

  /**
   * Make an HTTP request
   */
  private makeRequest<T>(options: {
    hostname: string
    path: string
    method?: string
    headers?: Record<string, string>
    body?: string
  }): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: options.hostname,
        path: options.path,
        method: options.method || 'GET',
        headers: options.headers
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`))
            } else {
              resolve(parsed)
            }
          } catch (e) {
            reject(new Error('Failed to parse Spotify response'))
          }
        })
      })

      req.on('error', reject)

      if (options.body) {
        req.write(options.body)
      }
      req.end()
    })
  }

  /**
   * Make an authenticated API request
   */
  private async apiRequest<T>(endpoint: string): Promise<T> {
    await this.ensureToken()

    return this.makeRequest<T>({
      hostname: 'api.spotify.com',
      path: `/v1${endpoint}`,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    })
  }

  /**
   * Parse a Spotify URL or URI
   */
  parseSpotifyUrl(url: string): { type: string; id: string } | null {
    // Handle Spotify URIs: spotify:track:4iV5W9uYEdYUVa79Axb7Rh
    const uriMatch = url.match(/^spotify:(track|album|playlist|artist):([a-zA-Z0-9]+)$/)
    if (uriMatch) {
      return { type: uriMatch[1], id: uriMatch[2] }
    }

    // Handle Spotify URLs: https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh
    const urlMatch = url.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/)
    if (urlMatch) {
      return { type: urlMatch[1], id: urlMatch[2] }
    }

    // Handle link.spotify.com URLs
    const shortMatch = url.match(/link\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/)
    if (shortMatch) {
      return { type: shortMatch[1], id: shortMatch[2] }
    }

    return null
  }

  /**
   * Check if a URL is a Spotify URL
   */
  isSpotifyUrl(url: string): boolean {
    return url.includes('open.spotify.com') ||
           url.includes('link.spotify.com') ||
           url.startsWith('spotify:')
  }

  /**
   * Get track info
   */
  async getTrack(id: string): Promise<SpotifyTrack> {
    return this.apiRequest<SpotifyTrack>(`/tracks/${id}`)
  }

  /**
   * Get album info with all tracks
   */
  async getAlbum(id: string): Promise<SpotifyAlbum> {
    return this.apiRequest<SpotifyAlbum>(`/albums/${id}`)
  }

  /**
   * Get playlist info with tracks (paginated)
   */
  async getPlaylist(id: string, market: string = 'US'): Promise<SpotifyPlaylist> {
    const playlist = await this.apiRequest<SpotifyPlaylist>(`/playlists/${id}?market=${market}`)

    // If playlist has more than 100 tracks, fetch remaining pages
    if (playlist.tracks.total > 100) {
      const allItems = [...playlist.tracks.items]
      let offset = 100

      while (offset < playlist.tracks.total) {
        const page = await this.apiRequest<{ items: Array<{ track: SpotifyTrack }> }>(
          `/playlists/${id}/tracks?offset=${offset}&limit=100&market=${market}`
        )
        allItems.push(...page.items)
        offset += 100
      }

      playlist.tracks.items = allItems
    }

    return playlist
  }

  /**
   * Get artist info
   */
  async getArtist(id: string): Promise<SpotifyArtist> {
    return this.apiRequest<SpotifyArtist>(`/artists/${id}`)
  }

  /**
   * Get artist's top tracks
   */
  async getArtistTopTracks(id: string, market: string = 'US'): Promise<SpotifyTrack[]> {
    const response = await this.apiRequest<{ tracks: SpotifyTrack[] }>(
      `/artists/${id}/top-tracks?market=${market}`
    )
    return response.tracks
  }

  /**
   * Get artist's albums
   */
  async getArtistAlbums(id: string, limit: number = 50): Promise<SpotifyAlbum[]> {
    const response = await this.apiRequest<{ items: SpotifyAlbum[] }>(
      `/artists/${id}/albums?include_groups=album,single&limit=${limit}`
    )
    return response.items
  }
}

export const spotifyAPI = new SpotifyAPI()
