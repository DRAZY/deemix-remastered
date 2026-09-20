import { EventEmitter } from 'events'
import { app } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { deezerAuth } from './deezerAuth'
import { downloader, type DownloadOptions, type FolderSettings, type TrackTemplates, type MetadataSettings } from './downloader'
import { runPool, safeWriteJson, quarantineCorruptFile } from './playlistSync'
import { fetchDeezerPublicJson, fetchDeezerPublicPaginated } from './deezerPublicApi'
import { buildAlbumContext, type AlbumContext } from './albumContext'
import { logSafe } from './logSafe'

// Reuse the SyncSchedule contract from playlistSync to keep one source of truth
// for cadence semantics across both engines.
export type SyncSchedule = 'launch' | '1h' | '6h' | '12h' | '24h' | 'manual'

export interface ArtistSyncDownloadSettings {
  downloadPath: string
  quality: 'MP3_128' | 'MP3_320' | 'FLAC'
  bitrateFallback: boolean
  isrcFallback?: boolean
  createArtistFolder: boolean
  createAlbumFolder: boolean
  saveArtwork: boolean
  embedArtwork: boolean
  saveLyrics: boolean
  syncedLyrics: boolean
  createErrorLog: boolean
  // Mirrors the server's `overwriteFiles` setting. Threaded through to the
  // downloader as `overwriteMode` so sync runs honor the user's "skip
  // existing files" choice. See issue #66.
  overwriteFiles: 'no' | 'overwrite' | 'rename'
  // Mirrors the server's `skipDuplicateTracks` opt-in — skip a recording (by ISRC)
  // already in the library. Off unless the user enabled it. See #91/#92.
  skipDuplicateTracks: boolean
  // Worker-pool size for parallel per-track downloads inside a sync run.
  // Falls back to 5 if unset (matches the server's default).
  maxConcurrentDownloads: number
  folderSettings: FolderSettings
  trackTemplates: TrackTemplates
  metadataSettings: MetadataSettings
}

export type ArtistSettingsProvider = () => ArtistSyncDownloadSettings

export type FirstSyncMode = 'subscribe-forward' | 'download-backlog' | 'date-threshold'

export type DeezerRecordType = 'album' | 'ep' | 'single' | 'compile' | 'bootleg' | 'featured' | string

export interface ArtistSyncFilters {
  includeAlbums: boolean
  includeSingles: boolean
  includeEPs: boolean
  includeCompilations: boolean
  includeFeatures: boolean
  minReleaseDate: string | null
}

export interface SyncedArtist {
  id: string
  source: 'deezer'
  sourceArtistId: string
  sourceArtistName: string
  sourceArtistUrl: string
  schedule: SyncSchedule
  enabled: boolean
  lastSyncAt: string | null
  lastSyncStatus: 'success' | 'partial' | 'error' | null
  lastSyncError: string | null
  knownAlbumIds: string[]
  failedAlbums: Array<{
    sourceAlbumId: string
    title: string
    releaseDate: string | null
    error: string
  }>
  // Albums that downloaded only partially — tracked across syncs so the missing
  // tracks get retried (bounded) instead of being silently lost (#93). An album
  // is NEVER added to knownAlbumIds while it has a partialAlbums entry; once all
  // its tracks are accounted for (downloaded, permanently-unavailable, or the
  // transient-retry cap is hit) the entry is cleared and the album becomes known.
  partialAlbums: Array<{
    sourceAlbumId: string
    title: string
    releaseDate: string | null
    failedTrackIds: number[]
    attempts: number
    lastReason: string
  }>
  totalAlbumsDownloaded: number
  totalTracksDownloaded: number
  downloadPath: string
  filters: ArtistSyncFilters
  firstSyncMode: FirstSyncMode
  createdAt: string
  // NEW (v1.6.3): see playlistSync.ts for the staleness model — same
  // semantics, different keying entity (artist instead of playlist).
  origin: 'favorites' | 'manual'
  lastSeenInFavoritesAt: string | null
}

export interface ArtistSyncResult {
  artistId: string
  newAlbums: number
  newTracks: number
  failedAlbums: number
  totalAlbumsSeen: number
  error: string | null
}

interface SyncState {
  artists: SyncedArtist[]
  lastFavoritesRefreshAt?: string | null
}

const SCHEDULE_INTERVALS: Record<SyncSchedule, number> = {
  'launch': 0,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  'manual': Infinity
}

export const DEFAULT_ARTIST_FILTERS: ArtistSyncFilters = {
  includeAlbums: true,
  includeSingles: false,
  includeEPs: true,
  includeCompilations: false,
  includeFeatures: false,
  minReleaseDate: null
}

interface DeezerArtistAlbum {
  id: number
  title: string
  release_date?: string
  record_type?: DeezerRecordType
  explicit_lyrics?: boolean
  cover_xl?: string
  cover_big?: string
  artist?: { id: number; name: string }
}

interface DeezerAlbumTrack {
  id: number
  title: string
  artist?: { name: string }
  track_position?: number
  disk_number?: number
}

function generateId(): string {
  return `artist_sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

class ArtistSyncEngine extends EventEmitter {
  private state: SyncState = { artists: [] }
  private activeSyncs = new Map<string, boolean>()
  private cancelRequested = new Set<string>()
  private schedulerInterval: NodeJS.Timeout | null = null
  private isInitialized = false
  private settingsProvider: ArtistSettingsProvider | null = null

  setSettingsProvider(provider: ArtistSettingsProvider): void {
    this.settingsProvider = provider
  }

  private getStatePath(): string {
    return join(app.getPath('userData'), 'artist-sync.json')
  }

  async init(): Promise<void> {
    await this.loadState()
    this.startScheduler()
    this.isInitialized = true

    const launchArtists = this.state.artists.filter(a => a.enabled && a.schedule === 'launch')
    for (const artist of launchArtists) {
      this.syncArtist(artist.id).catch(err =>
        console.error(`[ArtistSync] Launch sync failed for ${artist.id}:`, err)
      )
    }
  }

  async shutdown(): Promise<void> {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval)
      this.schedulerInterval = null
    }
    await this.saveState()
  }

  private async loadState(): Promise<void> {
    try {
      const data = await readFile(this.getStatePath(), 'utf-8')
      const parsed = JSON.parse(data)
      this.state = parsed
      if (!Array.isArray(this.state.artists)) {
        this.state.artists = []
      }
      // Backfill defaults for fields added after initial release.
      for (const artist of this.state.artists) {
        if (!artist.filters) artist.filters = { ...DEFAULT_ARTIST_FILTERS }
        if (!artist.firstSyncMode) artist.firstSyncMode = 'subscribe-forward'
        if (!Array.isArray(artist.knownAlbumIds)) artist.knownAlbumIds = []
        if (!Array.isArray(artist.failedAlbums)) artist.failedAlbums = []
        if (!Array.isArray(artist.partialAlbums)) artist.partialAlbums = []  // #93
        // v1.6.3 — backfill: pre-existing entries are treated as manual so
        // they aren't auto-flagged on the first favorites refresh.
        if (!artist.origin) artist.origin = 'manual'
        if (artist.lastSeenInFavoritesAt === undefined) artist.lastSeenInFavoritesAt = null
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[ArtistSync] Failed to load state:', err)
        // See playlistSync.loadState — quarantine before resetting so a
        // subsequent saveState() can't overwrite the bytes.
        await quarantineCorruptFile(this.getStatePath())
      }
      this.state = { artists: [] }
    }
  }

  // Serialize all saveState calls via a Promise chain. Without this, the
  // bulk-add path raced fire-and-forget syncArtist's own saveState calls on
  // the shared safeWriteJson tmp file, silently losing entries on Windows.
  // See playlistSync.ts for the full explanation (#68).
  private savePromise: Promise<void> = Promise.resolve()
  private async saveState(): Promise<void> {
    this.savePromise = this.savePromise.then(async () => {
      try {
        await safeWriteJson(this.getStatePath(), this.state)
      } catch (err) {
        console.error('[ArtistSync] Failed to save state:', err)
      }
    })
    return this.savePromise
  }

  private startScheduler(): void {
    this.schedulerInterval = setInterval(() => {
      const now = Date.now()
      for (const artist of this.state.artists) {
        if (!artist.enabled || artist.schedule === 'manual' || artist.schedule === 'launch') continue
        if (this.activeSyncs.has(artist.id)) continue

        const interval = SCHEDULE_INTERVALS[artist.schedule]
        const lastSync = artist.lastSyncAt ? new Date(artist.lastSyncAt).getTime() : 0
        if (now - lastSync >= interval) {
          this.syncArtist(artist.id).catch(err =>
            console.error(`[ArtistSync] Scheduled sync failed for ${artist.id}:`, err)
          )
        }
      }
    }, 60000)
  }

  // CRUD
  async addArtist(config: {
    sourceArtistId: string
    sourceArtistName: string
    sourceArtistUrl: string
    schedule: SyncSchedule
    downloadPath: string
    firstSyncMode?: FirstSyncMode
    filters?: Partial<ArtistSyncFilters>
    // Origin defaults to 'manual'; pass 'favorites' when adding from the
    // Favorites → Pin to Sync UX so membership-refresh can flag the entry
    // if the user later un-favorites the artist on Deezer.
    origin?: 'favorites' | 'manual'
  }): Promise<SyncedArtist> {
    const existing = this.state.artists.find(
      a => a.source === 'deezer' && a.sourceArtistId === String(config.sourceArtistId)
    )
    if (existing) return existing

    const origin: 'favorites' | 'manual' = config.origin ?? 'manual'
    const nowIso = new Date().toISOString()
    const artist: SyncedArtist = {
      id: generateId(),
      source: 'deezer',
      sourceArtistId: String(config.sourceArtistId),
      sourceArtistName: config.sourceArtistName,
      sourceArtistUrl: config.sourceArtistUrl,
      schedule: config.schedule,
      enabled: true,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      knownAlbumIds: [],
      failedAlbums: [],
      partialAlbums: [],
      totalAlbumsDownloaded: 0,
      totalTracksDownloaded: 0,
      downloadPath: config.downloadPath,
      filters: { ...DEFAULT_ARTIST_FILTERS, ...(config.filters || {}) },
      firstSyncMode: config.firstSyncMode || 'subscribe-forward',
      createdAt: nowIso,
      origin,
      lastSeenInFavoritesAt: origin === 'favorites' ? nowIso : null
    }
    this.state.artists.push(artist)
    await this.saveState()
    this.emit('artists:changed', this.state.artists)

    // Trigger initial sync. With the default subscribe-forward mode this
    // captures the current discography into knownAlbumIds without downloading.
    this.syncArtist(artist.id).catch(err =>
      console.error(`[ArtistSync] Initial sync failed for ${artist.id}:`, err)
    )

    return artist
  }

  // Bulk add — see playlistSync.addPlaylistsBulk for the contract & rationale.
  // Issue #70: bulk favorite-artist sync was being truncated by the per-IP
  // 'sync' rate limit (120/60s); the fix is one HTTP call → one engine call
  // → one saveState() → respect the 3-concurrency cap for initial syncs.
  async addArtistsBulk(configs: Array<{
    sourceArtistId: string
    sourceArtistName: string
    sourceArtistUrl: string
    schedule: SyncSchedule
    downloadPath: string
    firstSyncMode?: FirstSyncMode
    filters?: Partial<ArtistSyncFilters>
    origin?: 'favorites' | 'manual'
  }>): Promise<Array<{ ok: boolean; artist?: SyncedArtist; error?: string }>> {
    const results: Array<{ ok: boolean; artist?: SyncedArtist; error?: string }> = []
    const created: SyncedArtist[] = []

    for (const config of configs) {
      try {
        if (!config.sourceArtistId || !config.sourceArtistName) {
          results.push({ ok: false, error: 'Missing required fields' })
          continue
        }
        // Idempotent: dedupe against in-memory state so bulk re-runs after
        // partial success don't create duplicate entries.
        const existing = this.state.artists.find(
          a => a.source === 'deezer' && a.sourceArtistId === String(config.sourceArtistId)
        )
        if (existing) {
          results.push({ ok: true, artist: existing })
          continue
        }
        const origin: 'favorites' | 'manual' = config.origin ?? 'manual'
        const nowIso = new Date().toISOString()
        const artist: SyncedArtist = {
          id: generateId(),
          source: 'deezer',
          sourceArtistId: String(config.sourceArtistId),
          sourceArtistName: config.sourceArtistName,
          sourceArtistUrl: config.sourceArtistUrl,
          schedule: config.schedule,
          enabled: true,
          lastSyncAt: null,
          lastSyncStatus: null,
          lastSyncError: null,
          knownAlbumIds: [],
          failedAlbums: [],
          totalAlbumsDownloaded: 0,
          totalTracksDownloaded: 0,
          downloadPath: config.downloadPath,
          filters: { ...DEFAULT_ARTIST_FILTERS, ...(config.filters || {}) },
          firstSyncMode: config.firstSyncMode || 'subscribe-forward',
          createdAt: nowIso,
          origin,
          lastSeenInFavoritesAt: origin === 'favorites' ? nowIso : null
        }
        this.state.artists.push(artist)
        created.push(artist)
        results.push({ ok: true, artist })
      } catch (err: any) {
        results.push({ ok: false, error: err?.message || 'Failed to add' })
      }
    }

    if (created.length > 0) {
      await this.saveState()
      this.emit('artists:changed', this.state.artists)
    }

    for (const artist of created) {
      this.syncArtist(artist.id).catch(err =>
        console.error(`[ArtistSync] Initial sync failed for ${artist.id}:`, err)
      )
    }

    return results
  }

  // See playlistSync.replaceState — same contract, applied to artist sync.
  // Backup/restore (#72) preserves knownAlbumIds + lastSyncAt verbatim so the
  // engine does NOT re-resolve every album or schedule everything immediately
  // after restore.
  async replaceState(artists: any[]): Promise<{ accepted: number; rejected: number }> {
    if (!Array.isArray(artists)) {
      return { accepted: 0, rejected: 0 }
    }
    let rejected = 0
    const cleaned: SyncedArtist[] = []
    for (const raw of artists) {
      if (!raw || typeof raw !== 'object') { rejected++; continue }
      if (!raw.id || !raw.sourceArtistId) { rejected++; continue }
      const entry: SyncedArtist = {
        id: String(raw.id),
        source: 'deezer',
        sourceArtistId: String(raw.sourceArtistId),
        sourceArtistName: String(raw.sourceArtistName ?? ''),
        sourceArtistUrl: String(raw.sourceArtistUrl ?? `https://www.deezer.com/artist/${raw.sourceArtistId}`),
        schedule: raw.schedule || '24h',
        enabled: raw.enabled !== false,
        lastSyncAt: raw.lastSyncAt ?? null,
        lastSyncStatus: raw.lastSyncStatus ?? null,
        lastSyncError: raw.lastSyncError ?? null,
        knownAlbumIds: Array.isArray(raw.knownAlbumIds) ? raw.knownAlbumIds.map(String) : [],
        failedAlbums: Array.isArray(raw.failedAlbums) ? raw.failedAlbums : [],
        partialAlbums: Array.isArray(raw.partialAlbums) ? raw.partialAlbums : [],
        totalAlbumsDownloaded: Number(raw.totalAlbumsDownloaded) || 0,
        totalTracksDownloaded: Number(raw.totalTracksDownloaded) || 0,
        downloadPath: String(raw.downloadPath ?? ''),
        filters: { ...DEFAULT_ARTIST_FILTERS, ...(raw.filters || {}) },
        firstSyncMode: raw.firstSyncMode || 'subscribe-forward',
        createdAt: raw.createdAt || new Date().toISOString(),
        origin: raw.origin === 'favorites' ? 'favorites' : 'manual',
        lastSeenInFavoritesAt: raw.lastSeenInFavoritesAt ?? null
      }
      cleaned.push(entry)
    }
    this.state.artists = cleaned
    await this.saveState()
    this.emit('artists:changed', this.state.artists)
    return { accepted: cleaned.length, rejected }
  }

  async removeArtist(id: string): Promise<void> {
    this.state.artists = this.state.artists.filter(a => a.id !== id)
    this.activeSyncs.delete(id)
    this.cancelRequested.delete(id)
    await this.saveState()
    this.emit('artists:changed', this.state.artists)
  }

  async updateArtist(
    id: string,
    updates: Partial<Pick<SyncedArtist, 'schedule' | 'enabled' | 'downloadPath' | 'sourceArtistName' | 'filters' | 'firstSyncMode'>>
  ): Promise<SyncedArtist | null> {
    const artist = this.state.artists.find(a => a.id === id)
    if (!artist) return null
    if (updates.filters) {
      artist.filters = { ...artist.filters, ...updates.filters }
      delete (updates as any).filters
    }
    Object.assign(artist, updates)
    await this.saveState()
    this.emit('artists:changed', this.state.artists)
    return artist
  }

  getArtists(): SyncedArtist[] {
    return this.state.artists
  }

  getArtist(id: string): SyncedArtist | null {
    return this.state.artists.find(a => a.id === id) || null
  }

  getLastFavoritesRefreshAt(): string | null {
    return this.state.lastFavoritesRefreshAt ?? null
  }

  async markFavoriteMembership(deezerFavoriteArtistIds: string[]): Promise<{
    refreshed: number
    stale: number
  }> {
    const now = new Date().toISOString()
    const favSet = new Set(deezerFavoriteArtistIds.map(String))
    let refreshed = 0
    let stale = 0
    for (const a of this.state.artists) {
      if (a.origin !== 'favorites') continue
      if (favSet.has(a.sourceArtistId)) {
        a.lastSeenInFavoritesAt = now
        refreshed++
      } else {
        stale++
      }
    }
    this.state.lastFavoritesRefreshAt = now
    await this.saveState()
    this.emit('artists:changed', this.state.artists)
    return { refreshed, stale }
  }

  async resetArtist(id: string): Promise<boolean> {
    const artist = this.state.artists.find(a => a.id === id)
    if (!artist) return false
    artist.knownAlbumIds = []
    artist.failedAlbums = []
    artist.partialAlbums = []
    artist.totalAlbumsDownloaded = 0
    artist.totalTracksDownloaded = 0
    artist.lastSyncStatus = null
    artist.lastSyncError = null
    await this.saveState()
    this.emit('artists:changed', this.state.artists)
    return true
  }

  cancelSync(id: string): void {
    this.cancelRequested.add(id)
  }

  isSyncing(id: string): boolean {
    return this.activeSyncs.has(id)
  }

  getActiveSyncIds(): string[] {
    return Array.from(this.activeSyncs.keys())
  }

  // #93: classify a per-track download failure. PERMANENT = retrying can never
  // help (region/availability), so the album is accepted as done. Everything else
  // (timeouts, quota, network, empty responses, cancellation, unknown) is TRANSIENT
  // and worth a bounded retry. Keys on the downloader's structured error code when
  // present, with a message fallback that excludes the transient "temporarily
  // unavailable" phrasing.
  private isPermanentFailure(code: string | undefined, reason: string): boolean {
    if (code) return code === 'GEO_RESTRICTED' || code === 'TRACK_UNAVAILABLE'
    const m = (reason || '').toLowerCase()
    if (m.includes('temporarily')) return false
    return m.includes('geo') || m.includes('region') || m.includes('country') ||
           m.includes('unavailable') || m.includes('not available') || m.includes('restricted')
  }

  // Filtering rules per record_type. Deezer's "featured" record type isn't
  // exposed by the public /artist/{id}/albums endpoint — it requires the
  // /related or /search route. For v1 we treat anything where the album's
  // primary artist differs from the synced artist as a "feature".
  private albumPassesFilters(album: DeezerArtistAlbum, artist: SyncedArtist): boolean {
    const recordType = (album.record_type || '').toLowerCase()
    const filters = artist.filters

    if (recordType === 'single' && !filters.includeSingles) return false
    if (recordType === 'ep' && !filters.includeEPs) return false
    if (recordType === 'compile' && !filters.includeCompilations) return false
    if (recordType === 'album' && !filters.includeAlbums) return false

    // Anything else (bootleg, etc.) follows the includeAlbums flag as a
    // pragmatic default — they're typically the most-album-like entries.
    if (!['single', 'ep', 'compile', 'album'].includes(recordType) && !filters.includeAlbums) return false

    // "Feature" detection by primary-artist mismatch.
    const albumArtistId = album.artist?.id != null ? String(album.artist.id) : null
    if (albumArtistId && albumArtistId !== artist.sourceArtistId && !filters.includeFeatures) {
      return false
    }

    if (filters.minReleaseDate && album.release_date) {
      if (album.release_date < filters.minReleaseDate) return false
    }

    return true
  }

  // Sync the artist's discography.
  //
  // Algorithm:
  //   1. Fetch /artist/{id}/albums (paginated, follow `next`)
  //   2. Apply filters per artist config
  //   3. Compute newAlbumIds = filtered - knownAlbumIds
  //   4. First-sync mode:
  //        - subscribe-forward: capture into knownAlbumIds without downloading
  //        - download-backlog: download everything in the filtered set
  //        - date-threshold: filters.minReleaseDate already shaped the set;
  //          treat the same as download-backlog
  //   5. For each album to download: fetch tracks and queue each via downloader
  //   6. Mark successfully-downloaded albums as known; record failures
  async syncArtist(id: string): Promise<ArtistSyncResult> {
    const artist = this.state.artists.find(a => a.id === id)
    if (!artist) throw new Error(`Artist ${id} not found`)
    if (this.activeSyncs.has(id)) throw new Error(`Artist ${id} is already syncing`)
    // Soft-skip at the concurrency cap — the 60s scheduler retries skipped
    // entries once active syncs drain. See playlistSync.ts for context (#68).
    if (this.activeSyncs.size >= 3) {
      console.log(`[ArtistSync] Skipping initial sync for ${logSafe(id)} — at concurrency cap; scheduler will retry`)
      return {
        artistId: id,
        newAlbums: 0,
        newTracks: 0,
        failedAlbums: 0,
        totalAlbumsSeen: 0,
        error: null
      }
    }

    this.activeSyncs.set(id, true)
    this.cancelRequested.delete(id)
    this.emit('sync:start', id)
    console.log(`[ArtistSync] Starting sync for "${artist.sourceArtistName}" (deezer:${artist.sourceArtistId})`)

    try {
      const discography = await this.fetchDeezerArtistDiscography(artist.sourceArtistId)
      const filtered = discography.filter(album => this.albumPassesFilters(album, artist))
      const filteredIds = filtered.map(a => String(a.id))
      const known = new Set(artist.knownAlbumIds)
      // #93: partially-downloaded albums are deliberately NOT in knownAlbumIds, so
      // they fall into newAlbumIds here and get retried. Drop ledger entries for
      // albums that left the filtered discography so they don't retry forever.
      artist.partialAlbums = (artist.partialAlbums || []).filter(p => filteredIds.includes(p.sourceAlbumId))
      const newAlbumIds = filteredIds.filter(aid => !known.has(aid))
      const isFirstSync = artist.lastSyncAt === null

      this.emit('sync:progress', id, { current: 0, total: newAlbumIds.length, phase: 'resolving' })

      // First-sync mode decides whether we actually download the discovered
      // albums, or just register them as "known" going forward.
      const downloadNow =
        !isFirstSync ||
        artist.firstSyncMode === 'download-backlog' ||
        artist.firstSyncMode === 'date-threshold'

      let downloadedAlbumCount = 0
      let downloadedTrackCount = 0
      const failed: SyncedArtist['failedAlbums'] = []

      if (!downloadNow) {
        // Subscribe-forward on first sync: mark all current albums as known
        // without queueing any downloads.
        artist.knownAlbumIds = filteredIds
      } else {
        const settings = this.settingsProvider?.()
        const newAlbumsByDate = filtered
          .filter(a => newAlbumIds.includes(String(a.id)))
          .sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''))

        // #93: an album earns a knownAlbumIds entry ONLY when every track is
        // accounted for. Until then it lives in partialMap and is retried (bounded
        // by RETRY_CAP) on each sync. The downloader skips files that already exist,
        // so a retry only re-fetches the genuinely-missing tracks.
        const RETRY_CAP = 3
        const partialMap = new Map(artist.partialAlbums.map(p => [p.sourceAlbumId, p]))

        for (let i = 0; i < newAlbumsByDate.length; i++) {
          if (this.cancelRequested.has(id)) break
          const album = newAlbumsByDate[i]
          const albumIdStr = String(album.id)
          this.emit('sync:progress', id, {
            current: i + 1,
            total: newAlbumsByDate.length,
            phase: 'downloading',
            albumTitle: album.title
          })
          try {
            const tracks = await this.fetchDeezerAlbumTracks(album.id)
            const albumCoverUrl = album.cover_xl || album.cover_big || ''
            if (tracks.length === 0) {
              // No playable tracks = permanently unavailable here; mark known so it
              // doesn't retry forever, and surface it in the failed list. (#93)
              if (!artist.knownAlbumIds.includes(albumIdStr)) artist.knownAlbumIds.push(albumIdStr)
              partialMap.delete(albumIdStr)
              failed.push({
                sourceAlbumId: albumIdStr,
                title: album.title,
                releaseDate: album.release_date || null,
                error: 'Album has no available tracks'
              })
              continue
            }
            // #95: build the authoritative album context (the same one a manual
            // album-page download uses) so synced tracks land in the SAME folders
            // — including CD subfolders for multi-disc albums — and carry the same
            // tags. Without this, sync fell back to per-track metadata and never
            // created CD folders. Best-effort: if the album lookup fails, fall back
            // to per-track naming rather than failing the whole album.
            let albumContext: AlbumContext | undefined
            try {
              const albumInfo = await fetchDeezerPublicJson<any>(
                `https://api.deezer.com/album/${album.id}`,
                { label: `album ${album.id} info` }
              )
              if (albumInfo && !albumInfo.error) {
                albumContext = buildAlbumContext(album.id, albumInfo, tracks)
              }
            } catch {
              // leave albumContext undefined → previous per-track fallback naming
            }

            // Within-album parallelism — download the album's tracks in
            // parallel up to maxConcurrentDownloads. Keeps the cross-album
            // loop sequential so the per-album progress UI ("Album 3/5,
            // downloading X") remains meaningful.
            const poolConcurrency = Math.max(1, settings?.maxConcurrentDownloads ?? 5)

            const trackResults = await runPool(
              tracks,
              poolConcurrency,
              async (track) => {
                if (this.cancelRequested.has(id)) {
                  return { ok: false as const, trackId: track.id, reason: 'cancelled', code: 'CANCELLED' as string | undefined }
                }
                const opts: DownloadOptions = {
                  trackId: track.id,
                  outputPath: artist.downloadPath || settings?.downloadPath || join(process.env.HOME || process.env.USERPROFILE || '/tmp', 'Music', 'Deemix'),
                  quality: settings?.quality || 'MP3_320',
                  bitrateFallback: settings?.bitrateFallback ?? true,
                  isrcFallback: settings?.isrcFallback ?? true,
                  createFolders: true,
                  artistFolder: settings?.createArtistFolder ?? true,
                  albumFolder: settings?.createAlbumFolder ?? true,
                  saveArtwork: settings?.saveArtwork ?? true,
                  embedArtwork: settings?.embedArtwork ?? true,
                  saveLyrics: settings?.saveLyrics ?? true,
                  syncedLyrics: settings?.syncedLyrics ?? true,
                  isSingle: false,
                  isFromPlaylist: false,
                  createErrorLog: settings?.createErrorLog ?? true,
                  savePlaylistAsCompilation: false,
                  // Safe-side default: scheduled/unattended sync must not
                  // destroy existing files unless the user explicitly opted in.
                  overwriteMode: settings?.overwriteFiles ?? 'no',
                  skipDuplicateTracks: settings?.skipDuplicateTracks ?? false,
                  folderSettings: settings?.folderSettings,
                  trackTemplates: settings?.trackTemplates,
                  metadataSettings: settings?.metadataSettings,
                  playlistCoverUrl: albumCoverUrl || undefined,
                  // #95: album context + this track's disc number so multi-disc
                  // albums get CD subfolders during sync, matching album-page
                  // downloads. (CD folder = createCDFolder && discNumber && discs>1)
                  albumContext,
                  discNumber: track.disk_number,
                  // #102/#103: authoritative position backstop for FALLBACK/ISRC
                  // substitution — see DownloadOptions.trackNumber.
                  trackNumber: track.track_position
                }
                try {
                  const downloadId = await downloader.download(opts)
                  await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => {
                      cleanup()
                      reject(new Error('Download timed out'))
                    }, 5 * 60 * 1000)
                    const onComplete = (progress: any) => {
                      if (progress.id === downloadId) { cleanup(); resolve() }
                    }
                    const onError = (progress: any) => {
                      if (progress.id === downloadId) {
                        cleanup()
                        const e: any = new Error(progress.error || 'Download failed')
                        e.code = progress.errorDetails?.code
                        reject(e)
                      }
                    }
                    const onCancelled = (progress: any) => {
                      if (progress.id === downloadId) { cleanup(); const e: any = new Error('Download cancelled'); e.code = 'CANCELLED'; reject(e) }
                    }
                    const cleanup = () => {
                      clearTimeout(timeout)
                      downloader.removeListener('complete', onComplete)
                      downloader.removeListener('error', onError)
                      downloader.removeListener('cancelled', onCancelled)
                    }
                    const current = downloader.getAllProgress().find(p => p.id === downloadId)
                    if (current?.status === 'completed') { cleanup(); resolve(); return }
                    if (current?.status === 'error') {
                      cleanup()
                      const e: any = new Error(current.error || 'Download failed')
                      e.code = current.errorDetails?.code
                      reject(e)
                      return
                    }
                    downloader.on('complete', onComplete)
                    downloader.on('error', onError)
                    downloader.on('cancelled', onCancelled)
                  })
                  return { ok: true as const, trackId: track.id }
                } catch (err: any) {
                  console.error(`[ArtistSync] Track ${logSafe(track.id)} of album ${logSafe(album.title)} failed:`, logSafe(err.message))
                  return { ok: false as const, trackId: track.id, reason: err.message || 'Download failed', code: err.code as string | undefined }
                }
              }
            )

            // #93 disposition: an album is marked "known" ONLY when every track is
            // accounted for. Failed tracks are classified — permanent failures
            // (geo/unavailable) are accepted so they don't retry forever; transient
            // failures keep the album out of knownAlbumIds so the next sync retries
            // just the missing tracks, bounded by RETRY_CAP.
            const okResults = trackResults.filter((r: any) => r.ok)
            const failedTracks = trackResults.filter((r: any) => !r.ok) as Array<{ ok: false; trackId?: number; reason: string; code?: string }>
            downloadedTrackCount += okResults.length
            const markKnown = () => {
              if (!artist.knownAlbumIds.includes(albumIdStr)) artist.knownAlbumIds.push(albumIdStr)
              partialMap.delete(albumIdStr)
            }

            if (failedTracks.length === 0) {
              // Fully downloaded → genuinely known.
              downloadedAlbumCount++
              markKnown()
            } else {
              const transient = failedTracks.filter(t => !this.isPermanentFailure(t.code, t.reason))
              const permanentCount = failedTracks.length - transient.length
              if (transient.length === 0) {
                // Every failure is permanent (geo/unavailable) — retrying can't help.
                // Accept so it stops re-attempting; surface what's missing.
                if (okResults.length > 0) downloadedAlbumCount++
                markKnown()
                failed.push({
                  sourceAlbumId: albumIdStr, title: album.title, releaseDate: album.release_date || null,
                  error: `${failedTracks.length} track(s) unavailable in your region`
                })
              } else {
                const attempts = (partialMap.get(albumIdStr)?.attempts || 0) + 1
                if (attempts >= RETRY_CAP) {
                  // Bounded: give up after RETRY_CAP so it never churns forever.
                  if (okResults.length > 0) downloadedAlbumCount++
                  markKnown()
                  failed.push({
                    sourceAlbumId: albumIdStr, title: album.title, releaseDate: album.release_date || null,
                    error: `${failedTracks.length} track(s) failed after ${RETRY_CAP} attempts`
                  })
                } else {
                  // Keep OUT of knownAlbumIds → next sync retries the missing tracks.
                  partialMap.set(albumIdStr, {
                    sourceAlbumId: albumIdStr, title: album.title, releaseDate: album.release_date || null,
                    failedTrackIds: failedTracks.map(t => t.trackId).filter((x): x is number => typeof x === 'number'),
                    attempts, lastReason: transient[0]?.reason || 'download failed'
                  })
                  failed.push({
                    sourceAlbumId: albumIdStr, title: album.title, releaseDate: album.release_date || null,
                    error: `${failedTracks.length} track(s) failed — retrying (attempt ${attempts}/${RETRY_CAP})${permanentCount ? `, ${permanentCount} unavailable` : ''}`
                  })
                }
              }
            }
          } catch (err: any) {
            failed.push({
              sourceAlbumId: albumIdStr,
              title: album.title,
              releaseDate: album.release_date || null,
              error: err.message || 'Album fetch failed'
            })
          }
        }
        // #93: persist the retry ledger (entries for albums still missing tracks).
        artist.partialAlbums = [...partialMap.values()]
      }

      artist.failedAlbums = failed
      artist.totalAlbumsDownloaded += downloadedAlbumCount
      artist.totalTracksDownloaded += downloadedTrackCount
      artist.lastSyncAt = new Date().toISOString()
      artist.lastSyncStatus = failed.length > 0
        ? (downloadedAlbumCount > 0 ? 'partial' : (downloadNow ? 'error' : 'success'))
        : 'success'
      artist.lastSyncError = failed.length > 0
        ? `${failed.length} album(s) failed`
        : null

      await this.saveState()

      const result: ArtistSyncResult = {
        artistId: id,
        newAlbums: downloadedAlbumCount,
        newTracks: downloadedTrackCount,
        failedAlbums: failed.length,
        totalAlbumsSeen: filteredIds.length,
        error: null
      }

      this.emit('sync:complete', id, result)
      this.emit('artists:changed', this.state.artists)
      return result
    } catch (err: any) {
      artist.lastSyncAt = new Date().toISOString()
      artist.lastSyncStatus = 'error'
      artist.lastSyncError = err.message
      await this.saveState()
      const result: ArtistSyncResult = {
        artistId: id,
        newAlbums: 0,
        newTracks: 0,
        failedAlbums: 0,
        totalAlbumsSeen: 0,
        error: err.message
      }
      this.emit('sync:error', id, err.message)
      this.emit('artists:changed', this.state.artists)
      return result
    } finally {
      this.activeSyncs.delete(id)
      this.cancelRequested.delete(id)
    }
  }

  async syncAll(): Promise<ArtistSyncResult[]> {
    const enabled = this.state.artists.filter(a => a.enabled)
    const results: ArtistSyncResult[] = []
    for (const artist of enabled) {
      if (this.activeSyncs.has(artist.id)) continue
      try {
        const result = await this.syncArtist(artist.id)
        results.push(result)
      } catch (err: any) {
        results.push({
          artistId: artist.id,
          newAlbums: 0,
          newTracks: 0,
          failedAlbums: 0,
          totalAlbumsSeen: 0,
          error: err.message
        })
      }
    }
    return results
  }

  // Enumerate the full discography via the paced, quota-aware public-API client.
  // Previously this fired raw https.get per page with no retry; on a large
  // discography (or with several syncs running at once) a quota burst would
  // reject the whole enumeration. The client now paces + retries (#84, #93).
  private fetchDeezerArtistDiscography(artistId: string): Promise<DeezerArtistAlbum[]> {
    return fetchDeezerPublicPaginated<DeezerArtistAlbum>(
      `https://api.deezer.com/artist/${artistId}/albums?limit=100`,
      `artist ${artistId} discography`
    )
  }

  // Fetch an album's tracklist via the paced, quota-aware client. A quota trip
  // here used to silently drop the album into failedAlbums with no retry — the
  // root cause of #93. The client now backs off and retries before giving up,
  // and a genuine quota exhaustion surfaces as "Quota limit exceeded" (distinct
  // from an actually-unavailable release, which returns an empty tracklist).
  private async fetchDeezerAlbumTracks(albumId: number): Promise<DeezerAlbumTrack[]> {
    const parsed = await fetchDeezerPublicJson<{ data?: DeezerAlbumTrack[] }>(
      `https://api.deezer.com/album/${albumId}/tracks?limit=200`,
      { label: `album ${albumId} tracks` }
    )
    return parsed.data || []
  }
}

export const artistSync = new ArtistSyncEngine()

// Suppress unused-import warning in case future routes need deezerAuth access.
void deezerAuth
