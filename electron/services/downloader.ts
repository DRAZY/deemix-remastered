import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as crypto from 'crypto'
import { Blowfish } from 'egoroof-blowfish'
import * as aesjs from 'aes-js'
import { deezerAuth } from './deezerAuth'

export interface FolderSettings {
  createPlaylistFolder: boolean
  createArtistFolder: boolean
  createAlbumFolder: boolean
  createCDFolder: boolean
  createPlaylistStructure: boolean
  createSinglesStructure: boolean
  playlistFolderTemplate: string
  albumFolderTemplate: string
  artistFolderTemplate: string
}

export interface TrackTemplates {
  trackNameTemplate: string
  albumTrackTemplate: string
  playlistTrackTemplate: string
}

export interface TagSettings {
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

export type LocalArtworkFormat = 'jpeg' | 'png' | 'both'

export interface AlbumCoverSettings {
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

export type ArtistSeparator = 'standard' | 'comma' | 'slash' | 'semicolon' | 'ampersand'
export type DateFormat = 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY'

export type FeaturedArtistsHandling = 'nothing' | 'remove' | 'moveToTitle' | 'removeFromTitle'
export type CasingOption = 'unchanged' | 'lowercase' | 'uppercase' | 'titlecase' | 'sentencecase'

export interface MetadataSettings {
  tags: TagSettings
  albumCovers: AlbumCoverSettings
  useNullSeparator: boolean
  saveID3v1: boolean
  saveOnlyMainArtist: boolean
  artistSeparator: ArtistSeparator
  dateFormatFlac: DateFormat
  // Text processing settings
  titleCasing?: CasingOption
  artistCasing?: CasingOption
  removeAlbumVersion?: boolean
  featuredArtistsHandling?: FeaturedArtistsHandling
  keepVariousArtists?: boolean
  removeArtistCombinations?: boolean
}

export interface DownloadOptions {
  trackId: string | number
  outputPath: string
  quality: 'MP3_128' | 'MP3_320' | 'FLAC'
  bitrateFallback?: boolean  // Whether to fallback to lower bitrates if preferred unavailable
  createFolders: boolean
  artistFolder: boolean
  albumFolder: boolean
  saveArtwork: boolean
  embedArtwork: boolean
  saveLyrics: boolean
  syncedLyrics?: boolean
  // Additional folder settings
  folderSettings?: FolderSettings
  // Track naming templates
  trackTemplates?: TrackTemplates
  // Metadata settings (tags, album covers, etc.)
  metadataSettings?: MetadataSettings
  // Context for template replacement
  playlistName?: string
  isFromPlaylist?: boolean
  isSingle?: boolean
  discNumber?: number
  playlistPosition?: number
  // Playlist context - for compilation handling
  playlistContext?: {
    playlistId: string | number
    playlistName: string
  }
  playlistOwner?: string
  savePlaylistAsCompilation?: boolean
  // Album context - used to keep all album tracks in same folder
  albumContext?: {
    albumId: number | string
    albumTitle: string
    albumArtist: string
    artistPicture?: string  // Artist picture URL for saving artist image
    totalDiscs?: number     // Total number of discs in the album
    explicitLyrics?: boolean // Album-level explicit flag for consistent folder naming
  }
  // Error logging
  createErrorLog?: boolean
  // Overwrite behavior: 'no' = skip existing, 'overwrite' = replace, 'rename' = add suffix
  overwriteMode?: 'no' | 'overwrite' | 'rename'
}

// Detailed error information for better user feedback
export interface DownloadErrorDetails {
  message: string                    // Human-readable error message
  code?: string                      // Error code (e.g., 'TRACK_UNAVAILABLE', 'GEO_RESTRICTED')
  httpStatus?: number               // HTTP status code if applicable
  serverResponse?: string           // Raw server response for debugging
  timestamp: string                 // When the error occurred
  trackId?: string | number         // Associated track ID
  suggestion?: string               // Suggestion for user action
}

export interface DownloadProgress {
  id: string
  trackId: string | number
  progress: number
  speed: number
  downloaded: number
  total: number
  status: 'pending' | 'downloading' | 'decrypting' | 'tagging' | 'completed' | 'error'
  // Track info for error logging and display
  trackTitle?: string
  trackArtist?: string
  albumTitle?: string
  albumFolder?: string  // Folder path for error log file (may include CD subfolder)
  albumRootFolder?: string  // Root album folder path (excludes CD subfolders) - used for deletion
  actualFormat?: string  // Actual downloaded format (may differ from requested due to fallback)
  error?: string
  errorDetails?: DownloadErrorDetails  // Enhanced error information
}

const BLOWFISH_KEY = 'g4el58wc0zvf9na1'

// Custom error class with additional metadata for better error reporting
class DownloadError extends Error {
  code?: string
  httpStatus?: number
  serverResponse?: string

  constructor(message: string, options?: {
    code?: string
    httpStatus?: number
    serverResponse?: string
  }) {
    super(message)
    this.name = 'DownloadError'
    this.code = options?.code
    this.httpStatus = options?.httpStatus
    this.serverResponse = options?.serverResponse
  }
}

export class Downloader extends EventEmitter {
  private activeDownloads: Map<string, DownloadProgress> = new Map()
  private downloadQueue: { id: string; options: DownloadOptions }[] = []
  private isProcessing = false
  private maxConcurrent = 3
  private currentDownloads = 0
  // Queue pause state - when paused, no new downloads start (current ones complete)
  private _isPaused = false
  // Artwork cache: stores downloaded artwork buffers keyed by album picture hash
  // This prevents re-downloading the same cover for each track in an album
  private artworkCache: Map<string, Promise<Buffer>> = new Map()
  // Genre cache: stores album genre lookups to avoid redundant API calls (now supports multiple genres)
  private genreCache: Map<string, Promise<string[]>> = new Map()
  // Progress throttling: track last emit time per download to reduce event frequency
  private lastProgressEmit: Map<string, number> = new Map()
  private readonly PROGRESS_THROTTLE_MS = 250 // Emit progress at most every 250ms
  // Reserved paths: tracks output paths currently being used by in-progress downloads
  // This prevents concurrent downloads from overwriting each other's files
  private reservedPaths: Set<string> = new Set()
  // Playlist M3U tracker: collects actual file paths as tracks complete
  // so M3U can be generated from real paths instead of reconstructed guesses
  private playlistM3UTracker: Map<string, {
    outputDir: string
    totalTracks: number
    processedCount: number  // tracks completed + failed (for knowing when to generate)
    completedEntries: Array<{
      position: number
      duration: number
      artist: string
      title: string
      absolutePath: string
    }>
  }> = new Map()

  constructor() {
    super()
  }

  /**
   * Check if the download queue is paused
   */
  get isPaused(): boolean {
    return this._isPaused
  }

  /**
   * Pause the download queue - current downloads complete, no new ones start
   */
  pauseQueue(): void {
    if (!this._isPaused) {
      this._isPaused = true
      console.log('[Downloader] Queue paused')
      this.emit('paused')
    }
  }

  /**
   * Resume the download queue - start processing pending downloads again
   */
  resumeQueue(): void {
    if (this._isPaused) {
      this._isPaused = false
      console.log('[Downloader] Queue resumed')
      this.emit('resumed')
      // Immediately try to process queue
      this.processQueue()
    }
  }

  /**
   * Get the current queue status
   */
  getQueueStatus(): { isPaused: boolean; queueLength: number; currentDownloads: number; maxConcurrent: number } {
    return {
      isPaused: this._isPaused,
      queueLength: this.downloadQueue.length,
      currentDownloads: this.currentDownloads,
      maxConcurrent: this.maxConcurrent
    }
  }

  /**
   * Create a detailed error object for better user feedback
   */
  private createErrorDetails(
    message: string,
    options: {
      code?: string
      httpStatus?: number
      serverResponse?: string
      trackId?: string | number
      suggestion?: string
    } = {}
  ): DownloadErrorDetails {
    return {
      message,
      code: options.code,
      httpStatus: options.httpStatus,
      serverResponse: options.serverResponse,
      timestamp: new Date().toISOString(),
      trackId: options.trackId,
      suggestion: options.suggestion || this.getSuggestionForError(message, options.code, options.httpStatus)
    }
  }

  /**
   * Generate helpful suggestions based on error type
   */
  private getSuggestionForError(message: string, code?: string, httpStatus?: number): string {
    const lowerMessage = message.toLowerCase()

    if (code === 'GEO_RESTRICTED' || lowerMessage.includes('geo') || lowerMessage.includes('region') || lowerMessage.includes('country')) {
      return 'This track may not be available in your region. Try using a VPN or check if the track is available on Deezer in your country.'
    }
    if (code === 'TRACK_UNAVAILABLE' || lowerMessage.includes('unavailable') || lowerMessage.includes('not available')) {
      return 'This track is no longer available on Deezer. It may have been removed by the artist or label.'
    }
    if (httpStatus === 403 || lowerMessage.includes('forbidden') || lowerMessage.includes('permission')) {
      return 'Access denied. Your session may have expired. Try logging out and back in.'
    }
    if (httpStatus === 401 || lowerMessage.includes('unauthorized') || lowerMessage.includes('auth')) {
      return 'Authentication failed. Please check your ARL token or log in again.'
    }
    if (httpStatus === 404 || lowerMessage.includes('not found')) {
      return 'Track not found on Deezer servers. It may have been removed.'
    }
    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      return 'Connection timed out. Check your internet connection and try again.'
    }
    if (lowerMessage.includes('network') || lowerMessage.includes('connection')) {
      return 'Network error. Check your internet connection and try again.'
    }
    if (lowerMessage.includes('no data') || lowerMessage.includes('empty')) {
      return 'Server returned no data. The track may be temporarily unavailable. Try again later.'
    }
    if (lowerMessage.includes('decrypt')) {
      return 'Failed to decrypt track. This may indicate an issue with your account permissions.'
    }

    return 'Try again later. If the problem persists, check your login status and internet connection.'
  }

  /**
   * Infer an error code from an error message
   */
  private inferErrorCode(message: string): string {
    const lowerMessage = message.toLowerCase()

    if (lowerMessage.includes('geo') || lowerMessage.includes('region') || lowerMessage.includes('country')) {
      return 'GEO_RESTRICTED'
    }
    if (lowerMessage.includes('unavailable') || lowerMessage.includes('not available')) {
      return 'TRACK_UNAVAILABLE'
    }
    if (lowerMessage.includes('forbidden') || lowerMessage.includes('403')) {
      return 'ACCESS_DENIED'
    }
    if (lowerMessage.includes('unauthorized') || lowerMessage.includes('401') || lowerMessage.includes('auth')) {
      return 'AUTH_FAILED'
    }
    if (lowerMessage.includes('not found') || lowerMessage.includes('404')) {
      return 'NOT_FOUND'
    }
    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      return 'TIMEOUT'
    }
    if (lowerMessage.includes('network') || lowerMessage.includes('connection')) {
      return 'NETWORK_ERROR'
    }
    if (lowerMessage.includes('no data') || lowerMessage.includes('empty') || lowerMessage.includes('not created')) {
      return 'NO_DATA'
    }
    if (lowerMessage.includes('decrypt')) {
      return 'DECRYPT_FAILED'
    }

    return 'DOWNLOAD_FAILED'
  }

  /**
   * Emit progress with throttling to reduce UI update frequency
   * Always emits immediately for status changes, throttles percentage updates
   */
  private emitProgressThrottled(progress: DownloadProgress, forceEmit: boolean = false): void {
    const now = Date.now()
    const lastEmit = this.lastProgressEmit.get(progress.id) || 0

    // Always emit immediately for status changes or completion
    if (forceEmit || progress.status === 'completed' || progress.status === 'error' ||
        progress.progress === 100 || now - lastEmit >= this.PROGRESS_THROTTLE_MS) {
      this.lastProgressEmit.set(progress.id, now)
      this.emit('progress', progress)
    }
  }

  /**
   * Clean up throttle tracking when download completes
   */
  private cleanupThrottle(downloadId: string): void {
    this.lastProgressEmit.delete(downloadId)
  }

  /**
   * Apply casing transformation to a string
   */
  private applyCasing(text: string, casing: string): string {
    if (!text || casing === 'unchanged') return text

    switch (casing) {
      case 'lowercase':
        return text.toLowerCase()
      case 'uppercase':
        return text.toUpperCase()
      case 'titlecase':
        return text.replace(/\w\S*/g, txt =>
          txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
        )
      case 'sentencecase':
        return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
      default:
        return text
    }
  }

  /**
   * Remove "Album Version" and similar tags from track title
   */
  private cleanAlbumVersion(title: string): string {
    if (!title) return title
    // Remove common album version patterns (case insensitive)
    return title
      .replace(/\s*[\(\[]\s*(Album Version|Album Edit|Original Mix|Radio Edit|Radio Version|Single Version|Explicit|Clean)\s*[\)\]]/gi, '')
      .replace(/\s*-\s*(Album Version|Album Edit|Original Mix|Radio Edit|Radio Version|Single Version)\s*$/gi, '')
      .trim()
  }

  /**
   * Write error to errors.txt file in the album/playlist folder
   */
  private writeErrorLog(
    folderPath: string,
    trackId: string | number,
    trackTitle: string,
    trackArtist: string,
    errorMessage: string
  ): void {
    try {
      // Ensure the folder exists before writing
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true })
        console.log(`[Downloader] Created folder for error log: ${folderPath}`)
      }

      const errorLogPath = path.join(folderPath, 'errors.txt')
      const errorLine = `${trackId} | ${trackArtist} - ${trackTitle} | ${errorMessage}\n`

      // Append to existing file or create new one
      fs.appendFileSync(errorLogPath, errorLine, 'utf8')
      console.log(`[Downloader] Error logged to: ${errorLogPath}`)
    } catch (error: any) {
      console.error(`[Downloader] Failed to write error log:`, error.message)
    }
  }

  /**
   * Handle featured artists in title based on settings
   */
  private handleFeaturedArtists(
    title: string,
    artist: string,
    handling: string
  ): { title: string; artist: string } {
    if (!handling || handling === 'nothing') {
      return { title, artist }
    }

    // Common featured artist patterns
    const featPatterns = [
      /\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)\s*[\)\]]/gi,
      /\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/gi
    ]

    let featuredArtist = ''

    // Extract featured artist from title
    for (const pattern of featPatterns) {
      const match = title.match(pattern)
      if (match) {
        featuredArtist = match[0]
        break
      }
    }

    switch (handling) {
      case 'remove':
        // Remove featured artist from artist field
        for (const pattern of featPatterns) {
          artist = artist.replace(pattern, '').trim()
        }
        break
      case 'moveToTitle':
        // Featured artist is already in title, just ensure it's there
        // Remove from artist if present
        for (const pattern of featPatterns) {
          artist = artist.replace(pattern, '').trim()
        }
        break
      case 'removeFromTitle':
        // Remove featured artist info from title
        for (const pattern of featPatterns) {
          title = title.replace(pattern, '').trim()
        }
        break
    }

    return { title, artist }
  }

  /**
   * Handle "Various Artists" in album artist field
   */
  private handleVariousArtists(albumArtist: string, keepVariousArtists: boolean): string {
    if (!albumArtist) return albumArtist
    if (keepVariousArtists) return albumArtist

    const variousArtistsPatterns = [
      /^Various Artists$/i,
      /^V\.?A\.?$/i,
      /^Various$/i
    ]

    for (const pattern of variousArtistsPatterns) {
      if (pattern.test(albumArtist)) {
        return '' // Return empty to use track artist instead
      }
    }
    return albumArtist
  }

  /**
   * Filter out combined artist entries like "Artist1 & Artist2" from artist list
   * These appear when Deezer creates combined artist entries for collaborations
   */
  private filterArtistCombinations(artists: string[]): string[] {
    if (!artists || artists.length <= 1) return artists

    // Patterns that indicate a combined artist entry
    const combinationPatterns = [
      / & /,      // "Artist1 & Artist2"
      / and /i,   // "Artist1 and Artist2"
      / x /i,     // "Artist1 x Artist2"
      / vs\.? /i, // "Artist1 vs Artist2"
      / feat\.? /i, // "Artist1 feat. Artist2" (though this is usually in title)
      / ft\.? /i    // "Artist1 ft Artist2"
    ]

    return artists.filter(artist => {
      // Keep artists that don't match any combination pattern
      for (const pattern of combinationPatterns) {
        if (pattern.test(artist)) {
          console.log(`[Downloader] Filtered out artist combination: "${artist}"`)
          return false
        }
      }
      return true
    })
  }

  /**
   * Write ID3v1 tags to the end of an MP3 file
   * ID3v1 is a 128-byte fixed format at the end of the file
   */
  private writeID3v1Tags(filePath: string, tags: { title?: string; artist?: string; album?: string; year?: string; comment?: string; track?: number; genre?: number }): void {
    try {
      // Read existing file
      let fileData = fs.readFileSync(filePath)

      // Check if file already has ID3v1 tag (last 128 bytes start with "TAG")
      if (fileData.length >= 128) {
        const last128 = fileData.slice(-128)
        if (last128.toString('utf8', 0, 3) === 'TAG') {
          // Remove existing ID3v1 tag
          fileData = fileData.slice(0, -128)
        }
      }

      // Create ID3v1 tag buffer (128 bytes)
      const id3v1 = Buffer.alloc(128, 0)

      // "TAG" identifier (3 bytes)
      id3v1.write('TAG', 0, 3, 'ascii')

      // Title (30 bytes)
      if (tags.title) {
        const title = tags.title.substring(0, 30)
        id3v1.write(title, 3, 'utf8')
      }

      // Artist (30 bytes)
      if (tags.artist) {
        // For ID3v1, use first artist if null-separated
        const artist = tags.artist.split('\0')[0].substring(0, 30)
        id3v1.write(artist, 33, 'utf8')
      }

      // Album (30 bytes)
      if (tags.album) {
        const album = tags.album.substring(0, 30)
        id3v1.write(album, 63, 'utf8')
      }

      // Year (4 bytes)
      if (tags.year) {
        const year = tags.year.substring(0, 4)
        id3v1.write(year, 93, 'ascii')
      }

      // Comment (28 bytes for ID3v1.1, leave room for track)
      if (tags.comment) {
        const comment = tags.comment.substring(0, 28)
        id3v1.write(comment, 97, 'utf8')
      }

      // ID3v1.1: Zero byte at position 125 + track number at 126
      id3v1.writeUInt8(0, 125)
      if (tags.track && tags.track > 0 && tags.track <= 255) {
        id3v1.writeUInt8(tags.track, 126)
      }

      // Genre (1 byte) - default to 255 (unknown) if not specified
      id3v1.writeUInt8(tags.genre !== undefined ? tags.genre : 255, 127)

      // Append ID3v1 tag to file
      const newFileData = Buffer.concat([fileData, id3v1])
      fs.writeFileSync(filePath, newFileData)

      console.log('[Downloader] ID3v1 tags written successfully')
    } catch (error) {
      console.error('[Downloader] Error writing ID3v1 tags:', error)
    }
  }

  async download(options: DownloadOptions): Promise<string> {
    // Check for duplicate - prevent same track from being queued twice
    const existingDownload = this.findExistingDownload(options.trackId)
    if (existingDownload) {
      console.log(`[Downloader] Track ${options.trackId} already in queue/downloading (${existingDownload.id}), returning existing ID`)
      return existingDownload.id
    }

    const downloadId = `dl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    console.log(`[Downloader] Creating download ${downloadId} for track ${options.trackId}`)

    const progress: DownloadProgress = {
      id: downloadId,
      trackId: options.trackId,
      progress: 0,
      speed: 0,
      downloaded: 0,
      total: 0,
      status: 'pending'
    }

    this.activeDownloads.set(downloadId, progress)
    this.downloadQueue.push({ id: downloadId, options })
    this.emit('queued', progress)
    console.log(`[Downloader] Queued download ${downloadId}, queue size: ${this.downloadQueue.length}`)

    this.processQueue()

    return downloadId
  }

  /**
   * Find an existing download for a track (pending or in progress)
   * Returns null if track is not currently being downloaded
   */
  private findExistingDownload(trackId: string | number): DownloadProgress | null {
    // Check active downloads (includes pending and in-progress)
    for (const [_, progress] of this.activeDownloads) {
      if (progress.trackId === trackId &&
          (progress.status === 'pending' || progress.status === 'downloading')) {
        return progress
      }
    }
    return null
  }

  private async processQueue(): Promise<void> {
    console.log(`[Downloader] processQueue called - isProcessing: ${this.isProcessing}, currentDownloads: ${this.currentDownloads}/${this.maxConcurrent}, queueSize: ${this.downloadQueue.length}, isPaused: ${this._isPaused}`)

    // Don't start new downloads if paused
    if (this._isPaused) {
      console.log('[Downloader] processQueue: skipping - queue is paused')
      return
    }

    if (this.isProcessing || this.currentDownloads >= this.maxConcurrent) {
      console.log('[Downloader] processQueue: skipping - at capacity or already processing')
      return
    }

    const next = this.downloadQueue.shift()
    if (!next) {
      console.log('[Downloader] processQueue: queue is empty')
      return
    }

    console.log(`[Downloader] processQueue: starting download ${next.id}`)
    this.currentDownloads++
    this.processDownload(next.id, next.options)
      .catch(error => {
        console.error(`[Downloader] processDownload error for ${next.id}:`, error.message)
        const progress = this.activeDownloads.get(next.id)
        if (progress) {
          progress.status = 'error'
          progress.error = error.message

          // Create detailed error information
          progress.errorDetails = this.createErrorDetails(error.message, {
            code: error.code || this.inferErrorCode(error.message),
            httpStatus: error.httpStatus,
            serverResponse: error.serverResponse,
            trackId: progress.trackId
          })

          this.emit('error', progress)

          // Record failure for M3U tracking (so M3U still generates with available tracks)
          if (next.options.isFromPlaylist && next.options.playlistName) {
            this.recordM3UFailure(next.options.playlistName)
          }

          // Write error log if enabled and we have folder info
          console.log(`[Downloader] Error log check - createErrorLog: ${next.options.createErrorLog}, albumFolder: ${progress.albumFolder || 'NOT SET'}`)
          if (next.options.createErrorLog && progress.albumFolder) {
            console.log(`[Downloader] Writing error log for track ${progress.trackId}: ${progress.trackTitle}`)
            this.writeErrorLog(
              progress.albumFolder,
              progress.trackId,
              progress.trackTitle || 'Unknown Track',
              progress.trackArtist || 'Unknown Artist',
              error.message
            )
          } else if (next.options.createErrorLog && !progress.albumFolder) {
            console.warn(`[Downloader] Cannot write error log - albumFolder not set for track ${progress.trackId}`)
          }
        }
      })
      .finally(() => {
        console.log(`[Downloader] processDownload finished for ${next.id}`)
        this.currentDownloads--
        this.processQueue()
      })

    // Continue processing if we have capacity
    if (this.currentDownloads < this.maxConcurrent) {
      this.processQueue()
    }
  }

  private async processDownload(downloadId: string, options: DownloadOptions): Promise<void> {
    console.log(`[Downloader] processDownload starting for ${downloadId}, track: ${options.trackId}`)
    console.log(`[Downloader] Requested quality: ${options.quality}`)

    const progress = this.activeDownloads.get(downloadId)
    if (!progress) {
      console.error(`[Downloader] No progress found for ${downloadId}`)
      return
    }

    progress.status = 'downloading'
    this.emit('start', progress)
    console.log(`[Downloader] Status set to downloading, getting track info...`)

    // Get track info
    let trackInfo
    try {
      trackInfo = await deezerAuth.getTrackInfo(options.trackId)
      console.log(`[Downloader] Got track info:`, trackInfo ? `${trackInfo.SNG_TITLE} by ${trackInfo.ART_NAME}` : 'null')
    } catch (error: any) {
      console.error(`[Downloader] Failed to get track info:`, error.message)

      // Check if this is a clear auth error (don't validate session - it can cause issues)
      const errorMsg = error.message || 'Unknown error'
      if (deezerAuth.isAuthError(error) ||
          errorMsg.includes('session expired') ||
          errorMsg.includes('please log in')) {
        console.log(`[Downloader] Auth error detected in error message`)
        throw new Error(`Session expired: Please log in again to continue downloading`)
      }
      throw new Error(`Track info error: ${errorMsg}`)
    }

    if (!trackInfo) {
      throw new Error('Failed to get track info - no data returned')
    }

    // Fetch lyrics if lyrics saving or embedding is enabled
    // song.getData doesn't include lyrics - they must be fetched separately via song.getLyrics
    const needsLyrics = options.saveLyrics ||
                        options.metadataSettings?.tags?.unsyncLyrics ||
                        options.metadataSettings?.tags?.syncLyrics
    if (needsLyrics) {
      try {
        const lyrics = await deezerAuth.getLyrics(options.trackId)
        if (lyrics) {
          trackInfo.LYRICS = lyrics
          console.log(`[Downloader] Lyrics attached to track info`)
        }
      } catch (error: any) {
        console.log(`[Downloader] Could not fetch lyrics:`, error.message)
      }
    }

    // Store track info in progress for error logging and UI display
    // Include VERSION in title if present (e.g., "Club Mix", "Extended Club Mix")
    // Strip existing parens from VERSION to avoid double-wrapping like "((Remix))"
    const trackVersion = trackInfo.VERSION
    const cleanTrackVersion = trackVersion ? trackVersion.replace(/^\((.+)\)$/, '$1') : ''
    progress.trackTitle = cleanTrackVersion
      ? `${trackInfo.SNG_TITLE || 'Unknown Track'} (${cleanTrackVersion})`
      : (trackInfo.SNG_TITLE || 'Unknown Track')
    progress.trackArtist = trackInfo.ART_NAME || 'Unknown Artist'
    progress.albumTitle = trackInfo.ALB_TITLE || options.albumContext?.albumTitle || ''

    // Calculate folder path early for error logging (even if download fails)
    // This ensures we can write to errors.txt even if URL retrieval fails
    try {
      const earlyOutputPath = this.buildOutputPath(trackInfo, options, options.quality === 'FLAC' ? 'FLAC' : 'MP3_320')
      progress.albumFolder = path.dirname(earlyOutputPath)
      console.log(`[Downloader] Early albumFolder set: ${progress.albumFolder}`)

      // Calculate album root folder for deletion purposes
      const totalDiscs = options.albumContext?.totalDiscs || 1
      const hasCDFolder = options.folderSettings?.createCDFolder && options.discNumber && totalDiscs > 1
      if (hasCDFolder) {
        progress.albumRootFolder = path.dirname(progress.albumFolder)
      } else {
        progress.albumRootFolder = progress.albumFolder
      }
    } catch (pathError: any) {
      console.error(`[Downloader] Failed to calculate early folder path:`, pathError.message)
      // Fall back to album context if available
      if (options.albumContext) {
        const folderArtist = this.sanitizeFilename(options.albumContext.albumArtist || 'Unknown Artist')
        const folderAlbum = this.sanitizeFilename(options.albumContext.albumTitle || 'Unknown Album')
        progress.albumFolder = path.join(options.outputPath, folderArtist, `${folderArtist} - ${folderAlbum}`)
        progress.albumRootFolder = progress.albumFolder  // No CD folder in fallback
        console.log(`[Downloader] Fallback albumFolder set: ${progress.albumFolder}`)
      }
    }

    // Get the download URL and actual format FIRST
    // Default bitrateFallback to true if not specified
    const bitrateFallback = options.bitrateFallback !== false
    console.log(`[Downloader] Getting download URL for quality: ${options.quality}, bitrateFallback: ${bitrateFallback}`)
    let downloadUrl: string
    let actualFormat: string
    try {
      const result = await deezerAuth.getTrackUrl(trackInfo.SNG_ID, options.quality, bitrateFallback)
      downloadUrl = result.url
      actualFormat = result.format
      progress.actualFormat = actualFormat

      // If the track was resolved to a different version (fallback/ISRC),
      // re-fetch track info so metadata, folder path, and M3U use the correct album
      if (result.resolvedTrackId && String(result.resolvedTrackId) !== String(trackInfo.SNG_ID)) {
        console.log(`[Downloader] Track resolved to alternative: ${trackInfo.SNG_ID} → ${result.resolvedTrackId} — refreshing metadata`)
        const resolvedInfo = await deezerAuth.getTrackInfo(result.resolvedTrackId)
        if (resolvedInfo) {
          trackInfo = resolvedInfo
          // Update progress display with resolved track info
          const resolvedVersion = trackInfo.VERSION ? trackInfo.VERSION.replace(/^\((.+)\)$/, '$1') : ''
          progress.trackTitle = resolvedVersion
            ? `${trackInfo.SNG_TITLE || 'Unknown Track'} (${resolvedVersion})`
            : (trackInfo.SNG_TITLE || 'Unknown Track')
          progress.trackArtist = trackInfo.ART_NAME || 'Unknown Artist'
          progress.albumTitle = trackInfo.ALB_TITLE || ''
        }
      }

      console.log(`[Downloader] Got URL for format: ${actualFormat}`)
      console.log(`[Downloader] Download URL: ${downloadUrl?.substring(0, 100)}...`)

      // Validate URL
      if (!downloadUrl || typeof downloadUrl !== 'string' || !downloadUrl.startsWith('https://')) {
        throw new Error(`Invalid download URL received: ${downloadUrl?.substring(0, 50) || 'empty'}`)
      }
    } catch (error: any) {
      console.error(`[Downloader] Failed to get media URL:`, error.message)
      if (error.message.includes('PreferredBitrateNotFound')) {
        throw new Error(`Preferred bitrate (${options.quality}) not available for this track. Enable Bitrate Fallback in settings to download in a lower quality.`)
      }
      throw new Error(`Failed to get download URL: ${error.message}`)
    }

    // Build output path using the ACTUAL format and resolved track info
    const initialOutputPath = this.buildOutputPath(trackInfo, options, actualFormat)
    console.log(`[Downloader] Initial output path: ${initialOutputPath}`)

    // Reserve a unique output path to prevent concurrent download collisions
    // Returns null if overwrite mode is 'no' and file already exists (skip download)
    const outputPath = this.reserveOutputPath(initialOutputPath, trackInfo.SNG_ID, options.overwriteMode)
    if (outputPath === null) {
      // File exists and overwrite mode is 'no' — mark as completed and skip
      progress.status = 'completed'
      progress.progress = 100
      // Record skipped file for M3U — it still exists on disk
      if (options.isFromPlaylist && options.playlistName) {
        this.recordM3UEntry(options.playlistName, {
          position: options.playlistPosition || 0,
          duration: trackInfo.DURATION || 0,
          artist: trackInfo.ART_NAME || 'Unknown Artist',
          title: progress.trackTitle || trackInfo.SNG_TITLE || 'Unknown Track',
          absolutePath: initialOutputPath
        })
      }
      this.emit('progress', progress)
      return
    }
    console.log(`[Downloader] Reserved output path: ${outputPath}`)

    // Wrap in try/finally to ensure path is always released
    let encryptedPath: string | null = null
    try {
      // Ensure directory exists
      const dir = path.dirname(outputPath)
      if (!fs.existsSync(dir)) {
        console.log(`[Downloader] Creating directory: ${dir}`)
        fs.mkdirSync(dir, { recursive: true })
      }

      // Store folder path for error logging
      progress.albumFolder = dir

      // Calculate album root folder for deletion purposes
      // If this is a multi-disc album with CD folders, go up one level to get the actual album folder
      const totalDiscs = options.albumContext?.totalDiscs || 1
      const hasCDFolder = options.folderSettings?.createCDFolder && options.discNumber && totalDiscs > 1
      if (hasCDFolder) {
        // dir is like /Music/Artist/Album/CD1, we want /Music/Artist/Album
        progress.albumRootFolder = path.dirname(dir)
        console.log(`[Downloader] Multi-disc album - albumRootFolder: ${progress.albumRootFolder}`)
      } else {
        // No CD folder, album folder is the same as track folder
        progress.albumRootFolder = dir
      }

      // Download the encrypted file
      // Use track ID in encrypted filename to prevent collisions when downloading
      // multiple tracks with similar names concurrently (e.g., "This Town" and "This Town (Extended Mix)")
      encryptedPath = outputPath + `.${trackInfo.SNG_ID}.encrypted`
      console.log(`[Downloader] Starting encrypted file download for track ${trackInfo.SNG_ID}...`)
      console.log(`[Downloader] Encrypted path: ${encryptedPath}`)
      console.log(`[Downloader] Download URL: ${downloadUrl.substring(0, 100)}...`)
      try {
        await this.downloadFromUrl(downloadUrl, encryptedPath, progress)
        console.log(`[Downloader] Encrypted file downloaded`)
      } catch (error: any) {
        console.error(`[Downloader] Download file error:`, error.message)
        // Clean up any partial file
        try {
          if (encryptedPath && fs.existsSync(encryptedPath)) {
            fs.unlinkSync(encryptedPath)
          }
        } catch (e) {}
        throw new Error(`Download error: ${error.message}`)
      }

      // Verify encrypted file exists and has content before decryption
      if (!fs.existsSync(encryptedPath)) {
        throw new Error('Download failed: encrypted file not created')
      }
      const fileStats = fs.statSync(encryptedPath)
      if (fileStats.size === 0) {
        fs.unlinkSync(encryptedPath)
        throw new Error('Download failed: file is empty (track may be unavailable)')
      }
      console.log(`[Downloader] Encrypted file verified: ${fileStats.size} bytes`)

      // Decrypt the file
      progress.status = 'decrypting'
      this.emit('progress', progress)
      console.log(`[Downloader] Starting decryption...`)

      let decryptedPath: string
      try {
        decryptedPath = await this.decryptFile(encryptedPath, trackInfo.SNG_ID, outputPath)
        console.log(`[Downloader] Decryption complete: ${decryptedPath}`)
      } catch (error: any) {
        console.error(`[Downloader] Decryption error:`, error.message)
        throw new Error(`Decryption error: ${error.message}`)
      }

      // Clean up encrypted file
      if (fs.existsSync(encryptedPath)) {
        fs.unlinkSync(encryptedPath)
      }
      encryptedPath = null // Mark as cleaned up

      // Tag the file with metadata
      progress.status = 'tagging'
      this.emit('progress', progress)
      console.log(`[Downloader] Starting tagging for ${actualFormat} file...`)

      try {
        if (actualFormat === 'FLAC') {
          await this.tagFlacFile(decryptedPath, trackInfo, options)
        } else {
          await this.tagFile(decryptedPath, trackInfo, options)
        }
        console.log(`[Downloader] Tagging complete`)
      } catch (error: any) {
        console.error(`[Downloader] Tagging error:`, error.message)
        // Don't throw on tagging errors - file is still usable
      }

      // Save artwork if requested
      if (options.saveArtwork && trackInfo.ALB_PICTURE) {
        try {
          await this.saveArtwork(trackInfo.ALB_PICTURE, dir, options)
        } catch (error: any) {
          console.error(`[Downloader] Artwork save error:`, error.message)
        }
      }

      // Save artist image if requested
      if (options.albumContext?.artistPicture && options.metadataSettings?.albumCovers?.saveArtistImage) {
        try {
          // Get the artist folder directory (parent of album folder if album folder is created)
          let artistDir = dir
          if (options.albumFolder && options.artistFolder) {
            // Go up one level to the artist folder
            artistDir = path.dirname(dir)
          }
          await this.saveArtistImage(
            options.albumContext.artistPicture,
            options.albumContext.albumArtist,
            artistDir,
            options
          )
        } catch (error: any) {
          console.error(`[Downloader] Artist image save error:`, error.message)
        }
      }

      // Save lyrics if requested
      if (options.saveLyrics && trackInfo.LYRICS) {
        try {
          await this.saveLyrics(trackInfo, dir)
        } catch (error: any) {
          console.error(`[Downloader] Lyrics save error:`, error.message)
        }
      }

      progress.status = 'completed'
      progress.progress = 100
      this.cleanupThrottle(downloadId)

      // Record actual file path for M3U generation (playlist tracks only)
      if (options.isFromPlaylist && options.playlistName) {
        this.recordM3UEntry(options.playlistName, {
          position: options.playlistPosition || 0,
          duration: trackInfo.DURATION || 0,
          artist: trackInfo.ART_NAME || 'Unknown Artist',
          title: progress.trackTitle || trackInfo.SNG_TITLE || 'Unknown Track',
          absolutePath: decryptedPath
        })
      }

      this.emit('complete', { ...progress, path: decryptedPath })
    } finally {
      // Always release the reserved path when done (success or failure)
      this.releaseOutputPath(outputPath)

      // Clean up encrypted file if it still exists (in case of error before cleanup)
      if (encryptedPath && fs.existsSync(encryptedPath)) {
        try {
          fs.unlinkSync(encryptedPath)
          console.log(`[Downloader] Cleaned up encrypted file in finally block`)
        } catch (e) {}
      }
    }
  }

  private buildOutputPath(trackInfo: any, options: DownloadOptions, actualFormat?: string): string {
    // Security: Validate base output path
    let outputPath = options.outputPath
    if (!outputPath || outputPath.includes('..')) {
      throw new Error('Invalid output path')
    }

    // Normalize the base path
    outputPath = path.normalize(outputPath)

    const folderSettings = options.folderSettings

    // Debug logging for folder settings
    console.log(`[Downloader] buildOutputPath - isSingle: ${options.isSingle}, isFromPlaylist: ${options.isFromPlaylist}`)
    console.log(`[Downloader] Folder settings - createArtistFolder: ${folderSettings?.createArtistFolder}, createAlbumFolder: ${folderSettings?.createAlbumFolder}, createSinglesStructure: ${folderSettings?.createSinglesStructure}`)

    // For folder structure, prefer album context (ensures all album tracks go to same folder)
    // Fall back to track info for single track downloads
    const albumContext = options.albumContext
    const folderArtist = albumContext?.albumArtist || trackInfo.ALB_ART_NAME || trackInfo.ART_NAME || 'Unknown Artist'
    const folderAlbum = albumContext?.albumTitle || trackInfo.ALB_TITLE || 'Unknown Album'

    // Track artist is still used for filename templates
    const artistName = trackInfo.ART_NAME || 'Unknown Artist'
    const albumName = trackInfo.ALB_TITLE || 'Unknown Album'
    const year = trackInfo.PHYSICAL_RELEASE_DATE?.split('-')[0] || ''
    const genre = '' // Would need async lookup
    const label = trackInfo.LABEL_NAME || ''
    // For folder naming, prefer album-level explicit flag (consistent across all tracks)
    // Fall back to track-level flag for single track downloads
    // Note: Deezer private API returns EXPLICIT_LYRICS as string "0"/"1", not boolean
    // Must use strict checks — "0" is truthy in JS but means NOT explicit
    const isAlbumExplicit = albumContext?.explicitLyrics === true
    const isTrackExplicit = trackInfo.EXPLICIT_LYRICS === 1 || trackInfo.EXPLICIT_LYRICS === '1' || trackInfo.EXPLICIT_LYRICS === true
    const folderExplicit = (albumContext ? isAlbumExplicit : isTrackExplicit) ? 'Explicit' : ''

    // Template replacement helper for FOLDER names - uses album context for consistency
    const today = new Date()
    const dateStr = today.toISOString().split('T')[0] // YYYY-MM-DD
    const replaceFolderTemplate = (template: string): string => {
      return this.sanitizeFilename(
        template
          .replace(/%artist%/gi, folderArtist)
          .replace(/%album%/gi, folderAlbum)
          .replace(/%playlist%/gi, options.playlistName || 'Playlist')
          .replace(/%owner%/gi, options.playlistOwner || '')
          .replace(/%year%/gi, year)
          .replace(/%date%/gi, dateStr)
          .replace(/%genre%/gi, genre)
          .replace(/%label%/gi, label)
          .replace(/%explicit%/gi, folderExplicit)
      )
    }

    // Handle playlist folder (if downloading from a playlist)
    if (options.isFromPlaylist && folderSettings?.createPlaylistFolder) {
      const playlistFolder = replaceFolderTemplate(folderSettings.playlistFolderTemplate || '%playlist%')
      outputPath = path.join(outputPath, playlistFolder)

      // Create artist/album subfolders within playlist if structure option is enabled
      if (folderSettings.createPlaylistStructure) {
        if (folderSettings.createArtistFolder) {
          const artistFolder = replaceFolderTemplate(folderSettings.artistFolderTemplate || '%artist%')
          outputPath = path.join(outputPath, artistFolder)
        }
        if (folderSettings.createAlbumFolder) {
          const albumFolder = replaceFolderTemplate(folderSettings.albumFolderTemplate || '%artist% - %album%')
          outputPath = path.join(outputPath, albumFolder)
        }
      }
    } else {
      // Standard folder structure for non-playlist downloads
      // Handle singles differently if option is enabled
      if (options.isSingle && folderSettings?.createSinglesStructure === false) {
        // Don't create album folder for singles if option is disabled
        if (folderSettings?.createArtistFolder || options.artistFolder) {
          const artistFolder = replaceFolderTemplate(folderSettings?.artistFolderTemplate || '%artist%')
          outputPath = path.join(outputPath, artistFolder)
        }
      } else {
        // Normal album/artist folder creation
        if (folderSettings?.createArtistFolder || options.artistFolder) {
          const artistFolder = replaceFolderTemplate(folderSettings?.artistFolderTemplate || '%artist%')
          outputPath = path.join(outputPath, artistFolder)
        }

        if (folderSettings?.createAlbumFolder || options.albumFolder) {
          const albumFolder = replaceFolderTemplate(folderSettings?.albumFolderTemplate || '%artist% - %album%')
          outputPath = path.join(outputPath, albumFolder)
        }
      }

      // Handle CD folder for multi-disc albums
      // Only create CD folders if the album actually has multiple discs
      // This ensures single-disc albums don't get unnecessary CD1 folders
      const totalDiscs = options.albumContext?.totalDiscs || 1
      if (folderSettings?.createCDFolder && options.discNumber && totalDiscs > 1) {
        outputPath = path.join(outputPath, `CD${options.discNumber}`)
      }
    }

    // Build filename from template
    const trackTemplates = options.trackTemplates
    let filenameTemplate: string
    let templateSource: string

    // Choose the appropriate template based on context
    if (options.isFromPlaylist && trackTemplates?.playlistTrackTemplate) {
      filenameTemplate = trackTemplates.playlistTrackTemplate
      templateSource = 'playlistTrackTemplate'
    } else if (!options.isSingle && trackTemplates?.albumTrackTemplate) {
      filenameTemplate = trackTemplates.albumTrackTemplate
      templateSource = 'albumTrackTemplate'
    } else if (trackTemplates?.trackNameTemplate) {
      filenameTemplate = trackTemplates.trackNameTemplate
      templateSource = 'trackNameTemplate'
    } else {
      // Default fallback template
      filenameTemplate = options.isFromPlaylist
        ? '%position% - %artist% - %title%'
        : '%tracknumber% - %title%'
      templateSource = 'default fallback'
    }
    console.log(`[Downloader] Using template: ${templateSource} = "${filenameTemplate}"`)

    // Extract track metadata for template replacement
    // Combine SNG_TITLE with VERSION field to get full track name
    // Deezer stores mix/version info separately (e.g., "Club Mix", "Extended Club Mix")
    const baseTitle = trackInfo.SNG_TITLE || 'Unknown Track'
    const version = trackInfo.VERSION
    // VERSION may already be wrapped in parentheses from the API — strip before re-wrapping
    const cleanVersion = version ? version.replace(/^\((.+)\)$/, '$1') : ''
    const title = cleanVersion ? `${baseTitle} (${cleanVersion})` : baseTitle
    console.log(`[Downloader] Track metadata - ID: ${trackInfo.SNG_ID}, Title: "${baseTitle}", Version: "${version || 'none'}", Full: "${title}", Artist: "${trackInfo.ART_NAME}"`)
    const artists = trackInfo.ARTISTS?.map((a: any) => a.ART_NAME).join(', ') || artistName
    const allArtists = trackInfo.SNG_CONTRIBUTORS?.main_artist?.join(', ') || artists
    const mainArtists = trackInfo.SNG_CONTRIBUTORS?.mainartist?.join(', ') || artistName
    const featArtists = trackInfo.SNG_CONTRIBUTORS?.featartist?.join(', ') || ''
    const albumArtist = trackInfo.ALB_ART_NAME || artistName
    const trackNum = trackInfo.TRACK_NUMBER?.toString().padStart(2, '0') || '00'
    const trackTotal = trackInfo.TRACKS_COUNT?.toString() || ''
    const discNum = trackInfo.DISK_NUMBER?.toString() || '1'
    const discTotal = trackInfo.DISKS_COUNT?.toString() || ''
    const date = trackInfo.PHYSICAL_RELEASE_DATE || ''
    const bpm = trackInfo.BPM?.toString() || ''
    const isrc = trackInfo.ISRC || ''
    const upc = trackInfo.ALB_UPC || ''
    const explicit = (trackInfo.EXPLICIT_LYRICS === 1 || trackInfo.EXPLICIT_LYRICS === '1' || trackInfo.EXPLICIT_LYRICS === true) ? 'Explicit' : ''
    const trackId = trackInfo.SNG_ID?.toString() || ''
    const albumId = trackInfo.ALB_ID?.toString() || ''
    const artistId = trackInfo.ART_ID?.toString() || ''
    const position = options.playlistPosition?.toString().padStart(3, '0') || '000'

    // Replace all template variables
    const filename = this.sanitizeFilename(
      filenameTemplate
        .replace(/%title%/gi, title)
        .replace(/%artist%/gi, artistName)
        .replace(/%artists%/gi, artists)
        .replace(/%allartists%/gi, allArtists)
        .replace(/%mainartists%/gi, mainArtists)
        .replace(/%featartists%/gi, featArtists)
        .replace(/%album%/gi, albumName)
        .replace(/%albumartist%/gi, albumArtist)
        .replace(/%tracknumber%/gi, trackNum)
        .replace(/%tracktotal%/gi, trackTotal)
        .replace(/%discnumber%/gi, discNum)
        .replace(/%disctotal%/gi, discTotal)
        .replace(/%genre%/gi, genre)
        .replace(/%year%/gi, year)
        .replace(/%date%/gi, date)
        .replace(/%bpm%/gi, bpm)
        .replace(/%label%/gi, label)
        .replace(/%isrc%/gi, isrc)
        .replace(/%upc%/gi, upc)
        .replace(/%explicit%/gi, explicit)
        .replace(/%track_id%/gi, trackId)
        .replace(/%album_id%/gi, albumId)
        .replace(/%artist_id%/gi, artistId)
        .replace(/%playlist_id%/gi, options.playlistName || '')
        .replace(/%position%/gi, position)
    )

    // Use actual format if provided, otherwise fall back to requested quality
    const format = actualFormat || options.quality
    const ext = format === 'FLAC' ? '.flac' : '.mp3'

    const finalPath = path.join(outputPath, filename + ext)
    console.log(`[Downloader] Generated filename: "${filename}${ext}" for track ${trackInfo.SNG_ID}`)

    // Security: Ensure final path is still within the base output path
    const normalizedFinal = path.normalize(finalPath)
    const normalizedBase = path.normalize(options.outputPath)
    if (!normalizedFinal.startsWith(normalizedBase)) {
      throw new Error('Path traversal detected')
    }

    return finalPath
  }

  private sanitizeFilename(name: string): string {
    if (!name || typeof name !== 'string') return 'Unknown'

    return name
      // Remove empty brackets/parentheses left by empty template variables
      // e.g. "Album ()" or "Album []" or "Album {}" → "Album"
      .replace(/\s*\(\s*\)/g, '')
      .replace(/\s*\[\s*\]/g, '')
      .replace(/\s*\{\s*\}/g, '')
      // Remove path traversal attempts
      .replace(/\.\./g, '')
      .replace(/[\/\\]/g, '_')
      // Remove other dangerous characters
      .replace(/[<>:"|?*\x00-\x1f]/g, '_')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      // Remove leading/trailing dots and spaces (Windows restriction)
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .trim()
      // Limit length
      .substring(0, 200)
      // Ensure we have something valid
      || 'Unknown'
  }

  /**
   * Reserve an output path for a download and detect collisions.
   * This tracks which paths are being used by in-progress downloads to prevent
   * concurrent downloads from overwriting each other.
   *
   * @param basePath - The output path from buildOutputPath
   * @param trackId - The Deezer track ID for logging
   * @returns The reserved path (same as input, collision info logged)
   */
  private reserveOutputPath(basePath: string, trackId: string | number, overwriteMode?: string): string | null {
    const normalizedPath = path.normalize(basePath)

    // Check for collision with another in-progress download
    if (this.reservedPaths.has(normalizedPath)) {
      console.warn(`[Downloader] PATH COLLISION for track ${trackId}: ${normalizedPath}`)
    }

    // Check for existing file and handle based on overwrite mode
    if (fs.existsSync(normalizedPath)) {
      const mode = overwriteMode || 'overwrite'
      if (mode === 'no') {
        console.log(`[Downloader] Skipping track ${trackId} — file already exists: ${normalizedPath}`)
        return null // Signal to skip this download
      } else if (mode === 'rename') {
        // Find a unique filename by appending a counter
        const ext = path.extname(normalizedPath)
        const base = normalizedPath.slice(0, -ext.length)
        let counter = 1
        let newPath = `${base} (${counter})${ext}`
        while (fs.existsSync(newPath)) {
          counter++
          newPath = `${base} (${counter})${ext}`
        }
        console.log(`[Downloader] Renaming track ${trackId} to avoid overwrite: ${newPath}`)
        this.reservedPaths.add(path.normalize(newPath))
        return newPath
      }
      // mode === 'overwrite' — proceed normally
      console.log(`[Downloader] Overwriting existing file for track ${trackId}: ${normalizedPath}`)
    }

    this.reservedPaths.add(normalizedPath)
    return normalizedPath
  }

  /**
   * Release a previously reserved output path.
   * Should be called when download completes (success or failure).
   *
   * @param reservedPath - The path that was returned by reserveOutputPath
   */
  private releaseOutputPath(reservedPath: string): void {
    const normalized = path.normalize(reservedPath)
    if (this.reservedPaths.delete(normalized)) {
      console.log(`[Downloader] Released path: ${normalized}`)
    }
  }

  private async downloadFromUrl(
    url: string,
    outputPath: string,
    progress: DownloadProgress
  ): Promise<void> {
    console.log(`[Downloader] Starting HTTPS download from URL...`)
    console.log(`[Downloader] Output path: ${outputPath}`)
    console.log(`[Downloader] URL: ${url.substring(0, 100)}...`)

    return new Promise((resolve, reject) => {
      let file: fs.WriteStream
      let fileReady = false
      let rejected = false

      try {
        file = fs.createWriteStream(outputPath)
      } catch (err: any) {
        console.error(`[Downloader] Failed to create write stream:`, err.message)
        reject(new Error(`Failed to create file: ${err.message}`))
        return
      }

      // Handle file stream errors
      file.on('error', (err) => {
        console.error(`[Downloader] File stream error:`, err.message)
        if (!rejected) {
          rejected = true
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) {}
          reject(new Error(`File write error: ${err.message}`))
        }
      })

      // Wait for file to be ready before starting download
      file.on('open', () => {
        console.log(`[Downloader] File stream opened successfully`)
        fileReady = true
      })

      https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': deezerAuth.getCookieString()
        }
      }, (response) => {
        console.log(`[Downloader] Response status: ${response.statusCode}`)

        if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirect
          const redirectUrl = response.headers.location
          console.log(`[Downloader] Redirect to: ${redirectUrl?.substring(0, 80)}...`)
          if (redirectUrl) {
            https.get(redirectUrl, (redirectResponse) => {
              console.log(`[Downloader] Redirect response status: ${redirectResponse.statusCode}`)
              // Check redirect response status
              if (redirectResponse.statusCode !== 200) {
                file.close()
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) {}
                reject(new DownloadError(`HTTP ${redirectResponse.statusCode}: Download failed after redirect`, {
                  httpStatus: redirectResponse.statusCode,
                  code: redirectResponse.statusCode === 403 ? 'ACCESS_DENIED' :
                        redirectResponse.statusCode === 404 ? 'NOT_FOUND' :
                        redirectResponse.statusCode === 451 ? 'GEO_RESTRICTED' : 'HTTP_ERROR'
                }))
                return
              }
              this.handleDownloadResponse(redirectResponse, file, progress, resolve, reject)
            }).on('error', (err) => {
              console.error(`[Downloader] Redirect error:`, err.message)
              file.close()
              try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) {}
              reject(err)
            })
            return
          }
        }

        if (response.statusCode !== 200) {
          file.close()
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) {}
          reject(new DownloadError(`HTTP ${response.statusCode}: Download failed`, {
            httpStatus: response.statusCode,
            code: response.statusCode === 403 ? 'ACCESS_DENIED' :
                  response.statusCode === 404 ? 'NOT_FOUND' :
                  response.statusCode === 451 ? 'GEO_RESTRICTED' : 'HTTP_ERROR'
          }))
          return
        }

        this.handleDownloadResponse(response, file, progress, resolve, reject)
      }).on('error', (error) => {
        console.error(`[Downloader] Download error:`, error.message)
        file.close()
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath)
          }
        } catch (e) {}
        reject(error)
      })
    })
  }

  private handleDownloadResponse(
    response: any,
    file: fs.WriteStream,
    progress: DownloadProgress,
    resolve: () => void,
    reject: (error: Error) => void
  ): void {
    const total = parseInt(response.headers['content-length'] || '0')
    progress.total = total
    let downloaded = 0
    const startTime = Date.now()
    const outputPath = (file as any).path as string

    // Check for empty content or error responses
    if (total === 0) {
      console.warn('[Downloader] Warning: Content-Length is 0 or missing')
    }

    response.on('data', (chunk: Buffer) => {
      downloaded += chunk.length
      progress.downloaded = downloaded
      progress.progress = total > 0 ? Math.round((downloaded / total) * 100) : 0
      progress.speed = downloaded / ((Date.now() - startTime) / 1000)
      // Use throttled emit to reduce UI update frequency during downloads
      this.emitProgressThrottled(progress)
    })

    response.pipe(file)

    file.on('finish', () => {
      // Wait for close callback to ensure file is fully written to disk
      file.close((err) => {
        if (err) {
          console.error('[Downloader] Error closing file:', err.message)
          reject(err)
          return
        }

        // Verify data was actually written
        if (downloaded === 0) {
          console.error('[Downloader] No data was downloaded (0 bytes received)')
          // Clean up empty file
          try {
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath)
            }
          } catch (e) {}
          reject(new DownloadError('No data received from server - track may be unavailable or geo-restricted', {
            code: 'NO_DATA',
            httpStatus: response.statusCode
          }))
          return
        }

        // Verify file actually exists on disk after close
        if (!fs.existsSync(outputPath)) {
          console.error(`[Downloader] File does not exist after close: ${outputPath}`)
          reject(new DownloadError('File was not created on disk - possible filesystem issue', {
            code: 'FILE_NOT_CREATED'
          }))
          return
        }

        // Verify file size matches downloaded bytes
        try {
          const stats = fs.statSync(outputPath)
          console.log(`[Downloader] File verified: ${stats.size} bytes on disk, ${downloaded} bytes downloaded`)
          if (stats.size === 0) {
            console.error('[Downloader] File is empty on disk')
            fs.unlinkSync(outputPath)
            reject(new DownloadError('Downloaded file is empty', { code: 'EMPTY_FILE' }))
            return
          }
        } catch (statErr: any) {
          console.error(`[Downloader] Failed to verify file:`, statErr.message)
          reject(new DownloadError(`Failed to verify downloaded file: ${statErr.message}`, { code: 'VERIFY_FAILED' }))
          return
        }

        console.log(`[Downloader] File closed and verified successfully, ${downloaded} bytes written`)
        resolve()
      })
    })

    file.on('error', (error) => {
      console.error('[Downloader] File write error:', error.message)
      file.close(() => {
        // Clean up partial file
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath)
          }
        } catch (e) {}
        reject(error)
      })
    })

    // Handle response errors
    response.on('error', (error: Error) => {
      console.error('[Downloader] Response stream error:', error.message)
      file.close(() => {
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath)
          }
        } catch (e) {}
        reject(error)
      })
    })
  }

  private async generateDownloadUrl(trackInfo: any, format: number): Promise<string> {
    const md5Origin = trackInfo.MD5_ORIGIN
    const mediaVersion = trackInfo.MEDIA_VERSION
    const sngId = trackInfo.SNG_ID

    console.log(`[Downloader] generateDownloadUrl: md5Origin=${md5Origin}, mediaVersion=${mediaVersion}, sngId=${sngId}`)

    if (!md5Origin) {
      console.log(`[Downloader] No MD5_ORIGIN - checking for PREVIEW URL`)
      // Fallback to preview URL for testing
      if (trackInfo.PREVIEW) {
        console.log(`[Downloader] Using PREVIEW URL: ${trackInfo.PREVIEW}`)
        return trackInfo.PREVIEW
      }
      console.error(`[Downloader] No MD5_ORIGIN and no PREVIEW - track not available`)
      throw new Error('Track not available for download')
    }

    // Generate the URL path using Latin-1 separator (0xa4 = ¤)
    const separator = String.fromCharCode(0xa4)
    const step1 = [md5Origin, format.toString(), sngId, mediaVersion].join(separator)
    const md5Hash = crypto.createHash('md5').update(step1, 'latin1').digest('hex')
    const step2 = md5Hash + separator + step1 + separator

    // Pad to 16 byte boundary with spaces
    let padded = step2
    while (padded.length % 16 !== 0) {
      padded += ' '
    }

    console.log(`[Downloader] URL generation: step2 length=${step2.length}, padded length=${padded.length}`)

    // AES encrypt using pure JS implementation (OpenSSL 3.0 compatible)
    try {
      const key = aesjs.utils.utf8.toBytes('jo6aey6haid2Teih')

      // Convert string to bytes using Latin-1 encoding (each char = 1 byte)
      const textBytes = new Uint8Array(padded.length)
      for (let i = 0; i < padded.length; i++) {
        textBytes[i] = padded.charCodeAt(i) & 0xff
      }

      // Use AES-ECB mode
      const aesEcb = new aesjs.ModeOfOperation.ecb(key)
      const encryptedBytes = aesEcb.encrypt(textBytes)
      const encryptedPath = aesjs.utils.hex.fromBytes(encryptedBytes)

      console.log(`[Downloader] Generated URL path: ${encryptedPath.substring(0, 40)}...`)
      return `https://e-cdns-proxy-${md5Origin[0]}.dzcdn.net/mobile/1/${encryptedPath}`
    } catch (aesError: any) {
      console.error('[Downloader] AES encryption failed:', aesError.message, aesError.stack)
      throw new Error(`Failed to generate download URL: ${aesError.message}`)
    }
  }

  private async decryptFile(inputPath: string, sngId: string, outputPath: string): Promise<string> {
    console.log(`[Downloader] Decrypting file for song ID: ${sngId}`)

    // Generate blowfish key from song ID
    const hash = crypto.createHash('md5').update(sngId, 'ascii').digest('hex')
    const blowfishKey = Buffer.alloc(16)

    for (let i = 0; i < 16; i++) {
      blowfishKey[i] = hash.charCodeAt(i) ^ hash.charCodeAt(i + 16) ^ BLOWFISH_KEY.charCodeAt(i)
    }

    // Initialize Blowfish with the key (using pure JS implementation)
    const bf = new Blowfish(blowfishKey, Blowfish.MODE.CBC, Blowfish.PADDING.NULL)
    const iv = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
    bf.setIv(iv)

    const input = fs.readFileSync(inputPath)
    const output = Buffer.alloc(input.length)

    // Decrypt in 2048 byte chunks, every third chunk is encrypted
    let chunkIndex = 0
    let position = 0

    while (position < input.length) {
      const chunkSize = Math.min(2048, input.length - position)
      const chunk = input.slice(position, position + chunkSize)

      if (chunkIndex % 3 === 0 && chunkSize === 2048) {
        // Decrypt this chunk with Blowfish CBC
        try {
          // Reset IV for each chunk decryption
          bf.setIv(iv)
          const decrypted = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY))
          decrypted.copy(output, position)
        } catch (e: any) {
          console.error(`[Downloader] Chunk decryption failed at position ${position}:`, e.message)
          // If decryption fails, just copy the chunk as-is
          chunk.copy(output, position)
        }
      } else {
        // Copy chunk as-is
        chunk.copy(output, position)
      }

      position += chunkSize
      chunkIndex++
    }

    console.log(`[Downloader] Decryption complete, writing to: ${outputPath}`)
    fs.writeFileSync(outputPath, output)
    return outputPath
  }

  private async tagFile(filePath: string, trackInfo: any, options: DownloadOptions): Promise<void> {
    try {
      console.log('[Downloader] ========== TAG FILE START ==========')
      console.log('[Downloader] File path:', filePath)
      console.log('[Downloader] File exists:', fs.existsSync(filePath))
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath)
        console.log('[Downloader] File size:', stats.size, 'bytes')
      }

      console.log('[Downloader] TrackInfo available fields:', Object.keys(trackInfo || {}))
      console.log('[Downloader] TrackInfo.SNG_TITLE:', trackInfo?.SNG_TITLE)
      console.log('[Downloader] TrackInfo.ART_NAME:', trackInfo?.ART_NAME)
      console.log('[Downloader] TrackInfo.ALB_TITLE:', trackInfo?.ALB_TITLE)
      console.log('[Downloader] TrackInfo.ALB_PICTURE:', trackInfo?.ALB_PICTURE)
      console.log('[Downloader] options.metadataSettings:', JSON.stringify(options.metadataSettings, null, 2)?.substring(0, 500))

      const NodeID3 = require('node-id3')
      console.log('[Downloader] NodeID3 loaded successfully')

      // Get tag settings (default to all true if not provided)
      const tagSettings = options.metadataSettings?.tags || {
        title: true, artist: true, album: true, cover: true,
        trackNumber: true, trackTotal: false, discNumber: true, discTotal: false,
        albumArtist: true, genre: true, year: true, date: true,
        explicitLyrics: false, isrc: true, trackLength: true, albumBarcode: true,
        bpm: true, replayGain: false, albumLabel: true, unsyncLyrics: false,
        syncLyrics: false, copyright: false, composer: false, involvedPeople: false,
        sourceId: false
      }
      const usingDefaults = !options.metadataSettings?.tags
      console.log('[Downloader] Tag settings source:', usingDefaults ? 'DEFAULTS (settings not received!)' : 'USER SETTINGS')
      if (!usingDefaults) {
        // Log which tags are enabled/disabled for verification
        const enabledTags = Object.entries(tagSettings).filter(([_, v]) => v).map(([k]) => k)
        const disabledTags = Object.entries(tagSettings).filter(([_, v]) => !v).map(([k]) => k)
        console.log('[Downloader] Enabled tags:', enabledTags.join(', '))
        console.log('[Downloader] Disabled tags:', disabledTags.length > 0 ? disabledTags.join(', ') : 'none')
      }

      const albumCoverSettings = options.metadataSettings?.albumCovers || {
        embeddedArtworkSize: 800,
        saveEmbeddedArtworkAsPNG: false,
        coverDescriptionUTF8: false,
        jpegImageQuality: 80
      }
      console.log('[Downloader] Album cover settings:', JSON.stringify(albumCoverSettings))

      // Get artist separator
      const artistSeparator = options.metadataSettings?.artistSeparator || 'standard'
      const separatorMap: Record<string, string> = {
        'standard': ', ',
        'comma': ',',
        'slash': '/',
        'semicolon': ';',
        'ampersand': ' & '
      }
      const separator = separatorMap[artistSeparator] || ', '

      // Get text processing settings
      const titleCasing = (options.metadataSettings as any)?.titleCasing || 'unchanged'
      const artistCasing = (options.metadataSettings as any)?.artistCasing || 'unchanged'
      const removeAlbumVersion = (options.metadataSettings as any)?.removeAlbumVersion || false
      const featuredArtistsHandling = (options.metadataSettings as any)?.featuredArtistsHandling || 'nothing'
      const keepVariousArtists = (options.metadataSettings as any)?.keepVariousArtists !== false
      const useNullSeparator = options.metadataSettings?.useNullSeparator || false
      const removeArtistCombinations = (options.metadataSettings as any)?.removeArtistCombinations || false
      const saveID3v1 = options.metadataSettings?.saveID3v1 || false
      const isPlaylistCompilation = options.playlistContext && options.savePlaylistAsCompilation

      // Use null separator for multi-value tags if enabled (foobar2000 compatibility)
      const tagSeparator = useNullSeparator ? '\0' : separator

      // Build tags object based on user settings
      const tags: any = {}

      // Basic tags - include VERSION in title if present
      const baseTitle = trackInfo.SNG_TITLE || ''
      const versionInfo = trackInfo.VERSION
      const cleanVersionInfo = versionInfo ? versionInfo.replace(/^\((.+)\)$/, '$1') : ''
      let processedTitle = cleanVersionInfo ? `${baseTitle} (${cleanVersionInfo})` : baseTitle
      let processedArtist = ''

      // Get artist string — include all artists (main + featured)
      // ARTISTS array is the most reliable source from the Deezer private API
      // as it contains every credited artist on the track
      if (trackInfo.ART_NAME) {
        if (options.metadataSettings?.saveOnlyMainArtist) {
          processedArtist = trackInfo.ART_NAME
        } else if (trackInfo.ARTISTS?.length > 0) {
          let artists = trackInfo.ARTISTS.map((a: any) => a.ART_NAME)
          if (removeArtistCombinations) {
            artists = this.filterArtistCombinations(artists)
          }
          processedArtist = artists.join(tagSeparator)
        } else if (trackInfo.SNG_CONTRIBUTORS?.main_artist?.length > 0) {
          // Fallback: combine main_artist + featartist from contributors
          let artists = [...trackInfo.SNG_CONTRIBUTORS.main_artist]
          if (trackInfo.SNG_CONTRIBUTORS.featartist?.length > 0) {
            artists.push(...trackInfo.SNG_CONTRIBUTORS.featartist)
          }
          if (removeArtistCombinations) {
            artists = this.filterArtistCombinations(artists)
          }
          processedArtist = artists.join(tagSeparator)
        } else {
          processedArtist = trackInfo.ART_NAME
        }
      }

      // Apply text processing
      if (removeAlbumVersion) {
        processedTitle = this.cleanAlbumVersion(processedTitle)
      }

      // Handle featured artists
      const featResult = this.handleFeaturedArtists(processedTitle, processedArtist, featuredArtistsHandling)
      processedTitle = featResult.title
      processedArtist = featResult.artist

      // Apply casing
      processedTitle = this.applyCasing(processedTitle, titleCasing)
      processedArtist = this.applyCasing(processedArtist, artistCasing)

      if (tagSettings.title && processedTitle) {
        tags.title = processedTitle
      }

      if (tagSettings.artist && processedArtist) {
        tags.artist = processedArtist
      }

      if (tagSettings.album && trackInfo.ALB_TITLE) {
        tags.album = trackInfo.ALB_TITLE
      }

      if (tagSettings.albumArtist) {
        if (isPlaylistCompilation) {
          tags.performerInfo = 'Various Artists'
        } else {
          const rawAlbumArtist = trackInfo.ALB_ART_NAME || trackInfo.ART_NAME || ''
          const albumArtist = this.handleVariousArtists(rawAlbumArtist, keepVariousArtists)
          tags.performerInfo = albumArtist || processedArtist || rawAlbumArtist
        }
      }

      // Add compilation flag for playlists (iTunes TCMP frame)
      if (isPlaylistCompilation) {
        tags.userDefinedText = tags.userDefinedText || []
        tags.userDefinedText.push({
          description: 'COMPILATION',
          value: '1'
        })
      }

      if (tagSettings.trackNumber && trackInfo.TRACK_NUMBER) {
        if (tagSettings.trackTotal && trackInfo.TRACKS_COUNT) {
          tags.trackNumber = `${trackInfo.TRACK_NUMBER}/${trackInfo.TRACKS_COUNT}`
        } else {
          tags.trackNumber = trackInfo.TRACK_NUMBER.toString()
        }
      }

      if (tagSettings.discNumber && trackInfo.DISK_NUMBER) {
        if (tagSettings.discTotal && trackInfo.DISKS_COUNT) {
          tags.partOfSet = `${trackInfo.DISK_NUMBER}/${trackInfo.DISKS_COUNT}`
        } else {
          tags.partOfSet = trackInfo.DISK_NUMBER.toString()
        }
      }

      if (tagSettings.genre) {
        const genres = await this.getGenresForTrack(trackInfo)
        // Filter out "All" genre if present
        const validGenres = genres.filter(g => g.toLowerCase() !== 'all')
        if (validGenres.length > 0) {
          // MP3 ID3v2.4 supports multiple genres - join with semicolon for broad compatibility
          tags.genre = validGenres.join('; ')
          console.log(`[Downloader] Set MP3 genre tag: ${tags.genre} (${validGenres.length} genre(s))`)
        } else {
          console.log(`[Downloader] Skipping genre tag - no valid genres found`)
        }
      }

      if (tagSettings.year && trackInfo.PHYSICAL_RELEASE_DATE) {
        tags.year = trackInfo.PHYSICAL_RELEASE_DATE.split('-')[0]
      }

      if (tagSettings.date && trackInfo.PHYSICAL_RELEASE_DATE) {
        // Use TDRC frame for full date in ID3v2.4
        tags.date = trackInfo.PHYSICAL_RELEASE_DATE
      }

      if (tagSettings.bpm && trackInfo.BPM) {
        tags.bpm = trackInfo.BPM.toString()
      }

      if (tagSettings.isrc && trackInfo.ISRC) {
        tags.ISRC = trackInfo.ISRC
      }

      if (tagSettings.albumBarcode && trackInfo.ALB_UPC) {
        // Store UPC in TXXX frame
        tags.userDefinedText = tags.userDefinedText || []
        tags.userDefinedText.push({
          description: 'BARCODE',
          value: trackInfo.ALB_UPC
        })
      }

      if (tagSettings.albumLabel && trackInfo.LABEL_NAME) {
        tags.publisher = trackInfo.LABEL_NAME
      }

      if (tagSettings.copyright && trackInfo.COPYRIGHT) {
        tags.copyright = trackInfo.COPYRIGHT
      }

      if (tagSettings.composer && trackInfo.SNG_CONTRIBUTORS?.composer?.length > 0) {
        tags.composer = trackInfo.SNG_CONTRIBUTORS.composer.join(separator)
      }

      if (tagSettings.trackLength && trackInfo.DURATION) {
        // TLEN frame in milliseconds
        tags.length = (parseInt(trackInfo.DURATION) * 1000).toString()
      }

      if (tagSettings.explicitLyrics && trackInfo.EXPLICIT_LYRICS !== undefined) {
        // Use iTunes advisory rating
        tags.userDefinedText = tags.userDefinedText || []
        tags.userDefinedText.push({
          description: 'ITUNESADVISORY',
          value: trackInfo.EXPLICIT_LYRICS ? '1' : '0'
        })
      }

      if (tagSettings.sourceId && trackInfo.SNG_ID) {
        tags.userDefinedText = tags.userDefinedText || []
        tags.userDefinedText.push({
          description: 'DEEZER_TRACK_ID',
          value: trackInfo.SNG_ID.toString()
        })
      }

      // Involved people (producers, engineers, etc.)
      if (tagSettings.involvedPeople && trackInfo.SNG_CONTRIBUTORS) {
        const credits: string[] = []
        const contributors = trackInfo.SNG_CONTRIBUTORS

        if (contributors.producer?.length > 0) {
          credits.push(`Producer: ${contributors.producer.join(', ')}`)
        }
        if (contributors.engineer?.length > 0) {
          credits.push(`Engineer: ${contributors.engineer.join(', ')}`)
        }
        if (contributors.writer?.length > 0) {
          credits.push(`Writer: ${contributors.writer.join(', ')}`)
        }
        if (contributors.mixer?.length > 0) {
          credits.push(`Mixer: ${contributors.mixer.join(', ')}`)
        }
        if (contributors.author?.length > 0) {
          credits.push(`Author: ${contributors.author.join(', ')}`)
        }

        if (credits.length > 0) {
          tags.comment = {
            language: 'eng',
            text: credits.join('\n')
          }
        }
      }

      // Unsynced lyrics
      if (tagSettings.unsyncLyrics && trackInfo.LYRICS?.LYRICS_TEXT) {
        tags.unsynchronisedLyrics = {
          language: 'eng',
          text: trackInfo.LYRICS.LYRICS_TEXT
        }
      }

      // Synced lyrics (SYLT frame)
      if (tagSettings.syncLyrics && trackInfo.LYRICS?.LYRICS_SYNC_JSON) {
        try {
          const syncedLyrics = trackInfo.LYRICS.LYRICS_SYNC_JSON
          const syltLines: Array<{ text: string; timeStamp: number }> = []

          for (const line of syncedLyrics) {
            if (line.milliseconds !== undefined && line.line) {
              syltLines.push({
                text: line.line,
                timeStamp: line.milliseconds
              })
            }
          }

          if (syltLines.length > 0) {
            tags.synchronisedLyrics = [{
              language: 'eng',
              timeStampFormat: 2, // Milliseconds
              contentType: 1, // Lyrics
              synchronisedText: syltLines
            }]
          }
        } catch (e) {
          console.error('[Downloader] Failed to process synced lyrics:', e)
        }
      }

      // Embed artwork if requested
      if (tagSettings.cover && options.embedArtwork && trackInfo.ALB_PICTURE) {
        try {
          const artworkSize = albumCoverSettings.embeddedArtworkSize || 800
          // Use quality 90 to match original deemix (was 80)
          const quality = albumCoverSettings.jpegImageQuality || 90

          // Use cached artwork to avoid re-downloading for each track in album
          console.log(`[Downloader] Getting embedded artwork (cached): ${trackInfo.ALB_PICTURE}`)
          const artworkBuffer = await this.getCachedArtwork(trackInfo.ALB_PICTURE, artworkSize, quality)

          tags.image = {
            mime: 'image/jpeg',
            type: { id: 3, name: 'front cover' },
            description: albumCoverSettings.coverDescriptionUTF8 ? 'Cover' : 'Album Artwork',
            imageBuffer: artworkBuffer
          }
          console.log(`[Downloader] Embedded artwork: ${artworkBuffer.length} bytes`)
        } catch (e) {
          console.error('[Downloader] Failed to embed artwork:', e)
        }
      }

      // Write tags
      console.log(`[Downloader] ========== WRITING TAGS ==========`)
      console.log(`[Downloader] Tags object keys: ${Object.keys(tags).join(', ')}`)
      console.log(`[Downloader] Tags summary:`, {
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        year: tags.year,
        trackNumber: tags.trackNumber,
        hasImage: !!tags.image,
        imageSize: tags.image?.imageBuffer?.length
      })
      console.log(`[Downloader] Writing to file: ${filePath}`)

      // Verify file still exists before writing
      if (!fs.existsSync(filePath)) {
        console.error('[Downloader] ERROR: File does not exist before tag write!')
        return
      }

      // Get file stats
      const fileStats = fs.statSync(filePath)
      console.log(`[Downloader] File size before tagging: ${fileStats.size} bytes`)

      // Read the file into a buffer, write tags, then write back
      // This is more reliable than direct file operations
      try {
        const fileBuffer = fs.readFileSync(filePath)
        console.log(`[Downloader] Read file buffer: ${fileBuffer.length} bytes`)

        // Check if it's a valid MP3 (starts with ID3 tag or MP3 frame sync)
        const hasID3 = fileBuffer[0] === 0x49 && fileBuffer[1] === 0x44 && fileBuffer[2] === 0x33 // "ID3"
        const hasMP3Sync = fileBuffer[0] === 0xFF && (fileBuffer[1] & 0xE0) === 0xE0 // MP3 frame sync
        console.log(`[Downloader] File has ID3 header: ${hasID3}, has MP3 sync: ${hasMP3Sync}`)

        // Write tags to buffer
        const taggedBuffer = NodeID3.write(tags, fileBuffer)

        if (taggedBuffer && Buffer.isBuffer(taggedBuffer)) {
          console.log(`[Downloader] Tagged buffer size: ${taggedBuffer.length} bytes`)
          fs.writeFileSync(filePath, taggedBuffer)
          console.log('[Downloader] Tags written successfully via buffer method')

          // Write ID3v1 tags if enabled (for legacy player compatibility)
          if (saveID3v1) {
            this.writeID3v1Tags(filePath, {
              title: tags.title,
              artist: tags.artist,
              album: tags.album,
              year: tags.year,
              track: trackInfo.TRACK_NUMBER ? parseInt(trackInfo.TRACK_NUMBER) : undefined
            })
          }

          // Verify by reading back
          const verifyTags = NodeID3.read(filePath)
          console.log('[Downloader] Verification - read back title:', verifyTags?.title)
          console.log('[Downloader] Verification - read back artist:', verifyTags?.artist)
          console.log('[Downloader] Verification - has image:', !!verifyTags?.image)
        } else {
          // Try direct file write as fallback
          console.log('[Downloader] Buffer method failed, trying direct file write...')
          const success = NodeID3.write(tags, filePath)
          console.log(`[Downloader] Direct write returned: ${success}`)

          if (!success) {
            // Try update instead
            console.log('[Downloader] Trying NodeID3.update...')
            const updateResult = NodeID3.update(tags, filePath)
            console.log(`[Downloader] Update returned: ${updateResult}`)
          }

          // Write ID3v1 tags if enabled
          if (saveID3v1) {
            this.writeID3v1Tags(filePath, {
              title: tags.title,
              artist: tags.artist,
              album: tags.album,
              year: tags.year,
              track: trackInfo.TRACK_NUMBER ? parseInt(trackInfo.TRACK_NUMBER) : undefined
            })
          }
        }
      } catch (writeError: any) {
        console.error('[Downloader] Tag write error:', writeError.message)
        // Last resort - try update
        try {
          const updateResult = NodeID3.update(tags, filePath)
          console.log(`[Downloader] Fallback update returned: ${updateResult}`)
        } catch (updateError: any) {
          console.error('[Downloader] Fallback update error:', updateError.message)
        }
      }

      console.log('[Downloader] ========== TAG FILE END ==========')
    } catch (error) {
      console.error('[Downloader] Error tagging file:', error)
    }
  }

  private async tagFlacFile(filePath: string, trackInfo: any, options: DownloadOptions): Promise<void> {
    try {
      // Get tag settings (default to all true if not provided)
      const tagSettings = options.metadataSettings?.tags || {
        title: true, artist: true, album: true, cover: true,
        trackNumber: true, trackTotal: false, discNumber: true, discTotal: false,
        albumArtist: true, genre: true, year: true, date: true,
        explicitLyrics: false, isrc: true, trackLength: true, albumBarcode: true,
        bpm: true, replayGain: false, albumLabel: true, unsyncLyrics: false,
        syncLyrics: false, copyright: false, composer: false, involvedPeople: false,
        sourceId: false
      }
      const usingDefaults = !options.metadataSettings?.tags
      console.log('[Downloader/FLAC] Tag settings source:', usingDefaults ? 'DEFAULTS (settings not received!)' : 'USER SETTINGS')
      if (!usingDefaults) {
        const enabledTags = Object.entries(tagSettings).filter(([_, v]) => v).map(([k]) => k)
        const disabledTags = Object.entries(tagSettings).filter(([_, v]) => !v).map(([k]) => k)
        console.log('[Downloader/FLAC] Enabled tags:', enabledTags.join(', '))
        console.log('[Downloader/FLAC] Disabled tags:', disabledTags.length > 0 ? disabledTags.join(', ') : 'none')
      }

      const albumCoverSettings = options.metadataSettings?.albumCovers || {
        embeddedArtworkSize: 800,
        saveEmbeddedArtworkAsPNG: false,
        jpegImageQuality: 90
      }

      // Get artist separator
      const artistSeparator = options.metadataSettings?.artistSeparator || 'standard'
      const separatorMap: Record<string, string> = {
        'standard': ', ',
        'comma': ',',
        'slash': '/',
        'semicolon': ';',
        'ampersand': ' & '
      }
      const separator = separatorMap[artistSeparator] || ', '

      // Get date format for FLAC
      const dateFormat = options.metadataSettings?.dateFormatFlac || 'YYYY-MM-DD'

      // Get text processing settings
      const titleCasing = (options.metadataSettings as any)?.titleCasing || 'unchanged'
      const artistCasing = (options.metadataSettings as any)?.artistCasing || 'unchanged'
      const removeAlbumVersionSetting = (options.metadataSettings as any)?.removeAlbumVersion || false
      const featuredArtistsHandling = (options.metadataSettings as any)?.featuredArtistsHandling || 'nothing'
      const keepVariousArtists = (options.metadataSettings as any)?.keepVariousArtists !== false
      const removeArtistCombinations = (options.metadataSettings as any)?.removeArtistCombinations || false
      const isPlaylistCompilation = options.playlistContext && options.savePlaylistAsCompilation

      // Note: FLAC Vorbis comments don't support null separator like ID3
      // Multiple values are stored as separate ARTIST= lines instead

      // Build Vorbis comments
      const comments: string[] = []

      // Process title and artist - include VERSION in title if present
      const flacBaseTitle = trackInfo.SNG_TITLE || ''
      const flacVersionInfo = trackInfo.VERSION
      const flacCleanVersion = flacVersionInfo ? flacVersionInfo.replace(/^\((.+)\)$/, '$1') : ''
      let processedTitle = flacCleanVersion ? `${flacBaseTitle} (${flacCleanVersion})` : flacBaseTitle
      let processedArtist = ''

      // Get artist string — include all artists (main + featured)
      if (trackInfo.ART_NAME) {
        if (options.metadataSettings?.saveOnlyMainArtist) {
          processedArtist = trackInfo.ART_NAME
        } else if (trackInfo.ARTISTS?.length > 0) {
          let artists = trackInfo.ARTISTS.map((a: any) => a.ART_NAME)
          if (removeArtistCombinations) {
            artists = this.filterArtistCombinations(artists)
          }
          processedArtist = artists.join(separator)
        } else if (trackInfo.SNG_CONTRIBUTORS?.main_artist?.length > 0) {
          let artists = [...trackInfo.SNG_CONTRIBUTORS.main_artist]
          if (trackInfo.SNG_CONTRIBUTORS.featartist?.length > 0) {
            artists.push(...trackInfo.SNG_CONTRIBUTORS.featartist)
          }
          if (removeArtistCombinations) {
            artists = this.filterArtistCombinations(artists)
          }
          processedArtist = artists.join(separator)
        } else {
          processedArtist = trackInfo.ART_NAME
        }
      }

      // Apply text processing
      if (removeAlbumVersionSetting) {
        processedTitle = this.cleanAlbumVersion(processedTitle)
      }

      // Handle featured artists
      const featResult = this.handleFeaturedArtists(processedTitle, processedArtist, featuredArtistsHandling)
      processedTitle = featResult.title
      processedArtist = featResult.artist

      // Apply casing
      processedTitle = this.applyCasing(processedTitle, titleCasing)
      processedArtist = this.applyCasing(processedArtist, artistCasing)

      if (tagSettings.title && processedTitle) {
        comments.push(`TITLE=${processedTitle}`)
      }

      if (tagSettings.artist && processedArtist) {
        comments.push(`ARTIST=${processedArtist}`)
      }

      if (tagSettings.album && trackInfo.ALB_TITLE) {
        comments.push(`ALBUM=${trackInfo.ALB_TITLE}`)
      }

      if (tagSettings.albumArtist) {
        if (isPlaylistCompilation) {
          comments.push(`ALBUMARTIST=Various Artists`)
          comments.push(`COMPILATION=1`)
        } else {
          const rawAlbumArtist = trackInfo.ALB_ART_NAME || trackInfo.ART_NAME || ''
          const albumArtist = this.handleVariousArtists(rawAlbumArtist, keepVariousArtists)
          const finalAlbumArtist = albumArtist || processedArtist || rawAlbumArtist
          if (finalAlbumArtist) {
            comments.push(`ALBUMARTIST=${finalAlbumArtist}`)
          }
        }
      }

      if (tagSettings.trackNumber && trackInfo.TRACK_NUMBER) {
        comments.push(`TRACKNUMBER=${trackInfo.TRACK_NUMBER}`)
      }

      if (tagSettings.trackTotal && trackInfo.TRACKS_COUNT) {
        comments.push(`TRACKTOTAL=${trackInfo.TRACKS_COUNT}`)
      }

      if (tagSettings.discNumber && trackInfo.DISK_NUMBER) {
        comments.push(`DISCNUMBER=${trackInfo.DISK_NUMBER}`)
      }

      if (tagSettings.discTotal && trackInfo.DISKS_COUNT) {
        comments.push(`DISCTOTAL=${trackInfo.DISKS_COUNT}`)
      }

      if (tagSettings.genre) {
        const genres = await this.getGenresForTrack(trackInfo)
        // Filter out "All" genre if present
        const validGenres = genres.filter(g => g.toLowerCase() !== 'all')
        if (validGenres.length > 0) {
          // FLAC/Vorbis comments natively support multiple GENRE tags
          for (const genre of validGenres) {
            comments.push(`GENRE=${genre}`)
          }
          console.log(`[Downloader] Set FLAC genre tag(s): ${validGenres.join(', ')} (${validGenres.length} genre(s))`)
        } else {
          console.log(`[Downloader/FLAC] Skipping genre tag - no valid genres found`)
        }
      }

      if (tagSettings.year && trackInfo.PHYSICAL_RELEASE_DATE) {
        comments.push(`YEAR=${trackInfo.PHYSICAL_RELEASE_DATE.split('-')[0]}`)
      }

      if (tagSettings.date && trackInfo.PHYSICAL_RELEASE_DATE) {
        const rawDate = trackInfo.PHYSICAL_RELEASE_DATE
        let formattedDate = rawDate

        if (rawDate) {
          const parts = rawDate.split('-')
          if (parts.length === 3) {
            const [year, month, day] = parts
            switch (dateFormat) {
              case 'DD-MM-YYYY':
                formattedDate = `${day}-${month}-${year}`
                break
              case 'MM-DD-YYYY':
                formattedDate = `${month}-${day}-${year}`
                break
              case 'YYYY':
                formattedDate = year
                break
              case 'DD/MM/YYYY':
                formattedDate = `${day}/${month}/${year}`
                break
              case 'MM/DD/YYYY':
                formattedDate = `${month}/${day}/${year}`
                break
              default:
                formattedDate = rawDate
            }
          }
        }
        comments.push(`DATE=${formattedDate}`)
      }

      if (tagSettings.bpm && trackInfo.BPM) {
        comments.push(`BPM=${trackInfo.BPM}`)
      }

      if (tagSettings.isrc && trackInfo.ISRC) {
        comments.push(`ISRC=${trackInfo.ISRC}`)
      }

      if (tagSettings.albumBarcode && trackInfo.ALB_UPC) {
        comments.push(`BARCODE=${trackInfo.ALB_UPC}`)
      }

      if (tagSettings.albumLabel && trackInfo.LABEL_NAME) {
        comments.push(`LABEL=${trackInfo.LABEL_NAME}`)
      }

      if (tagSettings.copyright && trackInfo.COPYRIGHT) {
        comments.push(`COPYRIGHT=${trackInfo.COPYRIGHT}`)
      }

      if (tagSettings.composer && trackInfo.SNG_CONTRIBUTORS?.composer?.length > 0) {
        comments.push(`COMPOSER=${trackInfo.SNG_CONTRIBUTORS.composer.join(separator)}`)
      }

      if (tagSettings.trackLength && trackInfo.DURATION) {
        comments.push(`LENGTH=${trackInfo.DURATION}`)
      }

      if (tagSettings.explicitLyrics && trackInfo.EXPLICIT_LYRICS !== undefined) {
        comments.push(`EXPLICIT=${trackInfo.EXPLICIT_LYRICS ? '1' : '0'}`)
      }

      if (tagSettings.sourceId && trackInfo.SNG_ID) {
        comments.push(`DEEZER_TRACK_ID=${trackInfo.SNG_ID}`)
      }

      // Involved people
      if (tagSettings.involvedPeople && trackInfo.SNG_CONTRIBUTORS) {
        const contributors = trackInfo.SNG_CONTRIBUTORS
        if (contributors.producer?.length > 0) {
          comments.push(`PRODUCER=${contributors.producer.join(', ')}`)
        }
        if (contributors.engineer?.length > 0) {
          comments.push(`ENGINEER=${contributors.engineer.join(', ')}`)
        }
        if (contributors.writer?.length > 0) {
          comments.push(`WRITER=${contributors.writer.join(', ')}`)
        }
        if (contributors.mixer?.length > 0) {
          comments.push(`MIXER=${contributors.mixer.join(', ')}`)
        }
        if (contributors.author?.length > 0) {
          comments.push(`AUTHOR=${contributors.author.join(', ')}`)
        }
      }

      // Unsynced Lyrics
      if (tagSettings.unsyncLyrics && trackInfo.LYRICS?.LYRICS_TEXT) {
        comments.push(`LYRICS=${trackInfo.LYRICS.LYRICS_TEXT.replace(/\n/g, '\\n')}`)
      }

      // Synced Lyrics (stored as LRC format in SYNCEDLYRICS field)
      if (tagSettings.syncLyrics && trackInfo.LYRICS?.LYRICS_SYNC_JSON) {
        try {
          // Build minimal LRC content (just timestamps and lines, no metadata header)
          const lrcLines: string[] = []
          for (const line of trackInfo.LYRICS.LYRICS_SYNC_JSON) {
            if (line.milliseconds !== undefined && line.line) {
              const ms = line.milliseconds
              const minutes = Math.floor(ms / 60000)
              const seconds = Math.floor((ms % 60000) / 1000)
              const centiseconds = Math.floor((ms % 1000) / 10)
              const timestamp = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`
              lrcLines.push(`[${timestamp}]${line.line}`)
            }
          }
          if (lrcLines.length > 0) {
            // Escape newlines for Vorbis comment storage
            comments.push(`SYNCEDLYRICS=${lrcLines.join('\\n')}`)
            console.log(`[Downloader] Added FLAC synced lyrics: ${lrcLines.length} lines`)
          }
        } catch (e) {
          console.error('[Downloader] Failed to process FLAC synced lyrics:', e)
        }
      }

      console.log(`[Downloader] Writing FLAC Vorbis comments: ${comments.length} fields`)

      // Download cover image if needed (using cache)
      let pictureData: Buffer | null = null
      if (tagSettings.cover && options.embedArtwork && trackInfo.ALB_PICTURE) {
        try {
          const artworkSize = albumCoverSettings.embeddedArtworkSize || 800
          const quality = albumCoverSettings.jpegImageQuality || 90

          console.log(`[Downloader] Getting FLAC cover (cached): ${trackInfo.ALB_PICTURE}`)
          pictureData = await this.getCachedArtwork(trackInfo.ALB_PICTURE, artworkSize, quality)
          console.log(`[Downloader] FLAC cover from cache: ${pictureData.length} bytes`)
        } catch (e) {
          console.error('[Downloader] Failed to get cover for FLAC:', e)
        }
      }

      // Use manual buffer-based approach for reliable FLAC tagging
      // The flac-metadata library's streaming API has bugs with postprocess callbacks
      const flacData = fs.readFileSync(filePath)

      // Verify FLAC marker
      if (flacData.toString('utf8', 0, 4) !== 'fLaC') {
        console.error('[Downloader] Not a valid FLAC file')
        return
      }

      // Parse metadata blocks to find audio data offset
      interface FlacBlock {
        type: number
        isLast: boolean
        length: number
        data: Buffer
      }
      const blocks: FlacBlock[] = []
      let offset = 4 // Skip 'fLaC' marker

      while (offset < flacData.length) {
        const headerByte = flacData.readUInt8(offset)
        const isLast = (headerByte & 0x80) !== 0
        const type = headerByte & 0x7F
        const length = flacData.readUIntBE(offset + 1, 3)

        if (type === 127) break // Invalid block type

        const blockData = flacData.slice(offset + 4, offset + 4 + length)
        blocks.push({ type, isLast, length, data: blockData })

        offset += 4 + length
        if (isLast) break
      }

      const audioDataOffset = offset
      console.log(`[Downloader] FLAC audio data starts at offset: ${audioDataOffset}`)

      // Build new FLAC file with our metadata
      const chunks: Buffer[] = []
      chunks.push(Buffer.from('fLaC'))

      const vendor = 'Deemix Remastered'

      // Write all blocks except VORBIS_COMMENT (4), PICTURE (6), and PADDING (1)
      // We'll add our own VORBIS_COMMENT and PICTURE at the end
      for (const block of blocks) {
        if (block.type === 0) {
          // STREAMINFO - always keep as first block, mark as not last
          const header = Buffer.alloc(4)
          header.writeUInt8(0x00 | block.type, 0) // isLast=false
          header.writeUIntBE(block.length, 1, 3)
          chunks.push(header)
          chunks.push(block.data)
        }
        // Skip VORBIS_COMMENT (4), PICTURE (6), PADDING (1) - we'll add our own
      }

      // Add our VORBIS_COMMENT block
      const vendorBytes = Buffer.from(vendor, 'utf8')
      let commentDataSize = 4 + vendorBytes.length + 4 // vendor length + vendor + comment count

      const commentBuffers = comments.map(c => Buffer.from(c, 'utf8'))
      for (const cb of commentBuffers) {
        commentDataSize += 4 + cb.length
      }

      const vorbisData = Buffer.alloc(commentDataSize)
      let pos = 0

      // Vendor length (little-endian)
      vorbisData.writeUInt32LE(vendorBytes.length, pos)
      pos += 4
      vendorBytes.copy(vorbisData, pos)
      pos += vendorBytes.length

      // Comment count
      vorbisData.writeUInt32LE(comments.length, pos)
      pos += 4

      // Each comment
      for (const cb of commentBuffers) {
        vorbisData.writeUInt32LE(cb.length, pos)
        pos += 4
        cb.copy(vorbisData, pos)
        pos += cb.length
      }

      // Write VORBIS_COMMENT header (isLast depends on whether we have picture)
      const vorbisHeader = Buffer.alloc(4)
      const vorbisIsLast = !pictureData
      vorbisHeader.writeUInt8((vorbisIsLast ? 0x80 : 0x00) | 4, 0) // type=4 (VORBIS_COMMENT)
      vorbisHeader.writeUIntBE(vorbisData.length, 1, 3)
      chunks.push(vorbisHeader)
      chunks.push(vorbisData)

      // Add PICTURE block if we have cover data
      if (pictureData) {
        const artworkSize = albumCoverSettings.embeddedArtworkSize || 800
        const mimeType = 'image/jpeg'
        const description = 'Front Cover'

        const mimeTypeBytes = Buffer.from(mimeType, 'utf8')
        const descriptionBytes = Buffer.from(description, 'utf8')

        const pictureBlockSize = 4 + 4 + mimeTypeBytes.length + 4 + descriptionBytes.length + 16 + 4 + pictureData.length
        const pictureBlockData = Buffer.alloc(pictureBlockSize)

        let ppos = 0

        // Picture type (3 = Cover front)
        pictureBlockData.writeUInt32BE(3, ppos)
        ppos += 4

        // MIME type
        pictureBlockData.writeUInt32BE(mimeTypeBytes.length, ppos)
        ppos += 4
        mimeTypeBytes.copy(pictureBlockData, ppos)
        ppos += mimeTypeBytes.length

        // Description
        pictureBlockData.writeUInt32BE(descriptionBytes.length, ppos)
        ppos += 4
        descriptionBytes.copy(pictureBlockData, ppos)
        ppos += descriptionBytes.length

        // Width, height, color depth, colors
        pictureBlockData.writeUInt32BE(artworkSize, ppos) // width
        ppos += 4
        pictureBlockData.writeUInt32BE(artworkSize, ppos) // height
        ppos += 4
        pictureBlockData.writeUInt32BE(24, ppos) // bits per pixel
        ppos += 4
        pictureBlockData.writeUInt32BE(0, ppos) // colors (0 for non-indexed)
        ppos += 4

        // Picture data
        pictureBlockData.writeUInt32BE(pictureData.length, ppos)
        ppos += 4
        pictureData.copy(pictureBlockData, ppos)

        // Write PICTURE header (this IS the last block)
        const pictureHeader = Buffer.alloc(4)
        pictureHeader.writeUInt8(0x80 | 6, 0) // isLast=true, type=6 (PICTURE)
        pictureHeader.writeUIntBE(pictureBlockData.length, 1, 3)
        chunks.push(pictureHeader)
        chunks.push(pictureBlockData)
      }

      // Add the audio data
      const audioData = flacData.slice(audioDataOffset)
      chunks.push(audioData)

      // Write the new FLAC file
      const outputBuffer = Buffer.concat(chunks)
      fs.writeFileSync(filePath, outputBuffer)

      console.log(`[Downloader] FLAC tags written successfully (${comments.length} fields, picture: ${pictureData ? 'yes' : 'no'})`)
    } catch (error) {
      console.error('[Downloader] Error tagging FLAC file:', error)
    }
  }

  /**
   * Get genre name from a genre ID using Deezer's comprehensive genre mapping
   * Note: Genre ID 0 means "All" in Deezer which is not a useful genre, so we return undefined
   */
  private getGenreNameFromId(genreId: number): string | undefined {
    // Genre ID 0 means "All" / "No specific genre" - return undefined instead
    if (!genreId || genreId === 0) {
      return undefined
    }

    // Comprehensive Deezer genre mapping (100+ genres)
    const genres: { [key: number]: string } = {
      // Main genres (1-22)
      1: 'Pop',
      2: 'Rap/Hip Hop',
      3: 'Rock',
      4: 'Dance',
      5: 'R&B',
      6: 'Alternative',
      7: 'Electro',
      8: 'Folk',
      9: 'Reggae',
      10: 'Jazz',
      11: 'Classical',
      12: 'Films/Games',
      13: 'Metal',
      14: 'Soul & Funk',
      15: 'African Music',
      16: 'Asian Music',
      17: 'Blues',
      18: 'Brazilian Music',
      19: 'Indian Music',
      20: 'Kids',
      21: 'Latin Music',
      22: 'Soundtracks',
      // Sub-genres and extended genres
      52: 'French Rap',
      65: 'Punk',
      66: 'Indie Rock',
      67: 'Hard Rock',
      68: 'Hardcore',
      69: 'Progressive Rock',
      70: 'Grunge',
      73: 'Trip-Hop',
      75: 'Chanson française',
      76: 'French Pop',
      77: 'Variété française',
      78: 'Chanson',
      80: 'Drum & Bass',
      81: 'Country',
      82: 'Americana',
      84: 'Bluegrass',
      85: 'Gospel/Religious',
      86: 'Christian',
      87: 'Spiritual',
      88: 'Worship',
      93: 'House',
      94: 'Techno',
      95: 'Comedy/Humor',
      96: 'Spoken Word',
      97: 'Podcast',
      98: 'Audiobooks',
      99: 'Radio',
      100: 'Dub',
      101: 'Dancehall',
      102: 'Roots Reggae',
      103: 'Ragga',
      106: 'Anime',
      107: 'Video Games',
      108: 'Musical',
      109: 'Opera',
      110: 'Baroque',
      111: 'Romantic',
      112: 'Chamber Music',
      113: 'World',
      114: 'Celtic',
      115: 'Flamenco',
      116: 'Ska',
      117: 'Afrobeat',
      118: 'Highlife',
      119: 'Soukous',
      120: 'Mbalax',
      121: 'Bossa Nova',
      122: 'MPB',
      123: 'Samba',
      124: 'Forró',
      125: 'Sertanejo',
      126: 'Axé',
      127: 'Funk Carioca',
      128: 'Pagode',
      129: 'Bollywood',
      130: 'Carnatic',
      131: 'Hindustani',
      132: 'Singer & Songwriter',
      133: 'Indie Folk',
      134: 'Acoustic',
      135: 'Americana',
      136: 'Salsa',
      137: 'Bachata',
      138: 'Merengue',
      139: 'Reggaeton',
      140: 'Cumbia',
      141: 'Tango',
      142: 'Mariachi',
      143: 'Banda',
      144: 'Ambient',
      145: 'Downtempo',
      146: 'IDM',
      147: 'Experimental',
      148: 'Industrial',
      149: 'Noise',
      150: 'Trance',
      151: 'Progressive Trance',
      152: 'Electronic',
      153: 'Easy Listening',
      154: 'Lounge',
      155: 'Bossa Nova',
      156: 'Exotica',
      157: 'Space Age Pop',
      158: 'Nu-Disco',
      159: 'Disco',
      160: 'Funk',
      161: 'Neo-Soul',
      162: 'Contemporary R&B',
      163: 'Quiet Storm',
      164: 'Motown',
      165: 'Northern Soul',
      166: 'Psychedelic Soul',
      167: 'New Wave',
      168: 'Post-Punk',
      169: 'New Age',
      170: 'Meditation',
      171: 'Relaxation',
      172: 'Nature Sounds',
      173: 'Lounge',
      174: 'Chillout',
      175: 'Deep House',
      176: 'Tech House',
      177: 'Progressive House',
      178: 'Minimal',
      179: 'Dubstep',
      180: 'Bass Music',
      181: 'Trap',
      182: 'Future Bass',
      183: 'Hardstyle',
      184: 'Gabber',
      185: 'Breakbeat',
      186: 'Chill',
      187: 'Chillwave',
      188: 'Synthwave',
      189: 'Retrowave',
      190: 'Vaporwave',
      191: 'Lo-Fi',
      192: 'Lo-Fi Hip Hop',
      193: 'Emo',
      194: 'Screamo',
      195: 'Post-Hardcore',
      196: 'Metalcore',
      197: 'Indie Pop',
      198: 'Dream Pop',
      199: 'Shoegaze',
      200: 'Britpop',
      201: 'Garage Rock',
      202: 'Surf Rock',
      203: 'Psychedelic Rock',
      204: 'Stoner Rock',
      205: 'Doom Metal',
      206: 'Black Metal',
      207: 'Death Metal',
      208: 'Thrash Metal',
      209: 'Power Metal',
      210: 'Symphonic Metal',
      211: 'Gothic Metal',
      212: 'Nu Metal',
      213: 'Groove Metal',
      214: 'Sludge Metal',
      // K-Pop and J-Pop
      464: 'K-Pop',
      465: 'K-Hip Hop',
      466: 'J-Pop',
      467: 'J-Rock',
      468: 'Visual Kei',
      469: 'City Pop',
      470: 'Enka',
      // Additional electronic
      480: 'EDM',
      481: 'Big Room',
      482: 'Future House',
      483: 'Tropical House',
      484: 'Melodic House',
      485: 'Afro House',
      486: 'Latin House',
      487: 'Organic House',
      // Additional hip hop
      500: 'Trap',
      501: 'Drill',
      502: 'Boom Bap',
      503: 'Conscious Hip Hop',
      504: 'Gangsta Rap',
      505: 'Southern Hip Hop',
      506: 'West Coast Hip Hop',
      507: 'East Coast Hip Hop',
      508: 'Mumble Rap',
      509: 'Cloud Rap',
      510: 'Phonk'
    }
    return genres[genreId]
  }

  /**
   * Get genres for a track - ALWAYS uses public API first for reliable genre names
   * Returns an array of genre names (supports multiple genres)
   *
   * Note: We prioritize the public API (api.deezer.com) because it returns the actual
   * genre NAME directly, whereas the GW API only returns genre IDs which require
   * an unreliable hardcoded mapping. Deezer's genre IDs are inconsistent - the same
   * ID can mean different things for different content.
   */
  private async getGenresForTrack(trackInfo: any): Promise<string[]> {
    console.log(`[Downloader] Getting genres for track: ${trackInfo.SNG_TITLE}`)
    console.log(`[Downloader] Track GENRE_ID: ${trackInfo.GENRE_ID}, ALB_GENRE_ID: ${trackInfo.ALB_GENRE_ID}, ALB_ID: ${trackInfo.ALB_ID}`)

    const albumId = trackInfo.ALB_ID
    if (!albumId) {
      console.log('[Downloader] No album ID available for genre lookup')
      // Fall back to ID mapping only if no album ID
      return this.getGenresFromIdMapping(trackInfo)
    }

    // Use cache to avoid redundant API calls for same album
    const cacheKey = `album_${albumId}`
    let genrePromise = this.genreCache.get(cacheKey)

    if (!genrePromise) {
      console.log(`[Downloader] Fetching genres from public API for album ${albumId}...`)
      genrePromise = this.fetchAlbumGenres(albumId)
      this.genreCache.set(cacheKey, genrePromise)

      // Clean up cache after 2 minutes
      genrePromise.finally(() => {
        setTimeout(() => {
          this.genreCache.delete(cacheKey)
        }, 120000)
      })
    } else {
      console.log(`[Downloader] Using cached genres for album ${albumId}`)
    }

    const genres = await genrePromise

    // If public API returned genres, use them (they're reliable)
    if (genres.length > 0) {
      console.log(`[Downloader] Got ${genres.length} genre(s) from public API: ${genres.join(', ')}`)
      return genres
    }

    // Fall back to ID mapping only if public API returned nothing
    console.log(`[Downloader] Public API returned no genres, falling back to ID mapping`)
    return this.getGenresFromIdMapping(trackInfo)
  }

  /**
   * Fallback: Get genres from track info using ID mapping
   * Only used when public API fails or returns no data
   */
  private getGenresFromIdMapping(trackInfo: any): string[] {
    const genres: string[] = []

    // Check track-level genre ID (skip ID 0 which means "All")
    if (trackInfo.GENRE_ID && trackInfo.GENRE_ID !== 0 && trackInfo.GENRE_ID !== '0') {
      const genre = this.getGenreNameFromId(Number(trackInfo.GENRE_ID))
      if (genre) {
        console.log(`[Downloader] Fallback: Found genre from track GENRE_ID: ${genre} (ID: ${trackInfo.GENRE_ID})`)
        genres.push(genre)
      }
    }

    // Check album genre ID on track info (skip ID 0)
    if (trackInfo.ALB_GENRE_ID && trackInfo.ALB_GENRE_ID !== 0 && trackInfo.ALB_GENRE_ID !== '0') {
      const genre = this.getGenreNameFromId(Number(trackInfo.ALB_GENRE_ID))
      if (genre && !genres.includes(genre)) {
        console.log(`[Downloader] Fallback: Found genre from ALB_GENRE_ID: ${genre} (ID: ${trackInfo.ALB_GENRE_ID})`)
        genres.push(genre)
      }
    }

    if (genres.length > 0) {
      console.log(`[Downloader] Fallback: Returning ${genres.length} genre(s) from ID mapping: ${genres.join(', ')}`)
    } else {
      console.log(`[Downloader] Fallback: No genres found from ID mapping`)
    }

    return genres
  }

  /**
   * Fetch genres from album info via Deezer API
   * Returns an array of genre names (supports multiple genres)
   * Uses public API (api.deezer.com) as primary source since it reliably returns genre data
   */
  private async fetchAlbumGenres(albumId: string | number): Promise<string[]> {
    try {
      // First try the public Deezer API which reliably returns genre data
      const publicGenres = await this.fetchGenresFromPublicApi(albumId)
      if (publicGenres.length > 0) {
        console.log(`[Downloader] Got ${publicGenres.length} genre(s) from public API: ${publicGenres.join(', ')}`)
        return publicGenres
      }

      // Fallback to GW API
      const albumInfo = await deezerAuth.getAlbumInfo(albumId)
      console.log(`[Downloader] Album info for ${albumId} - GENRE_ID: ${albumInfo.GENRE_ID}, has GENRES: ${!!albumInfo.GENRES}`)

      const genres: string[] = []

      // Check for GENRES array first (contains genre objects with name) - this has multiple genres
      if (albumInfo.GENRES?.data && albumInfo.GENRES.data.length > 0) {
        console.log(`[Downloader] Album GENRES.data:`, JSON.stringify(albumInfo.GENRES.data))
        const genreNames = albumInfo.GENRES.data
          .map((g: any) => {
            // Skip genre ID 0 entries entirely (handle both string and number)
            const genreId = Number(g.id)
            if (genreId === 0 || isNaN(genreId)) return undefined
            // Prefer name directly from API if available and not "All", otherwise lookup by ID
            if (g.name && g.name.toLowerCase() !== 'all') {
              return g.name
            }
            return this.getGenreNameFromId(genreId)
          })
          // Filter out undefined, empty strings, and "All" (case-insensitive)
          .filter((n: string | undefined): n is string => {
            if (!n || n.trim() === '') return false
            if (n.toLowerCase() === 'all') return false
            return true
          })

        if (genreNames.length > 0) {
          console.log(`[Downloader] Got ${genreNames.length} genre(s) from album GENRES array: ${genreNames.join(', ')}`)
          return genreNames
        } else {
          console.log(`[Downloader] GENRES array filtered to empty - all entries were "All" or invalid`)
        }
      }

      // Fallback: Check for single GENRE_ID on album (skip ID 0 which means "All")
      const numericGenreId = Number(albumInfo.GENRE_ID)
      if (albumInfo.GENRE_ID && numericGenreId !== 0 && !isNaN(numericGenreId)) {
        const genre = this.getGenreNameFromId(numericGenreId)
        if (genre) {
          console.log(`[Downloader] Got genre from album GENRE_ID: ${genre} (ID: ${albumInfo.GENRE_ID})`)
          genres.push(genre)
        }
      }

      if (genres.length === 0) {
        console.log(`[Downloader] No genres found in album ${albumId}`)
      }
      return genres
    } catch (error: any) {
      console.error(`[Downloader] Failed to fetch album genres: ${error.message}`)
      return []
    }
  }

  /**
   * Fetch genres from the public Deezer API (api.deezer.com)
   * This API reliably returns genre information in the genres.data array
   */
  private fetchGenresFromPublicApi(albumId: string | number): Promise<string[]> {
    return new Promise((resolve) => {
      const url = `https://api.deezer.com/album/${albumId}`
      console.log(`[Downloader] Fetching genres from public API: ${url}`)

      https.get(url, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const albumData = JSON.parse(data)
            const genres: string[] = []

            // Public API returns genres in lowercase: genres.data[].name
            if (albumData.genres?.data && albumData.genres.data.length > 0) {
              for (const genre of albumData.genres.data) {
                if (genre.name && genre.name.toLowerCase() !== 'all') {
                  genres.push(genre.name)
                }
              }
            }

            resolve(genres)
          } catch (e) {
            console.error(`[Downloader] Failed to parse public API response:`, e)
            resolve([])
          }
        })
      }).on('error', (e) => {
        console.error(`[Downloader] Public API request failed:`, e.message)
        resolve([])
      })
    })
  }

  private async saveArtwork(albumPicture: string, outputDir: string, options: DownloadOptions): Promise<void> {
    try {
      const albumCoverSettings = options.metadataSettings?.albumCovers || {
        saveCovers: true,
        coverNameTemplate: 'cover',
        localArtworkSize: 1200,
        localArtworkFormat: 'jpeg' as LocalArtworkFormat,
        jpegImageQuality: 90  // Match original deemix quality
      }

      // Check if we should save covers
      if (!albumCoverSettings.saveCovers) {
        console.log('[Downloader] Skipping artwork save (disabled in settings)')
        return
      }

      const artworkSize = albumCoverSettings.localArtworkSize || 1200
      const coverName = albumCoverSettings.coverNameTemplate || 'cover'
      const quality = albumCoverSettings.jpegImageQuality || 90  // Match original deemix quality

      // Build artwork path
      const artworkPath = path.join(outputDir, `${coverName}.jpg`)

      // Don't overwrite existing artwork
      if (fs.existsSync(artworkPath)) {
        const stats = fs.statSync(artworkPath)
        if (stats.size > 0) {
          console.log(`[Downloader] Artwork already exists: ${artworkPath} (${stats.size} bytes)`)
          return
        }
        // Remove zero-byte file
        fs.unlinkSync(artworkPath)
      }

      // Deezer CDN only reliably serves JPEG
      const artworkUrl = `https://e-cdns-images.dzcdn.net/images/cover/${albumPicture}/${artworkSize}x${artworkSize}-000000-${quality}-0-0.jpg`

      console.log(`[Downloader] Downloading artwork: ${artworkUrl}`)
      const buffer = await this.downloadBuffer(artworkUrl)

      if (buffer.length > 0) {
        fs.writeFileSync(artworkPath, buffer)
        console.log(`[Downloader] Saved artwork: ${artworkPath} (${buffer.length} bytes)`)
      } else {
        console.error('[Downloader] Downloaded artwork is empty')
      }
    } catch (error) {
      console.error('[Downloader] Failed to save artwork:', error)
    }
  }

  private async saveArtistImage(artistPictureUrl: string, artistName: string, outputDir: string, options: DownloadOptions): Promise<void> {
    try {
      const albumCoverSettings = options.metadataSettings?.albumCovers || {
        saveArtistImage: false,
        localArtworkSize: 1200,
        localArtworkFormat: 'jpeg' as LocalArtworkFormat,
        jpegImageQuality: 90
      }

      // Check if we should save artist images
      if (!albumCoverSettings.saveArtistImage) {
        return
      }

      const artworkSize = albumCoverSettings.localArtworkSize || 1200
      const quality = albumCoverSettings.jpegImageQuality || 90

      // Build artist image path
      const sanitizedArtistName = this.sanitizeFilename(artistName || 'Unknown Artist')
      const artistImagePath = path.join(outputDir, `${sanitizedArtistName}.jpg`)

      // Don't overwrite existing artist image
      if (fs.existsSync(artistImagePath)) {
        const stats = fs.statSync(artistImagePath)
        if (stats.size > 0) {
          console.log(`[Downloader] Artist image already exists: ${artistImagePath}`)
          return
        }
        // Remove zero-byte file
        fs.unlinkSync(artistImagePath)
      }

      // The artist picture URL from Deezer public API is like:
      // https://api.deezer.com/artist/27/image or
      // https://e-cdns-images.dzcdn.net/images/artist/{hash}/1000x1000-000000-80-0-0.jpg
      // We need to transform it to get the desired size
      let artworkUrl = artistPictureUrl

      // If it's a CDN URL, modify the size and quality
      if (artistPictureUrl.includes('dzcdn.net/images/artist')) {
        // Extract the hash from URL like: /images/artist/{hash}/...
        const match = artistPictureUrl.match(/\/images\/artist\/([^/]+)\//)
        if (match) {
          const hash = match[1]
          artworkUrl = `https://e-cdns-images.dzcdn.net/images/artist/${hash}/${artworkSize}x${artworkSize}-000000-${quality}-0-0.jpg`
        }
      } else if (artistPictureUrl.includes('api.deezer.com/artist')) {
        // For API URLs, we need to follow the redirect or construct the CDN URL
        // The API URL format is: https://api.deezer.com/artist/{id}/image
        // We'll try to download directly and let the redirect handling work
        artworkUrl = artistPictureUrl
      }

      console.log(`[Downloader] Downloading artist image: ${artworkUrl}`)
      const buffer = await this.downloadBuffer(artworkUrl)

      if (buffer.length > 0) {
        fs.writeFileSync(artistImagePath, buffer)
        console.log(`[Downloader] Saved artist image: ${artistImagePath} (${buffer.length} bytes)`)
      } else {
        console.error('[Downloader] Downloaded artist image is empty')
      }
    } catch (error) {
      console.error('[Downloader] Failed to save artist image:', error)
    }
  }

  private async saveLyrics(trackInfo: any, outputDir: string): Promise<void> {
    try {
      if (!trackInfo.LYRICS?.LYRICS_TEXT && !trackInfo.LYRICS?.LYRICS_SYNC_JSON) {
        return
      }

      // Include VERSION in filename if present
      const lyricsBaseTitle = trackInfo.SNG_TITLE || 'Unknown'
      const lyricsVersion = trackInfo.VERSION
      const fullTitle = lyricsVersion ? `${lyricsBaseTitle} (${lyricsVersion})` : lyricsBaseTitle
      const baseName = this.sanitizeFilename(fullTitle)

      // Save plain lyrics
      if (trackInfo.LYRICS?.LYRICS_TEXT) {
        const lyricsPath = path.join(outputDir, `${baseName}.txt`)
        fs.writeFileSync(lyricsPath, trackInfo.LYRICS.LYRICS_TEXT)
      }

      // Save synced lyrics as LRC
      if (trackInfo.LYRICS?.LYRICS_SYNC_JSON) {
        const lrcPath = path.join(outputDir, `${baseName}.lrc`)
        const lrcContent = this.convertToLrc(trackInfo.LYRICS.LYRICS_SYNC_JSON, trackInfo)
        fs.writeFileSync(lrcPath, lrcContent)
      }
    } catch (error) {
      console.error('Failed to save lyrics:', error)
    }
  }

  private convertToLrc(syncedLyrics: any[], trackInfo: any): string {
    let lrc = ''

    // Add metadata - include VERSION in title if present
    const lrcBaseTitle = trackInfo.SNG_TITLE || 'Unknown'
    const lrcVersion = trackInfo.VERSION
    const lrcFullTitle = lrcVersion ? `${lrcBaseTitle} (${lrcVersion})` : lrcBaseTitle
    lrc += `[ti:${lrcFullTitle}]\n`
    lrc += `[ar:${trackInfo.ART_NAME || 'Unknown'}]\n`
    lrc += `[al:${trackInfo.ALB_TITLE || 'Unknown'}]\n`
    lrc += '\n'

    // Add synced lyrics
    for (const line of syncedLyrics) {
      if (line.milliseconds !== undefined && line.line) {
        const time = this.formatLrcTime(line.milliseconds)
        lrc += `[${time}]${line.line}\n`
      }
    }

    return lrc
  }

  private formatLrcTime(ms: number): string {
    const minutes = Math.floor(ms / 60000)
    const seconds = Math.floor((ms % 60000) / 1000)
    const centiseconds = Math.floor((ms % 1000) / 10)
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`
  }

  private async downloadBuffer(url: string, maxRedirects = 5): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const makeRequest = (requestUrl: string, redirectCount: number) => {
        if (redirectCount > maxRedirects) {
          reject(new Error('Too many redirects'))
          return
        }

        https.get(requestUrl, (response) => {
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
            const redirectUrl = response.headers.location
            if (redirectUrl) {
              console.log(`[Downloader] Following redirect to: ${redirectUrl.substring(0, 60)}...`)
              // Handle relative URLs
              const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, requestUrl).toString()
              makeRequest(fullUrl, redirectCount + 1)
              return
            }
          }

          // Check for successful response
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}: Failed to download`))
            return
          }

          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => {
            const buffer = Buffer.concat(chunks)
            if (buffer.length === 0) {
              reject(new Error('Downloaded empty buffer'))
            } else {
              console.log(`[Downloader] Downloaded ${buffer.length} bytes`)
              resolve(buffer)
            }
          })
          response.on('error', reject)
        }).on('error', reject)
      }

      makeRequest(url, 0)
    })
  }

  /**
   * Get cached artwork buffer for an album, downloading if not cached.
   * This follows the original deemix pattern of caching artwork per album
   * to avoid re-downloading the same cover for each track.
   */
  private async getCachedArtwork(albumPictureHash: string, size: number, quality: number): Promise<Buffer> {
    const cacheKey = `${albumPictureHash}_${size}_${quality}`

    // Check if we already have a download in progress or completed
    let artworkPromise = this.artworkCache.get(cacheKey)

    if (!artworkPromise) {
      console.log(`[Downloader] Artwork cache miss for ${cacheKey}, downloading...`)
      // Start download and cache the promise
      const artworkUrl = `https://e-cdns-images.dzcdn.net/images/cover/${albumPictureHash}/${size}x${size}-000000-${quality}-0-0.jpg`
      artworkPromise = this.downloadBuffer(artworkUrl)
      this.artworkCache.set(cacheKey, artworkPromise)

      // Clean up cache entry after some time to prevent memory growth
      artworkPromise.then(() => {
        setTimeout(() => {
          this.artworkCache.delete(cacheKey)
          console.log(`[Downloader] Cleaned up artwork cache: ${cacheKey}`)
        }, 60000) // Keep in cache for 1 minute
      }).catch(() => {
        // Clean up failed downloads immediately
        this.artworkCache.delete(cacheKey)
      })
    } else {
      console.log(`[Downloader] Artwork cache hit for ${cacheKey}`)
    }

    return artworkPromise
  }

  getProgress(downloadId: string): DownloadProgress | undefined {
    return this.activeDownloads.get(downloadId)
  }

  getAllProgress(): DownloadProgress[] {
    return Array.from(this.activeDownloads.values())
  }

  cancelDownload(downloadId: string): void {
    // Remove from queue if pending
    const queueIndex = this.downloadQueue.findIndex(d => d.id === downloadId)
    if (queueIndex !== -1) {
      this.downloadQueue.splice(queueIndex, 1)
    }

    // Update status
    const progress = this.activeDownloads.get(downloadId)
    if (progress) {
      progress.status = 'error'
      progress.error = 'Cancelled'
      this.emit('cancelled', progress)
    }
  }

  setMaxConcurrent(max: number): void {
    // Clamp between 1 and 50
    this.maxConcurrent = Math.max(1, Math.min(50, max))
    console.log(`[Downloader] Max concurrent downloads set to: ${this.maxConcurrent}`)
    // Try to process more if we now have capacity
    this.processQueue()
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent
  }

  /**
   * Register a playlist for automatic M3U generation from real file paths.
   * As tracks complete, their actual paths are collected. When all tracks
   * are done, the M3U is generated with paths that match the files on disk.
   */
  registerPlaylistForM3U(playlistName: string, outputDir: string, totalTracks: number): void {
    this.playlistM3UTracker.set(playlistName, {
      outputDir,
      totalTracks,
      processedCount: 0,
      completedEntries: []
    })
    console.log(`[Downloader] Registered playlist "${playlistName}" for M3U (${totalTracks} tracks)`)
  }

  /**
   * Record a completed track for M3U generation. Called internally when a
   * playlist track finishes downloading. When all tracks are recorded,
   * automatically generates the M3U file.
   */
  /**
   * Record a failed/skipped track so the M3U still generates when
   * some tracks are unavailable (geo-restricted, etc.)
   */
  private recordM3UFailure(playlistName: string): void {
    const tracker = this.playlistM3UTracker.get(playlistName)
    if (!tracker) return
    tracker.processedCount++
    this.checkM3UComplete(playlistName)
  }

  private recordM3UEntry(playlistName: string, entry: {
    position: number
    duration: number
    artist: string
    title: string
    absolutePath: string
  }): void {
    const tracker = this.playlistM3UTracker.get(playlistName)
    if (!tracker) return

    tracker.completedEntries.push(entry)
    tracker.processedCount++
    this.checkM3UComplete(playlistName)
  }

  private checkM3UComplete(playlistName: string): void {
    const tracker = this.playlistM3UTracker.get(playlistName)
    if (!tracker) return

    // Generate M3U when all tracks are processed (success + failure)
    if (tracker.processedCount >= tracker.totalTracks) {
      try {
        // Sort by playlist position to maintain order
        tracker.completedEntries.sort((a, b) => a.position - b.position)

        // Convert absolute paths to relative paths from the output directory
        const tracks = tracker.completedEntries.map(e => {
          let relativePath = e.absolutePath
          if (relativePath.startsWith(tracker.outputDir)) {
            relativePath = relativePath.slice(tracker.outputDir.length)
            // Remove leading slash/backslash
            relativePath = relativePath.replace(/^[/\\]/, '')
          }
          return {
            duration: e.duration,
            artist: e.artist,
            title: e.title,
            relativePath
          }
        })

        this.generateM3U(playlistName, tracker.outputDir, tracks)
      } catch (err: any) {
        console.error(`[Downloader] Auto M3U generation failed for "${playlistName}":`, err.message)
      } finally {
        this.playlistM3UTracker.delete(playlistName)
      }
    }
  }

  /**
   * Generate an M3U8 playlist file
   * @param playlistName Name of the playlist (used for filename)
   * @param outputDir Directory where the M3U file will be saved
   * @param tracks Array of track entries with relative paths
   */
  generateM3U(
    playlistName: string,
    outputDir: string,
    tracks: Array<{
      duration: number
      artist: string
      title: string
      relativePath: string
    }>
  ): string {
    try {
      const sanitizedName = this.sanitizeFilename(playlistName)
      const m3uPath = path.join(outputDir, `${sanitizedName}.m3u8`)

      // Build M3U content
      let content = '#EXTM3U\n'
      content += `#PLAYLIST:${playlistName}\n\n`

      for (const track of tracks) {
        // EXTINF format: #EXTINF:duration,Artist - Title
        const duration = Math.round(track.duration)
        content += `#EXTINF:${duration},${track.artist} - ${track.title}\n`
        content += `${track.relativePath}\n`
      }

      // Write the file
      fs.writeFileSync(m3uPath, content, 'utf8')
      console.log(`[Downloader] Generated M3U playlist: ${m3uPath}`)

      return m3uPath
    } catch (error: any) {
      console.error('[Downloader] Failed to generate M3U:', error.message)
      throw error
    }
  }
}

export const downloader = new Downloader()
