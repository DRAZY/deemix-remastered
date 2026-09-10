import { defineStore } from 'pinia'
import { publicLinkForItem } from '../utils/sourceLinks'
import { ref, computed } from 'vue'
import type { Track, Album, Playlist, DownloadItem, DownloadStatus, FailedTrack, SubstitutedTrack, DownloadHistoryEntry, DownloadTrackEntry } from '../types'
import { useSettingsStore } from './settingsStore'
import { useToastStore } from './toastStore'
import { useAuthStore } from './authStore'

export const useDownloadStore = defineStore('downloads', () => {
  // Use regular ref for proper reactivity
  const downloads = ref<DownloadItem[]>([])
  const downloadHistory = ref<DownloadHistoryEntry[]>([])
  const serverPort = ref(6595)

  // Debounce and idle callback tracking
  let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let idleCallbackId: number | null = null

  // Unified polling state - single loop for ALL downloads
  let unifiedPollingInterval: ReturnType<typeof setInterval> | null = null
  const pollingGroups = new Map<string, { trackIds: string[], type: 'track' | 'album' }>()

  // === PERFORMANCE: O(1) lookup Maps for duplicate detection ===
  // These Maps are updated whenever downloads change, providing instant lookups
  const trackIdToStatus = new Map<number | string, DownloadStatus>()
  const albumIdToStatus = new Map<number | string, DownloadStatus>()
  const playlistIdToStatus = new Map<number | string, DownloadStatus>()

  // === PERFORMANCE: Adaptive polling configuration ===
  const POLLING_INTERVALS = {
    idle: 5000,      // 5s when no active downloads
    light: 3000,     // 3s when 1-3 active downloads
    moderate: 2000,  // 2s when 4-10 active downloads
    heavy: 1500      // 1.5s when >10 active downloads
  }
  let currentPollingInterval = POLLING_INTERVALS.moderate

  // Normalize a catalog track id to the numeric form the status-map lookups
  // use (isTrackInQueue/isTrackCompleted parseInt string ids before .get()).
  function asCatalogKey(id: number | string): number {
    return typeof id === 'string' ? parseInt(id, 10) : id
  }

  // Quality tiers, comparable across the renderer's requested labels
  // ('128' | '320' | 'flac') and the server's delivered labels ('MP3_128' |
  // 'MP3_320' | 'FLAC', Qobuz 'FLAC 24/96'). 0 means unknown, which callers
  // must read as "cannot compare", never as "lowest".
  function tierRank(format?: string | null): number {
    if (!format) return 0
    const f = String(format).toUpperCase()
    if (f.startsWith('FLAC')) return 3
    if (f === '320' || f === 'MP3_320') return 2
    if (f === '128' || f === 'MP3_128') return 1
    return 0
  }

  // Tier the newest completed row for this item actually delivered, falling
  // back to what it requested when the server never reported a delivered
  // format. Album and playlist rows count for the tracks they contain, the
  // same way rebuildLookupMaps registers their catalog ids. downloads is
  // newest-first, so the first hit is the freshest.
  function completedTierRank(kind: 'track' | 'album' | 'playlist', id: number | string): number {
    const key = asCatalogKey(id)
    for (const d of downloads.value) {
      if (d.refresh || d.status !== 'completed') continue
      let hit = false
      if (kind === 'track') {
        hit = (d.track?.id != null && asCatalogKey(d.track.id) === key) ||
          (d.catalogTrackIds?.some(cid => asCatalogKey(cid) === key) ?? false)
      } else if (kind === 'album') {
        hit = d.type === 'album' && d.album?.id != null && asCatalogKey(d.album.id) === key
      } else {
        hit = d.type === 'playlist' && d.playlist?.id != null && asCatalogKey(d.playlist.id) === key
      }
      if (hit) return tierRank(d.actualFormat || d.quality)
    }
    return 0
  }

  // True when the item is marked downloaded but at a lower tier than the
  // quality currently selected in Settings: it went down as MP3 128, say, and
  // the user has since switched to 320 or FLAC. Asking for it again is an
  // upgrade, not a duplicate, so the "already downloaded" gate steps aside and
  // the server's tier-aware skip check (isLowerTier) does the rest (#144).
  // Unknown tiers never unlock; a same-or-higher tier on disk keeps the toast.
  function isCompletedAtLowerTier(kind: 'track' | 'album' | 'playlist', id: number | string): boolean {
    const want = tierRank(useSettingsStore().settings.quality)
    const have = completedTierRank(kind, id)
    return want > 0 && have > 0 && have < want
  }

  // Helper to rebuild lookup Maps from downloads array
  function rebuildLookupMaps() {
    trackIdToStatus.clear()
    albumIdToStatus.clear()
    playlistIdToStatus.clear()

    for (const d of downloads.value) {
      // Refresh-tags items are not downloads — they must not contribute to the
      // downloaded/in-queue status maps (otherwise refreshing an album would
      // make it look downloaded).
      if (d.refresh) continue
      if (d.track?.id) {
        trackIdToStatus.set(d.track.id, d.status)
      }
      // Album/playlist rows also register their contained catalog track ids,
      // so re-attempting one of those songs as a single hits the same
      // "already downloaded" toast as a plain single — instead of creating a
      // queue row only the server's ISRC layer can skip. Failed tracks are
      // excluded: they must stay re-downloadable.
      if (d.catalogTrackIds?.length) {
        const failed = new Set(
          (d.failedTracks || [])
            .map(f => f.trackId != null ? asCatalogKey(f.trackId) : NaN)
            .filter(k => !Number.isNaN(k))
        )
        for (const cid of d.catalogTrackIds) {
          const key = asCatalogKey(cid)
          if (Number.isNaN(key) || failed.has(key)) continue
          // Never overwrite an entry already set — single-track rows are more
          // specific, and iteration is newest-first so the freshest row wins.
          if (!trackIdToStatus.has(key)) trackIdToStatus.set(key, d.status)
        }
      }
      if (d.type === 'album' && d.album?.id) {
        albumIdToStatus.set(d.album.id, d.status)
      }
      if (d.type === 'playlist' && d.playlist?.id) {
        playlistIdToStatus.set(d.playlist.id, d.status)
      }
    }
  }

  // Helper to get optimal polling interval based on active downloads
  function getOptimalPollingInterval(): number {
    const activeCount = pollingGroups.size
    if (activeCount === 0) return POLLING_INTERVALS.idle
    if (activeCount <= 3) return POLLING_INTERVALS.light
    if (activeCount <= 10) return POLLING_INTERVALS.moderate
    return POLLING_INTERVALS.heavy
  }

  // Computed properties - these are cached and only recalculate when downloads changes
  const activeDownloads = computed(() =>
    downloads.value.filter(d => d.status === 'pending' || d.status === 'downloading')
  )

  const completedDownloads = computed(() =>
    downloads.value.filter(d => d.status === 'completed')
  )

  const failedDownloads = computed(() =>
    downloads.value.filter(d => d.status === 'error')
  )

  // Total download speed across all active downloads
  const totalDownloadSpeed = computed(() => {
    return activeDownloads.value.reduce((sum, d) => sum + (d.speed || 0), 0)
  })

  // Queue pause state
  const isPaused = ref(false)

  // Ids of downloads that were interrupted by the app closing and flagged on the
  // most recent startup (#98). Captured so auto-resume only touches this-session
  // interruptions, never a user's genuine prior failures.
  const interruptedDownloadIds = ref<string[]>([])

  // ============================================
  // DUPLICATE DETECTION HELPERS
  // These check if items are already in the active queue
  // ============================================

  /**
   * Check if a track is already in the download queue (pending or downloading)
   * O(1) lookup using Map instead of O(n) array search
   * @param trackId - Deezer track ID
   * @returns true if track is already queued
   */
  function isTrackInQueue(trackId: number | string): boolean {
    const id = typeof trackId === 'string' ? parseInt(trackId, 10) : trackId
    const status = trackIdToStatus.get(id)
    return status === 'pending' || status === 'downloading'
  }

  /**
   * Check if an album is already in the download queue (pending or downloading)
   * O(1) lookup using Map instead of O(n) array search
   * @param albumId - Deezer album ID
   * @returns true if album is already queued
   */
  function isAlbumInQueue(albumId: number | string): boolean {
    const id = typeof albumId === 'string' ? parseInt(albumId, 10) : albumId
    const status = albumIdToStatus.get(id)
    return status === 'pending' || status === 'downloading'
  }

  /**
   * Check if a playlist is already in the download queue (pending or downloading)
   * O(1) lookup using Map instead of O(n) array search
   * @param playlistId - Deezer playlist ID
   * @returns true if playlist is already queued
   */
  function isPlaylistInQueue(playlistId: number | string): boolean {
    const id = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId
    const status = playlistIdToStatus.get(id)
    return status === 'pending' || status === 'downloading'
  }

  /**
   * Get the download item for a track if it's in the queue
   * @param trackId - Deezer track ID
   * @returns DownloadItem or undefined
   */
  function getTrackDownload(trackId: number | string): DownloadItem | undefined {
    const id = typeof trackId === 'string' ? parseInt(trackId, 10) : trackId
    return downloads.value.find(d =>
      d.track?.id === id &&
      (d.status === 'pending' || d.status === 'downloading')
    )
  }

  /**
   * Get the download item for an album if it's in the queue
   * @param albumId - Deezer album ID
   * @returns DownloadItem or undefined
   */
  function getAlbumDownload(albumId: number | string): DownloadItem | undefined {
    const id = typeof albumId === 'string' ? parseInt(albumId, 10) : albumId
    return downloads.value.find(d =>
      d.type === 'album' &&
      d.album?.id === id &&
      (d.status === 'pending' || d.status === 'downloading')
    )
  }

  /**
   * Get the download item for a playlist if it's in the queue
   * @param playlistId - Deezer playlist ID
   * @returns DownloadItem or undefined
   */
  function getPlaylistDownload(playlistId: number | string): DownloadItem | undefined {
    const id = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId
    return downloads.value.find(d =>
      d.type === 'playlist' &&
      d.playlist?.id === id &&
      (d.status === 'pending' || d.status === 'downloading')
    )
  }

  // ============================================
  // COMPLETED DOWNLOAD DETECTION HELPERS
  // These check if items have already been downloaded
  // ============================================

  /**
   * Check if a track has already been downloaded (completed status)
   * O(1) lookup using Map instead of O(n) array search
   * @param trackId - Deezer track ID
   * @returns true if track was already downloaded
   */
  function isTrackCompleted(trackId: number | string): boolean {
    const id = typeof trackId === 'string' ? parseInt(trackId, 10) : trackId
    return trackIdToStatus.get(id) === 'completed'
  }

  /**
   * Check if an album has already been downloaded (completed status)
   * O(1) lookup using Map instead of O(n) array search
   * @param albumId - Deezer album ID
   * @returns true if album was already downloaded
   */
  function isAlbumCompleted(albumId: number | string): boolean {
    const id = typeof albumId === 'string' ? parseInt(albumId, 10) : albumId
    return albumIdToStatus.get(id) === 'completed'
  }

  /**
   * Check if a playlist has already been downloaded (completed status)
   * O(1) lookup using Map instead of O(n) array search
   * @param playlistId - Deezer playlist ID
   * @returns true if playlist was already downloaded
   */
  function isPlaylistCompleted(playlistId: number | string): boolean {
    const id = typeof playlistId === 'string' ? parseInt(playlistId, 10) : playlistId
    return playlistIdToStatus.get(id) === 'completed'
  }

  async function pauseQueue() {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/queue/pause`, {
        method: 'POST'
      })
      if (response.ok) {
        const data = await response.json()
        isPaused.value = data.isPaused
        const toastStore = useToastStore()
        toastStore.info('Downloads paused')
      }
    } catch (e) {
      console.error('[DownloadStore] Failed to pause queue:', e)
    }
  }

  async function resumeQueue() {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/queue/resume`, {
        method: 'POST'
      })
      if (response.ok) {
        const data = await response.json()
        isPaused.value = data.isPaused
        const toastStore = useToastStore()
        toastStore.info('Downloads resumed')
      }
    } catch (e) {
      console.error('[DownloadStore] Failed to resume queue:', e)
    }
  }

  async function fetchQueueStatus() {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/queue/status`)
      if (response.ok) {
        const data = await response.json()
        isPaused.value = data.isPaused
      }
    } catch (e) {
      console.error('[DownloadStore] Failed to fetch queue status:', e)
    }
  }

  async function init() {
    if (window.electronAPI) {
      serverPort.value = await window.electronAPI.getServerPort()
    }
    // Queue + history state-of-record is a real userData file (via IPC) — the
    // same pattern credentials use, because renderer localStorage under
    // file:// has proven lossy across app updates (users lost their entire
    // Transfer Rack and history on every version roll). localStorage remains
    // as the dev/browser fallback and as the migration source for installs
    // predating the file.
    let saved: string | null = null
    try {
      const diskState = await window.electronAPI?.storage?.loadDownloadsState?.()
      if (diskState) {
        saved = JSON.stringify(diskState.downloads || [])
        downloadHistory.value = Array.isArray(diskState.downloadHistory) ? diskState.downloadHistory : []
      }
    } catch (e) {
      console.error('[DownloadStore] Disk state load failed, falling back to localStorage:', e)
    }
    if (saved === null) {
      // First run on this build (or non-Electron context): migrate whatever
      // localStorage still holds, then persist it to disk below.
      saved = localStorage.getItem('downloads')
      const savedHistory = localStorage.getItem('downloadHistory')
      if (savedHistory) {
        try { downloadHistory.value = JSON.parse(savedHistory) } catch { /* keep empty */ }
      }
    }
    if (saved) {
      try {
        downloads.value = JSON.parse(saved)
        // Any item still marked in-flight was interrupted by the app closing —
        // the download queue restarts empty, so nothing is actually running and
        // it would otherwise sit as a permanent "downloading" zombie with no way
        // to resume except deleting and re-adding the link (issue #81). Flip it
        // to `error` so the existing per-item retry control appears and
        // retryDownload()/retryFailedTracks() can re-run it (already-downloaded
        // files are skipped, so it effectively resumes). Refresh (retag) items
        // are skipped — retrying one routes through addAlbumDownload WITHOUT the
        // refresh flag, which would re-download instead of re-tag.
        let interrupted = 0
        const interruptedIds: string[] = []
        for (const d of downloads.value) {
          if ((d.status === 'downloading' || d.status === 'pending') && !d.refresh) {
            d.status = 'error'
            d.error = 'Interrupted — the app closed before this finished. Click retry to resume (already-downloaded tracks are skipped).'
            d.speed = 0
            interrupted++
            interruptedIds.push(d.id)
          }
        }
        // Remember these for opt-in auto-resume (#98). Auto-resume runs later,
        // after auth is restored (see resumeInterruptedDownloads), so a resume
        // can actually reach Deezer. If the setting is off they just stay as
        // one-click-retryable, exactly as before.
        interruptedDownloadIds.value = interruptedIds
        // Rebuild O(1) lookup Maps after loading
        rebuildLookupMaps()
        // Persist the corrected statuses so a second restart stays consistent.
        if (interrupted > 0) {
          console.log(`[DownloadStore] Marked ${interrupted} interrupted download(s) as retryable on startup`)
          saveDownloads()
        }
      } catch (e) {
        console.error('Failed to load downloads:', e)
      }
    }
    // Ensure the on-disk copy exists/reflects whatever we just loaded — this is
    // what completes the one-time localStorage → file migration.
    persistStateToDisk()
    // Sync settings to server
    await syncSettingsToServer()
    // Fetch initial queue status (pause state)
    await fetchQueueStatus()
  }

  function recordHistory(item: DownloadItem) {
    // A "Refresh tags" run is not a download — keep it out of history (and
    // therefore out of stats, which are derived from history). Single chokepoint
    // so no call site can accidentally log a refresh.
    if (item.refresh) return
    const entry: DownloadHistoryEntry = {
      id: item.id,
      title: item.title,
      artist: item.artist,
      type: item.type,
      source: item.source,
      quality: item.quality,
      actualFormat: item.actualFormat,
      substituted: item.substituted,
      substitutedTracks: item.substitutedTracks,
      skippedAsDuplicate: item.skippedAsDuplicate,
      path: item.path,
      link: publicLinkForItem(item) ?? undefined,
      status: item.status === 'completed' ? 'completed' : 'error',
      error: item.error,
      completedAt: new Date().toISOString(),
      totalTracks: item.totalTracks,
      failedTracks: item.failedTracks?.length
    }
    downloadHistory.value.unshift(entry)
    // Keep last 500 entries
    if (downloadHistory.value.length > 500) {
      downloadHistory.value = downloadHistory.value.slice(0, 500)
    }
    localStorage.setItem('downloadHistory', JSON.stringify(downloadHistory.value))
    persistStateToDisk()
  }

  function clearHistory() {
    downloadHistory.value = []
    localStorage.removeItem('downloadHistory')
    persistStateToDisk()
  }

  async function syncSettingsToServer() {
    const settingsStore = useSettingsStore()

    // Ensure settings are loaded before syncing — on Windows, userData reads
    // can be slower and the store may not be ready when downloads are triggered
    if (!settingsStore.isLoaded) {
      console.log('[DownloadStore] Settings not yet loaded, waiting...')
      await settingsStore.loadSettings()
    }

    try {
      const qualityMap: Record<string, string> = {
        '128': 'MP3_128',
        '320': 'MP3_320',
        'flac': 'FLAC'
      }

      console.log(`[DownloadStore] Syncing settings to server - quality: ${settingsStore.settings.quality}, downloadPath: ${settingsStore.settings.downloadPath}`)

      const settingsToSync: Record<string, any> = {
        quality: qualityMap[settingsStore.settings.quality] || 'MP3_320',
        maxConcurrentDownloads: settingsStore.settings.maxConcurrentDownloads,
        downloadPacing: settingsStore.settings.downloadPacing,
        overwriteFiles: settingsStore.settings.overwriteFiles,
        skipDuplicateTracks: settingsStore.settings.skipDuplicateTracks,
        bitrateFallback: settingsStore.settings.bitrateFallback,
        isrcFallback: settingsStore.settings.isrcFallback,
        createErrorLog: settingsStore.settings.createErrorLog,
        createPlaylistFile: settingsStore.settings.createPlaylistFile,
        // Must be listed explicitly: this payload is an allowlist, and the server
        // only overwrites keys the body actually carries. Omitting it left the
        // server on its own default of true forever, so unticking the box in
        // Settings changed nothing and album M3Us kept being written (#131).
        createAlbumPlaylistFile: settingsStore.settings.createAlbumPlaylistFile,
        clearQueueOnClose: settingsStore.settings.clearQueueOnClose,
        createPlaylistFolder: settingsStore.settings.createPlaylistFolder,
        createArtistFolder: settingsStore.settings.createArtistFolder,
        createAlbumFolder: settingsStore.settings.createAlbumFolder,
        createCDFolder: settingsStore.settings.createCDFolder,
        createPlaylistStructure: settingsStore.settings.createPlaylistStructure,
        createSinglesStructure: settingsStore.settings.createSinglesStructure,
        createShortReleaseFolder: settingsStore.settings.createShortReleaseFolder,
        playlistFolderTemplate: settingsStore.settings.playlistFolderTemplate,
        albumFolderTemplate: settingsStore.settings.albumFolderTemplate,
        artistFolderTemplate: settingsStore.settings.artistFolderTemplate,
        trackNameTemplate: settingsStore.settings.trackNameTemplate,
        albumTrackTemplate: settingsStore.settings.albumTrackTemplate,
        playlistTrackTemplate: settingsStore.settings.playlistTrackTemplate,
        m3uNameTemplate: settingsStore.settings.m3uNameTemplate,
        saveArtwork: settingsStore.settings.saveArtwork,
        embedArtwork: settingsStore.settings.embedArtwork,
        saveLyrics: settingsStore.settings.saveLyrics,
        syncedLyrics: settingsStore.settings.syncedLyrics,
        preferSyncedLyrics: settingsStore.settings.preferSyncedLyrics,
        tags: settingsStore.settings.tags,
        albumCovers: settingsStore.settings.albumCovers,
        savePlaylistAsCompilation: settingsStore.settings.savePlaylistAsCompilation,
        useNullSeparator: settingsStore.settings.useNullSeparator,
        saveID3v1: settingsStore.settings.saveID3v1,
        saveOnlyMainArtist: settingsStore.settings.saveOnlyMainArtist,
        keepVariousArtists: settingsStore.settings.keepVariousArtists,
        removeAlbumVersion: settingsStore.settings.removeAlbumVersion,
        removeArtistCombinations: settingsStore.settings.removeArtistCombinations,
        artistSeparator: settingsStore.settings.artistSeparator,
        dateFormatFlac: settingsStore.settings.dateFormatFlac,
        featuredArtistsHandling: settingsStore.settings.featuredArtistsHandling,
        titleCasing: settingsStore.settings.titleCasing,
        artistCasing: settingsStore.settings.artistCasing,
        previewVolume: settingsStore.settings.previewVolume
        // executeAfterDownload removed - security risk
      }

      if (settingsStore.settings.downloadPath) {
        settingsToSync.downloadPath = settingsStore.settings.downloadPath
      }

      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsToSync)
      })

      if (!response.ok) {
        console.error(`[DownloadStore] Settings sync failed with status ${response.status}`)
      } else {
        console.log('[DownloadStore] Settings synced to server successfully')
      }
    } catch (e) {
      console.error('[DownloadStore] Failed to sync settings:', e)
    }
  }

  // Helper to safely extract artist name
  function extractArtistName(artist: any): string | undefined {
    if (!artist) return undefined
    if (typeof artist === 'string') return artist
    if (artist !== null && typeof artist === 'object' && 'name' in artist) {
      return artist.name
    }
    return undefined
  }

  // Helper to safely extract cover URL
  function extractCoverUrl(item: any, ...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = item[key]
      if (value && typeof value === 'string') return value
    }
    return undefined
  }

  async function addDownload(track: Track, { skipSync = false, playlistName = '' } = {}) {
    const toastStore = useToastStore()

    // Check if already downloaded (completed). A completed row at a lower tier
    // than the current quality setting is an upgrade request, not a repeat (#144).
    if (isTrackCompleted(track.id)) {
      if (isCompletedAtLowerTier('track', track.id)) {
        console.log(`[DownloadStore] Track ${track.id} was downloaded at a lower tier — re-downloading at current quality`)
      } else {
        toastStore.info(`"${track.title}" was already downloaded`)
        console.log(`[DownloadStore] Track ${track.id} already completed, skipping`)
        return // Early return - already downloaded
      }
    }

    // Check for duplicate - prevent adding track already in queue
    if (isTrackInQueue(track.id)) {
      toastStore.info(`"${track.title}" is already downloading`)
      console.log(`[DownloadStore] Track ${track.id} already in queue, skipping`)
      return // Early return - don't add duplicate
    }

    if (!skipSync) await syncSettingsToServer()
    const settingsStore = useSettingsStore()

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    const item: DownloadItem = {
      id: tempId,
      track,
      source: (track as any).source === 'qobuz' ? 'qobuz' : 'deezer',
      title: track.title,
      artist: extractArtistName(track.artist),
      cover: extractCoverUrl(track.album || {}, 'cover_medium', 'cover_big', 'cover_small', 'cover') || (typeof track.cover === 'string' ? track.cover : undefined),
      progress: 0,
      status: 'pending',
      type: 'track',
      addedAt: new Date().toISOString(),
      quality: settingsStore.settings.quality
    }

    downloads.value = [item, ...downloads.value]
    // Update O(1) lookup Map immediately
    if (track.id) {
      trackIdToStatus.set(track.id, 'pending')
    }
    saveDownloads()

    try {
      // Qobuz-sourced search results route to the Qobuz download endpoint (which
      // returns { downloadId }); Deezer uses /api/download (returns { id }).
      const isQobuz = (track as any).source === 'qobuz'
      const requestBody: Record<string, any> = { trackId: isQobuz ? ((track as any).qobuzId ?? track.id) : track.id }
      if (playlistName && !isQobuz) requestBody.playlistName = playlistName
      const endpoint = isQobuz ? '/api/qobuz/download' : '/api/download'
      const response = await fetch(`http://127.0.0.1:${serverPort.value}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = errorData.error || 'Download request failed'

        // Handle session expiration - trigger auth store to handle re-login
        if (response.status === 401 || errorMsg.toLowerCase().includes('session expired')) {
          const toastStore = useToastStore()
          toastStore.error('Session expired. Please log in again to download.')
          throw new Error('Session expired: Please log in again')
        }

        throw new Error(errorMsg)
      }

      const data = await response.json()
      const dlId = data.id || data.downloadId
      if (dlId) {
        // Cancelled while the enqueue request was in flight (#118): the row is
        // gone, so stop the server work the response just created.
        if (!downloads.value.some(d => d.id === item.id)) {
          cancelServerIds([dlId])
          return
        }
        item.id = dlId
        saveDownloads()
        registerForPolling(dlId, [dlId], 'track')
      } else {
        throw new Error('Server did not return a download ID')
      }
    } catch (error: any) {
      console.error('[DownloadStore] Download error:', error.message)
      updateDownloadStatus(tempId, 'error', error.message || String(error))
    }
  }

  async function addAlbumDownload(album: Album, tracks: Track[], refreshTags = false) {
    const toastStore = useToastStore()

    // Qobuz-sourced album/playlist → grouped Qobuz download path.
    if ((album as any).source === 'qobuz') {
      const qType = (album as any).qobuzType === 'playlist' ? 'playlist' : 'album'
      await addQobuzAlbumDownload({ type: qType, id: String((album as any).qobuzId ?? album.id), data: (album as any).qobuzData || album })
      return
    }

    // Check if already downloaded (completed). Refresh-tags intentionally
    // re-processes existing files, so it bypasses this guard.
    if (!refreshTags && isAlbumCompleted(album.id)) {
      if (isCompletedAtLowerTier('album', album.id)) {
        console.log(`[DownloadStore] Album ${album.id} was downloaded at a lower tier — re-downloading at current quality (#144)`)
      } else {
        toastStore.info(`"${album.title}" was already downloaded`)
        console.log(`[DownloadStore] Album ${album.id} already completed, skipping`)
        return // Early return - already downloaded
      }
    }

    // Check for duplicate - prevent adding album already in queue
    if (isAlbumInQueue(album.id)) {
      toastStore.info(`"${album.title}" is already downloading`)
      console.log(`[DownloadStore] Album ${album.id} already in queue, skipping`)
      return // Early return - don't add duplicate
    }

    // Check if album folder already exists on disk
    try {
      const checkResponse = await fetch(`http://127.0.0.1:${serverPort.value}/api/album/check?id=${album.id}`)
      const checkData = await checkResponse.json()
      if (checkData.exists && checkData.trackCount > 0) {
        toastStore.info(`"${album.title}" already exists on disk (${checkData.trackCount}/${checkData.albumTracks} tracks) — downloading anyway`)
      }
    } catch { /* ignore check failures — don't block download */ }

    await syncSettingsToServer()
    const settingsStore = useSettingsStore()

    const albumId = `album_${album.id}_${Date.now()}`

    const item: DownloadItem = {
      id: albumId,
      album,
      source: 'deezer',
      title: album.title,
      artist: extractArtistName(album.artist),
      cover: extractCoverUrl(album, 'cover_medium', 'cover_big', 'cover_small', 'cover_xl', 'cover'),
      progress: 0,
      status: 'pending',
      type: 'album',
      addedAt: new Date().toISOString(),
      quality: settingsStore.settings.quality,
      totalTracks: tracks.length,
      completedTracks: 0,
      failedTracks: [],
      trackIds: [],
      catalogTrackIds: tracks.map(t => t.id),
      refresh: refreshTags
    }

    downloads.value = [item, ...downloads.value]
    // Update O(1) lookup Map immediately — but a refresh must NOT touch the
    // album's downloaded-status (it's a tag operation, not a download).
    if (album.id && !refreshTags) {
      albumIdToStatus.set(album.id, 'pending')
    }
    saveDownloads()

    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/download/album`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ albumId: album.id, refreshTags })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = errorData.error || 'Album download request failed'

        // Handle session expiration - trigger auth store to handle re-login
        if (response.status === 401 || errorMsg.toLowerCase().includes('session expired')) {
          const toastStore = useToastStore()
          toastStore.error('Session expired. Please log in again to download.')
          throw new Error('Session expired: Please log in again')
        }

        throw new Error(errorMsg)
      }

      const data = await response.json()
      if (data.ids && data.ids.length > 0) {
        // Cancelled while the enqueue request was in flight (#118): the row is
        // gone, so stop the server work the response just created.
        if (!downloads.value.some(d => d.id === item.id)) {
          cancelServerIds(data.ids)
          return
        }
        console.log(`[DownloadStore] Album ${item.title}: received ${data.ids.length} IDs from server:`, data.ids.slice(0, 3), '...')
        item.trackIds = data.ids
        // Update totalTracks to match actual download count (may differ from UI track list)
        if (item.totalTracks !== data.ids.length) {
          console.log(`[DownloadStore] Updating totalTracks from ${item.totalTracks} to ${data.ids.length}`)
          item.totalTracks = data.ids.length
        }
        item.status = 'downloading'
        saveDownloads()
        registerForPolling(albumId, data.ids, 'album')
      } else {
        throw new Error('Server did not return download IDs')
      }
    } catch (error: any) {
      console.error('[DownloadStore] Album download error:', error.message)
      updateDownloadStatus(albumId, 'error', error.message || String(error))
    }
  }

  /**
   * Qobuz album/playlist download — creates ONE grouped parent row (like the
   * Deezer album path) whose children are the enqueued Qobuz tracks, so the
   * Transfer Rack shows a single aggregated album unit instead of N track rows.
   * `qobuz` is the analyze result: { type, id, data }.
   */
  async function addQobuzAlbumDownload(qobuz: { type: string; id: string; data: any }) {
    const toastStore = useToastStore()
    const d = qobuz.data || {}

    // Same double-queue guards as the Deezer album path. The numeric
    // isAlbumInQueue/isAlbumCompleted maps can't index Qobuz's alphanumeric
    // ids, so match the rows directly. Retries are unaffected — retryDownload
    // removes the failed row before re-adding.
    const rowMatches = (dl: DownloadItem) =>
      dl.type === 'album' && dl.source === 'qobuz' && String((dl.album as any)?.id) === qobuz.id
    if (downloads.value.some(dl => rowMatches(dl) && (dl.status === 'pending' || dl.status === 'downloading'))) {
      toastStore.info(`"${d.title || 'This album'}" is already downloading`)
      return
    }
    if (downloads.value.some(dl => rowMatches(dl) && dl.status === 'completed')) {
      toastStore.info(`"${d.title || 'This album'}" was already downloaded`)
      return
    }

    await syncSettingsToServer()
    const settingsStore = useSettingsStore()
    const groupId = `qobuzalbum_${qobuz.id}_${Date.now()}`
    const trackTotal = d.tracks?.items?.length || d.tracks_count || 0

    const item: DownloadItem = {
      id: groupId,
      // Full source markers + covers on the embedded album: retry/resume paths
      // route by these, and the Deezer path once swallowed a marker-less Qobuz
      // row ('Album not available: no data' + blank art).
      album: {
        id: qobuz.id, title: d.title, artist: { name: d.artist?.name },
        cover_medium: d.image?.large || d.image?.small || (d as any).cover_medium || (d as any).images300?.[0],
        source: 'qobuz', qobuzId: qobuz.id, qobuzType: qobuz.type, qobuzData: d,
      } as any,
      source: 'qobuz',
      title: d.title || 'Qobuz Album',
      artist: d.artist?.name || (qobuz.type === 'playlist' ? (d.owner?.name || 'Playlist') : 'Unknown Artist'),
      cover: d.image?.large || d.image?.small || d.images?.[0] || (d as any).cover_medium || (d as any).cover_big || (d as any).images300?.[0] || '',
      progress: 0,
      status: 'pending',
      type: 'album',
      addedAt: new Date().toISOString(),
      quality: settingsStore.settings.quality,
      totalTracks: trackTotal,
      completedTracks: 0,
      failedTracks: [],
      trackIds: [],
      // Track list is often absent here (server resolves it) — polling
      // backfills catalogTrackIds from the server's progress entries.
      catalogTrackIds: (d.tracks?.items || []).map((t: any) => t.id),
    }
    downloads.value = [item, ...downloads.value]
    saveDownloads()

    try {
      const body = qobuz.type === 'playlist' ? { playlistId: qobuz.id } : { albumId: qobuz.id }
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/qobuz/download-album`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || 'Qobuz album download request failed')
      }
      const data = await response.json()
      if (data.ids && data.ids.length > 0) {
        // Cancelled while the enqueue request was in flight (#118): the row is
        // gone, so stop the server work the response just created.
        if (!downloads.value.some(d => d.id === item.id)) {
          cancelServerIds(data.ids)
          return
        }
        item.trackIds = data.ids
        item.totalTracks = data.ids.length
        item.status = 'downloading'
        saveDownloads()
        registerForPolling(groupId, data.ids, 'album')
      } else {
        throw new Error('Server did not return download IDs')
      }
    } catch (error: any) {
      console.error('[DownloadStore] Qobuz album download error:', error.message)
      updateDownloadStatus(groupId, 'error', error.message || String(error))
    }
  }

  async function addPlaylistDownload(playlist: Playlist, tracks: Track[], refreshTags = false) {
    const toastStore = useToastStore()

    // Qobuz-sourced playlist → grouped Qobuz download path.
    if ((playlist as any).source === 'qobuz') {
      await addQobuzAlbumDownload({ type: 'playlist', id: String((playlist as any).qobuzId ?? playlist.id), data: playlist })
      return
    }

    // Check if already downloaded (completed). Refresh-tags re-processes
    // existing files on purpose, so it bypasses this guard.
    if (!refreshTags && isPlaylistCompleted(playlist.id)) {
      if (isCompletedAtLowerTier('playlist', playlist.id)) {
        console.log(`[DownloadStore] Playlist ${playlist.id} was downloaded at a lower tier — re-downloading at current quality (#144)`)
      } else {
        toastStore.info(`"${playlist.title}" was already downloaded`)
        console.log(`[DownloadStore] Playlist ${playlist.id} already completed, skipping`)
        return // Early return - already downloaded
      }
    }

    // Check for duplicate - prevent adding playlist already in queue
    if (isPlaylistInQueue(playlist.id)) {
      toastStore.info(`"${playlist.title}" is already downloading`)
      console.log(`[DownloadStore] Playlist ${playlist.id} already in queue, skipping`)
      return // Early return - don't add duplicate
    }

    await syncSettingsToServer()
    const settingsStore = useSettingsStore()

    const playlistId = `playlist_${playlist.id}_${Date.now()}`

    const item: DownloadItem = {
      id: playlistId,
      playlist,
      source: 'deezer',
      title: playlist.title,
      artist: extractArtistName(playlist.creator),
      cover: extractCoverUrl(playlist, 'picture_medium', 'picture_big', 'picture_small', 'picture_xl', 'picture'),
      progress: 0,
      status: 'pending',
      type: 'playlist',
      addedAt: new Date().toISOString(),
      quality: settingsStore.settings.quality,
      totalTracks: tracks.length,
      completedTracks: 0,
      failedTracks: [],
      trackIds: [],
      catalogTrackIds: tracks.map(t => t.id),
      refresh: refreshTags
    }

    downloads.value = [item, ...downloads.value]
    // Update O(1) lookup Map immediately — refresh must not touch downloaded-status.
    if (playlist.id && !refreshTags) {
      playlistIdToStatus.set(playlist.id, 'pending')
    }
    saveDownloads()

    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/download/playlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistId: playlist.id, refreshTags })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = errorData.error || 'Playlist download request failed'

        // Handle session expiration - trigger auth store to handle re-login
        if (response.status === 401 || errorMsg.toLowerCase().includes('session expired')) {
          const toastStore = useToastStore()
          toastStore.error('Session expired. Please log in again to download.')
          throw new Error('Session expired: Please log in again')
        }

        throw new Error(errorMsg)
      }

      const data = await response.json()
      if (data.ids && data.ids.length > 0) {
        // Cancelled while the enqueue request was in flight (#118): the row is
        // gone, so stop the server work the response just created.
        if (!downloads.value.some(d => d.id === item.id)) {
          cancelServerIds(data.ids)
          return
        }
        console.log(`[DownloadStore] Playlist ${item.title}: received ${data.ids.length} IDs from server`)
        item.trackIds = data.ids
        // Update totalTracks to match actual download count (may differ from UI track list)
        if (item.totalTracks !== data.ids.length) {
          console.log(`[DownloadStore] Updating totalTracks from ${item.totalTracks} to ${data.ids.length}`)
          item.totalTracks = data.ids.length
        }
        item.status = 'downloading'
        saveDownloads()
        registerForPolling(playlistId, data.ids, 'album')
      } else {
        throw new Error('Server did not return download IDs')
      }
    } catch (error: any) {
      console.error('[DownloadStore] Playlist download error:', error.message)
      updateDownloadStatus(playlistId, 'error', error.message || String(error))
    }
  }

  /**
   * Batch download — sends all track IDs in a single request to
   * /api/download/batch and tracks them as one playlist-like item.
   * Used by the Link Analyzer for converted Spotify playlists.
   */
  async function addBatchDownload(config: {
    trackIds: number[]
    playlistName: string
    title: string
    cover?: string
    totalTracks: number
    service?: 'deezer' | 'qobuz'
  }) {
    await syncSettingsToServer()
    const settingsStore = useSettingsStore()
    const toastStore = useToastStore()

    // 2.4: the Link Analyzer can batch Qobuz matches too. Route to the matching
    // service's batch endpoint; the request/response shape is identical.
    const service = config.service === 'qobuz' ? 'qobuz' : 'deezer'
    const batchEndpoint = service === 'qobuz' ? '/api/qobuz/download-batch' : '/api/download/batch'

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    const item: DownloadItem = {
      id: batchId,
      title: config.title,
      cover: config.cover,
      // Tag the row with the service it was fulfilled from so the source chip
      // (Q for Qobuz) shows on Link-Analyzer batches just like direct downloads.
      source: service,
      progress: 0,
      status: 'pending',
      type: 'playlist',
      addedAt: new Date().toISOString(),
      quality: settingsStore.settings.quality,
      totalTracks: config.totalTracks,
      completedTracks: 0,
      failedTracks: [],
      trackIds: [],
      catalogTrackIds: [...config.trackIds],
      batchConfig: {
        trackIds: config.trackIds,
        playlistName: config.playlistName,
        cover: config.cover
      }
    }

    downloads.value = [item, ...downloads.value]
    saveDownloads()

    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}${batchEndpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackIds: config.trackIds,
          playlistName: config.playlistName,
          playlistCoverUrl: config.cover
        })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = errorData.error || 'Batch download request failed'

        if (response.status === 401 || errorMsg.toLowerCase().includes('session expired')) {
          toastStore.error('Session expired. Please log in again to download.')
          throw new Error('Session expired: Please log in again')
        }

        throw new Error(errorMsg)
      }

      const data = await response.json()
      if (data.ids && data.ids.length > 0) {
        // Cancelled while the enqueue request was in flight (#118): the row is
        // gone, so stop the server work the response just created.
        if (!downloads.value.some(d => d.id === item.id)) {
          cancelServerIds(data.ids)
          return
        }
        console.log(`[DownloadStore] Batch "${config.title}": received ${data.ids.length} IDs from server`)
        item.trackIds = data.ids
        if (item.totalTracks !== data.ids.length) {
          item.totalTracks = data.ids.length
        }
        item.status = 'downloading'
        saveDownloads()
        registerForPolling(batchId, data.ids, 'album')
      } else {
        throw new Error('Server did not return download IDs')
      }
    } catch (error: any) {
      console.error('[DownloadStore] Batch download error:', error.message)
      updateDownloadStatus(batchId, 'error', error.message || String(error))
    }
  }

  // 2.4 cross-service matrix: download a mixed set of tracks, each from its
  // chosen service, as ONE playlist row. No top-level source chip (mixed); the
  // expanded per-track rows carry their own D/Q chips.
  async function addMixedBatchDownload(config: {
    tracks: { id: number; service: 'deezer' | 'qobuz' }[]
    playlistName: string
    title: string
    cover?: string
    totalTracks: number
  }) {
    await syncSettingsToServer()
    const settingsStore = useSettingsStore()
    const toastStore = useToastStore()

    const batchId = `mixed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // Distinct services this batch pulls from. One service -> a single top-level
    // chip; both -> the row shows D and Q together to flag it as mixed-source.
    const distinctServices = [...new Set(config.tracks.map(t => t.service))]

    const item: DownloadItem = {
      id: batchId,
      title: config.title,
      cover: config.cover,
      source: distinctServices.length === 1 ? distinctServices[0] : undefined,
      sources: distinctServices.length > 1 ? distinctServices : undefined,
      progress: 0,
      status: 'pending',
      type: 'playlist',
      addedAt: new Date().toISOString(),
      quality: settingsStore.settings.quality,
      totalTracks: config.totalTracks,
      completedTracks: 0,
      failedTracks: [],
      trackIds: [],
      catalogTrackIds: config.tracks.map(t => t.id)
    }

    downloads.value = [item, ...downloads.value]
    saveDownloads()

    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/download/mixed-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracks: config.tracks,
          playlistName: config.playlistName,
          playlistCoverUrl: config.cover
        })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = errorData.error || 'Mixed batch download request failed'
        if (response.status === 401 || errorMsg.toLowerCase().includes('session expired')) {
          toastStore.error('Session expired. Please log in again to download.')
          throw new Error('Session expired: Please log in again')
        }
        throw new Error(errorMsg)
      }

      const data = await response.json()
      if (data.ids && data.ids.length > 0) {
        if (!downloads.value.some(d => d.id === item.id)) {
          cancelServerIds(data.ids)
          return
        }
        item.trackIds = data.ids
        if (item.totalTracks !== data.ids.length) item.totalTracks = data.ids.length
        item.status = 'downloading'
        saveDownloads()
        registerForPolling(batchId, data.ids, 'album')
      } else {
        throw new Error('Server did not return download IDs')
      }
    } catch (error: any) {
      console.error('[DownloadStore] Mixed batch download error:', error.message)
      updateDownloadStatus(batchId, 'error', error.message || String(error))
    }
  }

  // Register a download group for unified polling
  function registerForPolling(groupId: string, trackIds: string[], type: 'track' | 'album') {
    pollingGroups.set(groupId, { trackIds, type })
    startUnifiedPolling()
  }

  // Unregister from polling when complete
  function unregisterFromPolling(groupId: string) {
    pollingGroups.delete(groupId)
    if (pollingGroups.size === 0) {
      stopUnifiedPolling()
    }
  }

  // Start the unified polling loop (single interval for ALL downloads)
  // Uses adaptive intervals based on queue size for better performance
  function startUnifiedPolling() {
    if (unifiedPollingInterval) return // Already running

    // Get optimal interval based on current queue size
    currentPollingInterval = getOptimalPollingInterval()

    const pollOnce = async () => {
      if (pollingGroups.size === 0) {
        stopUnifiedPolling()
        return
      }

      try {
        // Single API call for all downloads
        const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/queue`)
        const data = await response.json()
        const queue = data.queue || []

        // Build O(1) lookup map from queue — avoids O(n) find() per track
        const queueMap = new Map<string, any>()
        for (const q of queue) {
          queueMap.set(q.id, q)
        }

        // Build O(1) lookup map from downloads for this poll cycle
        const downloadMap = new Map<string, DownloadItem>()
        for (const d of downloads.value) {
          downloadMap.set(d.id, d)
        }

        let hasChanges = false
        const groupsToRemove: string[] = []

        // Process all polling groups with the single response
        for (const [groupId, { trackIds, type }] of pollingGroups) {
          const item = downloadMap.get(groupId)
          if (!item || item.status === 'completed' || item.status === 'error') {
            groupsToRemove.push(groupId)
            continue
          }

          if (type === 'track') {
            const serverItem = queueMap.get(groupId)
            if (serverItem) {
              const changed = updateTrackProgress(item, serverItem)
              hasChanges = hasChanges || changed
              if ((item.status as string) === 'completed' || (item.status as string) === 'error') {
                groupsToRemove.push(groupId)
              }
            }
          } else {
            // Album/playlist polling
            const changed = updateAlbumProgress(item, trackIds, queueMap)
            hasChanges = hasChanges || changed
            if ((item.status as string) === 'completed' || (item.status as string) === 'error') {
              groupsToRemove.push(groupId)
            }
          }
        }

        // Remove completed groups
        groupsToRemove.forEach(id => pollingGroups.delete(id))

        // Rebuild lookup Maps if any changes occurred (batched update)
        if (hasChanges) {
          rebuildLookupMaps()
          saveDownloads()
        }

        // Check if we need to adjust polling interval
        const optimalInterval = getOptimalPollingInterval()
        if (optimalInterval !== currentPollingInterval && pollingGroups.size > 0) {
          currentPollingInterval = optimalInterval
          // Restart with new interval
          stopUnifiedPolling()
          startUnifiedPolling()
          return
        }

        // Stop polling if no more active groups
        if (pollingGroups.size === 0) {
          stopUnifiedPolling()
        }
      } catch (error) {
        console.error('[DownloadStore] Polling error:', error)
      }
    }

    unifiedPollingInterval = setInterval(pollOnce, currentPollingInterval)
  }

  function stopUnifiedPolling() {
    if (unifiedPollingInterval) {
      clearInterval(unifiedPollingInterval)
      unifiedPollingInterval = null
    }
  }

  // Update track progress - returns true if anything changed
  function updateTrackProgress(item: DownloadItem, serverItem: any): boolean {
    let changed = false

    if (item.progress !== serverItem.progress) {
      item.progress = serverItem.progress
      changed = true
    }
    if (item.status !== serverItem.status) {
      const previousStatus = item.status
      item.status = serverItem.status
      changed = true

      // Clear speed on completion/error
      if (serverItem.status === 'completed' || serverItem.status === 'error') {
        item.speed = 0
      }

      // Show toast for single track completion (only if status actually changed)
      if (previousStatus !== 'completed' && previousStatus !== 'error') {
        const toastStore = useToastStore()
        if (serverItem.status === 'completed') {
          toastStore.success(item.refresh ? `Refreshed tags for "${item.title}"` : `Downloaded "${item.title}"`)
          recordHistory(item)
        } else if (serverItem.status === 'error') {
          toastStore.error(item.refresh ? `Tag refresh failed: "${item.title}"` : `Download failed: "${item.title}"`)
          recordHistory(item)
        }
      }
    }
    if (serverItem.error && item.error !== serverItem.error) {
      item.error = serverItem.error
      changed = true
    }
    if (serverItem.errorDetails && item.errorDetails !== serverItem.errorDetails) {
      item.errorDetails = serverItem.errorDetails
      changed = true
    }
    // Capture download speed and bytes (if server provides them)
    if (typeof serverItem.speed === 'number' && item.speed !== serverItem.speed) {
      item.speed = serverItem.speed
      changed = true
    }
    if (typeof serverItem.bytesDownloaded === 'number' && item.bytesDownloaded !== serverItem.bytesDownloaded) {
      item.bytesDownloaded = serverItem.bytesDownloaded
      changed = true
    }
    if (typeof serverItem.totalBytes === 'number' && item.totalBytes !== serverItem.totalBytes) {
      item.totalBytes = serverItem.totalBytes
      changed = true
    }
    // For deletion, prefer albumRootFolder (folder path) over path (file path)
    // This ensures we delete the containing folder, not just the file
    const folderPath = serverItem.albumRootFolder || serverItem.albumFolder
    if (folderPath && item.path !== folderPath) {
      item.path = folderPath
      changed = true
    } else if (serverItem.path && !item.path) {
      // Fallback: derive folder from file path
      const pathParts = serverItem.path.split(/[/\\]/)
      pathParts.pop()
      item.path = pathParts.join('/')
      changed = true
    }
    // Capture actual format (may differ from requested quality due to fallback)
    if (serverItem.actualFormat && item.actualFormat !== serverItem.actualFormat) {
      item.actualFormat = serverItem.actualFormat
      changed = true
    }
    // Library-duplicate skip — nothing downloaded; drives the IN LIBRARY chip.
    if (serverItem.skippedAsDuplicate && !item.skippedAsDuplicate) {
      item.skippedAsDuplicate = true
      changed = true
    }
    // Capture substitution flag (exact track unavailable; alternate release downloaded)
    if (serverItem.substituted && !item.substituted) {
      item.substituted = true
      item.substitutedTracks = [{
        id: item.id,
        trackId: serverItem.trackId,
        title: serverItem.trackTitle || item.title,
        artist: serverItem.trackArtist || item.artist
      }]
      changed = true
    }

    return changed
  }

  // Update album/playlist progress - returns true if anything changed
  function updateAlbumProgress(item: DownloadItem, trackIds: string[], queueMap: Map<string, any>): boolean {
    let changed = false
    let completedCount = 0
    let errorCount = 0
    const failedTracks: FailedTrack[] = []
    const trackList: DownloadTrackEntry[] = []
    let albumFolderPath: string | null = null
    let playlistFolderPath: string | null = null
    let actualFormat: string | null = null
    let anySubstituted = false
    let skippedCount = 0
    let speedSum = 0
    const substitutedTracks: SubstitutedTrack[] = []
    // Backfill contained catalog ids from server progress entries — enqueue
    // paths that don't know the tracklist (Qobuz albums/playlists resolved
    // server-side) get captured here for the duplicate toast.
    const knownCatalogIds = new Set((item.catalogTrackIds || []).map(asCatalogKey))

    for (const trackId of trackIds) {
      const serverItem = queueMap.get(trackId)
      if (serverItem) {
        if (serverItem.trackId != null) {
          const catalogKey = asCatalogKey(serverItem.trackId)
          if (!Number.isNaN(catalogKey) && !knownCatalogIds.has(catalogKey)) {
            knownCatalogIds.add(catalogKey)
            ;(item.catalogTrackIds ||= []).push(catalogKey)
            changed = true
          }
        }
        // Capture playlist folder path for deletion of entire playlist directory
        if (!playlistFolderPath && serverItem.playlistFolder) {
          playlistFolderPath = serverItem.playlistFolder
        }
        // Capture album folder path for deletion
        // Prefer albumRootFolder (excludes CD subfolders) for proper recursive deletion
        if (!albumFolderPath) {
          if (serverItem.albumRootFolder) {
            albumFolderPath = serverItem.albumRootFolder
          } else if (serverItem.albumFolder) {
            albumFolderPath = serverItem.albumFolder
          } else if (serverItem.path && serverItem.status === 'completed') {
            const pathParts = serverItem.path.split(/[/\\]/)
            pathParts.pop()
            albumFolderPath = pathParts.join('/')
          }
        }
        // Capture actual format from first track that has it
        if (!actualFormat && serverItem.actualFormat) {
          actualFormat = serverItem.actualFormat
        }
        // Count library-duplicate skips — when EVERY track skipped, nothing was
        // downloaded and the row gets the IN LIBRARY chip instead of a tier.
        if (serverItem.skippedAsDuplicate) {
          skippedCount++
        }
        // Flag the whole album/playlist row if any track was an alternate release,
        // and remember WHICH track so the badge can list them (drill-down).
        if (serverItem.substituted) {
          anySubstituted = true
          substitutedTracks.push({
            id: trackId,
            trackId: serverItem.trackId || trackId,
            title: serverItem.trackTitle || serverItem.title || 'Unknown Track',
            artist: serverItem.trackArtist || serverItem.artist
          })
        }

        // Aggregate live throughput of in-flight tracks so the group row (and
        // the sidebar/title-bar meters that sum activeDownloads speeds) shows
        // real numbers during album/playlist downloads instead of 0.
        if (serverItem.status === 'downloading' && typeof serverItem.speed === 'number') {
          speedSum += serverItem.speed
        }

        // Count tracks as "complete" if they've finished downloading
        // This includes 'completed', 'decrypting', and 'tagging' statuses
        // since the download phase is done and the track will complete shortly
        const isTrackDone = serverItem.status === 'completed' ||
                           serverItem.status === 'decrypting' ||
                           serverItem.status === 'tagging'

        if (isTrackDone) {
          completedCount++
        } else if (serverItem.status === 'error') {
          errorCount++
          failedTracks.push({
            id: trackId,
            trackId: serverItem.trackId || trackId,
            title: serverItem.trackTitle || serverItem.title || 'Unknown Track',
            artist: serverItem.trackArtist || serverItem.artist,
            albumTitle: serverItem.albumTitle,
            error: serverItem.error || 'Download failed',
            errorDetails: serverItem.errorDetails
          })
        }

        // Capture the per-track row for the expandable track list, including its
        // own source so mixed-source rows show each track's real D/Q origin.
        trackList.push({
          id: trackId,
          title: serverItem.trackTitle || serverItem.title || 'Unknown Track',
          artist: serverItem.trackArtist || serverItem.artist,
          status: serverItem.status,
          source: serverItem.source
        })
      }
    }

    // Live per-track list for the expansion. Reassign each poll so the expanded
    // view reflects live status; a lightweight signature guards the `changed`
    // (persist) flag so we don't churn saves when nothing visible moved.
    const trackSig = trackList.map(t => `${t.id}:${t.status}:${t.source || ''}`).join('|')
    const prevSig = (item.tracks || []).map(t => `${t.id}:${t.status}:${t.source || ''}`).join('|')
    if (trackSig !== prevSig) {
      item.tracks = trackList
      changed = true
    }

    // Progress bar = fraction of tracks finished, normalized over the ORIGINAL
    // total (so it agrees with the "X/Y" track count shown next to it). We
    // deliberately do NOT byte-weight in-flight tracks: with the concurrency
    // gate running several tracks at once, byte progress races ahead of the
    // completed count and the bar would read e.g. 59% next to "1/10" (issue:
    // progress bar mismatch). previouslyCompletedTracks keeps retried albums
    // (trackIds shrinks to just the retry set) consistent with their fraction.
    const originalTotal = item.originalTotalTracks || item.totalTracks || trackIds.length || 1
    const doneCount = (item.previouslyCompletedTracks || 0) + completedCount
    const newProgress = Math.min(100, Math.round((doneCount / originalTotal) * 100))
    if (item.progress !== newProgress) {
      item.progress = newProgress
      changed = true
    }

    if (item.completedTracks !== completedCount) {
      item.completedTracks = completedCount
      changed = true
    }

    // Only update failedTracks if the count changed (avoid deep comparison)
    if ((item.failedTracks?.length || 0) !== failedTracks.length) {
      item.failedTracks = failedTracks
      changed = true
    }

    // For playlists, prefer the playlist root folder for deletion (deletes entire playlist directory)
    // For albums, use the album root folder
    const deletePath = (item.type === 'playlist' && playlistFolderPath) ? playlistFolderPath : albumFolderPath
    if (deletePath && !item.path) {
      item.path = deletePath
      changed = true
    }

    // Update actual format (may differ from requested due to fallback)
    if (actualFormat && item.actualFormat !== actualFormat) {
      item.actualFormat = actualFormat
      changed = true
    }

    // Full-skip disclosure: every track was already in the library, so no
    // delivered tier exists — an honest bare-FLAC badge plus the IN LIBRARY chip.
    const allSkipped = trackIds.length > 0 && skippedCount === trackIds.length
    if (allSkipped && !item.skippedAsDuplicate) {
      item.skippedAsDuplicate = true
      changed = true
    }

    // Surface if any track fell back to an alternate release
    if (anySubstituted && !item.substituted) {
      item.substituted = true
      changed = true
    }
    if ((item.substitutedTracks?.length || 0) !== substitutedTracks.length) {
      item.substitutedTracks = substitutedTracks
      changed = true
    }

    // Publish the aggregated throughput (0 once nothing is in flight)
    if ((item.speed || 0) !== speedSum) {
      item.speed = speedSum
      changed = true
    }

    const processedCount = completedCount + errorCount
    if (processedCount >= trackIds.length) {
      const newStatus = errorCount > 0 ? 'error' : 'completed'
      if (item.status !== newStatus) {
        item.status = newStatus
        if (errorCount > 0) {
          item.error = `${errorCount} of ${trackIds.length} tracks failed`
        }
        changed = true

        // Show toast notification and record history
        const toastStore = useToastStore()
        if (item.refresh) {
          if (newStatus === 'completed') {
            toastStore.success(`Refreshed tags for "${item.title}"`)
          } else if (errorCount === trackIds.length) {
            toastStore.error(`Tag refresh failed: "${item.title}"`)
          } else {
            toastStore.warning(`Refreshed tags for "${item.title}" (${errorCount} track${errorCount > 1 ? 's' : ''} skipped)`)
          }
        } else if (newStatus === 'completed') {
          toastStore.success(`Downloaded "${item.title}"`)
        } else if (errorCount === trackIds.length) {
          toastStore.error(`Download failed: "${item.title}"`)
        } else {
          toastStore.warning(`Downloaded "${item.title}" with ${errorCount} failed track${errorCount > 1 ? 's' : ''}`)
        }
        recordHistory(item) // no-ops for refresh items
      }
    }

    return changed
  }

  function updateDownloadStatus(id: string, status: DownloadStatus, error?: string) {
    const item = downloads.value.find(d => d.id === id)
    if (item) {
      item.status = status
      if (error) item.error = error
      // Update O(1) lookup Maps — refresh items never affect downloaded-status.
      if (!item.refresh) {
        if (item.track?.id) {
          trackIdToStatus.set(item.track.id, status)
        }
        if (item.type === 'album' && item.album?.id) {
          albumIdToStatus.set(item.album.id, status)
        }
        if (item.type === 'playlist' && item.playlist?.id) {
          playlistIdToStatus.set(item.playlist.id, status)
        }
      }
      saveDownloads()
    }
  }

  // Tell the server to stop work on these download ids (#118). Fire-and-forget:
  // the row removal must not block on it, and a miss just means the orphaned
  // tracks finish silently (the pre-fix behavior) rather than anything worse.
  function cancelServerIds(serverIds: string[]) {
    if (serverIds.length === 0) return
    fetch(`http://127.0.0.1:${serverPort.value}/api/queue/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: serverIds })
    }).catch(e => console.warn('[DownloadStore] Server cancel failed:', e?.message))
  }

  function cancelDownload(id: string) {
    const item = downloads.value.find(d => d.id === id)
    // Actually stop the server-side work before dropping the row (#118) —
    // removing the row alone left the server downloading the rest of an album
    // headless, with app-quit as the only way out. Server ids: single rows
    // carry theirs as item.id once the server responds (dl_…); album/playlist
    // rows carry per-track ids in trackIds. temp_ rows never reached the
    // server; finished rows have nothing to stop (the server ignores
    // completed/errored ids anyway — this is just to skip the request).
    if (item && item.status !== 'completed' && item.status !== 'error') {
      const serverIds = item.type === 'track' || !item.type
        ? (item.id.startsWith('dl_') ? [item.id] : [])
        : (item.trackIds || [])
      cancelServerIds(serverIds)
    }
    const index = downloads.value.findIndex(d => d.id === id)
    if (index !== -1) {
      downloads.value = downloads.value.filter(d => d.id !== id)
      // Rebuild Maps after removal
      rebuildLookupMaps()
      saveDownloads()
    }
    unregisterFromPolling(id)
  }

  async function deleteDownload(id: string, deleteFiles: boolean = false) {
    const item = downloads.value.find(d => d.id === id)
    if (!item) return

    if (deleteFiles && item.path && window.electronAPI) {
      // Safety rail: never delete the download root itself. A row whose path
      // resolved to the root (e.g. from a bad folder derivation) must not be
      // able to wipe the whole library — remove the row, keep the files.
      // Trailing-separator-insensitive so it holds on Windows paths too.
      const settingsStore = useSettingsStore()
      const norm = (p: string) => p.replace(/[/\\]+$/, '')
      const root = norm(settingsStore.settings.downloadPath || '')
      if (root && norm(item.path) === root) {
        console.warn('[DownloadStore] Refusing to delete the download root folder:', item.path)
      } else {
        try {
          await window.electronAPI.deletePath(item.path)
        } catch (error) {
          console.error('[DownloadStore] Failed to delete files:', error)
        }
      }
    }

    cancelDownload(id)
  }

  async function retryDownload(id: string) {
    const item = downloads.value.find(d => d.id === id)
    if (!item || item.status !== 'error') return

    const toastStore = useToastStore()

    // Remove the failed item first
    downloads.value = downloads.value.filter(d => d.id !== id)
    // Rebuild Maps after removal
    rebuildLookupMaps()
    saveDownloads()

    // Re-add based on type
    if (item.type === 'track' && item.track) {
      toastStore.info(`Retrying "${item.title}"...`)
      await addDownload(item.track)
    } else if (item.type === 'album' && item.album) {
      toastStore.info(`Retrying album "${item.title}"...`)
      // Qobuz albums re-route straight to the Qobuz pipeline (their id isn't a
      // Deezer id; the server refetches the tracklist, existing files skip).
      // Call addQobuzAlbumDownload directly and reconstruct the Qobuz ref from
      // whatever the row carries — legacy rows may lack album-level markers,
      // and routing them through addAlbumDownload's own source check once sent
      // Qobuz ids to Deezer ('Album not available: no data').
      if ((item.album as any).source === 'qobuz' || item.source === 'qobuz') {
        try {
          const alb: any = item.album
          const qType = alb.qobuzType === 'playlist' ? 'playlist' : 'album'
          await addQobuzAlbumDownload({
            type: qType,
            id: String(alb.qobuzId ?? alb.id),
            data: alb.qobuzData || { title: item.title, artist: { name: item.artist }, image: { large: item.cover }, tracks_count: item.totalTracks }
          })
        } catch (e) {
          console.error('[DownloadStore] Failed to retry Qobuz album:', e)
          toastStore.error(`Failed to retry "${item.title}"`)
        }
        return
      }
      // Fetch fresh track list for the album using correct endpoint
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/album?id=${item.album.id}`)
        const data = await response.json()
        if (data.error) {
          throw new Error(data.error)
        }
        await addAlbumDownload(item.album, data.tracks || [])
      } catch (e) {
        console.error('[DownloadStore] Failed to retry album:', e)
        toastStore.error(`Failed to retry "${item.title}"`)
      }
    } else if (item.type === 'playlist' && item.batchConfig) {
      // Batch download (converted Spotify playlist from Link Analyzer)
      toastStore.info(`Retrying "${item.title}"...`)
      await addBatchDownload({
        trackIds: item.batchConfig.trackIds,
        playlistName: item.batchConfig.playlistName,
        title: item.title,
        cover: item.batchConfig.cover,
        totalTracks: item.batchConfig.trackIds.length
      })
    } else if (item.type === 'playlist' && item.playlist) {
      toastStore.info(`Retrying playlist "${item.title}"...`)
      // Fetch fresh track list for the playlist using correct endpoint
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/playlist?id=${item.playlist.id}`)
        const data = await response.json()
        if (data.error) {
          throw new Error(data.error)
        }
        await addPlaylistDownload(item.playlist, data.tracks || [])
      } catch (e) {
        console.error('[DownloadStore] Failed to retry playlist:', e)
        toastStore.error(`Failed to retry "${item.title}"`)
      }
    } else {
      // No branch could handle this row (missing track/album/playlist context).
      // The item was already removed above — NEVER let it silently vanish: put
      // it back so the user can still see, retry, or delete it deliberately.
      downloads.value.unshift(item)
      rebuildLookupMaps()
      saveDownloads()
      toastStore.error(`Couldn't retry "${item.title}" — missing download context`)
    }
  }

  async function retryFailedTracks(id: string) {
    const item = downloads.value.find(d => d.id === id)
    if (!item || !item.failedTracks || item.failedTracks.length === 0) return

    const toastStore = useToastStore()
    const failedCount = item.failedTracks.length
    toastStore.info(`Retrying ${failedCount} failed track${failedCount > 1 ? 's' : ''} from "${item.title}"...`)

    await syncSettingsToServer()

    // Preserve the parent item's album/playlist context so retried tracks return to
    // their ORIGINAL folder instead of the root download folder (#94). Without this
    // the server treats the retried track as a standalone single. Album items send
    // albumId (server rebuilds the authoritative album context); playlist items send
    // playlistName (server recreates the playlist folder).
    const retryContext: Record<string, unknown> = {}
    if (item.type === 'album' && item.album?.id) {
      retryContext.albumId = item.album.id
    } else if (item.type === 'playlist') {
      const playlistName = item.batchConfig?.playlistName || item.playlist?.title
      if (playlistName) retryContext.playlistName = playlistName
    }

    // Queue each failed track on the server and collect the new download IDs.
    // These IDs are appended to the parent item's trackIds so the polling
    // system tracks them under the original album/playlist — no separate entries.
    const newTrackIds: string[] = []
    for (const failed of item.failedTracks) {
      const trackId = failed.trackId || failed.id
      if (!trackId) continue
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackId, ...retryContext })
        })
        if (!response.ok) continue
        const data = await response.json()
        if (data.id) {
          newTrackIds.push(data.id)
        }
      } catch (e) {
        console.error(`[DownloadStore] Failed to retry track ${trackId}:`, e)
      }
    }

    if (newTrackIds.length > 0) {
      // Replace trackIds with ONLY the new retry IDs — old IDs may no longer
      // exist in the server's download queue, which would prevent completion.
      // Preserve the original album context so the UI can still show "28/29".
      item.previouslyCompletedTracks = (item.previouslyCompletedTracks || 0) + (item.completedTracks || 0)
      item.originalTotalTracks = item.originalTotalTracks || item.totalTracks
      item.trackIds = newTrackIds
      item.totalTracks = newTrackIds.length
      item.completedTracks = 0
      item.progress = 0
      item.failedTracks = []
      item.error = undefined
      item.status = 'downloading'
      saveDownloads()
      registerForPolling(item.id, newTrackIds, 'album')
      toastStore.success(`Retrying ${newTrackIds.length} track${newTrackIds.length > 1 ? 's' : ''}`)
    } else {
      toastStore.error('Failed to retry any tracks')
    }
  }

  function clearCompleted() {
    downloads.value = downloads.value.filter(d => d.status !== 'completed')
    // Rebuild Maps after removal
    rebuildLookupMaps()
    saveDownloads()
  }

  function clearAll() {
    downloads.value = []
    pollingGroups.clear()
    stopUnifiedPolling()
    // Clear all lookup Maps
    trackIdToStatus.clear()
    albumIdToStatus.clear()
    playlistIdToStatus.clear()
    isPaused.value = false
    saveDownloads()

    // Reset server-side queue state to ensure new downloads can start
    fetch(`http://127.0.0.1:${serverPort.value}/api/queue/clear`, { method: 'POST' })
      .catch(e => console.error('[DownloadStore] Failed to clear server queue:', e))
  }

  // Reorder a download item in the queue
  function reorderDownload(draggedId: string, targetId: string, position: 'before' | 'after') {
    const draggedIndex = downloads.value.findIndex(d => d.id === draggedId)
    const targetIndex = downloads.value.findIndex(d => d.id === targetId)

    if (draggedIndex === -1 || targetIndex === -1) return

    // Remove the dragged item
    const [draggedItem] = downloads.value.splice(draggedIndex, 1)

    // Calculate the new index (adjust if we removed from before the target)
    let newIndex = targetIndex
    if (draggedIndex < targetIndex) {
      newIndex-- // Adjust for the removed item
    }
    if (position === 'after') {
      newIndex++
    }

    // Insert at the new position
    downloads.value.splice(newIndex, 0, draggedItem)
    saveDownloads()
    // Make the reorder real: push the new order to the backend queue so the actual
    // download order matches the list (not just the view). Issue #88 follow-up.
    syncQueueOrder()
  }

  // Push the current visual order of still-queued items to the backend, so dragging
  // a download actually reprioritizes it. Flattens album/playlist rows into their
  // track download IDs (same id model the "Download next" button uses).
  function syncQueueOrder() {
    const ids: string[] = []
    for (const d of downloads.value) {
      if (d.status !== 'pending' && d.status !== 'downloading') continue
      if (Array.isArray(d.trackIds) && d.trackIds.length) ids.push(...d.trackIds.map(String))
      else ids.push(String(d.id))
    }
    if (!ids.length) return
    fetch(`http://127.0.0.1:${serverPort.value}/api/queue/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    }).catch(() => { /* best-effort; view order already updated */ })
  }

  // Debounced save with requestIdleCallback for better performance
  // Debounced write of the full queue+history state to the userData file (the
  // update-proof state-of-record). localStorage writes stay alongside as the
  // dev/browser fallback.
  let diskPersistTimer: ReturnType<typeof setTimeout> | null = null
  function persistStateToDisk() {
    if (!window.electronAPI?.storage?.saveDownloadsState) return
    if (diskPersistTimer) clearTimeout(diskPersistTimer)
    diskPersistTimer = setTimeout(() => {
      diskPersistTimer = null
      window.electronAPI!.storage.saveDownloadsState({
        downloads: JSON.parse(JSON.stringify(downloads.value)),
        downloadHistory: JSON.parse(JSON.stringify(downloadHistory.value))
      }).catch((e: any) => console.error('[DownloadStore] Disk persist failed:', e))
    }, 800)
  }

  function saveDownloads() {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer)
    }

    saveDebounceTimer = setTimeout(() => {
      // Use requestIdleCallback if available for non-blocking save
      if ('requestIdleCallback' in window) {
        if (idleCallbackId) {
          cancelIdleCallback(idleCallbackId)
        }
        idleCallbackId = requestIdleCallback(() => {
          localStorage.setItem('downloads', JSON.stringify(downloads.value))
          idleCallbackId = null
        }, { timeout: 2000 })
      } else {
        localStorage.setItem('downloads', JSON.stringify(downloads.value))
      }
    }, 1000) // Increased debounce to 1 second
    persistStateToDisk()
  }

  function saveDownloadsImmediate() {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer)
    }
    if (idleCallbackId) {
      cancelIdleCallback(idleCallbackId)
    }
    localStorage.setItem('downloads', JSON.stringify(downloads.value))
    persistStateToDisk()
  }

  /**
   * Check if an error message indicates a session-related issue
   * This helps the UI display more helpful guidance to the user
   */
  function isSessionError(error?: string): boolean {
    if (!error) return false
    const lowerError = error.toLowerCase()
    return (
      lowerError.includes('session expired') ||
      lowerError.includes('session invalid') ||
      lowerError.includes('please log in') ||
      lowerError.includes('authentication') ||
      lowerError.includes('unauthorized') ||
      lowerError.includes('401') ||
      lowerError.includes('login required')
    )
  }

  // Opt-in auto-resume of downloads interrupted by the app closing (#98).
  // Called from App.vue AFTER auth is restored — a resume re-queues through the
  // normal add* paths (server skips already-downloaded tracks), which actually
  // hit Deezer, so it must not run before login. Reuses the battle-tested
  // retryDownload path; only touches items flagged interrupted on this startup.
  async function resumeInterruptedDownloads() {
    const settingsStore = useSettingsStore()
    if (!settingsStore.settings.resumeInterruptedOnStartup) return
    const ids = interruptedDownloadIds.value
    if (ids.length === 0) return
    // Clear first so this can never double-fire within a session.
    interruptedDownloadIds.value = []
    const toastStore = useToastStore()
    toastStore.info(`Resuming ${ids.length} interrupted download${ids.length === 1 ? '' : 's'}…`)
    console.log(`[DownloadStore] Auto-resuming ${ids.length} interrupted download(s) on startup`)
    // Sequential: retryDownload re-adds through add* paths; serialising avoids a
    // burst of list-build requests, and the global concurrency gate + pacing
    // (#97, applied at boot) still bound the actual downloads regardless.
    const authStore = useAuthStore()
    const settingsStore2 = useSettingsStore()
    for (const id of ids) {
      // Only resume items still in the interrupted error state (user may have
      // already retried or removed one before auth finished).
      const item = downloads.value.find(d => d.id === id)
      if (!item || item.status !== 'error') continue
      // Per-row service eligibility: resume a row only when ITS service has a
      // session — a Qobuz row must not be blocked by missing Deezer auth, and
      // vice versa. Ineligible rows stay one-click-retryable.
      const isQobuzRow = item.source === 'qobuz' || (item.track as any)?.source === 'qobuz' || (item.album as any)?.source === 'qobuz'
      const eligible = isQobuzRow ? settingsStore2.isQobuzConnected : authStore.isLoggedIn
      if (eligible) {
        await retryDownload(id)
      }
    }
  }

  return {
    downloads,
    activeDownloads,
    completedDownloads,
    failedDownloads,
    totalDownloadSpeed,
    serverPort,
    isPaused,
    // Duplicate detection helpers (in-queue)
    isTrackInQueue,
    isAlbumInQueue,
    isPlaylistInQueue,
    getTrackDownload,
    getAlbumDownload,
    getPlaylistDownload,
    // Completed download detection helpers
    isTrackCompleted,
    isAlbumCompleted,
    isPlaylistCompleted,
    // Actions
    init,
    addDownload,
    addAlbumDownload,
    addQobuzAlbumDownload,
    addPlaylistDownload,
    addBatchDownload,
    addMixedBatchDownload,
    cancelDownload,
    deleteDownload,
    retryDownload,
    resumeInterruptedDownloads,
    clearCompleted,
    clearAll,
    reorderDownload,
    pauseQueue,
    resumeQueue,
    saveDownloadsImmediate,
    isSessionError,
    syncSettingsToServer,
    downloadHistory,
    clearHistory,
    retryFailedTracks
  }
})
