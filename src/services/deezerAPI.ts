import type { Track, Album, Artist, Playlist, DeezerAPIResponse } from '../types'

const DEEZER_API_BASE = 'https://api.deezer.com'
const CORS_PROXY = '' // Add CORS proxy if needed for browser

// Extended response type with pagination info
export interface PaginatedResponse<T> {
  data: T[]
  total: number
  next?: string
  prev?: string
}

export interface SearchResult<T> {
  data: T[]
  total: number
  hasMore: boolean
  nextIndex: number
}

class DeezerAPI {
  private baseUrl: string
  // In-memory cache for album details (reduces redundant API calls)
  private albumCache = new Map<string | number, { album: Album; timestamp: number }>()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minute cache
  // Cache for artist discography (ensures consistency within session)
  private discographyCache = new Map<string, { data: any; timestamp: number }>()
  // Cache for featured-in albums (search results can vary, so cache them)
  private featuredInCache = new Map<string, { data: Album[]; timestamp: number }>()

  // Retry configuration for transient failures
  private readonly MAX_RETRIES = 3
  private readonly INITIAL_RETRY_DELAY = 500 // ms

  constructor() {
    this.baseUrl = CORS_PROXY + DEEZER_API_BASE
  }

  // Helper for delay between retries
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // Get cached album or null if expired/missing
  private getCachedAlbum(id: string | number): Album | null {
    const cached = this.albumCache.get(id)
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.album
    }
    return null
  }

  // Cache an album
  private cacheAlbum(album: Album): void {
    if (album && album.id) {
      this.albumCache.set(album.id, { album, timestamp: Date.now() })
    }
  }

  private async fetch<T>(endpoint: string, retries = this.MAX_RETRIES): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`)

        // Handle rate limiting (429) with retry
        if (response.status === 429) {
          if (attempt < retries) {
            const retryDelay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt)
            console.warn(`[DeezerAPI] Rate limited, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${retries})`)
            await this.delay(retryDelay)
            continue
          }
          throw new Error('API rate limited - please try again later')
        }

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`)
        }

        const data = await response.json()

        // Deezer API returns error object with 200 status for some errors
        if (data && data.error) {
          // Some errors are transient (quota, etc.) - retry these
          const errorType = data.error.type || ''
          const isTransient = errorType.includes('Quota') || errorType.includes('Exception')

          if (isTransient && attempt < retries) {
            const retryDelay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt)
            console.warn(`[DeezerAPI] Transient error (${errorType}), retrying in ${retryDelay}ms`)
            await this.delay(retryDelay)
            continue
          }
          throw new Error(`Deezer API error: ${data.error.message || data.error.type || 'Unknown error'}`)
        }

        return data
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        // Network errors are transient - retry them
        const isNetworkError = lastError.message.includes('fetch') ||
                               lastError.message.includes('network') ||
                               lastError.message.includes('Failed to fetch') ||
                               lastError.message.includes('NetworkError')

        if (isNetworkError && attempt < retries) {
          const retryDelay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt)
          console.warn(`[DeezerAPI] Network error, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${retries})`)
          await this.delay(retryDelay)
          continue
        }

        // Non-retryable error or out of retries
        if (attempt === retries) {
          break
        }
      }
    }

    throw lastError || new Error('Failed to fetch data from Deezer API')
  }

  // Search with pagination support
  async search(
    query: string,
    type: 'track' | 'album' | 'artist' | 'playlist' = 'track',
    limit = 50,
    index = 0
  ): Promise<any[]> {
    const data = await this.fetch<DeezerAPIResponse<any>>(
      `/search/${type}?q=${encodeURIComponent(query)}&limit=${limit}&index=${index}`
    )
    return data.data || []
  }

  // Search with full pagination info
  async searchWithPagination(
    query: string,
    type: 'track' | 'album' | 'artist' | 'playlist' = 'track',
    limit = 50,
    index = 0
  ): Promise<SearchResult<any>> {
    const data = await this.fetch<PaginatedResponse<any> & { total?: number }>(
      `/search/${type}?q=${encodeURIComponent(query)}&limit=${limit}&index=${index}`
    )

    return {
      data: data.data || [],
      total: data.total || 0,
      hasMore: !!data.next,
      nextIndex: index + (data.data?.length || 0)
    }
  }

  // Load all results (exhaustive search) - use with caution for large result sets
  async searchAll(
    query: string,
    type: 'track' | 'album' | 'artist' | 'playlist' = 'track',
    maxResults = 1000
  ): Promise<any[]> {
    const results: any[] = []
    let index = 0
    const batchSize = 100 // Deezer max per request

    while (results.length < maxResults) {
      const data = await this.fetch<PaginatedResponse<any>>(
        `/search/${type}?q=${encodeURIComponent(query)}&limit=${batchSize}&index=${index}`
      )

      if (!data.data || data.data.length === 0) break

      results.push(...data.data)

      if (!data.next) break
      index += data.data.length
    }

    return results.slice(0, maxResults)
  }

  // Charts - Deezer allows up to 100 items per chart request
  // countryId: 0 = worldwide, other IDs for specific countries
  async getChart(type: 'tracks' | 'albums' | 'artists' | 'playlists', limit: number = 100, countryId: string = '0'): Promise<any[]> {
    const data = await this.fetch<{ data: any[] }>(`/chart/${countryId}/${type}?limit=${limit}`)
    return data.data || []
  }

  // Chart countries - get list of countries with chart IDs
  async getChartCountries(): Promise<{ id: string; name: string; code: string }[]> {
    // This calls our server endpoint which returns the country list
    const serverPort = window.electronAPI ? await window.electronAPI.getServerPort() : 6595
    const response = await fetch(`http://127.0.0.1:${serverPort}/api/chart/countries`)
    if (!response.ok) {
      throw new Error(`Failed to fetch chart countries: ${response.status}`)
    }
    return response.json()
  }

  // Get chart from server (supports country selection)
  async getChartFromServer(
    type: 'tracks' | 'albums' | 'artists' | 'playlists',
    countryId: string = '0',
    limit: number = 100
  ): Promise<any[]> {
    const serverPort = window.electronAPI ? await window.electronAPI.getServerPort() : 6595
    const response = await fetch(
      `http://127.0.0.1:${serverPort}/api/chart?type=${type}&country=${countryId}&limit=${limit}`
    )
    if (!response.ok) {
      throw new Error(`Failed to fetch chart: ${response.status}`)
    }
    const data = await response.json()
    return data.data || []
  }

  // New Releases - Get editorial new album releases
  async getNewReleases(limit: number = 20, genre: number = 0): Promise<Album[]> {
    const data = await this.fetch<{ data: Album[] }>(`/editorial/${genre}/releases?limit=${limit}`)
    return data.data || []
  }

  // Track
  async getTrack(id: string | number): Promise<Track> {
    return this.fetch<Track>(`/track/${id}`)
  }

  // Album (with caching)
  async getAlbum(id: string | number, skipCache = false): Promise<Album> {
    // Check cache first
    if (!skipCache) {
      const cached = this.getCachedAlbum(id)
      if (cached) return cached
    }

    const album = await this.fetch<Album>(`/album/${id}`)
    this.cacheAlbum(album)
    return album
  }

  async getAlbumTracks(id: string | number, limit = 500): Promise<Track[]> {
    // Albums can have many tracks (compilations, etc), get all of them
    const allTracks: Track[] = []
    let index = 0
    const batchSize = 100

    while (allTracks.length < limit) {
      const data = await this.fetch<PaginatedResponse<Track>>(`/album/${id}/tracks?limit=${batchSize}&index=${index}`)
      if (!data.data || data.data.length === 0) break
      allTracks.push(...data.data)
      if (!data.next) break
      index += data.data.length
    }

    return allTracks.slice(0, limit)
  }

  // Artist
  async getArtist(id: string | number): Promise<Artist> {
    return this.fetch<Artist>(`/artist/${id}`)
  }

  async getArtistTopTracks(id: string | number, limit = 100): Promise<Track[]> {
    const data = await this.fetch<DeezerAPIResponse<Track>>(`/artist/${id}/top?limit=${Math.min(limit, 100)}`)
    return data.data || []
  }

  async getArtistAlbums(id: string | number, limit = 500, index = 0): Promise<Album[]> {
    const data = await this.fetch<DeezerAPIResponse<Album>>(`/artist/${id}/albums?limit=${limit}&index=${index}`)
    return data.data || []
  }

  // Get all albums for an artist (paginated)
  async getArtistAlbumsAll(id: string | number, maxResults = 1000): Promise<Album[]> {
    const allAlbums: Album[] = []
    let index = 0
    const batchSize = 100

    while (allAlbums.length < maxResults) {
      const data = await this.fetch<PaginatedResponse<Album>>(`/artist/${id}/albums?limit=${batchSize}&index=${index}`)
      if (!data.data || data.data.length === 0) break
      // Filter to only include albums with valid id and title
      const validAlbums = data.data.filter(album => album && album.id && album.title)
      allAlbums.push(...validAlbums)
      if (!data.next) break
      index += data.data.length
    }

    // Debug: Log record_type distribution
    const typeCounts: Record<string, number> = {}
    for (const album of allAlbums) {
      const type = album.record_type || 'undefined'
      typeCounts[type] = (typeCounts[type] || 0) + 1
    }
    console.log(`[DeezerAPI] Fetched ${allAlbums.length} albums for artist ${id}. Types:`, typeCounts)

    return allAlbums.slice(0, maxResults)
  }

  // Get all albums for an artist (basic info only - fast)
  async getArtistAlbumsBasic(id: string | number, maxResults = 1000): Promise<Album[]> {
    return this.getArtistAlbumsAll(id, maxResults)
  }

  // Infer record_type from track count AND title hints when Deezer's data is unreliable
  // Deezer often returns all releases as "album" regardless of actual type
  private inferRecordType(nb_tracks: number | undefined, existingType?: string, title?: string): string {
    // If we have a specific type that's not just "album", trust it
    if (existingType && existingType !== 'album') {
      return existingType
    }

    // Check title for explicit hints (most reliable signal)
    if (title) {
      const lowerTitle = title.toLowerCase()

      // Check for EP indicators in title
      if (lowerTitle.includes(' ep') ||
          lowerTitle.includes('(ep)') ||
          lowerTitle.includes('[ep]') ||
          lowerTitle.endsWith(' ep') ||
          / e\.p\.?$/i.test(title) ||
          / - ep$/i.test(lowerTitle)) {
        return 'ep'
      }

      // Check for Single indicators in title
      if (lowerTitle.includes('(single)') ||
          lowerTitle.includes('[single]') ||
          lowerTitle.includes(' - single') ||
          lowerTitle.endsWith(' single')) {
        return 'single'
      }

      // Remixes collections are typically EPs (unless very long)
      if ((lowerTitle.includes('remixes') || lowerTitle.includes('the remixes')) &&
          nb_tracks && nb_tracks <= 12) {
        return 'ep'
      }
    }

    // If no track count, can't infer further - keep existing or default to album
    if (!nb_tracks || nb_tracks === 0) {
      return existingType || 'album'
    }

    // Infer from track count - MUST match backend (deezerAuth.ts) thresholds!
    // Singles: 1-2 tracks
    // EPs: 3-6 tracks
    // Albums: 7+ tracks
    if (nb_tracks <= 2) {
      return 'single'
    } else if (nb_tracks <= 6) {
      return 'ep'
    } else {
      return 'album'
    }
  }

  // Helper to safely merge basic album with detailed album data
  // IMPORTANT: Prefer detailed.record_type because /album/{id} returns accurate types
  // while /artist/{id}/albums often returns "album" for everything
  private mergeAlbumData(basic: Album, detailed: Album | null): Album {
    if (!detailed) {
      // Without details, try to infer from title
      return {
        ...basic,
        record_type: this.inferRecordType(basic.nb_tracks, basic.record_type, basic.title)
      }
    }

    const nb_tracks = detailed.nb_tracks ?? basic.nb_tracks
    // CRITICAL: Prefer detailed.record_type - it's more accurate than basic
    const recordType = detailed.record_type || basic.record_type
    const title = basic.title || detailed.title

    return {
      // Start with basic data
      ...basic,
      // Add detail-only fields from detailed response
      nb_tracks,
      duration: detailed.duration ?? basic.duration,
      fans: detailed.fans ?? basic.fans,
      // Use detailed record_type first, then infer only if still "album"
      record_type: this.inferRecordType(nb_tracks, recordType, title),
      release_date: detailed.release_date || basic.release_date,
      // Use detailed cover if basic doesn't have it
      cover: basic.cover || detailed.cover,
      cover_small: basic.cover_small || detailed.cover_small,
      cover_medium: basic.cover_medium || detailed.cover_medium,
      cover_big: basic.cover_big || detailed.cover_big,
      cover_xl: basic.cover_xl || detailed.cover_xl
    }
  }

  // Get all albums for an artist with full details (including nb_tracks)
  // Returns albums progressively via callback for better UX
  async getArtistAlbumsWithDetails(
    id: string | number,
    maxResults = 1000,
    onProgress?: (albums: Album[], loaded: number, total: number) => void
  ): Promise<Album[]> {
    // First get the basic album list - this is fast
    // Basic list includes record_type which is essential for filtering (album/ep/single)
    const basicAlbums = await this.getArtistAlbumsAll(id, maxResults)

    if (basicAlbums.length === 0) return []

    // Create a map of basic album data - this is the authoritative source for record_type
    const basicAlbumMap = new Map<string | number, Album>()
    for (const album of basicAlbums) {
      basicAlbumMap.set(album.id, album)
    }

    // Track which albums have full details (nb_tracks)
    const detailedAlbums = new Map<string | number, Album>()
    const albumsNeedingFetch: Album[] = []

    // Check cache first
    for (const album of basicAlbums) {
      const cached = this.getCachedAlbum(album.id)
      if (cached && cached.nb_tracks !== undefined) {
        // Merge cached with basic, preserving record_type from basic
        detailedAlbums.set(album.id, this.mergeAlbumData(album, cached))
      } else {
        albumsNeedingFetch.push(album)
      }
    }

    // Report initial progress with ALL basic albums
    // They have record_type for proper tab filtering even before details load
    if (onProgress) {
      const allAlbums = basicAlbums.map(album => {
        const detailed = detailedAlbums.get(album.id)
        return detailed || { ...album }
      })
      // Debug: verify record_type is preserved
      const typeCounts: Record<string, number> = {}
      for (const album of allAlbums) {
        const type = album.record_type || 'undefined'
        typeCounts[type] = (typeCounts[type] || 0) + 1
      }
      console.log(`[DeezerAPI] Initial progress - Types in allAlbums:`, typeCounts)
      onProgress(allAlbums, detailedAlbums.size, basicAlbums.length)
    }

    // If all albums were cached, we're done
    if (albumsNeedingFetch.length === 0) {
      console.log(`[DeezerAPI] All ${basicAlbums.length} albums loaded from cache`)
      // Return in original order
      return basicAlbums.map(album => detailedAlbums.get(album.id) || album)
    }

    console.log(`[DeezerAPI] Fetching details for ${albumsNeedingFetch.length} albums (${detailedAlbums.size} cached)`)

    // Fetch full details in batches (optimized for speed)
    const batchSize = 20  // Increased from 10 for faster loading
    const batchDelay = 25 // Reduced from 50ms - still safe for rate limits
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < albumsNeedingFetch.length; i += batchSize) {
      const batch = albumsNeedingFetch.slice(i, i + batchSize)

      const results = await Promise.allSettled(
        batch.map(album => this.getAlbum(album.id))
      )

      results.forEach((result, index) => {
        const basicAlbum = batch[index]
        if (result.status === 'fulfilled') {
          const detailedAlbum = result.value
          if (detailedAlbum && detailedAlbum.id) {
            // Use helper to safely merge, preserving record_type from basic
            detailedAlbums.set(basicAlbum.id, this.mergeAlbumData(basicAlbum, detailedAlbum))
            successCount++
          } else {
            // Invalid response - use basic album with nb_tracks = 0
            detailedAlbums.set(basicAlbum.id, { ...basicAlbum, nb_tracks: 0 })
            failCount++
          }
        } else {
          // Request failed - use basic album with nb_tracks = 0
          detailedAlbums.set(basicAlbum.id, { ...basicAlbum, nb_tracks: 0 })
          failCount++
        }
      })

      // Report progress - include ALL albums with details where available
      if (onProgress) {
        const allAlbums = basicAlbums.map(album => {
          const detailed = detailedAlbums.get(album.id)
          return detailed || { ...album }
        })
        onProgress(allAlbums, detailedAlbums.size, basicAlbums.length)
      }

      if (i + batchSize < albumsNeedingFetch.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelay))
      }
    }

    console.log(`[DeezerAPI] Album details: ${successCount} success, ${failCount} failed`)

    // Return all albums in original order with details merged
    return basicAlbums.map(album => {
      const detailed = detailedAlbums.get(album.id)
      return detailed || { ...album, nb_tracks: 0 }
    })
  }

  async getArtistRelated(id: string | number, limit = 50): Promise<Artist[]> {
    const data = await this.fetch<DeezerAPIResponse<Artist>>(`/artist/${id}/related?limit=${Math.min(limit, 100)}`)
    return data.data || []
  }

  /**
   * Get artist discography from the server using the private Deezer API
   * This returns properly categorized releases (albums, EPs, singles, etc.)
   * Unlike the public API which returns everything as "album"
   */
  async getArtistDiscographyFromServer(
    artistId: string | number,
    serverPort: number = 6595
  ): Promise<{
    all: Album[]
    albums: Album[]
    eps: Album[]
    singles: Album[]
    compilations: Album[]
    featured: Album[]
    counts: {
      total: number
      albums: number
      eps: number
      singles: number
      compilations: number
      featured: number
    }
  }> {
    const emptyResult = {
      all: [] as Album[],
      albums: [] as Album[],
      eps: [] as Album[],
      singles: [] as Album[],
      compilations: [] as Album[],
      featured: [] as Album[],
      counts: { total: 0, albums: 0, eps: 0, singles: 0, compilations: 0, featured: 0 }
    }

    // Normalize cache key to string (JS Map treats "123" !== 123)
    const cacheKey = String(artistId)
    const sessionCacheKey = `discography_${cacheKey}`

    // Check sessionStorage first (persists across navigation)
    try {
      const sessionCached = sessionStorage.getItem(sessionCacheKey)
      if (sessionCached) {
        const parsed = JSON.parse(sessionCached)
        if (Date.now() - parsed.timestamp < this.CACHE_TTL) {
          console.log(`[DeezerAPI] Using SESSION-CACHED discography for artist ${cacheKey}`)
          return parsed.data
        }
      }
    } catch (e) {
      // sessionStorage not available or parse error
    }

    // Check in-memory cache second
    const cached = this.discographyCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[DeezerAPI] Using memory-cached discography for artist ${cacheKey}`)
      return cached.data
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${serverPort}/api/artist/discography?id=${artistId}`
      )

      if (!response.ok) {
        console.warn(`[DeezerAPI] Server discography fetch failed: ${response.status}`)
        return emptyResult
      }

      const data = await response.json()

      if (data.error) {
        console.warn('[DeezerAPI] Server discography error:', data.error)
        return emptyResult
      }

      console.log(`[DeezerAPI] Server discography for artist ${artistId}:`, data.counts)

      const result = {
        all: data.all || [],
        albums: data.albums || [],
        eps: data.eps || [],
        singles: data.singles || [],
        compilations: data.compilations || [],
        featured: data.featured || [],
        counts: data.counts || emptyResult.counts
      }

      // Cache the result for consistency (use normalized key)
      if (result.counts.total > 0) {
        const now = Date.now()
        this.discographyCache.set(cacheKey, { data: result, timestamp: now })

        // Also save to sessionStorage for persistence across navigation
        try {
          sessionStorage.setItem(sessionCacheKey, JSON.stringify({ data: result, timestamp: now }))
          console.log(`[DeezerAPI] Saved discography to session cache for artist ${cacheKey}`)
        } catch (e) {
          // sessionStorage quota exceeded or not available
        }
      }

      return result
    } catch (error) {
      console.error('[DeezerAPI] Failed to fetch discography from server:', error)
      return emptyResult
    }
  }

  // Get albums where the artist is featured (appears on other artists' albums)
  // Strategy: Search for tracks mentioning the artist, extract albums, fetch full details
  async getArtistFeaturedIn(artistId: string | number, artistName: string, maxResults = 100): Promise<Album[]> {
    // Normalize cache key to string
    const cacheKey = String(artistId)

    // Check cache first (search results are inherently variable, so cache is important)
    const cached = this.featuredInCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[DeezerAPI] Using cached featured-in for artist ${cacheKey} (${cached.data.length} albums)`)
      return cached.data
    }

    const albumIds = new Set<number>()
    const artistIdNum = typeof artistId === 'string' ? parseInt(artistId, 10) : artistId

    // Multiple search strategies to find featured appearances
    const searchQueries = [
      `"${artistName}"`,           // Exact name match
      `feat ${artistName}`,
      `feat. ${artistName}`,
      `ft ${artistName}`,
      `ft. ${artistName}`,
      `featuring ${artistName}`,
      `& ${artistName}`,
      `and ${artistName}`,
      artistName
    ]

    console.log(`[DeezerAPI] Searching for featured appearances of ${artistName}...`)

    // Search for tracks with each query pattern
    for (const query of searchQueries) {
      if (albumIds.size >= maxResults * 2) break // Get extra to account for filtering

      try {
        // Search for tracks - paginate to get more results
        let index = 0
        const batchSize = 100
        const maxPerQuery = 300

        while (index < maxPerQuery) {
          const trackData = await this.fetch<PaginatedResponse<Track>>(
            `/search/track?q=${encodeURIComponent(query)}&limit=${batchSize}&index=${index}`
          )

          if (!trackData.data || trackData.data.length === 0) break

          for (const track of trackData.data) {
            // Skip if this is the artist's own track (they're the primary artist)
            const trackArtistId = track.artist?.id
            if (trackArtistId === artistIdNum) continue

            // Check if album is by a different artist
            if (track.album && track.album.id) {
              const albumArtistId = track.album.artist?.id || trackArtistId
              if (albumArtistId !== artistIdNum) {
                albumIds.add(typeof track.album.id === 'string' ? parseInt(track.album.id, 10) : track.album.id)
              }
            }
          }

          if (!trackData.next) break
          index += trackData.data.length
        }
      } catch (error) {
        // Continue with other queries
      }
    }

    console.log(`[DeezerAPI] Found ${albumIds.size} potential featured albums, fetching details...`)

    // Fetch full album details for each found album (to get nb_tracks, release_date)
    const albumIdsArray = Array.from(albumIds).slice(0, maxResults)
    const detailedAlbums: Album[] = []

    // Fetch in batches (optimized for speed)
    const batchSize = 20  // Increased from 10 for faster loading
    for (let i = 0; i < albumIdsArray.length; i += batchSize) {
      const batch = albumIdsArray.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map(id => this.getAlbum(id))
      )

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const album = result.value
          // Double-check it's not by the target artist
          const albumArtistId = album.artist?.id
          if (albumArtistId !== artistIdNum) {
            detailedAlbums.push(album)
          }
        }
      }
    }

    console.log(`[DeezerAPI] Returning ${detailedAlbums.length} featured-in albums for ${artistName}`)

    // Cache the results (search is variable, so caching ensures consistency)
    this.featuredInCache.set(cacheKey, { data: detailedAlbums, timestamp: Date.now() })

    return detailedAlbums
  }

  // Playlist
  async getPlaylist(id: string | number): Promise<Playlist> {
    return this.fetch<Playlist>(`/playlist/${id}`)
  }

  async getPlaylistTracks(id: string | number, limit = 2000): Promise<Track[]> {
    // Playlists can be very large, get all tracks
    const allTracks: Track[] = []
    let index = 0
    const batchSize = 100

    while (allTracks.length < limit) {
      const data = await this.fetch<PaginatedResponse<Track>>(`/playlist/${id}/tracks?limit=${batchSize}&index=${index}`)
      if (!data.data || data.data.length === 0) break
      allTracks.push(...data.data)
      if (!data.next) break
      index += data.data.length
    }

    return allTracks.slice(0, limit)
  }

  // Get playlist tracks with progress callback for large playlists
  async getPlaylistTracksWithProgress(
    id: string | number,
    totalTracks: number,
    onProgress: (loaded: number, total: number) => void,
    limit = 2000
  ): Promise<Track[]> {
    const allTracks: Track[] = []
    let index = 0
    const batchSize = 100

    while (allTracks.length < limit) {
      const data = await this.fetch<PaginatedResponse<Track>>(`/playlist/${id}/tracks?limit=${batchSize}&index=${index}`)
      if (!data.data || data.data.length === 0) break
      allTracks.push(...data.data)

      // Report progress
      onProgress(allTracks.length, Math.min(totalTracks, limit))

      if (!data.next) break
      index += data.data.length
    }

    return allTracks.slice(0, limit)
  }

  // URL parsing - extract type and ID from Deezer URLs
  parseUrl(url: string): { type: string; id: string } | null {
    const patterns = [
      /deezer\.com\/(?:\w+\/)?track\/(\d+)/,
      /deezer\.com\/(?:\w+\/)?album\/(\d+)/,
      /deezer\.com\/(?:\w+\/)?artist\/(\d+)/,
      /deezer\.com\/(?:\w+\/)?playlist\/(\d+)/
    ]

    const types = ['track', 'album', 'artist', 'playlist']

    for (let i = 0; i < patterns.length; i++) {
      const match = url.match(patterns[i])
      if (match) {
        return { type: types[i], id: match[1] }
      }
    }

    return null
  }

  // Get content from URL
  async getFromUrl(url: string): Promise<{ type: string; data: any } | null> {
    const parsed = this.parseUrl(url)
    if (!parsed) return null

    let data: any
    switch (parsed.type) {
      case 'track':
        data = await this.getTrack(parsed.id)
        break
      case 'album':
        data = await this.getAlbum(parsed.id)
        break
      case 'artist':
        data = await this.getArtist(parsed.id)
        break
      case 'playlist':
        data = await this.getPlaylist(parsed.id)
        break
      default:
        return null
    }

    return { type: parsed.type, data }
  }
}

export const deezerAPI = new DeezerAPI()
