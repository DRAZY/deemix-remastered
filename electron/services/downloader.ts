import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as crypto from 'crypto'
import { Blowfish } from 'egoroof-blowfish'
import { deezerAuth } from './deezerAuth'
import { applyMergeFromMeta, replayGainString, type ResolvedMeta, type RetagFields } from './retagger'
import { libraryIndex } from './libraryIndex'
import { qobuzAuth } from './qobuzAuth'
import { downloadQobuzTrack } from './qobuzDownloader'
import { probeAudioFile, expectedContainer, isLowerTier } from './audioProbe'

/** Collapse newlines so remote-supplied text cannot forge extra log lines. */
const logSafe = (v: unknown): string => String(v ?? '').replace(/[\r\n]+/g, ' ')

export interface FolderSettings {
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
  releaseType: boolean
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

export type ArtistSeparator = 'standard' | 'comma' | 'slash' | 'semicolon' | 'semicolonSpace' | 'ampersand'
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
  service?: 'deezer' | 'qobuz'  // download backend; defaults to deezer
  qobuzMeta?: any               // listing-supplied track metadata (#112) — skips the per-track track/get when complete
  prefetchedCover?: Buffer      // pre-fetched cover art (e.g. Qobuz URL), used instead of the Deezer-hash CDN fetch
  quality: 'MP3_128' | 'MP3_320' | 'FLAC'
  bitrateFallback?: boolean  // Whether to fallback to lower bitrates if preferred unavailable
  isrcFallback?: boolean     // Whether an unavailable track may resolve to an alternate version: Deezer's FALLBACK pointer or an ISRC-matched release (either may be a different master). Off = the exact track or nothing.
  createFolders: boolean
  artistFolder: boolean
  albumFolder: boolean
  saveArtwork: boolean
  embedArtwork: boolean
  saveLyrics: boolean
  syncedLyrics?: boolean
  // When true, the plain .txt is skipped for any track that also produced an
  // .lrc, so a track with synced lyrics leaves one file instead of two (#141).
  preferSyncedLyrics?: boolean
  // With preferSyncedLyrics on, also remove a .txt written by an earlier run
  // once this run writes the .lrc for the same track (#141). Opt-in: the app
  // deleting a file it wrote before is fine except when someone edited it.
  deleteSupersededLyrics?: boolean
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
  // Authoritative track position from the album tracklist (public API
  // track_position). Backstop for FALLBACK/ISRC substitution: when the
  // requested track's GW record lacks TRACK_NUMBER, this keeps the file from
  // inheriting the substituted release's numbering (#102/#103).
  trackNumber?: number
  playlistPosition?: number
  // Playlist context - for compilation handling
  playlistContext?: {
    playlistId: string | number
    playlistName: string
  }
  playlistOwner?: string
  playlistCoverUrl?: string  // Full URL for playlist cover image
  savePlaylistAsCompilation?: boolean
  // Album context - used to keep all album tracks in same folder
  albumContext?: {
    albumId: number | string
    albumTitle: string
    albumArtist: string
    artistPicture?: string   // Artist picture URL for saving artist image
    totalDiscs?: number      // Total number of discs in the album
    totalTracks?: number     // Total tracks in the album — Track Total tag (#107)
    explicitLyrics?: boolean // Album-level explicit flag for consistent folder naming
    isCompilation?: boolean  // Whether album is a compilation (Deezer record_type "compile")
    recordType?: string      // Deezer record_type (album/single/ep/compile) — drives the RELEASETYPE tag (#82)
    upc?: string             // Album UPC/barcode — drives %barcode% / %upc% template substitution
    label?: string           // Album record label — public API only; trackInfo.LABEL_NAME is empty on private-API fetches
  }
  // Error logging
  createErrorLog?: boolean
  // Overwrite behavior: 'no' = skip existing, 'overwrite' = replace, 'rename' = add suffix,
  // 'refresh-tags' = don't download; if the file already exists, merge-rewrite its tags only
  overwriteMode?: 'no' | 'overwrite' | 'rename' | 'refresh-tags'
  // Opt-in library de-dup: skip downloading a recording (by ISRC) we already have
  // elsewhere in the library. Off unless the user enables it. Tracks with no ISRC
  // are never deduped. See libraryIndex.ts.
  skipDuplicateTracks?: boolean
  // Pre-resolved album info (set by processDownload before buildOutputPath)
  _resolvedAlbumExplicit?: boolean
  _resolvedAlbumArtist?: string        // Album-level artist from public API (for consistent folder naming)
  _resolvedAlbumIsCompilation?: boolean // Whether the album is a compilation (record_type === 'compile')
  _resolvedAlbumRecordType?: string    // Album record_type from public API — drives the RELEASETYPE tag for single-track downloads (#82)
  _resolvedAlbumUpc?: string           // Album UPC from public API — falls through to trackInfo.ALB_UPC (which is always empty for private-API track fetches)
  _resolvedAlbumLabel?: string         // Album label from public API — falls through to trackInfo.LABEL_NAME (empty on private-API fetches)
  // M3U tracker ID — unique key for the playlist M3U tracker (avoids name collisions)
  _m3uTrackerId?: string
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
  // Which service this track is being pulled from — drives the per-track D/Q
  // source chip, and lets mixed-source (Link Analyzer "both") rows show each
  // track's real origin.
  source?: 'deezer' | 'qobuz'
  progress: number
  speed: number
  downloaded: number
  total: number
  status: 'pending' | 'downloading' | 'decrypting' | 'tagging' | 'completed' | 'error'
  // Track info for error logging and display
  trackTitle?: string
  trackArtist?: string
  albumTitle?: string
  path?: string  // Final file path — set on every completion INCLUDING skips, so queue
                 // polling (/api/queue) sees it; the renderer derives the folder for
                 // "Open folder" and delete-files from this when albumFolder is absent
  albumFolder?: string  // Folder path for error log file (may include CD subfolder)
  albumRootFolder?: string  // Root album folder path (excludes CD subfolders) - used for deletion
  playlistFolder?: string  // Playlist root folder path - used for deletion of entire playlist
  actualFormat?: string  // Actual downloaded format (may differ from requested due to fallback)
  substituted?: boolean  // True when the exact track was unavailable and an ISRC/FALLBACK alternative (possibly a different master) was downloaded
  // Only meaningful when substituted. true = the alternate carries the same ISRC
  // as the requested track (same recording, other release); false = a different
  // ISRC, i.e. a different recording or master; undefined = either side had no
  // ISRC, so the app cannot say.
  substitutedSameRecording?: boolean
  error?: string
  errorDetails?: DownloadErrorDetails  // Enhanced error information
  skippedAsDuplicate?: boolean  // Completed by being skipped as a library duplicate (by ISRC)
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
  private maxConcurrent = 5
  private currentDownloads = 0
  // Queue pause state - when paused, no new downloads start AND in-flight downloads
  // are aborted and re-queued so they resume from the queue (true mid-download pause).
  private _isPaused = false
  // Abort handles for in-flight CDN fetches, keyed by downloadId — lets pauseQueue
  // actually stop a download mid-stream. Populated in downloadFromUrl, cleared in
  // processDownload's finally.
  private downloadAborts: Map<string, AbortController> = new Map()
  // Downloads that were aborted specifically by a pause (so their catch re-queues
  // them for resume instead of marking them failed).
  private pausedDownloadIds: Set<string> = new Set()
  // Marks in-flight downloads killed by cancelDownload (#118) so the abort
  // catch exits quietly (no error event, no errors.txt, no resume re-queue) —
  // distinguishing user cancel from pause and from real failures.
  private cancelledDownloadIds: Set<string> = new Set()
  // Download pacing (issue #86): a tiered opt-in. 'off' (default) is a true no-op —
  // the gate is fully bypassed and the queue drains exactly as it always has.
  // 'balanced'/'cautious' space out the rate of NEW download starts with a jittered
  // delay, so a large discography doesn't hit Deezer as one detectable burst.
  private downloadPacing: 'off' | 'balanced' | 'cautious' = 'off'
  private lastDownloadStartAt = 0
  // Serializes the jittered pacing wait across concurrent download workers, so even
  // with maxConcurrent > 1 the actual CDN fetches start one-jittered-gap apart.
  private pacingChain: Promise<void> = Promise.resolve()
  // Base gap between download starts per tier (ms). The actual gap is jittered
  // ±50% around this base so the cadence isn't a fixed, machine-like interval.
  private readonly PACING_BASE_MS: Record<'balanced' | 'cautious', number> = {
    balanced: 2500,  // ~15-30 starts/min — calms bursts, still reasonably quick
    cautious: 7000   // ~6-12 starts/min — closest to natural listening cadence
  }
  // Artwork cache: stores downloaded artwork buffers keyed by album picture hash
  // This prevents re-downloading the same cover for each track in an album
  private artworkCache: Map<string, Promise<Buffer>> = new Map()
  // Genre cache: stores album genre lookups to avoid redundant API calls (now supports multiple genres)
  private genreCache: Map<string, Promise<string[]>> = new Map()
  // Progress throttling: track last emit time per download to reduce event frequency
  private lastProgressEmit: Map<string, number> = new Map()
  private readonly PROGRESS_THROTTLE_MS = 250 // Emit progress at most every 250ms
  // Album info cache: stores album-level metadata per album ID
  // Fetched from public API once per unique album, prevents duplicate lookups
  // Used for explicit status, album artist (for consistent folder naming), and compilation detection
  private albumInfoCache: Map<string, Promise<{ explicit: boolean, artist: string, isCompilation: boolean, recordType: string, upc: string, label: string }>> = new Map()
  // Reserved paths: tracks output paths currently being used by in-progress downloads
  // This prevents concurrent downloads from overwriting each other's files
  private reservedPaths: Set<string> = new Set()
  // Playlist folders that already had their cover artwork saved (avoid saving per-track)
  private playlistCoverSaved: Set<string> = new Set()
  // Cover paths claimed by a playlist. savePlaylistCover has to fetch its image
  // over HTTP first, while per-track album art is written from a buffer already
  // in memory, so a finished track would otherwise land its album cover at
  // cover.jpg and the playlist cover would find a non-empty file and give up.
  // A playlist folder is not an album, so its cover belongs to the playlist.
  private playlistCoverPaths: Set<string> = new Set()
  // Playlist M3U tracker: collects actual file paths as tracks complete
  // so M3U can be generated from real paths instead of reconstructed guesses
  private playlistM3UTracker: Map<string, {
    outputDir: string
    // What this tracker is generating for. Albums legitimately write their .m3u8
    // into the album folder (#121); playlists must NOT inherit that fallback —
    // doing so put the playlist M3U inside the first track's album folder
    // whenever playlist folders were off (#138). See recordM3UEntry.
    kind: 'album' | 'playlist'
    // The playlist's own folder, captured from the first track that carries it
    // (set only when createPlaylistFolder is on). The M3U is written here — next
    // to the music — instead of the download root, and its relative paths are
    // computed against it (#121). Undefined → falls back to outputDir (root),
    // which is correct when playlist folders are off.
    resolvedPlaylistFolder?: string
    totalTracks: number
    processedCount: number
    m3uNameTemplate: string
    playlistName: string
    lastActivity: number  // timestamp of last entry/failure record
    activityTimer: ReturnType<typeof setTimeout> | null
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
      // Actually stop in-flight downloads mid-stream. Each aborted download is
      // re-queued for resume by its own catch in processDownload, so resuming
      // restarts it. Without this, pause only blocked NEW downloads while the
      // active track streamed to completion.
      const inFlight = Array.from(this.downloadAborts.entries())
      for (const [id, controller] of inFlight) {
        this.pausedDownloadIds.add(id)
        try { controller.abort() } catch (e) {}
      }
      if (inFlight.length) console.log(`[Downloader] Paused — aborted ${inFlight.length} in-flight download(s) for resume`)
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
      // errors.txt is one record per line and the title, artist and error text
      // all come from the remote service, so a newline inside any of them would
      // forge extra records in a file the user (and future tooling) reads back.
      const errorLine = `${logSafe(trackId)} | ${logSafe(trackArtist)} - ${logSafe(trackTitle)} | ${logSafe(errorMessage)}\n`

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
   * Map Deezer's record_type to the MusicBrainz RELEASETYPE value that Navidrome
   * (and Picard) expect, so libraries can separate albums/singles/EPs (#82).
   * Returns '' for unknown/missing types so we never write a junk tag.
   * NOTE: Deezer's type is imperfect — EPs are frequently labelled "single" or
   * "album" upstream, so EP detection is best-effort, not authoritative.
   */
  private mapReleaseType(recordType?: string): string {
    switch ((recordType || '').toLowerCase()) {
      case 'album': return 'Album'
      case 'single': return 'Single'
      case 'ep': return 'EP'
      case 'compile': return 'Compilation'
      default: return ''
    }
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
      // Record as processed for M3U tracking — this track won't go through processDownload
      if (options._m3uTrackerId) {
        this.recordM3UFailure(options._m3uTrackerId || options.playlistName || "")
      }
      return existingDownload.id
    }

    const downloadId = `dl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    console.log(`[Downloader] Creating download ${downloadId} for track ${options.trackId}`)

    const progress: DownloadProgress = {
      id: downloadId,
      trackId: options.trackId,
      source: options.service === 'qobuz' ? 'qobuz' : 'deezer',
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

    // Download pacing (issue #86) is NOT applied here. It used to gate every queue
    // start, which made already-downloaded files wait the full jittered delay before
    // being skipped (issue #88) — even though a skip makes no Deezer request. Pacing
    // now happens inside processDownload, AFTER the skip check and right before the
    // actual CDN fetch (see awaitPacingSlot), so skips stay instant and only real
    // audio downloads are paced.

    const next = this.downloadQueue.shift()
    if (!next) {
      console.log('[Downloader] processQueue: queue is empty')
      return
    }

    console.log(`[Downloader] processQueue: starting download ${next.id}`)
    this.currentDownloads++
    this.processDownload(next.id, next.options)
      .catch(error => {
        console.error(`[Downloader] processDownload error for ${logSafe(next.id)}:`, logSafe(error.message))
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
          if (next.options._m3uTrackerId) {
            this.recordM3UFailure(next.options._m3uTrackerId || next.options.playlistName || "")
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
        // Never below zero: clearAll() resets the counter to 0 while aborted
        // in-flight downloads are still unwinding toward this decrement.
        this.currentDownloads = Math.max(0, this.currentDownloads - 1)
        this.processQueue()
      })

    // Continue processing if we have capacity
    if (this.currentDownloads < this.maxConcurrent) {
      this.processQueue()
    }
  }

  /**
   * Qobuz download path — flows through the same queue/events as Deezer so it
   * shows in the Transfer Rack with live progress, but skips the entire Deezer
   * metadata/URL/decrypt pipeline: getFileUrl returns a plain file we stream to
   * disk (see qobuzDownloader.ts). Naming is a sanitized "Artist - Title" for now
   * (folder-template parity is a later slice).
   */
  private async processQobuzDownload(
    downloadId: string,
    options: DownloadOptions,
    progress: DownloadProgress
  ): Promise<void> {
    progress.status = 'downloading'
    this.emit('start', progress)
    // Same lifecycle guarantees as the Deezer path: the reservation is always
    // released and the abort controller is registered so pause/cancel can kill
    // the in-flight stream instead of letting it run to completion.
    let reservedPathForCleanup: string | null = null
    const abortController = new AbortController()
    this.downloadAborts.set(downloadId, abortController)
    try {
      // #112: album/playlist queues pass the listing's track metadata through —
      // skip the per-track track/get round-trip when it carries the essentials
      // the shim needs; anything short falls back to the live fetch. 'isrc' is
      // checked for PRESENCE (some tracks legitimately have isrc: null; an
      // absent field means the listing shape can't be trusted for tagging).
      const cached = options.qobuzMeta
      const cachedUsable = !!(cached && cached.id && cached.title &&
        (cached.performer?.name || cached.album?.artist?.name) &&
        cached.album?.title && cached.album?.image && 'isrc' in cached)
      const meta = cachedUsable ? cached : await qobuzAuth.getTrack(options.trackId)
      const artist = meta?.performer?.name || meta?.album?.artist?.name || 'Unknown Artist'
      const title = meta?.title || `track-${options.trackId}`
      progress.trackTitle = title
      progress.trackArtist = artist
      this.emit('progress', progress)

      const q = options.quality === 'FLAC' ? 'flac' : options.quality === 'MP3_128' ? '128' : '320'
      const shim = this.qobuzMetaToTrackInfo(meta)

      // M3U bookkeeping for playlist tracks — records the real on-disk path so
      // the generated playlist file matches disk exactly (Deezer parity).
      const recordM3U = (absolutePath: string) => {
        if (options._m3uTrackerId) {
          this.recordM3UEntry(options._m3uTrackerId || options.playlistName || '', {
            position: options.playlistPosition || 0,
            duration: shim.DURATION || 0,
            artist: shim.ART_NAME || 'Unknown Artist',
            title: progress.trackTitle || shim.SNG_TITLE || 'Unknown Track',
            absolutePath,
            playlistFolder: progress.playlistFolder,
            albumFolder: progress.albumRootFolder || progress.albumFolder
          })
        }
      }

      // Duplicate skip by ISRC — same discipline as the Deezer path: runs before
      // any network fetch so skips stay instant.
      if (options.skipDuplicateTracks && shim.ISRC) {
        await libraryIndex.ensureLoaded()
        const existingPath = libraryIndex.findExisting(shim.ISRC)
        if (existingPath) {
          console.log(`[Downloader] Skipping Qobuz duplicate (ISRC ${shim.ISRC} already in library): ${existingPath}`)
          progress.status = 'completed'
          progress.progress = 100
          progress.skippedAsDuplicate = true
          recordM3U(existingPath)
          this.emit('progress', progress)
          progress.path = existingPath
          this.emit('complete', { ...progress })
          return
        }
      }

      // Disc context from the real Qobuz metadata — buildOutputPath only creates
      // CD subfolders when options carry discNumber + totalDiscs, which the
      // Qobuz options never did: multi-disc albums flattened into one folder
      // with colliding track numbers. Same fields the Deezer album path passes.
      const totalDiscs = shim.DISKS_COUNT || 1
      options = {
        ...options,
        discNumber: shim.DISK_NUMBER || undefined,
        albumContext: { ...(options.albumContext || {}), totalDiscs }
      }

      // Build the path from the user's folder-structure + track-naming templates
      // (reuses the Deezer path builder via the Qobuz→trackInfo shim), then honor
      // the overwrite mode ('no' → skip when the file already exists).
      const initialOutputPath = this.buildOutputPath(shim, options, options.quality)
      // Qobuz negotiates the tier during the fetch, so the requested quality is
      // the best expectation available at skip time — which is the right basis
      // anyway: "you asked for 320 and this file is 128" is what should override
      // the skip.
      const outputPath = this.reserveOutputPath(initialOutputPath, options.trackId, options.overwriteMode, options.quality)
      if (outputPath === null) {
        progress.status = 'completed'
        progress.progress = 100
        recordM3U(initialOutputPath)
        // The file already exists on disk — make sure the index knows it
        // (mirrors the Deezer locate-existing path).
        libraryIndex.add(shim.ISRC, initialOutputPath)
        this.emit('progress', progress)
        progress.path = initialOutputPath
        this.emit('complete', { ...progress })
        return
      }
      reservedPathForCleanup = outputPath
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })

      // Pace the actual CDN fetch (issue #86) — past the skip checks so existing
      // files never wait; no-op when pacing is 'off'. Same gate as Deezer.
      await this.awaitPacingSlot()

      // Folder context on the progress object — same fields the Deezer path sets.
      // The renderer derives item.path from these for "open folder" and Delete
      // Files on album/playlist rows; without them Qobuz rows couldn't delete
      // their folders.
      const trackDir = path.dirname(outputPath)
      progress.albumFolder = trackDir
      // The deletable/openable root steps above the CD subfolder ONLY when
      // buildOutputPath actually created one — mirror its exact condition
      // (createCDFolder && discNumber && totalDiscs > 1, never for playlist
      // tracks). Guessing from disc count alone once pointed album rows at the
      // download ROOT when a multi-disc album didn't get a CD folder.
      const hasCDFolder = options.folderSettings?.createCDFolder && options.discNumber && totalDiscs > 1 && !options.isFromPlaylist
      progress.albumRootFolder = hasCDFolder ? path.dirname(trackDir) : trackDir
      if (options.isFromPlaylist && options.playlistName && options.folderSettings?.createPlaylistFolder) {
        const playlistFolder = this.sanitizeFilename(
          (options.folderSettings.playlistFolderTemplate || '%playlist%')
            .replace(/%playlist%/gi, options.playlistName)
            .replace(/%owner%/gi, options.playlistOwner || '')
        )
        progress.playlistFolder = path.join(options.outputPath, playlistFolder)
      }

      // Speed feeds the throughput meters (title bar, sidebar sparkline, rack
      // aggregation) — same computation and throttled emit as the Deezer path.
      const dlStartTime = Date.now()
      const result = await downloadQobuzTrack(options.trackId, q as '128' | '320' | 'flac', outputPath, (recv, total) => {
        progress.downloaded = recv
        progress.total = total
        progress.progress = total ? Math.floor((recv / total) * 100) : 0
        progress.speed = recv / ((Date.now() - dlStartTime) / 1000)
        this.emitProgressThrottled(progress)
      }, options.bitrateFallback !== false, abortController.signal)
      progress.speed = 0

      // The delivered format is authoritative — a FLAC request on a lossy-only
      // plan legitimately comes back MP3 (with the extension already corrected).
      // A tier step-down (killed hi-res stream → lower lossless tier) shows the
      // delivered tier on the chip (e.g. 'FLAC 24/96') so the substitution is
      // never silent.
      const gotFlac = result.path.toLowerCase().endsWith('.flac')
      // Qobuz is the hi-res service — the delivered tier IS the product, so
      // every Qobuz FLAC chip shows it (e.g. 'FLAC 24/192', 'FLAC 16/44.1'),
      // not just step-downs. Delivery facts come straight from getFileUrl.
      //
      // The lossy branch used to assert MP3_320 outright, since that is the only
      // lossy tier Qobuz sells. Read it off the bitstream instead: an assumption
      // that happens to be true is still the thing that hides it becoming false.
      const qobuzProbe = gotFlac ? null : probeAudioFile(result.path)
      progress.actualFormat = gotFlac
        ? (result.bitDepth && result.samplingRate
            ? `FLAC ${result.bitDepth}/${result.samplingRate}`
            : 'FLAC')
        : (qobuzProbe && qobuzProbe.tier !== 'MP3_OTHER' ? qobuzProbe.tier : 'MP3_320')

      // Qobuz files arrive untagged — tag them from the API metadata by reusing
      // the Deezer tagger via a Deezer-shaped shim + a pre-fetched cover buffer.
      progress.status = 'tagging'
      this.emit('progress', progress)
      let cover: Buffer | undefined
      if (options.embedArtwork || options.saveArtwork) {
        const baseUrl = meta?.album?.image?.large || meta?.album?.image?.small
        if (baseUrl) {
          // Honor the artwork-size settings: Qobuz's `large` is fixed 600px, but
          // the CDN serves an original-size `_org` variant — use it when the
          // configured embedded/local artwork size wants more than 600px.
          const covers = options.metadataSettings?.albumCovers
          const wantedSize = Math.max(
            options.embedArtwork ? (covers?.embeddedArtworkSize || 0) : 0,
            options.saveArtwork ? (covers?.localArtworkSize || 0) : 0
          )
          const candidates = wantedSize > 600 && /_600(\.\w+)$/.test(baseUrl)
            ? [baseUrl.replace(/_600(\.\w+)$/, '_org$1'), baseUrl]
            : [baseUrl]
          // Cached per album (same promise-based cache as the Deezer path):
          // without this every TRACK re-downloaded the album's cover — at
          // >600px settings that's the multi-MB _org scan once per track, a
          // major share of Qobuz's per-track overhead on album/playlist runs.
          cover = await this.getCachedQobuzArtwork(candidates)
        }
      }
      try {
        const tagOptions = { ...options, prefetchedCover: options.embedArtwork ? cover : undefined }
        if (gotFlac) await this.tagFlacFile(result.path, shim, tagOptions)
        else await this.tagFile(result.path, shim, tagOptions)
      } catch (tagErr: any) {
        console.error(`[Downloader] Qobuz tagging error (file kept):`, tagErr.message)
      }

      // Separate cover file (cover.jpg) — honors the same albumCovers settings as
      // the Deezer path (saveCovers toggle, name template, never overwrites).
      if (options.saveArtwork && cover) {
        try {
          await this.saveArtworkBuffer(cover, path.dirname(result.path), options)
        } catch (artErr: any) {
          console.error('[Downloader] Qobuz artwork save error (non-fatal):', artErr.message)
        }
      }

      progress.status = 'completed'
      progress.progress = 100
      recordM3U(result.path)
      // Record this recording in the library index (by ISRC) so future
      // downloads — from either service — de-dup against it. Deezer
      // completions have always done this; Qobuz ones were invisible to the
      // skip check until a manual library rescan. No-op without an ISRC.
      libraryIndex.add(shim.ISRC, result.path)
      progress.path = result.path
      this.emit('complete', { ...progress })
    } catch (error: any) {
      // Aborted by cancel (#118): downloadQobuzTrack already removed the
      // partial file; status is error/'Cancelled'. Exit without the error
      // event / errors.txt (M3U failure bookkeeping still runs below so a
      // partially-cancelled playlist's tracker completes and generates).
      if (this.cancelledDownloadIds.delete(downloadId)) {
        console.log(`[Downloader] Qobuz download ${downloadId} cancelled mid-stream`)
        if (options._m3uTrackerId) {
          this.recordM3UFailure(options._m3uTrackerId || options.playlistName || '')
        }
        return
      }
      console.error(`[Downloader] Qobuz download error for ${downloadId}:`, error.message)
      progress.status = 'error'
      progress.error = error.message
      this.emit('error', progress)
      // This catch swallows the error (the queue wrapper's error path never
      // runs for Qobuz), so mirror its bookkeeping here: keep the M3U tracker
      // counting so the playlist file still generates, and write errors.txt.
      if (options._m3uTrackerId) {
        this.recordM3UFailure(options._m3uTrackerId || options.playlistName || '')
      }
      if (options.createErrorLog && progress.albumFolder) {
        this.writeErrorLog(
          progress.albumFolder,
          progress.trackId,
          progress.trackTitle || 'Unknown Track',
          progress.trackArtist || 'Unknown Artist',
          error.message
        )
      }
    } finally {
      this.downloadAborts.delete(downloadId)
      if (reservedPathForCleanup) this.releaseOutputPath(reservedPathForCleanup)
      // Cancel marker consumed by the catch on abort; clear any leftover from
      // a cancel that landed after the network phase (too late to stop).
      this.cancelledDownloadIds.delete(downloadId)
    }
    // NOTE: concurrency (currentDownloads--) and queue re-processing are handled
    // by the processQueue() wrapper's .finally(); do not touch them here.
  }

  /** Map Qobuz track metadata into the Deezer-shaped trackInfo the tagger reads. */
  private qobuzMetaToTrackInfo(meta: any): any {
    const album = meta?.album || {}
    const date = album.release_date_original || album.released_at || ''
    return {
      SNG_ID: meta?.id,
      SNG_TITLE: meta?.title || '',
      VERSION: meta?.version || '',
      ART_NAME: meta?.performer?.name || album?.artist?.name || 'Unknown Artist',
      ALB_TITLE: album.title || '',
      ALB_ART_NAME: album?.artist?.name || '',
      ALB_UPC: album.upc || '',
      LABEL_NAME: album?.label?.name || '',
      COPYRIGHT: meta?.copyright || '',
      ISRC: meta?.isrc || '',
      TRACK_NUMBER: meta?.track_number || undefined,
      TRACKS_COUNT: album.tracks_count || undefined,
      DISK_NUMBER: meta?.media_number || 1,
      DISKS_COUNT: album.media_count || 1,
      DURATION: meta?.duration || 0,
      EXPLICIT_LYRICS: meta?.parental_warning ? 1 : 0,
      EXPLICIT_ALBUM_CONTENT: { EXPLICIT_LYRICS_STATUS: album?.parental_warning ? 1 : 0 },
      PHYSICAL_RELEASE_DATE: date,
      // Direct genre name from Qobuz metadata — the Deezer genre path resolves
      // via Deezer album-id lookup / genre-id maps, neither of which exists for
      // Qobuz. getGenresForTrack and the %genre% folder token read this first.
      _directGenres: album?.genre?.name ? [album.genre.name] : [],
      // Contributor shape the tagger's composer/multi-artist paths consume.
      SNG_CONTRIBUTORS: {
        main_artist: [meta?.performer?.name || album?.artist?.name].filter(Boolean),
        mainartist: [meta?.performer?.name || album?.artist?.name].filter(Boolean),
        composer: meta?.composer?.name ? [meta.composer.name] : [],
        featartist: [],
      },
      ARTISTS: Array.isArray(album?.artists)
        ? album.artists.map((a: any) => ({ ART_NAME: a?.name })).filter((a: any) => a.ART_NAME)
        : undefined,
      // No ALB_PICTURE (Deezer hash) — cover comes via options.prefetchedCover.
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

    // Qobuz downloads use a completely separate, decryption-free path.
    if (options.service === 'qobuz') {
      return this.processQobuzDownload(downloadId, options, progress)
    }

    progress.status = 'downloading'
    this.emit('start', progress)
    console.log(`[Downloader] Status set to downloading, getting track info...`)

    // Get track info
    let trackInfo
    try {
      // Ask for the copyright enrichment only when the tag is actually enabled,
      // so users who don't want it don't pay a second gateway call per track.
      const wantsCopyright = options.metadataSettings?.tags?.copyright === true
      trackInfo = await deezerAuth.getTrackInfo(options.trackId, { withCopyright: wantsCopyright })
      console.log(`[Downloader] Got track info:`, trackInfo ? `${trackInfo.SNG_TITLE} by ${trackInfo.ART_NAME}` : 'null')
    } catch (error: any) {
      console.error(`[Downloader] Failed to get track info:`, logSafe(error.message))

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

      // Calculate playlist root folder for deletion of entire playlist
      // This is the top-level playlist directory (e.g., ~/Music/Deemix/Study Lofi/)
      if (options.isFromPlaylist && options.folderSettings?.createPlaylistFolder && options.playlistName) {
        const playlistFolder = this.sanitizeFilename(
          (options.folderSettings.playlistFolderTemplate || '%playlist%')
            .replace(/%playlist%/gi, options.playlistName)
            .replace(/%owner%/gi, options.playlistOwner || '')
        )
        progress.playlistFolder = path.join(options.outputPath, playlistFolder)
        console.log(`[Downloader] Playlist folder set: ${progress.playlistFolder}`)

        // Save playlist cover artwork in the playlist folder as cover.jpg
        if (options.playlistCoverUrl && options.saveArtwork) {
          this.savePlaylistCover(options.playlistCoverUrl, progress.playlistFolder, options)
        }
      } else if (options.isFromPlaylist && options.playlistCoverUrl && options.saveArtwork && options.playlistName) {
        // No playlist folder — save cover in root download dir named after the playlist
        this.savePlaylistCover(options.playlistCoverUrl, options.outputPath, options, options.playlistName)
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
    const isrcFallback = options.isrcFallback !== false
    console.log(`[Downloader] Getting download URL for quality: ${options.quality}, bitrateFallback: ${bitrateFallback}, isrcFallback: ${isrcFallback}`)
    let downloadUrl: string
    let actualFormat: string
    try {
      const result = await deezerAuth.getTrackUrl(trackInfo.SNG_ID, options.quality, bitrateFallback, isrcFallback)
      downloadUrl = result.url
      actualFormat = result.format
      progress.actualFormat = actualFormat

      // If the track was resolved to a different version (fallback/ISRC),
      // re-fetch track info so metadata, folder path, and M3U use the correct album
      if (result.resolvedTrackId && String(result.resolvedTrackId) !== String(trackInfo.SNG_ID)) {
        console.log(`[Downloader] Track resolved to alternative: ${trackInfo.SNG_ID} → ${result.resolvedTrackId} — refreshing metadata`)
        // Flag for the UI: the exact track was unavailable, so we downloaded an
        // ISRC/FALLBACK-matched alternative from another release. Audio is bit-exact
        // to that source but may be a different master than the requested track.
        progress.substituted = true
        const requestedIsrc = String(trackInfo.ISRC || '').trim().toUpperCase()
        // Preserve the original track/disc number — the resolved track may be from
        // a different album where it has a different position
        const originalTrackNumber = trackInfo.TRACK_NUMBER
        const originalDiskNumber = trackInfo.DISK_NUMBER
        const resolvedInfo = await deezerAuth.getTrackInfo(result.resolvedTrackId, { withCopyright: options.metadataSettings?.tags?.copyright === true })
        if (resolvedInfo) {
          const resolvedIsrc = String(resolvedInfo.ISRC || '').trim().toUpperCase()
          progress.substitutedSameRecording = (requestedIsrc && resolvedIsrc)
            ? requestedIsrc === resolvedIsrc
            : undefined
          console.log(`[Downloader] Alternate recording check: requested ISRC ${requestedIsrc || '(none)'} vs ${resolvedIsrc || '(none)'} → ${progress.substitutedSameRecording === undefined ? 'unknown' : progress.substitutedSameRecording ? 'same recording' : 'DIFFERENT recording'}`)
          trackInfo = resolvedInfo
          // Restore original position so the file is numbered correctly on this
          // album. Restricted tracks sometimes come back from song.getData without
          // usable numbers, so fall back to the album-tracklist position the
          // caller passed before accepting the substituted release's numbering
          // (#102/#103).
          trackInfo.TRACK_NUMBER = originalTrackNumber || options.trackNumber || trackInfo.TRACK_NUMBER
          trackInfo.DISK_NUMBER = originalDiskNumber || options.discNumber || trackInfo.DISK_NUMBER
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
      console.error(`[Downloader] Failed to get media URL:`, logSafe(error.message))
      if (error.message.includes('PreferredBitrateNotFound')) {
        throw new Error(`Preferred bitrate (${options.quality}) not available for this track. Enable Bitrate Fallback in settings to download in a lower quality.`)
      }
      throw new Error(`Failed to get download URL: ${error.message}`)
    }

    // Resolve album info for folder naming (if not already known via albumContext)
    // Fetches album artist, explicit status, and compilation flag from public API
    // This ensures tracks from the same album use consistent folder naming
    if (!options.albumContext && trackInfo.ALB_ID) {
      const albumId = String(trackInfo.ALB_ID)
      if (!this.albumInfoCache.has(albumId)) {
        this.albumInfoCache.set(albumId, (async () => {
          try {
            const https = await import('https')
            const albumData: any = await new Promise((resolve, reject) => {
              const req = https.default.get(`https://api.deezer.com/album/${albumId}`, { timeout: 15000 }, (res: any) => {
                let data = ''
                res.on('data', (chunk: string) => data += chunk)
                res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve({}) } })
              })
              req.on('timeout', () => req.destroy(new Error('Album info fetch timed out')))
              req.on('error', reject)
            })
            const status = albumData.explicit_content_lyrics
            return {
              // Status 1 = explicit, 4 = partially explicit
              explicit: status === 1 || status === 4,
              // Album-level artist from public API (e.g., "Various Artists" for compilations)
              artist: albumData.artist?.name || '',
              // Deezer record_type "compile" = compilation/sampler
              isCompilation: albumData.record_type === 'compile',
              // Full record_type (album/single/ep/compile) for the RELEASETYPE tag (#82)
              recordType: typeof albumData.record_type === 'string' ? albumData.record_type : '',
              // Album UPC/barcode — Deezer's private song.getData omits this field, so
              // %barcode%/%upc% template substitution + the BARCODE tag rely on this public-API pull.
              upc: typeof albumData.upc === 'string' ? albumData.upc : '',
              // Album label — also omitted by private song.getData; the LABEL/publisher tag needs it.
              label: typeof albumData.label === 'string' ? albumData.label : ''
            }
          } catch {
            return { explicit: false, artist: '', isCompilation: false, recordType: '', upc: '', label: '' }
          }
        })())
      }
      try {
        const albumInfo = await this.albumInfoCache.get(albumId)
        options._resolvedAlbumExplicit = albumInfo?.explicit
        options._resolvedAlbumArtist = albumInfo?.artist || undefined
        options._resolvedAlbumIsCompilation = albumInfo?.isCompilation
        options._resolvedAlbumRecordType = albumInfo?.recordType
        options._resolvedAlbumUpc = albumInfo?.upc || undefined
        options._resolvedAlbumLabel = albumInfo?.label || undefined
      } catch {
        options._resolvedAlbumExplicit = undefined
        options._resolvedAlbumArtist = undefined
        options._resolvedAlbumIsCompilation = undefined
        options._resolvedAlbumUpc = undefined
        options._resolvedAlbumLabel = undefined
      }
    }

    // Album-level totals (#107): Deezer's private song.getData carries
    // TRACK_NUMBER/DISK_NUMBER but NOT the album TRACKS_COUNT/DISKS_COUNT
    // (verified), so the Track Total / Disc Total tags and %tracktotal% /
    // %disctotal% templates never had a value. Source them here — from the album
    // context on album/playlist downloads, or a cached album.getData lookup for
    // standalone tracks (NUMBER_TRACK/NUMBER_DISK are authoritative) — and inject
    // onto the (already-cloned) trackInfo so every downstream tagger + template
    // sees them.
    if (trackInfo.TRACKS_COUNT == null && options.albumContext?.totalTracks) {
      trackInfo.TRACKS_COUNT = options.albumContext.totalTracks
    }
    if (trackInfo.DISKS_COUNT == null && options.albumContext?.totalDiscs) {
      trackInfo.DISKS_COUNT = options.albumContext.totalDiscs
    }
    if ((trackInfo.TRACKS_COUNT == null || trackInfo.DISKS_COUNT == null) && trackInfo.ALB_ID) {
      try {
        const albumMeta = await deezerAuth.getAlbumInfo(trackInfo.ALB_ID)
        if (trackInfo.TRACKS_COUNT == null && albumMeta?.NUMBER_TRACK) {
          trackInfo.TRACKS_COUNT = Number(albumMeta.NUMBER_TRACK)
        }
        if (trackInfo.DISKS_COUNT == null && albumMeta?.NUMBER_DISK) {
          trackInfo.DISKS_COUNT = Number(albumMeta.NUMBER_DISK)
        }
      } catch (e: any) {
        console.log('[Downloader] Album totals lookup failed (tags will omit them):', logSafe(e.message))
      }
    }

    // Build output path using the ACTUAL format and resolved track info
    const initialOutputPath = this.buildOutputPath(trackInfo, options, actualFormat)
    console.log(`[Downloader] Initial output path: ${initialOutputPath}`)

    // Refresh-tags mode: never download. If the file already exists, merge-rewrite
    // its tags from the authoritative track + album data we already hold (exact IDs,
    // correct UPC/label via albumContext — no ISRC reverse-lookup ambiguity, #77).
    if (options.overwriteMode === 'refresh-tags') {
      // Don't trust the single recomputed path — locate the file across candidate
      // layouts (playlist folder, album folder, prefix-agnostic glob) so a playlist
      // refresh doesn't silently skip files that live in album folders or whose
      // playlist position shifted (issue #79).
      const located = this.locateExistingTrackFile(trackInfo, options, initialOutputPath, actualFormat)
      await this.refreshExistingFileTags(located || initialOutputPath, trackInfo, options, progress)
      return
    }

    // Library de-dup (opt-in): if we already have this exact recording somewhere in
    // the library (matched by ISRC, not path), skip it. This runs BEFORE pacing and
    // the CDN fetch so duplicate-skips stay instant (same discipline as #88). Tracks
    // with no ISRC are never deduped. Stale index entries self-evict in findExisting.
    if (options.skipDuplicateTracks && trackInfo.ISRC) {
      await libraryIndex.ensureLoaded()
      const existingPath = libraryIndex.findExisting(trackInfo.ISRC)
      // De-dup matches on ISRC alone, so without a tier check it would answer
      // "already have it" while holding a copy worse than the one being fetched
      // — including a 128 MP3 when this download would have been FLAC.
      if (existingPath && isLowerTier(existingPath, actualFormat)) {
        console.log(`[Downloader] Duplicate ISRC ${trackInfo.ISRC} found at ${existingPath}, but it is a lower tier than ${actualFormat} — downloading anyway`)
      } else if (existingPath) {
        console.log(`[Downloader] Skipping duplicate (ISRC ${trackInfo.ISRC} already in library): ${existingPath}`)
        progress.status = 'completed'
        progress.progress = 100
        progress.skippedAsDuplicate = true
        // M3U: point the playlist entry at the file we already have.
        if (options._m3uTrackerId) {
          this.recordM3UEntry(options._m3uTrackerId || options.playlistName || "", {
            position: options.playlistPosition || 0,
            duration: trackInfo.DURATION || 0,
            artist: trackInfo.ART_NAME || 'Unknown Artist',
            title: progress.trackTitle || trackInfo.SNG_TITLE || 'Unknown Track',
            absolutePath: existingPath,
            playlistFolder: progress.playlistFolder,
            albumFolder: progress.albumRootFolder || progress.albumFolder
          })
        }
        this.emit('progress', progress)
        progress.path = existingPath
        this.emit('complete', { ...progress })
        return
      }
    }

    // Reserve a unique output path to prevent concurrent download collisions
    // Returns null if overwrite mode is 'no' and file already exists (skip download)
    // actualFormat, not options.quality: if Deezer only has this track at 128
    // there is nothing to upgrade to, so an existing 128 file should still skip.
    const outputPath = this.reserveOutputPath(initialOutputPath, trackInfo.SNG_ID, options.overwriteMode, actualFormat)
    if (outputPath === null) {
      // File exists and overwrite mode is 'no' — mark as completed and skip
      progress.status = 'completed'
      progress.progress = 100
      // Record skipped file for M3U — it still exists on disk
      if (options._m3uTrackerId) {
        this.recordM3UEntry(options._m3uTrackerId || options.playlistName || "", {
          position: options.playlistPosition || 0,
          duration: trackInfo.DURATION || 0,
          artist: trackInfo.ART_NAME || 'Unknown Artist',
          title: progress.trackTitle || trackInfo.SNG_TITLE || 'Unknown Track',
          absolutePath: initialOutputPath,
          playlistFolder: progress.playlistFolder,
          albumFolder: progress.albumRootFolder || progress.albumFolder
        })
      }
      // Keep the library index fresh even when the file already existed at the
      // computed path (so a later same-ISRC download from a different release can
      // de-dup against it without a backfill scan). No-op without an ISRC.
      libraryIndex.add(trackInfo.ISRC, initialOutputPath)
      this.emit('progress', progress)
      // Mirror the success path's contract: every download that finishes —
      // including ones that finish by being skipped — must emit 'complete'.
      // Sync engines (playlistSync/artistSync) resolve their per-track Promise
      // on this event; without it, skipped tracks hang their worker for the
      // full 5-minute timeout and the sync pool stalls (#67).
      progress.path = initialOutputPath
      this.emit('complete', { ...progress })
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

      // Pace the actual CDN fetch (issue #86/#88). This is past the skip check, so
      // already-existing files never wait here — only genuinely-new downloads are
      // spaced out. No-op when pacing is 'off'.
      await this.awaitPacingSlot()

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
        console.error(`[Downloader] Download file error:`, logSafe(error.message))
        // Clean up any partial file
        try {
          if (encryptedPath && fs.existsSync(encryptedPath)) {
            fs.unlinkSync(encryptedPath)
          }
        } catch (e) {}
        // Aborted by cancel (#118): status is already error/'Cancelled' and the
        // partial file was cleaned above — exit without an error event, an
        // errors.txt entry, or a resume re-queue.
        if (this.cancelledDownloadIds.delete(downloadId)) {
          console.log(`[Downloader] Download ${downloadId} cancelled mid-stream`)
          return
        }
        // If this download was aborted by a queue pause, re-queue it for resume
        // instead of failing it. The finally block releases the reserved path, so
        // resume re-reserves and re-downloads cleanly.
        if (this.pausedDownloadIds.has(downloadId)) {
          this.pausedDownloadIds.delete(downloadId)
          progress.status = 'pending'
          progress.progress = 0
          progress.downloaded = 0
          progress.speed = 0
          this.downloadQueue.unshift({ id: downloadId, options })
          this.emit('progress', progress)
          console.log(`[Downloader] Download ${downloadId} paused mid-stream — re-queued for resume`)
          return // exit cleanly (finally releases path + cleans partial); no error emitted
        }
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

      // Check the delivered bitstream against the tier the Media API claimed.
      // Everything downstream — the extension already on disk, the tagger picked
      // below, the quality chip, the downgrade badge — runs off that one label,
      // and until here nothing had ever compared it to the actual bytes. The
      // label also has a soft spot worth covering: getMediaUrl falls back to the
      // FIRST format it requested when the response omits `media.format`, which
      // is the most optimistic possible guess.
      const delivered = probeAudioFile(decryptedPath)
      if (delivered) {
        const wantContainer = expectedContainer(actualFormat)
        if (wantContainer && delivered.container !== wantContainer) {
          // Not a quality question — the file is the wrong kind of thing. Its
          // extension lies and the tagger below would write ID3 frames into a
          // FLAC (or Vorbis comments into an MP3) and corrupt it. Delete rather
          // than ship it, same as a truncated transfer.
          try { if (fs.existsSync(decryptedPath)) fs.unlinkSync(decryptedPath) } catch (e) {}
          throw new Error(
            `Delivered audio is ${delivered.container.toUpperCase()} but the Media API reported ` +
            `${actualFormat}. Refusing to write a file whose extension and tags would both be wrong.`
          )
        }
        if (delivered.tier !== 'MP3_OTHER' && delivered.tier !== actualFormat) {
          // Same container, different tier. The audio is whatever Deezer sent and
          // is fine to keep; only the label was wrong. Correct it so the quality
          // chip and the downgrade badge tell the truth.
          console.warn(
            `[Downloader] Format label mismatch: API said ${actualFormat}, ` +
            `bitstream is ${delivered.tier} (${delivered.bitrate} kbps) — trusting the bitstream`
          )
          actualFormat = delivered.tier
          progress.actualFormat = delivered.tier
        } else {
          console.log(`[Downloader] Verified delivered format: ${delivered.tier}${delivered.bitrate ? ` (${delivered.bitrate} kbps)` : ''}`)
        }
      }

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
          await this.saveLyrics(trackInfo, decryptedPath, options.syncedLyrics !== false, options.preferSyncedLyrics === true, options.deleteSupersededLyrics === true)
        } catch (error: any) {
          console.error(`[Downloader] Lyrics save error:`, error.message)
        }
      }

      progress.status = 'completed'
      progress.progress = 100
      this.cleanupThrottle(downloadId)

      // Record actual file path for M3U generation (playlist tracks only)
      if (options._m3uTrackerId) {
        this.recordM3UEntry(options._m3uTrackerId || options.playlistName || "", {
          position: options.playlistPosition || 0,
          duration: trackInfo.DURATION || 0,
          artist: trackInfo.ART_NAME || 'Unknown Artist',
          title: progress.trackTitle || trackInfo.SNG_TITLE || 'Unknown Track',
          absolutePath: decryptedPath,
          playlistFolder: progress.playlistFolder,
          albumFolder: progress.albumRootFolder || progress.albumFolder
        })
      }

      // Record this recording in the library index (by ISRC) so future downloads can
      // de-dup against it when the user has that option on. No-op without an ISRC.
      libraryIndex.add(trackInfo.ISRC, decryptedPath)

      progress.path = decryptedPath
      this.emit('complete', { ...progress })
    } finally {
      // Always release the reserved path when done (success or failure)
      this.releaseOutputPath(outputPath)
      // Drop the abort handle for this download (no longer in-flight)
      this.downloadAborts.delete(downloadId)
      // Clear any cancel marker that landed too late to abort the stream
      this.cancelledDownloadIds.delete(downloadId)

      // Clean up encrypted file if it still exists (in case of error before cleanup)
      if (encryptedPath && fs.existsSync(encryptedPath)) {
        try {
          fs.unlinkSync(encryptedPath)
          console.log(`[Downloader] Cleaned up encrypted file in finally block`)
        } catch (e) {}
      }
    }
  }

  // Refresh-tags path: merge-rewrite an existing file's tags from authoritative
  // track + album data (no re-download, audio untouched). Reuses the v1.9.0
  // retagger merge writers via applyMergeFromMeta. See #77.
  private async refreshExistingFileTags(
    filePath: string,
    trackInfo: any,
    options: DownloadOptions,
    progress: DownloadProgress
  ): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        console.log(`[Downloader] Refresh-tags: file not found, skipping: ${filePath}`)
        progress.status = 'completed'
        progress.progress = 100
        this.emit('progress', progress)
        progress.path = filePath
        this.emit('complete', { ...progress, retagSkipped: true })
        return
      }

      progress.status = 'tagging'
      this.emit('progress', progress)

      // Genre via the same ID→name mapping the download writer uses.
      let genre = ''
      try {
        const genres = (await this.getGenresForTrack(trackInfo)).filter(g => g.toLowerCase() !== 'all')
        genre = genres.join('; ')
      } catch { /* genre optional */ }

      const releaseDate: string = trackInfo.PHYSICAL_RELEASE_DATE || ''
      const s = (v: any) => (v === null || v === undefined ? '' : String(v))

      // Build the artist string the same way the download writer does: every
      // credited artist (main + featured), not just ART_NAME — honoring
      // saveOnlyMainArtist + artistSeparator. Fixes issue #78 (only the main
      // artist was written on refresh).
      let refreshArtist = s(trackInfo.ART_NAME)
      if (!options.metadataSettings?.saveOnlyMainArtist) {
        const sepMap: Record<string, string> = {
          standard: ', ', comma: ',', slash: '/',
          semicolon: ';', semicolonSpace: '; ', ampersand: ' & '
        }
        // NOTE: deliberately NOT honoring useNullSeparator here. The merge writer
        // (applyMp3/applyFlac) writes a single tag string and does not emit
        // ID3v2.4/Vorbis multi-value frames, so a NUL separator corrupts the
        // artist tag (verified: MP3 → "AB" concatenated, FLAC → literal \0).
        // The visible separator is the only safe choice on the refresh path.
        const sep = sepMap[options.metadataSettings?.artistSeparator || 'standard'] || ', '
        const removeArtistCombinations = (options.metadataSettings as any)?.removeArtistCombinations || false
        let artists: string[] | null = null
        if (trackInfo.ARTISTS?.length > 0) {
          artists = trackInfo.ARTISTS.map((a: any) => a.ART_NAME).filter(Boolean)
        } else if (trackInfo.SNG_CONTRIBUTORS?.main_artist?.length > 0) {
          artists = [...trackInfo.SNG_CONTRIBUTORS.main_artist]
          if (trackInfo.SNG_CONTRIBUTORS.featartist?.length > 0) artists.push(...trackInfo.SNG_CONTRIBUTORS.featartist)
          artists = artists.filter(Boolean)
        }
        if (artists && artists.length > 0) {
          if (removeArtistCombinations) artists = this.filterArtistCombinations(artists)
          refreshArtist = artists.join(sep)
        }
      }

      const meta: ResolvedMeta = {
        title: s(trackInfo.SNG_TITLE),
        artist: refreshArtist,
        album: s(options.albumContext?.albumTitle || trackInfo.ALB_TITLE),
        albumArtist: s(options.albumContext?.albumArtist || trackInfo.ALB_ART_NAME || trackInfo.ART_NAME),
        trackNumber: s(trackInfo.TRACK_NUMBER),
        trackTotal: s(trackInfo.TRACKS_COUNT),
        discNumber: s(trackInfo.DISK_NUMBER),
        isrc: s(trackInfo.ISRC),
        // Authoritative album UPC/label — the whole point of the refresh path.
        upc: s(options.albumContext?.upc || options._resolvedAlbumUpc || ''),
        label: s(options.albumContext?.label || options._resolvedAlbumLabel || ''),
        year: releaseDate ? releaseDate.split('-')[0] : '',
        date: releaseDate,
        bpm: trackInfo.BPM ? s(trackInfo.BPM) : '',
        genre,
        duration: trackInfo.DURATION ? s(trackInfo.DURATION) : '',
        explicit: trackInfo.EXPLICIT_LYRICS === true || trackInfo.EXPLICIT_LYRICS === 1,
        recordType: s(options.albumContext?.recordType || options._resolvedAlbumRecordType || ''),
        gain: trackInfo.GAIN === null || trackInfo.GAIN === undefined ? '' : s(trackInfo.GAIN)
      }

      // Refresh honors the user's tag selection (Settings → Metadata tags): a tag
      // the user disabled is NOT written. Issue #78: refresh previously wrote the
      // full freemode set unconditionally, so disabled fields (e.g. Genre) still
      // landed. Map the user's TagSettings onto the retaggable subset; only fall
      // back to the full set when no settings were supplied (legacy/programmatic
      // callers). Merge semantics still preserve anything Deezer lacks.
      const ts = options.metadataSettings?.tags
      // Only an EXPLICIT false disables a tag. A key missing from a stale saved
      // settings blob (predating a newer tag key) must NOT silently disable that
      // field — default to enabled, matching the user's intent ("I disabled X").
      const on = (v: boolean | undefined) => v !== false
      const fields: RetagFields = ts ? {
        title: on(ts.title), artist: on(ts.artist), album: on(ts.album), albumArtist: on(ts.albumArtist),
        trackNumber: on(ts.trackNumber), trackTotal: on(ts.trackTotal), discNumber: on(ts.discNumber),
        isrc: on(ts.isrc), year: on(ts.year), date: on(ts.date), bpm: on(ts.bpm), genre: on(ts.genre),
        trackLength: on(ts.trackLength), explicitLyrics: on(ts.explicitLyrics),
        albumBarcode: on(ts.albumBarcode), albumLabel: on(ts.albumLabel),
        releaseType: on(ts.releaseType),
        // ReplayGain is default-OFF: only an EXPLICIT true enables it, unlike the
        // default-on `on()` tags above. Keeps refresh consistent with the download
        // writer's opt-in gate.
        replayGain: ts.replayGain === true
      } : {
        title: true, artist: true, album: true, albumArtist: true,
        trackNumber: true, trackTotal: true, discNumber: true, isrc: true,
        year: true, date: true, bpm: true, genre: true, trackLength: true,
        explicitLyrics: true, albumBarcode: true, albumLabel: true,
        releaseType: true,
        // Default-OFF even on the legacy no-settings fallback — RG must never be
        // written unless the user opted in.
        replayGain: false
      }
      const result = applyMergeFromMeta(filePath, meta, fields, false)
      console.log(`[Downloader] Refresh-tags ${result.status} (${result.changes.length} changed): ${filePath}`)

      progress.status = 'completed'
      progress.progress = 100
      // Note: no M3U regeneration on refresh — we're only touching tag blocks,
      // not changing files or paths, so the existing playlist file is left alone.
      this.emit('progress', progress)
      progress.path = filePath
      this.emit('complete', { ...progress })
    } catch (error: any) {
      console.error('[Downloader] Refresh-tags failed:', error)
      progress.status = 'error'
      progress.error = error?.message || String(error)
      this.emit('progress', progress)
      this.emit('error', progress)
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
    console.log(`[Downloader] Folder settings - createArtistFolder: ${folderSettings?.createArtistFolder}, createAlbumFolder: ${folderSettings?.createAlbumFolder}, createSinglesStructure: ${folderSettings?.createSinglesStructure}, createShortReleaseFolder: ${folderSettings?.createShortReleaseFolder}`)

    // For folder structure, prefer album context (ensures all album tracks go to same folder)
    // Fall back to resolved album artist from public API (ensures compilations stay grouped)
    // Last resort: track-level fields from private API
    const albumContext = options.albumContext
    const folderArtist = albumContext?.albumArtist
      || options._resolvedAlbumArtist
      || trackInfo.ALB_ART_NAME || trackInfo.ART_NAME || 'Unknown Artist'
    const folderAlbum = albumContext?.albumTitle || trackInfo.ALB_TITLE || 'Unknown Album'

    // Track artist is still used for filename templates
    const artistName = trackInfo.ART_NAME || 'Unknown Artist'
    const albumName = trackInfo.ALB_TITLE || 'Unknown Album'
    const year = trackInfo.PHYSICAL_RELEASE_DATE?.split('-')[0] || ''
    const genre = trackInfo._directGenres?.[0] || '' // Deezer: would need async lookup (unchanged); Qobuz supplies directly
    // v1.8.2: %label% template — same dead-field story as %barcode%. trackInfo.LABEL_NAME
    // is empty on private-API fetches, so cascade through the public-API resolver first.
    const label = albumContext?.label || options._resolvedAlbumLabel || trackInfo.LABEL_NAME || ''
    // For folder naming, determine explicit status consistently:
    // 1. albumContext (from album downloads) — scans all tracks
    // 2. Pre-resolved from public API (fetched before buildOutputPath) — most reliable
    // 3. EXPLICIT_ALBUM_CONTENT from trackInfo (private API) — may be missing
    // 4. Per-track EXPLICIT_LYRICS — last resort
    let folderExplicit = ''
    if (albumContext) {
      folderExplicit = albumContext.explicitLyrics === true ? 'Explicit' : ''
    } else if (options._resolvedAlbumExplicit !== undefined) {
      folderExplicit = options._resolvedAlbumExplicit ? 'Explicit' : ''
    } else if (trackInfo.EXPLICIT_ALBUM_CONTENT?.EXPLICIT_LYRICS_STATUS !== undefined) {
      const albumStatus = trackInfo.EXPLICIT_ALBUM_CONTENT.EXPLICIT_LYRICS_STATUS
      folderExplicit = (albumStatus === 1 || albumStatus === 4) ? 'Explicit' : ''
    } else {
      const isTrackExplicit = trackInfo.EXPLICIT_LYRICS === 1 || trackInfo.EXPLICIT_LYRICS === '1' || trackInfo.EXPLICIT_LYRICS === true
      folderExplicit = isTrackExplicit ? 'Explicit' : ''
    }

    // Template replacement helper for FOLDER names - uses album context for consistency
    const today = new Date()
    const dateStr = today.toISOString().split('T')[0] // YYYY-MM-DD
    // Album-level UPC/barcode. v1.8.1: source from the public-API resolver
    // because Deezer's private song.getData (which populates trackInfo) does
    // NOT include ALB_UPC — the field is undefined on every track fetch. Use
    // the same cascade folderArtist/folderExplicit use: albumContext first
    // (album-download path), then _resolvedAlbumUpc (single-track public-API
    // fetch), then trackInfo.ALB_UPC (always empty today; kept for forward
    // compat). Empty string when missing — never undefined.
    const folderUpc = albumContext?.upc || options._resolvedAlbumUpc || trackInfo.ALB_UPC || ''
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
          .replace(/%barcode%/gi, folderUpc)
          .replace(/%upc%/gi, folderUpc)
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
      // Standard folder structure for non-playlist downloads.
      // Two independent reasons to skip the album folder:
      //  - a loose track download, when "artist and album folders for individual
      //    tracks" is off (the long-standing isSingle path);
      //  - a release of one or two tracks, when the short-release folder option
      //    is off (#129).
      // The second keys on track count, NOT record_type: Deezer routinely reports
      // every release as "album" (deezerAPI.inferRecordType exists purely to work
      // around that), and a one-track EP leaves the same single-file folder a
      // one-track single does. Track count is a fact; the classification isn't.
      const releaseTrackCount = options.albumContext?.totalTracks
      const isShortRelease = typeof releaseTrackCount === 'number'
        && releaseTrackCount > 0
        && releaseTrackCount <= 2
      const skipAlbumFolder =
        (options.isSingle && folderSettings?.createSinglesStructure === false)
        || (isShortRelease && folderSettings?.createShortReleaseFolder === false)

      if (skipAlbumFolder) {
        // Artist folder only — the album folder would hold one or two files.
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
    // v1.8.1: same cascade as folderUpc — trackInfo.ALB_UPC is always empty
    // (private song.getData omits it), so the real value comes from the
    // public-API resolver populated in processDownload.
    const upc = options.albumContext?.upc || options._resolvedAlbumUpc || trackInfo.ALB_UPC || ''
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

  /**
   * Refresh-tags only: find the track's EXISTING file on disk. The refresh path
   * recomputes where the file *should* be from current settings, but a playlist
   * refresh recomputes a playlist-layout path (`%playlist%/%position% - %artist%
   * - %title%`) that frequently does NOT match where the file actually lives —
   * the same track may sit in an album folder (downloaded via album), or the
   * playlist order shifted so the `%position%` prefix changed. Checking only the
   * one recomputed path made playlist refresh silently skip and rewrite nothing
   * (issue #79). Returns the first existing candidate path, or null.
   */
  private locateExistingTrackFile(
    trackInfo: any,
    options: DownloadOptions,
    primaryPath: string,
    actualFormat?: string
  ): string | null {
    const ext = (actualFormat || options.quality) === 'FLAC' ? '.flac' : '.mp3'
    const candidates: string[] = [primaryPath]

    // Album-layout candidate: recompute as if this were an album download. Most
    // playlist tracks were originally downloaded (and organized) by album.
    if (options.isFromPlaylist) {
      try {
        const albumOpts: DownloadOptions = {
          ...options,
          isFromPlaylist: false,
          playlistName: undefined,
          playlistPosition: undefined,
          playlistContext: undefined,
          albumContext: options.albumContext || {
            albumId: trackInfo.ALB_ID,
            albumTitle: trackInfo.ALB_TITLE || 'Unknown Album',
            albumArtist: trackInfo.ALB_ART_NAME || trackInfo.ART_NAME || 'Unknown Artist'
          }
        }
        candidates.push(this.buildOutputPath(trackInfo, albumOpts, actualFormat))
      } catch { /* candidate optional */ }
    }

    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c
    }

    // Prefix-agnostic glob: every filename template ends with %title%, so the
    // file name ends with the (sanitized) title regardless of the `NN - ` /
    // `position - artist - ` prefix. Scan the candidate directories and match on
    // the title suffix — handles playlist reordering and template changes.
    const baseTitle = trackInfo.SNG_TITLE || 'Unknown Track'   // parity with buildOutputPath
    const titleBase = trackInfo.VERSION
      ? `${baseTitle} (${String(trackInfo.VERSION).replace(/^\((.+)\)$/, '$1')})`
      : baseTitle
    const wantTitle = this.sanitizeFilename(titleBase).toLowerCase()
    const wantTrackNum = trackInfo.TRACK_NUMBER?.toString().padStart(2, '0')
    if (wantTitle) {
      const dirs = Array.from(new Set(candidates.map(c => path.dirname(c)).filter(Boolean)))
      for (const dir of dirs) {
        let entries: string[] = []
        try { entries = fs.readdirSync(dir) } catch { continue }
        const matches = entries.filter(name => {
          if (path.extname(name).toLowerCase() !== ext) return false
          const stem = name.slice(0, -ext.length).toLowerCase()
          return stem === wantTitle || stem.endsWith(`- ${wantTitle}`)
        })
        if (matches.length === 1) return path.join(dir, matches[0])
        if (matches.length > 1 && wantTrackNum) {
          // Ambiguous (e.g. an album with two same-titled tracks). Disambiguate by
          // the track-number prefix; if still not unique, do NOT guess — skip this
          // dir rather than risk retagging the wrong file.
          const byNum = matches.filter(n => n.startsWith(`${wantTrackNum} `))
          if (byNum.length === 1) return path.join(dir, byNum[0])
        }
        // matches.length > 1 and not uniquely resolvable → fall through (no guess)
      }
    }
    return null
  }

  sanitizeFilename(name: string): string {
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
   * @param overwriteMode - 'no' skips when the file exists, 'rename' finds a free
   *   name, anything else overwrites
   * @param expectedFormat - Quality tier this download would produce. Under mode
   *   'no', an existing file at a LOWER tier is overwritten rather than skipped:
   *   MP3_128 and MP3_320 share the same `.mp3` filename, so without this a 320
   *   re-download silently kept the 128 already on disk. Omit it to get the old
   *   unconditional skip.
   * @returns The reserved path, or null to signal "skip this download"
   */
  private reserveOutputPath(basePath: string, trackId: string | number, overwriteMode?: string, expectedFormat?: string): string | null {
    const normalizedPath = path.normalize(basePath)

    // Check for collision with another in-progress download
    if (this.reservedPaths.has(normalizedPath)) {
      console.warn(`[Downloader] PATH COLLISION for track ${trackId}: ${normalizedPath}`)
    }

    // Check for existing file and handle based on overwrite mode
    if (fs.existsSync(normalizedPath)) {
      const mode = overwriteMode || 'overwrite'
      if (mode === 'no' && isLowerTier(normalizedPath, expectedFormat)) {
        // Fall through to overwrite: skipping here would keep a file that is
        // genuinely worse than what the user just asked for, while the UI went
        // on to report the requested tier.
        console.log(`[Downloader] Existing file for track ${trackId} is a lower tier than ${expectedFormat} — re-downloading instead of skipping`)
      } else if (mode === 'no') {
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

    // Register an abort handle so pauseQueue can stop this fetch mid-stream.
    const abortController = new AbortController()
    this.downloadAborts.set(progress.id, abortController)

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

      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': deezerAuth.getCookieString()
        },
        timeout: 30000, // 30s connection timeout
        signal: abortController.signal // pauseQueue can abort mid-stream
      }, (response) => {
        console.log(`[Downloader] Response status: ${response.statusCode}`)

        if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirect
          const redirectUrl = response.headers.location
          console.log(`[Downloader] Redirect to: ${redirectUrl?.substring(0, 80)}...`)
          if (redirectUrl) {
            const redirectReq = https.get(redirectUrl, {
              timeout: 30000,
              signal: abortController.signal // pauseQueue can abort mid-stream
            }, (redirectResponse) => {
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
              console.error(`[Downloader] Redirect error:`, logSafe(err.message))
              file.close()
              try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) {}
              reject(err)
            })
            redirectReq.on('timeout', () => {
              console.error('[Downloader] Redirect connection timed out')
              redirectReq.destroy(new Error('Connection timed out on redirect'))
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
        console.error(`[Downloader] Download error:`, logSafe(error.message))
        file.close()
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath)
          }
        } catch (e) {}
        reject(error)
      })
      req.on('timeout', () => {
        console.error('[Downloader] Connection timed out')
        req.destroy(new Error('Connection timed out'))
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

    // Stall detection: if no data received for 60 seconds, abort
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    const STALL_TIMEOUT_MS = 60000
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        console.error(`[Downloader] Download stalled — no data for ${STALL_TIMEOUT_MS / 1000}s, aborting`)
        response.destroy(new Error('Download stalled — no data received for 60 seconds'))
      }, STALL_TIMEOUT_MS)
    }
    resetStallTimer() // Start the timer

    response.on('data', (chunk: Buffer) => {
      downloaded += chunk.length
      progress.downloaded = downloaded
      progress.progress = total > 0 ? Math.round((downloaded / total) * 100) : 0
      progress.speed = downloaded / ((Date.now() - startTime) / 1000)
      // Use throttled emit to reduce UI update frequency during downloads
      this.emitProgressThrottled(progress)
      resetStallTimer() // Reset on each data chunk
    })

    response.pipe(file)

    file.on('finish', () => {
      if (stallTimer) clearTimeout(stallTimer)
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

        // Truncated transfer: the stream closed cleanly but fewer bytes arrived
        // than Content-Length promised (a partial body with a clean FIN, no
        // 'error' event). The stall timer only catches a *hang*, not an early
        // close, so without this a truncated file would resolve as success and
        // land on disk as a corrupt track. Only checkable when the server sent
        // a length.
        if (total > 0 && downloaded < total) {
          console.error(`[Downloader] Truncated download: ${downloaded}/${total} bytes`)
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
          } catch (e) {}
          reject(new DownloadError(`Download incomplete: received ${downloaded} of ${total} bytes`, {
            code: 'TRUNCATED',
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
      if (stallTimer) clearTimeout(stallTimer)
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
      if (stallTimer) clearTimeout(stallTimer)
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
        let decrypted: Buffer
        try {
          // Reset IV for each chunk decryption
          bf.setIv(iv)
          decrypted = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY))
        } catch (e: any) {
          // Unreachable under the guard above: decode() only throws on a non-Buffer
          // input, an unset IV, a length not divisible by 8, or a bad return-type
          // enum — and `chunkSize === 2048` plus the setIv() two lines up rule out
          // all four. Kept as a tripwire in case the chunking ever changes (streaming,
          // a different stripe size).
          //
          // Rethrow rather than fall back to copying the chunk. Writing the still-
          // ENCRYPTED bytes through would emit a file that reports a successful
          // download but contains digital noise where audio should be — exactly the
          // kind of silent corruption users can only detect by ear. The caller turns
          // this into "Decryption error" and fails the download, and since the output
          // file is written only after this loop finishes, no partial file survives.
          console.error(`[Downloader] Chunk decryption failed at position ${position}:`, e.message)
          throw new Error(`Chunk decryption failed at byte ${position}: ${e.message}`)
        }
        decrypted.copy(output, position)

        // The Blowfish instance is built with PADDING.NULL, and that library's
        // decode() strips trailing 0x00 bytes from the plaintext. So a 2048-byte
        // stripe legitimately comes back at 2047 or 2046 — measured at ~0.4% of
        // chunks, since MP3 frame data is full of nulls. This is not an error.
        //
        // It stays lossless only because the bytes stripped are zeros by
        // definition and `output` came from Buffer.alloc, which zero-fills, so
        // the gap already holds the right values. That makes the allocator above
        // LOAD-BEARING, not a style choice: Buffer.allocUnsafe returns recycled
        // memory and would scatter garbage bytes through the audio on ~1 chunk
        // in 250 while still reporting a successful download — silent corruption
        // that only shows up by ear.
        //
        // Verify rather than trust, so the coupling can't be broken silently.
        // Runs only on a short decode, and decode() strips at most 7 bytes.
        if (decrypted.length < chunkSize) {
          for (let i = position + decrypted.length; i < position + chunkSize; i++) {
            if (output[i] !== 0) {
              throw new Error(
                `Decrypt output buffer is not zero-filled at byte ${i}: PADDING.NULL ` +
                `strips trailing nulls, so this buffer must come from Buffer.alloc, ` +
                `never Buffer.allocUnsafe`
              )
            }
          }
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
        'semicolonSpace': '; ',
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

      if (tagSettings.album) {
        // Source the album tag from the SAME place as the folder name (albumContext
        // → private track field), mirroring the albumArtist tag below, so the tag
        // never disagrees with the folder — e.g. a relinked single whose track's
        // ALB_TITLE points to a different release than the one being downloaded (#96).
        const albumTag = options.albumContext?.albumTitle || trackInfo.ALB_TITLE
        if (albumTag) tags.album = albumTag
      }

      if (tagSettings.albumArtist) {
        if (isPlaylistCompilation) {
          tags.performerInfo = 'Various Artists'
        } else {
          // Use the SAME album-artist source the folder naming uses (albumContext →
          // public-API resolved → private track fields). Without this, a "Various
          // Artists" release lands in a correct folder but the ALBUMARTIST tag gets
          // the per-track performer from the private API (issue #83).
          const rawAlbumArtist = options.albumContext?.albumArtist || options._resolvedAlbumArtist || trackInfo.ALB_ART_NAME || trackInfo.ART_NAME || ''
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

      // RELEASETYPE — lets Navidrome separate albums/singles/EPs (#82). Written as
      // two TXXX frames so it matches both of Navidrome's tag aliases
      // ("releasetype" and "txxx:musicbrainz album type"). See mapReleaseType().
      // Default-on when the key is absent (e.g. settings synced before this tag
      // existed) — matches the refresh path's `!== false` semantics; only an
      // explicit opt-out suppresses it (issue #85).
      if (tagSettings.releaseType !== false) {
        const releaseType = this.mapReleaseType(options.albumContext?.recordType || options._resolvedAlbumRecordType)
        if (releaseType) {
          tags.userDefinedText = tags.userDefinedText || []
          tags.userDefinedText.push({ description: 'RELEASETYPE', value: releaseType })
          tags.userDefinedText.push({ description: 'MusicBrainz Album Type', value: releaseType })
        }
      }

      // REPLAYGAIN_TRACK_GAIN — lets ReplayGain-aware players (foobar2000, VLC,
      // etc.) normalize playback loudness to Deezer's reference, so a download
      // sounds closer to in-app playback. Metadata only; audio untouched.
      // Default OFF — opt-in truthy gate, NOT the releaseType `!== false` default.
      if (tagSettings.replayGain) {
        const rg = replayGainString(trackInfo.GAIN)
        if (rg) {
          tags.userDefinedText = tags.userDefinedText || []
          tags.userDefinedText.push({ description: 'REPLAYGAIN_TRACK_GAIN', value: rg })
        }
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

      // UPC/label live on the public album API, not private song.getData — v1.8.2 sources
      // them from the same resolver the templates use (trackInfo.* is always empty here).
      const tagUpc = options.albumContext?.upc || options._resolvedAlbumUpc || trackInfo.ALB_UPC || ''
      const tagLabel = options.albumContext?.label || options._resolvedAlbumLabel || trackInfo.LABEL_NAME || ''

      if (tagSettings.albumBarcode && tagUpc) {
        // Store UPC in TXXX frame
        tags.userDefinedText = tags.userDefinedText || []
        tags.userDefinedText.push({
          description: 'BARCODE',
          value: tagUpc
        })
      }

      if (tagSettings.albumLabel && tagLabel) {
        tags.publisher = tagLabel
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
            if (line.milliseconds === undefined || !line.line) continue
            // node-id3 rejects a SYLT timestamp that is not a true integer and
            // throws "An integer value is expected" for a string, a float or
            // undefined. That throw aborts the entire write, and the update()
            // fallback below fails identically, so one bad timestamp leaves the
            // file with no ID3 tag at all rather than merely losing its lyrics.
            // Deezer returns these as strings, so coerce here and drop anything
            // that will not survive the round trip.
            const ms = Math.round(Number(line.milliseconds))
            if (!Number.isFinite(ms) || ms < 0) continue
            syltLines.push({ text: line.line, timeStamp: ms })
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
      if (tagSettings.cover && options.embedArtwork && (trackInfo.ALB_PICTURE || options.prefetchedCover)) {
        try {
          const artworkSize = albumCoverSettings.embeddedArtworkSize || 800
          // Use quality 90 to match original deemix (was 80)
          const quality = albumCoverSettings.jpegImageQuality || 90

          // Prefer a pre-fetched cover (e.g. Qobuz, whose art is a full URL not a
          // Deezer hash); otherwise fetch from Deezer's CDN via the hash.
          const artworkBuffer = options.prefetchedCover
            || await this.getCachedArtwork(trackInfo.ALB_PICTURE, artworkSize, quality)

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

      // Read the file into a buffer, write tags, then write back.
      // This is more reliable than direct file operations.
      // The read is what establishes the file is there. An exists/stat check
      // first would only open a window in which the file can change between the
      // check and the read, and tells us nothing the read itself cannot.
      let fileBuffer: Buffer
      try {
        fileBuffer = fs.readFileSync(filePath)
      } catch {
        console.error('[Downloader] ERROR: File does not exist before tag write!')
        return
      }
      console.log(`[Downloader] Read file buffer: ${fileBuffer.length} bytes`)

      try {

        // Check if it's a valid MP3 (starts with ID3 tag or MP3 frame sync)
        const hasID3 = fileBuffer[0] === 0x49 && fileBuffer[1] === 0x44 && fileBuffer[2] === 0x33 // "ID3"
        const hasMP3Sync = fileBuffer[0] === 0xFF && (fileBuffer[1] & 0xE0) === 0xE0 // MP3 frame sync
        console.log(`[Downloader] File has ID3 header: ${hasID3}, has MP3 sync: ${hasMP3Sync}`)

        // Write tags to buffer
        const taggedBuffer = NodeID3.write(tags, fileBuffer)

        if (taggedBuffer && Buffer.isBuffer(taggedBuffer)) {
          console.log(`[Downloader] Tagged buffer size: ${taggedBuffer.length} bytes`)
          await this.writeFileAtomic(filePath, taggedBuffer)
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
        'semicolonSpace': '; ',
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

      if (tagSettings.album) {
        // Mirror the folder naming's album source (albumContext → private track
        // field) so the ALBUM tag matches the folder for relinked/duplicate
        // releases (#96), consistent with the MP3 path and the ALBUMARTIST tag.
        const albumTag = options.albumContext?.albumTitle || trackInfo.ALB_TITLE
        if (albumTag) comments.push(`ALBUM=${albumTag}`)
      }

      if (tagSettings.albumArtist) {
        if (isPlaylistCompilation) {
          comments.push(`ALBUMARTIST=Various Artists`)
          comments.push(`COMPILATION=1`)
        } else {
          // Mirror the folder naming's album-artist source (albumContext →
          // public-API resolved → private track fields) so a "Various Artists"
          // release tags ALBUMARTIST consistently with its folder (issue #83).
          const rawAlbumArtist = options.albumContext?.albumArtist || options._resolvedAlbumArtist || trackInfo.ALB_ART_NAME || trackInfo.ART_NAME || ''
          const albumArtist = this.handleVariousArtists(rawAlbumArtist, keepVariousArtists)
          const finalAlbumArtist = albumArtist || processedArtist || rawAlbumArtist
          if (finalAlbumArtist) {
            comments.push(`ALBUMARTIST=${finalAlbumArtist}`)
          }
        }
      }

      // RELEASETYPE — lets Navidrome separate albums/singles/EPs (#82). Both keys
      // are in Navidrome's releasetype alias list (Vorbis). See mapReleaseType().
      // Default-on when the key is absent (settings synced before this tag
      // existed) — matches the refresh path; only an explicit opt-out suppresses it (#85).
      if (tagSettings.releaseType !== false) {
        const releaseType = this.mapReleaseType(options.albumContext?.recordType || options._resolvedAlbumRecordType)
        if (releaseType) {
          comments.push(`RELEASETYPE=${releaseType}`)
          comments.push(`MUSICBRAINZ_ALBUMTYPE=${releaseType}`)
        }
      }

      // REPLAYGAIN_TRACK_GAIN — same as the MP3 path. Metadata only; audio
      // bytes preserved verbatim. Default OFF — opt-in truthy gate.
      if (tagSettings.replayGain) {
        const rg = replayGainString(trackInfo.GAIN)
        if (rg) comments.push(`REPLAYGAIN_TRACK_GAIN=${rg}`)
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

      // Same public-API resolver cascade as the ID3 path (v1.8.2) — trackInfo.* is empty here.
      const vorbisUpc = options.albumContext?.upc || options._resolvedAlbumUpc || trackInfo.ALB_UPC || ''
      const vorbisLabel = options.albumContext?.label || options._resolvedAlbumLabel || trackInfo.LABEL_NAME || ''

      if (tagSettings.albumBarcode && vorbisUpc) {
        comments.push(`BARCODE=${vorbisUpc}`)
      }

      if (tagSettings.albumLabel && vorbisLabel) {
        comments.push(`LABEL=${vorbisLabel}`)
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
      if (tagSettings.cover && options.embedArtwork && (trackInfo.ALB_PICTURE || options.prefetchedCover)) {
        try {
          const artworkSize = albumCoverSettings.embeddedArtworkSize || 800
          const quality = albumCoverSettings.jpegImageQuality || 90

          // Prefer a pre-fetched cover (Qobuz) over the Deezer-hash CDN fetch.
          pictureData = options.prefetchedCover
            || await this.getCachedArtwork(trackInfo.ALB_PICTURE, artworkSize, quality)
          console.log(`[Downloader] FLAC cover: ${pictureData.length} bytes`)
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
    // Non-Deezer sources (Qobuz) supply the genre name directly — no Deezer
    // album lookup or genre-id mapping applies to their ids.
    if (Array.isArray(trackInfo._directGenres) && trackInfo._directGenres.length > 0) {
      return trackInfo._directGenres
    }
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
      console.error(`[Downloader] Failed to fetch album genres: ${logSafe(error.message)}`)
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

      const req = https.get(url, { timeout: 15000 }, (res) => {
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
      })
      req.on('timeout', () => {
        req.destroy(new Error('Genre fetch timed out'))
      })
      req.on('error', (e) => {
        console.error(`[Downloader] Public API request failed:`, logSafe(e.message))
        resolve([])
      })
    })
  }

  /** Save a pre-fetched cover buffer as the folder's cover file (Qobuz path —
   *  no Deezer CDN hash to fetch from). Honors the same albumCovers settings as
   *  saveArtwork(): saveCovers toggle, cover name template, never overwrites an
   *  existing non-empty cover. */
  private async saveArtworkBuffer(cover: Buffer, outputDir: string, options: DownloadOptions): Promise<void> {
    const albumCoverSettings = options.metadataSettings?.albumCovers || {
      saveCovers: true,
      coverNameTemplate: 'cover'
    }
    if (!albumCoverSettings.saveCovers) return

    const coverName = albumCoverSettings.coverNameTemplate || 'cover'
    const artworkPath = path.join(outputDir, `${coverName}.jpg`)

    // This path belongs to a playlist, so a single track's album art is the
    // wrong image for it. Leave it to savePlaylistCover.
    if (this.playlistCoverPaths.has(artworkPath)) return

    // A non-empty cover already on disk means another worker got here first.
    // Nothing needs unlinking: the atomic write replaces whatever is there in a
    // single step, so a zero-byte leftover is overwritten rather than removed
    // into a window where the path is briefly absent.
    if (fs.existsSync(artworkPath) && fs.statSync(artworkPath).size > 0) return
    await this.writeFileAtomic(artworkPath, cover)
    console.log(`[Downloader] Saved Qobuz artwork: ${artworkPath} (${cover.length} bytes)`)
  }

  /**
   * Write a file so no concurrent worker can observe a partial result.
   *
   * The queue runs maxConcurrent workers and several tracks from one album share
   * a single cover path, which reservedPaths does not cover (it guards track
   * outputs only). A plain writeFileSync there lets two workers interleave and
   * leave a truncated or zero-byte file. Writing to a unique temp name and
   * renaming makes the swap atomic within the filesystem, so the last writer
   * wins whole and no reader ever sees a half-written file.
   */
  private async writeFileAtomic(targetPath: string, data: Buffer): Promise<void> {
    const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.promises.writeFile(tmpPath, data)
      try {
        await this.renameWithRetry(tmpPath, targetPath)
      } catch (renameError: any) {
        // Windows: a virus scanner, Explorer's thumbnail pass or a cloud-sync
        // client can hold the new file long enough that every rename attempt
        // fails with EPERM/EBUSY. Landing the bytes non-atomically beats the
        // v2.5.8–2.6.2 behaviour of leaving a stray .tmp and no cover at all
        // (#159). The tmp is removed in `finally` below.
        if (!Downloader.isTransientFsError(renameError)) throw renameError
        console.warn(`[Downloader] Rename kept failing (${renameError.code}), writing ${targetPath} directly`)
        await fs.promises.writeFile(targetPath, data)
      }
    } finally {
      await Downloader.unlinkWithRetry(tmpPath)
    }
    await Downloader.sweepStaleTmpSiblings(targetPath)
  }

  // EPERM / EACCES / EBUSY on Windows usually mean "another process has a
  // handle on this file right now", not a real permission problem. Retry.
  private static isTransientFsError(error: any): boolean {
    const code = error?.code
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
  }

  // Backoff schedule: ~3 s in total, most locks clear within the first 100 ms.
  private static readonly RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1000]

  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(from, to)
        return
      } catch (error: any) {
        const delay = Downloader.RENAME_RETRY_DELAYS_MS[attempt]
        if (delay === undefined || !Downloader.isTransientFsError(error)) throw error
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  // Best-effort removal of a staging file. A locked tmp gets the same patience
  // as the rename; if it still will not go, say so and name the path.
  private static async unlinkWithRetry(tmpPath: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.unlink(tmpPath)
        return
      } catch (error: any) {
        if (error?.code === 'ENOENT') return
        const delay = Downloader.RENAME_RETRY_DELAYS_MS[attempt]
        if (delay === undefined || !Downloader.isTransientFsError(error)) {
          console.warn(`[Downloader] Could not remove staging file ${tmpPath} (${error?.code || error})`)
          return
        }
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  // Remove `<name>.<pid>.<hex>.tmp` leftovers from earlier runs that sat next
  // to this target (the #159 symptom), so a re-sync cleans a folder up instead
  // of adding to the pile. Only other processes' pids are touched: a tmp with
  // our own pid may belong to a concurrent worker that has not renamed yet.
  private static async sweepStaleTmpSiblings(targetPath: string): Promise<void> {
    const dir = path.dirname(targetPath)
    const base = path.basename(targetPath)
    const stale = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.[0-9a-f]{8}\\.tmp$`)
    let entries: string[]
    try {
      entries = await fs.promises.readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const match = stale.exec(entry)
      if (!match || Number(match[1]) === process.pid) continue
      try {
        await fs.promises.unlink(path.join(dir, entry))
        console.log(`[Downloader] Removed stale staging file: ${path.join(dir, entry)}`)
      } catch { /* best effort */ }
    }
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

      // This path belongs to a playlist, so a single track's album art is the
      // wrong image for it. Leave it to savePlaylistCover.
      if (this.playlistCoverPaths.has(artworkPath)) return

      // Don't overwrite existing artwork
      // A non-empty file already on disk means another worker got here first.
      // The atomic write below replaces whatever is present in one step, so a
      // zero-byte leftover needs no unlink into a briefly-absent state.
      if (fs.existsSync(artworkPath) && fs.statSync(artworkPath).size > 0) {
        console.log(`[Downloader] Artwork already exists: ${artworkPath}`)
        return
      }

      // Deezer CDN only reliably serves JPEG
      const artworkUrl = `https://e-cdns-images.dzcdn.net/images/cover/${albumPicture}/${artworkSize}x${artworkSize}-000000-${quality}-0-0.jpg`

      console.log(`[Downloader] Downloading artwork: ${artworkUrl}`)
      const buffer = await this.downloadBuffer(artworkUrl)

      if (buffer.length > 0) {
        await this.writeFileAtomic(artworkPath, buffer)
        console.log(`[Downloader] Saved artwork: ${artworkPath} (${buffer.length} bytes)`)
      } else {
        console.error('[Downloader] Downloaded artwork is empty')
      }
    } catch (error) {
      console.error('[Downloader] Failed to save artwork:', error)
    }
  }

  private async savePlaylistCover(coverUrl: string, saveDir: string, options: DownloadOptions, playlistName?: string): Promise<void> {
    // Build a unique key for dedup — use dir + playlist name to handle multiple playlists in same dir
    const dedupKey = playlistName ? `${saveDir}:${playlistName}` : saveDir
    if (this.playlistCoverSaved.has(dedupKey)) return
    this.playlistCoverSaved.add(dedupKey)

    // Claim the exact path synchronously, before the async cover fetch below,
    // so album art from a track that finishes first cannot take it.
    const claimName = playlistName
      ? this.sanitizeFilename(playlistName)
      : (options.metadataSettings?.albumCovers?.coverNameTemplate || 'cover')
    this.playlistCoverPaths.add(path.join(saveDir, `${claimName}.jpg`))

    try {
      const albumCoverSettings = options.metadataSettings?.albumCovers || {
        saveCovers: true,
        coverNameTemplate: 'cover',
        localArtworkSize: 1200,
        localArtworkFormat: 'jpeg' as LocalArtworkFormat,
        jpegImageQuality: 90
      }

      if (!albumCoverSettings.saveCovers) return

      // When saving to a dedicated playlist folder, use the cover name template
      // When saving to the root download dir (no playlist folder), use the playlist name
      // to avoid collisions between multiple playlists
      const coverName = playlistName
        ? this.sanitizeFilename(playlistName)
        : (albumCoverSettings.coverNameTemplate || 'cover')
      const artworkPath = path.join(saveDir, `${coverName}.jpg`)

      // Don't overwrite existing artwork
      // A non-empty file already on disk means another worker got here first.
      // The atomic write below replaces whatever is present in one step, so a
      // zero-byte leftover needs no unlink into a briefly-absent state.
      if (fs.existsSync(artworkPath) && fs.statSync(artworkPath).size > 0) {
        console.log(`[Downloader] Playlist cover already exists: ${artworkPath}`)
        return
      }

      // Ensure directory exists
      if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true })
      }

      // Deezer playlist picture URLs are full URLs, request the largest available
      // Replace size in URL if it contains a size pattern, otherwise use as-is
      let url = coverUrl
      const sizeMatch = url.match(/\/(\d+x\d+)/)
      if (sizeMatch) {
        const size = albumCoverSettings.localArtworkSize || 1200
        url = url.replace(sizeMatch[1], `${size}x${size}`)
      }

      console.log(`[Downloader] Downloading playlist cover: ${url}`)
      const buffer = await this.downloadBuffer(url)

      if (buffer.length > 0) {
        await this.writeFileAtomic(artworkPath, buffer)
        console.log(`[Downloader] Saved playlist cover: ${artworkPath} (${buffer.length} bytes)`)
      }
    } catch (error) {
      console.error('[Downloader] Failed to save playlist cover:', error)
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
      // A non-empty file already on disk means another worker got here first.
      // The atomic write below replaces whatever is present in one step, so a
      // zero-byte leftover needs no unlink into a briefly-absent state.
      if (fs.existsSync(artistImagePath) && fs.statSync(artistImagePath).size > 0) {
        console.log(`[Downloader] Artist image already exists: ${artistImagePath}`)
        return
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
        await this.writeFileAtomic(artistImagePath, buffer)
        console.log(`[Downloader] Saved artist image: ${artistImagePath} (${buffer.length} bytes)`)
      } else {
        console.error('[Downloader] Downloaded artist image is empty')
      }
    } catch (error) {
      console.error('[Downloader] Failed to save artist image:', error)
    }
  }

  private async saveLyrics(trackInfo: any, audioPath: string, saveSynced: boolean = true, preferSynced: boolean = false, deleteSuperseded: boolean = false): Promise<void> {
    try {
      if (!trackInfo.LYRICS?.LYRICS_TEXT && !trackInfo.LYRICS?.LYRICS_SYNC_JSON) {
        return
      }

      // Lyrics files must share the audio file's exact basename (players match
      // .lrc/.txt to audio by identical name), so derive it from the real path
      // instead of rebuilding a name from the title — the audio name comes from
      // the user's naming template (track/disc numbers included) and any second
      // naming logic here would drift from it (#104).
      const outputDir = path.dirname(audioPath)
      const baseName = path.basename(audioPath, path.extname(audioPath))

      // An .lrc carries the same words plus timing, so when one is going to be
      // written the .txt is a duplicate. preferSynced skips it, leaving one
      // file per track instead of two (#141). Off by default: turning it on
      // changes what an existing library gets, so it stays the user's call.
      const willWriteLrc = saveSynced && !!trackInfo.LYRICS?.LYRICS_SYNC_JSON

      // Save plain lyrics
      const lyricsPath = path.join(outputDir, `${baseName}.txt`)
      if (trackInfo.LYRICS?.LYRICS_TEXT && !(preferSynced && willWriteLrc)) {
        fs.writeFileSync(lyricsPath, trackInfo.LYRICS.LYRICS_TEXT)
      } else if (preferSynced && willWriteLrc && deleteSuperseded && fs.existsSync(lyricsPath)) {
        // The .txt this run would have skipped already exists from an earlier
        // run; the .lrc written below supersedes it (#141, delete half).
        fs.unlinkSync(lyricsPath)
        console.log(`[Downloader] Removed superseded lyrics file: ${lyricsPath}`)
      }

      // Save synced lyrics as LRC — gated on the "Synced lyrics" setting so users
      // can get plain .txt lyrics without the .lrc file. Default true preserves the
      // prior always-write behavior for everyone who hasn't turned it off.
      if (saveSynced && trackInfo.LYRICS?.LYRICS_SYNC_JSON) {
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

        const req = https.get(requestUrl, { timeout: 30000 }, (response) => {
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
        })
        req.on('timeout', () => {
          req.destroy(new Error('Download timed out'))
        })
        req.on('error', reject)
      }

      makeRequest(url, 0)
    })
  }

  /** Qobuz counterpart of getCachedArtwork: one fetch per album cover, shared
   *  by every track of the album/playlist run. Keyed by the first candidate URL
   *  (candidates only differ in _org/_600 variant of the same image). Returns
   *  undefined when no candidate succeeds — tagging proceeds coverless, same
   *  as the old per-track behavior. */
  private async getCachedQobuzArtwork(candidates: string[]): Promise<Buffer | undefined> {
    if (candidates.length === 0) return undefined
    const cacheKey = `qobuz_${candidates[0]}`
    let artworkPromise = this.artworkCache.get(cacheKey)
    if (!artworkPromise) {
      artworkPromise = (async () => {
        for (const coverUrl of candidates) {
          try {
            const cr = await fetch(coverUrl)
            if (cr.ok) return Buffer.from(await cr.arrayBuffer())
          } catch { /* try next candidate */ }
        }
        throw new Error('No cover candidate succeeded')
      })()
      this.artworkCache.set(cacheKey, artworkPromise)
      artworkPromise.then(() => {
        setTimeout(() => { this.artworkCache.delete(cacheKey) }, 60000)
      }).catch(() => {
        this.artworkCache.delete(cacheKey)
      })
    }
    return artworkPromise.catch(() => undefined)
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
    // NOTE: completed entries MUST remain here for the lifetime of the session.
    // The renderer's updateAlbumProgress() recomputes an album/playlist's
    // completed-track count every poll by looking each track up in this
    // payload; if a completed entry is removed, the album undercounts and can
    // never reach "all done", so a large album (one that takes longer than any
    // prune window to finish) hangs as a permanent fake-active download. A 2.2.3
    // pruning optimization did exactly that and was reverted — do not re-add it
    // without also making album progress independent of this payload.
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
      // Finished items are immutable — the renderer cancels album rows by
      // sending the WHOLE trackIds list (#118), so completed/errored tracks
      // must not be rewritten as 'Cancelled'.
      if (progress.status === 'completed' || progress.status === 'error') return
      progress.status = 'error'
      progress.error = 'Cancelled'
      // Kill the in-flight stream — same AbortController pauseQueue() uses,
      // minus the resume re-queue. Without this, cancel only dequeued pending
      // tracks while the active one streamed to completion (#118).
      const controller = this.downloadAborts.get(downloadId)
      if (controller) {
        this.cancelledDownloadIds.add(downloadId)
        try { controller.abort() } catch (e) { /* already settled */ }
      }
      this.emit('cancelled', progress)
    }
  }

  /**
   * Move a queued download to the front of the queue so it downloads next.
   * Only works for pending downloads (already downloading tracks can't be reordered).
   */
  moveToFront(downloadId: string): boolean {
    const queueIndex = this.downloadQueue.findIndex(d => d.id === downloadId)
    if (queueIndex <= 0) return false // Not found or already first
    const [item] = this.downloadQueue.splice(queueIndex, 1)
    this.downloadQueue.unshift(item)
    console.log(`[Downloader] Moved ${logSafe(downloadId)} to front of queue (was position ${queueIndex + 1})`)
    return true
  }

  /**
   * Reorder the pending queue to match a desired id order (issue #88 follow-up:
   * make drag-and-drop actually reprioritize, not just rearrange the view). Items
   * whose id appears in `orderedIds` are placed in that order at the front; any
   * queue items not listed keep their existing relative order afterward (stable).
   * Returns the number of listed ids that matched real pending downloads.
   */
  reorderPending(orderedIds: string[]): number {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return 0
    const rank = new Map<string, number>()
    orderedIds.forEach((id, i) => { if (!rank.has(String(id))) rank.set(String(id), i) })
    let matched = 0
    this.downloadQueue = this.downloadQueue
      .map((item, i) => ({ item, i }))
      .sort((a, b) => {
        const ra = rank.has(a.item.id) ? rank.get(a.item.id)! : Infinity
        const rb = rank.has(b.item.id) ? rank.get(b.item.id)! : Infinity
        if (ra !== rb) return ra - rb
        return a.i - b.i // stable: preserve original order for ties / unlisted items
      })
      .map(x => x.item)
    for (const id of rank.keys()) if (this.downloadQueue.some(d => d.id === id)) matched++
    console.log(`[Downloader] reorderPending: ${matched} pending downloads reordered`)
    return matched
  }

  /**
   * Clear all downloads — reset queue, active downloads, and counters.
   * Called when user cancels all downloads to ensure clean state.
   */
  clearAll(): void {
    // Abort every in-flight stream first (#118) — clearing the maps alone let
    // active downloads run to completion headless, the same defect as the old
    // cancelDownload. The cancelled marker makes each abort catch exit quietly.
    for (const [id, controller] of this.downloadAborts) {
      this.cancelledDownloadIds.add(id)
      try { controller.abort() } catch (e) { /* already settled */ }
    }
    this.downloadQueue = []
    this.activeDownloads.clear()
    this.currentDownloads = 0
    this._isPaused = false
    this.reservedPaths.clear()
    this.albumInfoCache.clear()
    this.playlistCoverSaved.clear()
    this.playlistCoverPaths.clear()
    // Clear activity timers before clearing trackers
    for (const tracker of this.playlistM3UTracker.values()) {
      if (tracker.activityTimer) clearTimeout(tracker.activityTimer)
    }
    this.playlistM3UTracker.clear()
    console.log('[Downloader] All downloads cleared, state reset')
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
   * Set the download pacing tier (issue #86). 'off' restores full-speed behavior;
   * 'balanced'/'cautious' space out new download starts with a jittered delay to
   * avoid bursty, easily-detected download patterns.
   */
  setPacing(profile: string): void {
    const valid: 'off' | 'balanced' | 'cautious' =
      profile === 'balanced' || profile === 'cautious' ? profile : 'off'
    this.downloadPacing = valid
    console.log(`[Downloader] Download pacing set to: ${valid}`)
    this.processQueue()
  }

  getPacing(): 'off' | 'balanced' | 'cautious' {
    return this.downloadPacing
  }

  /**
   * Pacing gate (issue #86/#88). Called by each real audio download right before
   * the CDN fetch — AFTER the skip check, so already-downloaded files never reach
   * here and skip instantly. When pacing is off it's a true no-op. When on, it
   * serializes concurrent workers via a promise chain and waits out the remaining
   * jittered gap since the last actual download start.
   */
  private async awaitPacingSlot(): Promise<void> {
    if (this.downloadPacing === 'off') return
    const prev = this.pacingChain
    let release!: () => void
    this.pacingChain = new Promise<void>(r => { release = r })
    try {
      await prev
      const base = this.PACING_BASE_MS[this.downloadPacing as 'balanced' | 'cautious']
      const gap = Math.round(base * (0.5 + Math.random())) // jitter ±50%
      const wait = this.lastDownloadStartAt ? gap - (Date.now() - this.lastDownloadStartAt) : 0
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      this.lastDownloadStartAt = Date.now()
    } finally {
      release()
    }
  }

  /**
   * Register a playlist for automatic M3U generation from real file paths.
   * As tracks complete, their actual paths are collected. When all tracks
   * are done, the M3U is generated with paths that match the files on disk.
   */
  registerPlaylistForM3U(trackerId: string, playlistName: string, outputDir: string, totalTracks: number, m3uNameTemplate?: string, kind: 'album' | 'playlist' = 'playlist'): void {
    this.playlistM3UTracker.set(trackerId, {
      outputDir,
      kind,
      totalTracks,
      processedCount: 0,
      m3uNameTemplate: m3uNameTemplate || '%playlist%',
      completedEntries: [],
      playlistName,
      lastActivity: Date.now(),
      activityTimer: null
    })
    console.log(`[Downloader] Registered M3U tracker "${trackerId}" for "${playlistName}" (${totalTracks} tracks)`)
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
  private recordM3UFailure(trackerId: string): void {
    const tracker = this.playlistM3UTracker.get(trackerId)
    if (!tracker) return
    tracker.processedCount++
    // Do NOT reset activity timer for failures — failures are instant (duplicate
    // detection) while real downloads take time. Resetting the timer on failures
    // causes premature M3U generation in bulk operations where many duplicates
    // fire immediately but real downloads haven't started yet.
    this.checkM3UComplete(trackerId)
  }

  private recordM3UEntry(trackerId: string, entry: {
    position: number
    duration: number
    artist: string
    title: string
    absolutePath: string
    playlistFolder?: string
    albumFolder?: string
  }): void {
    const tracker = this.playlistM3UTracker.get(trackerId)
    if (!tracker) return

    // First track that knows its folder pins where the M3U lands (#121).
    //
    // The album folder is a valid target ONLY for album trackers. Playlists used
    // to share one `playlistFolder || albumRootFolder || albumFolder` expression
    // at every call site, so with createPlaylistFolder OFF the playlist M3U was
    // pinned to whichever track finished first and written into that track's
    // album folder instead of the download root (#138). A playlist tracker now
    // accepts only a real playlist folder; absent one, baseDir stays outputDir.
    const candidate = tracker.kind === 'album'
      ? (entry.playlistFolder || entry.albumFolder)
      : entry.playlistFolder
    if (candidate && !tracker.resolvedPlaylistFolder) {
      tracker.resolvedPlaylistFolder = candidate
    }
    tracker.completedEntries.push(entry)
    tracker.processedCount++
    tracker.lastActivity = Date.now()
    this.resetM3UActivityTimer(trackerId)
    this.checkM3UComplete(trackerId)
  }

  /**
   * Activity-based fallback: if no M3U entry has been recorded for 30 seconds
   * and we have at least one entry, generate the M3U with what we have.
   * This catches ALL edge cases where processedCount falls behind totalTracks.
   */
  private resetM3UActivityTimer(trackerId: string): void {
    const tracker = this.playlistM3UTracker.get(trackerId)
    if (!tracker) return

    // Clear existing timer
    if (tracker.activityTimer) {
      clearTimeout(tracker.activityTimer)
    }

    // Set new timer — fires 30s after last SUCCESSFUL download for this playlist
    tracker.activityTimer = setTimeout(() => {
      const t = this.playlistM3UTracker.get(trackerId)
      if (t && t.processedCount < t.totalTracks && t.completedEntries.length > 0) {
        // Only force-generate if we have actual entries — don't kill trackers
        // that haven't had any real downloads yet
        console.log(`[Downloader] M3U activity timeout for "${t.playlistName}" — generating with ${t.completedEntries.length} entries (processed ${t.processedCount}/${t.totalTracks})`)
        t.processedCount = t.totalTracks // Force completion
        this.checkM3UComplete(trackerId)
      }
    }, 30000)
  }

  private checkM3UComplete(trackerId: string): void {
    const tracker = this.playlistM3UTracker.get(trackerId)
    if (!tracker) return

    // Generate M3U when all tracks are processed (success + failure)
    if (tracker.processedCount >= tracker.totalTracks) {
      try {
        if (tracker.completedEntries.length > 0) {
          // Sort by playlist position to maintain order
          tracker.completedEntries.sort((a, b) => a.position - b.position)

          // Write the M3U into the playlist folder (next to the music) when one
          // exists, else the download root — and compute relative paths against
          // that same base so entries stay relative (#121).
          const baseDir = tracker.resolvedPlaylistFolder || tracker.outputDir
          const tracks = tracker.completedEntries.map(e => {
            let relativePath = e.absolutePath
            if (relativePath.startsWith(baseDir)) {
              relativePath = relativePath.slice(baseDir.length)
              relativePath = relativePath.replace(/^[/\\]/, '')
            }
            return {
              duration: e.duration,
              artist: e.artist,
              title: e.title,
              relativePath
            }
          })

          this.generateM3U(tracker.playlistName, baseDir, tracks, tracker.m3uNameTemplate)
          console.log(`[Downloader] M3U generated for "${tracker.playlistName}" (${tracks.length} tracks) at ${baseDir}`)
        } else {
          console.warn(`[Downloader] No M3U entries for "${tracker.playlistName}" — all tracks failed`)
        }
      } catch (err: any) {
        console.error(`[Downloader] Auto M3U generation failed for "${tracker.playlistName}":`, err.message)
      } finally {
        if (tracker.activityTimer) clearTimeout(tracker.activityTimer)
        this.playlistM3UTracker.delete(trackerId)
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
    }>,
    nameTemplate?: string
  ): string {
    try {
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
      const datetime = `${today}_${timeStr}`
      const resolvedName = (nameTemplate || '%playlist%')
        .replace(/%playlist%/gi, playlistName)
        .replace(/%datetime%/gi, datetime)
        .replace(/%date%/gi, today)
        .replace(/%time%/gi, timeStr)
        .replace(/%year%/gi, today.split('-')[0])
        .replace(/%[a-z_]+%/gi, '')
        .replace(/\s*\(\s*\)/g, '').replace(/\s*\[\s*\]/g, '').replace(/\s*\{\s*\}/g, '')
        .trim() || playlistName
      const sanitizedName = this.sanitizeFilename(resolvedName)
      const m3uPath = path.join(outputDir, `${sanitizedName}.m3u8`)

      // Build M3U content
      let content = '#EXTM3U\n'
      content += `#PLAYLIST:${resolvedName}\n\n`

      for (const track of tracks) {
        // EXTINF format: #EXTINF:duration,Artist - Title
        const duration = Math.round(track.duration)
        content += `#EXTINF:${duration},${track.artist} - ${track.title}\n`
        content += `${track.relativePath}\n`
      }

      // Ensure the target directory exists — normally the playlist folder was
      // already created for the music, but guard the root/edge cases so the
      // write can't fail silently on a missing dir (#121).
      fs.mkdirSync(outputDir, { recursive: true })

      // Write the file
      fs.writeFileSync(m3uPath, content, 'utf8')
      console.log(`[Downloader] Generated M3U playlist: ${m3uPath}`)

      return m3uPath
    } catch (error: any) {
      console.error(`[Downloader] Failed to generate M3U at "${outputDir}":`, error.message)
      throw error
    }
  }
}

export const downloader = new Downloader()
