import { EventEmitter } from 'events'
import { app } from 'electron'
import { join, dirname } from 'path'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { spotifyAPI, describeSpotifyError } from './spotifyAPI'
import { spotifyConverter } from './spotifyConverter'
import { deezerAuth } from './deezerAuth'
import { downloader, type DownloadOptions, type FolderSettings, type TrackTemplates, type MetadataSettings } from './downloader'
import { fetchDeezerPublicJson } from './deezerPublicApi'
import { logSafe } from './logSafe'

export interface SyncDownloadSettings {
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
  savePlaylistAsCompilation: boolean
  createPlaylistFile?: boolean
  // Mirrors the server's `overwriteFiles` setting. Threaded through to the
  // downloader as `overwriteMode` so sync runs honor the user's "skip
  // existing files" choice instead of clobbering pre-existing files and
  // externally-applied tags (e.g. ReplayGain). See issue #66.
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

export type SettingsProvider = () => SyncDownloadSettings

export type SyncSchedule = 'launch' | '1h' | '6h' | '12h' | '24h' | 'manual'

export interface SyncedPlaylist {
  id: string
  source: 'spotify' | 'deezer'
  sourcePlaylistId: string
  sourcePlaylistName: string
  sourcePlaylistUrl: string
  schedule: SyncSchedule
  enabled: boolean
  lastSyncAt: string | null
  lastSyncStatus: 'success' | 'partial' | 'error' | null
  lastSyncError: string | null
  knownTrackIds: string[]
  failedTracks: Array<{
    sourceTrackId: string
    title: string
    artist: string
    error: string
  }>
  totalTracksDownloaded: number
  m3uPath: string | null
  downloadPath: string
  createdAt: string
  // NEW (v1.6.3): how this sync entry came to exist. Favorites-origin
  // entries can be flagged when their source playlist is no longer in the
  // user's Deezer favorites; manual entries are never auto-flagged.
  origin: 'favorites' | 'manual'
  // Timestamp of the most recent refresh that observed this entry's source
  // playlist in the user's Deezer favorites. Compared against the engine's
  // lastFavoritesRefreshAt to decide whether the UI should surface a
  // "no longer favorited" prompt.
  lastSeenInFavoritesAt: string | null
}

export interface SyncResult {
  playlistId: string
  newTracks: number
  failedTracks: number
  totalTracks: number
  m3uPath: string | null
  error: string | null
}

interface SyncState {
  playlists: SyncedPlaylist[]
  activeProfileId?: string | null
  // Timestamp of the most recent full Deezer-favorites refresh. Set when
  // markFavoriteMembership() is invoked. Used to identify stale entries:
  // a favorites-origin entry is stale if its lastSeenInFavoritesAt is null
  // or is earlier than this value.
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

function generateId(): string {
  return `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// Atomic JSON write: stage to a sibling .tmp and rename into place.
// On NTFS / APFS / ext4, rename is atomic, so readers never observe a
// partial file even if the process dies mid-write. Eliminates the torn-write
// hole that caused silent sync-state loss on Windows (v1.6.5).
export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = filePath + '.tmp'
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(tmpPath, JSON.stringify(data, null, 2))
  await rename(tmpPath, filePath)
}

// Preserve the bytes of an unreadable state file before resetting in-memory
// state to defaults. The renamed sibling lets users (and us) recover from
// rare corruption events instead of having the next saveState() overwrite it.
export async function quarantineCorruptFile(filePath: string): Promise<string | null> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = filePath + '.corrupt-' + stamp
    await rename(filePath, dest)
    console.error(`[Sync] State file unreadable, quarantined to ${dest}`)
    return dest
  } catch {
    return null
  }
}

// Bounded-concurrency worker pool. N workers each pull the next index from a
// shared cursor until items are exhausted. Returns results in original order.
// Used by the sync engines to download tracks in parallel up to
// `maxConcurrentDownloads`, instead of the prior strictly-sequential await.
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  if (items.length === 0) return results
  const n = Math.max(1, Math.min(concurrency, items.length))
  let nextIdx = 0
  const pulls = Array.from({ length: n }, async () => {
    while (true) {
      const i = nextIdx++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(pulls)
  return results
}

class PlaylistSyncEngine extends EventEmitter {
  private state: SyncState = { playlists: [] }
  private activeSyncs = new Map<string, boolean>()
  private schedulerInterval: NodeJS.Timeout | null = null
  private isInitialized = false
  private settingsProvider: SettingsProvider | null = null

  /**
   * Set a callback that provides current download settings from the server.
   * This ensures synced playlists use the same quality, folder structure,
   * templates, and metadata settings as regular downloads.
   */
  setSettingsProvider(provider: SettingsProvider): void {
    this.settingsProvider = provider
  }

  private getStatePath(): string {
    return join(app.getPath('userData'), 'playlist-sync.json')
  }

  async init(): Promise<void> {
    await this.loadState()
    this.startScheduler()
    this.isInitialized = true

    // Parallel sync attaches up to maxConcurrentDownloads × 3 listeners on
    // the shared downloader emitter at any moment, and both engines share
    // the singleton. Default Node cap is 10 — raise it to a safe headroom
    // for two engines each running with concurrency up to the 50 ceiling.
    if (typeof (downloader as any).setMaxListeners === 'function') {
      (downloader as any).setMaxListeners(400)
    }

    // Trigger launch syncs
    const launchPlaylists = this.state.playlists.filter(
      p => p.enabled && p.schedule === 'launch'
    )
    for (const playlist of launchPlaylists) {
      this.syncPlaylist(playlist.id).catch(err =>
        console.error(`[PlaylistSync] Launch sync failed for ${playlist.id}:`, err)
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
      this.state = JSON.parse(data)
      if (!Array.isArray(this.state.playlists)) {
        this.state.playlists = []
      }
      // Backfill v1.6.3 fields for entries written by earlier versions.
      // Existing entries default to origin: 'manual' so the new prune logic
      // never auto-flags pre-1.6.3 pins (we cannot retroactively know
      // whether they came from a favorite or a direct Sync page add).
      for (const p of this.state.playlists) {
        if (!p.origin) p.origin = 'manual'
        if (p.lastSeenInFavoritesAt === undefined) p.lastSeenInFavoritesAt = null
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[PlaylistSync] Failed to load state:', err)
        // The file exists but is unreadable. Preserve the bytes before
        // resetting in-memory state, otherwise the next saveState() will
        // overwrite a potentially recoverable file with the empty default.
        await quarantineCorruptFile(this.getStatePath())
      }
      this.state = { playlists: [] }
    }
  }

  // Serialize all saveState calls via a Promise chain. Without this, the
  // bulk-add path (Favorites → Sync all) fires saveState concurrently with
  // fire-and-forget syncPlaylist's own saveState calls — both target the
  // same .tmp sibling of safeWriteJson, racing on writeFile + rename and
  // silently losing entries on Windows where the loser threw EBUSY. Each
  // chained .then() captures a fresh JSON.stringify(this.state) snapshot
  // after the previous rename has landed, so the last-write-wins property
  // becomes deterministic and includes every push made up to that point (#68).
  private savePromise: Promise<void> = Promise.resolve()
  private async saveState(): Promise<void> {
    this.savePromise = this.savePromise.then(async () => {
      try {
        await safeWriteJson(this.getStatePath(), this.state)
      } catch (err) {
        console.error('[PlaylistSync] Failed to save state:', err)
      }
    })
    return this.savePromise
  }

  private startScheduler(): void {
    // Check every 60 seconds which playlists are due for sync
    this.schedulerInterval = setInterval(() => {
      const now = Date.now()
      for (const playlist of this.state.playlists) {
        if (!playlist.enabled || playlist.schedule === 'manual' || playlist.schedule === 'launch') continue
        if (this.activeSyncs.has(playlist.id)) continue

        const interval = SCHEDULE_INTERVALS[playlist.schedule]
        const lastSync = playlist.lastSyncAt ? new Date(playlist.lastSyncAt).getTime() : 0
        if (now - lastSync >= interval) {
          this.syncPlaylist(playlist.id).catch(err =>
            console.error(`[PlaylistSync] Scheduled sync failed for ${playlist.id}:`, err)
          )
        }
      }
    }, 60000)
  }

  // CRUD Operations
  async addPlaylist(config: {
    source: 'spotify' | 'deezer'
    sourcePlaylistId: string
    sourcePlaylistName: string
    sourcePlaylistUrl: string
    schedule: SyncSchedule
    downloadPath: string
    // Origin defaults to 'manual' — entries added directly via the Sync page
    // are manual; entries added via the Favorites → Pin to Sync UX pass
    // 'favorites' so the membership-refresh logic can flag them when the
    // user later un-favorites the playlist on Deezer.
    origin?: 'favorites' | 'manual'
  }): Promise<SyncedPlaylist> {
    const { origin: originParam, ...rest } = config
    const origin: 'favorites' | 'manual' = originParam ?? 'manual'
    // Favorites-origin entries start as observed-in-favorites at creation time
    // so they aren't immediately flagged as stale before the first refresh.
    const nowIso = new Date().toISOString()
    const playlist: SyncedPlaylist = {
      id: generateId(),
      ...rest,
      enabled: true,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      knownTrackIds: [],
      failedTracks: [],
      totalTracksDownloaded: 0,
      m3uPath: null,
      createdAt: nowIso,
      origin,
      lastSeenInFavoritesAt: origin === 'favorites' ? nowIso : null
    }
    this.state.playlists.push(playlist)
    await this.saveState()
    this.emit('playlists:changed', this.state.playlists)

    // Trigger initial sync
    this.syncPlaylist(playlist.id).catch(err =>
      console.error(`[PlaylistSync] Initial sync failed for ${playlist.id}:`, err)
    )

    return playlist
  }

  // Bulk add — one push pass, ONE saveState, ONE 'playlists:changed' emit,
  // and initial syncs spawned respecting the 3-concurrency cap. Replaces the
  // bulk-favorites loop that hammered /api/sync/playlists 300+ times in <60s
  // and got truncated by the per-IP 'sync' rate limit (issue #70 — third fix).
  // Per-item errors are surfaced in the result array instead of throwing,
  // so one bad entry can't drop the whole batch.
  async addPlaylistsBulk(configs: Array<{
    source: 'spotify' | 'deezer'
    sourcePlaylistId: string
    sourcePlaylistName: string
    sourcePlaylistUrl: string
    schedule: SyncSchedule
    downloadPath: string
    origin?: 'favorites' | 'manual'
  }>): Promise<Array<{ ok: boolean; playlist?: SyncedPlaylist; error?: string }>> {
    const results: Array<{ ok: boolean; playlist?: SyncedPlaylist; error?: string }> = []
    const created: SyncedPlaylist[] = []

    for (const config of configs) {
      try {
        if (!config.source || !config.sourcePlaylistId || !config.sourcePlaylistName) {
          results.push({ ok: false, error: 'Missing required fields' })
          continue
        }
        if (!['spotify', 'deezer'].includes(config.source)) {
          results.push({ ok: false, error: 'Invalid source' })
          continue
        }
        // Idempotent: dedupe against in-memory state so callers can safely
        // retry a partial-success bulk without duplicating entries that
        // already landed. Mirrors artistSync.addArtistsBulk.
        const existing = this.state.playlists.find(
          p => p.source === config.source && p.sourcePlaylistId === String(config.sourcePlaylistId)
        )
        if (existing) {
          results.push({ ok: true, playlist: existing })
          continue
        }
        const { origin: originParam, ...rest } = config
        const origin: 'favorites' | 'manual' = originParam ?? 'manual'
        const nowIso = new Date().toISOString()
        const playlist: SyncedPlaylist = {
          id: generateId(),
          ...rest,
          enabled: true,
          lastSyncAt: null,
          lastSyncStatus: null,
          lastSyncError: null,
          knownTrackIds: [],
          failedTracks: [],
          totalTracksDownloaded: 0,
          m3uPath: null,
          createdAt: nowIso,
          origin,
          lastSeenInFavoritesAt: origin === 'favorites' ? nowIso : null
        }
        this.state.playlists.push(playlist)
        created.push(playlist)
        results.push({ ok: true, playlist })
      } catch (err: any) {
        results.push({ ok: false, error: err?.message || 'Failed to add' })
      }
    }

    // Single saveState for the whole batch — the chain still serializes
    // against concurrent in-flight syncs, but we don't enqueue N writes for
    // N additions like the old per-item path did.
    if (created.length > 0) {
      await this.saveState()
      this.emit('playlists:changed', this.state.playlists)
    }

    // Spawn initial syncs respecting the existing 3-concurrency cap. The
    // scheduler picks up the rest at its next 60s tick (all bulk-added
    // entries are 24h-or-similar, so `now - lastSync >= interval` is true).
    for (const playlist of created) {
      this.syncPlaylist(playlist.id).catch(err =>
        console.error(`[PlaylistSync] Initial sync failed for ${playlist.id}:`, err)
      )
    }

    return results
  }

  // Replace the entire in-memory playlist-sync state with a passed-in array,
  // persist once, emit once. Used by the backup/restore feature (#72) — the
  // critical invariant is that we do NOT fire initial syncs for restored
  // entries, because the backup already carries `knownTrackIds` and
  // `lastSyncAt`; firing initial syncs would re-resolve every track and
  // schedule everything for immediate re-download.
  //
  // Per-entry shape is validated minimally (id + source + sourcePlaylistId).
  // Entries failing validation are dropped (not throwing the whole batch).
  async replaceState(playlists: any[]): Promise<{ accepted: number; rejected: number }> {
    if (!Array.isArray(playlists)) {
      return { accepted: 0, rejected: 0 }
    }
    let rejected = 0
    const cleaned: SyncedPlaylist[] = []
    for (const raw of playlists) {
      if (!raw || typeof raw !== 'object') { rejected++; continue }
      if (!raw.id || !raw.source || !raw.sourcePlaylistId) { rejected++; continue }
      if (raw.source !== 'spotify' && raw.source !== 'deezer') { rejected++; continue }
      // Backfill any optional fields added in later versions so the engine
      // doesn't trip over older backups.
      const entry: SyncedPlaylist = {
        id: String(raw.id),
        source: raw.source,
        sourcePlaylistId: String(raw.sourcePlaylistId),
        sourcePlaylistName: String(raw.sourcePlaylistName ?? ''),
        sourcePlaylistUrl: String(raw.sourcePlaylistUrl ?? ''),
        schedule: raw.schedule || '24h',
        enabled: raw.enabled !== false,
        lastSyncAt: raw.lastSyncAt ?? null,
        lastSyncStatus: raw.lastSyncStatus ?? null,
        lastSyncError: raw.lastSyncError ?? null,
        knownTrackIds: Array.isArray(raw.knownTrackIds) ? raw.knownTrackIds.map(String) : [],
        failedTracks: Array.isArray(raw.failedTracks) ? raw.failedTracks : [],
        totalTracksDownloaded: Number(raw.totalTracksDownloaded) || 0,
        m3uPath: raw.m3uPath ?? null,
        downloadPath: String(raw.downloadPath ?? ''),
        createdAt: raw.createdAt || new Date().toISOString(),
        origin: raw.origin === 'favorites' ? 'favorites' : 'manual',
        lastSeenInFavoritesAt: raw.lastSeenInFavoritesAt ?? null
      }
      cleaned.push(entry)
    }
    this.state.playlists = cleaned
    // Preserve activeProfileId and lastFavoritesRefreshAt if the engine had
    // them — those are install-local and shouldn't be wiped by restore.
    await this.saveState()
    this.emit('playlists:changed', this.state.playlists)
    return { accepted: cleaned.length, rejected }
  }

  async removePlaylist(id: string): Promise<void> {
    this.state.playlists = this.state.playlists.filter(p => p.id !== id)
    this.activeSyncs.delete(id)
    await this.saveState()
    this.emit('playlists:changed', this.state.playlists)
  }

  async updatePlaylist(id: string, updates: Partial<Pick<SyncedPlaylist, 'schedule' | 'enabled' | 'downloadPath' | 'sourcePlaylistName'>>): Promise<SyncedPlaylist | null> {
    const playlist = this.state.playlists.find(p => p.id === id)
    if (!playlist) return null
    Object.assign(playlist, updates)
    await this.saveState()
    this.emit('playlists:changed', this.state.playlists)
    return playlist
  }

  getPlaylists(): SyncedPlaylist[] {
    return this.state.playlists
  }

  getPlaylist(id: string): SyncedPlaylist | null {
    return this.state.playlists.find(p => p.id === id) || null
  }

  getLastFavoritesRefreshAt(): string | null {
    return this.state.lastFavoritesRefreshAt ?? null
  }

  // Compares each favorites-origin entry against the supplied list of Deezer
  // playlist IDs currently in the user's favorites. For matches, refreshes
  // lastSeenInFavoritesAt to now. Non-matches keep their stale timestamp (or
  // null), and combined with the global lastFavoritesRefreshAt that lets the
  // UI surface a "no longer in your Deezer favorites" badge with a Remove
  // affordance — without auto-deleting anything.
  //
  // Manual-origin entries are untouched.
  async markFavoriteMembership(deezerFavoritePlaylistIds: string[]): Promise<{
    refreshed: number
    stale: number
  }> {
    const now = new Date().toISOString()
    const favSet = new Set(deezerFavoritePlaylistIds.map(String))
    let refreshed = 0
    let stale = 0
    for (const p of this.state.playlists) {
      if (p.origin !== 'favorites') continue
      // Only Deezer-source favorites can be matched — Spotify playlists
      // don't live in the Deezer favorites list.
      if (p.source !== 'deezer') continue
      if (favSet.has(p.sourcePlaylistId)) {
        p.lastSeenInFavoritesAt = now
        refreshed++
      } else {
        stale++
      }
    }
    this.state.lastFavoritesRefreshAt = now
    await this.saveState()
    this.emit('playlists:changed', this.state.playlists)
    return { refreshed, stale }
  }

  // Reset a playlist's known tracks so next sync re-downloads everything
  async resetPlaylist(id: string): Promise<boolean> {
    const playlist = this.state.playlists.find(p => p.id === id)
    if (!playlist) return false
    playlist.knownTrackIds = []
    playlist.totalTracksDownloaded = 0
    playlist.failedTracks = []
    playlist.lastSyncStatus = null
    playlist.lastSyncError = null
    await this.saveState()
    this.emit('playlists:changed', this.state.playlists)
    return true
  }

  // Sync Operations
  async syncPlaylist(id: string): Promise<SyncResult> {
    const playlist = this.state.playlists.find(p => p.id === id)
    if (!playlist) {
      throw new Error(`Playlist ${id} not found`)
    }
    if (this.activeSyncs.has(id)) {
      throw new Error(`Playlist ${id} is already syncing`)
    }

    // Limit concurrent syncs. Soft-skip if at cap — the 60s scheduler will
    // retry the unscheduled ones once active syncs drain. Previously this
    // threw, which under bulk-add flooded logs with ~47 errors per 50-add
    // operation. Throwing here also broke the fire-and-forget callers (#68).
    if (this.activeSyncs.size >= 3) {
      console.log(`[PlaylistSync] Skipping initial sync for ${logSafe(id)} — at concurrency cap; scheduler will retry`)
      return {
        playlistId: id,
        newTracks: 0,
        failedTracks: 0,
        totalTracks: 0,
        m3uPath: null,
        error: null
      }
    }

    this.activeSyncs.set(id, true)
    this.emit('sync:start', id)
    console.log(`[PlaylistSync] Starting sync for "${playlist.sourcePlaylistName}" (${playlist.source}:${playlist.sourcePlaylistId})`)

    try {
      // Fetch current track list from source
      let currentTrackIds: string[] = []
      let trackMap = new Map<string, { title: string; artist: string }>()
      let playlistCoverUrl = ''

      if (playlist.source === 'spotify') {
        console.log(`[PlaylistSync] Spotify credentials available: ${spotifyAPI.hasCredentials()}`)
        if (!spotifyAPI.hasCredentials()) {
          throw new Error('Spotify credentials not configured. Go to Settings > Spotify and click Test Connection.')
        }
        console.log(`[PlaylistSync] Fetching Spotify playlist ${playlist.sourcePlaylistId}...`)
        const spotifyPlaylist = await spotifyAPI.getPlaylist(playlist.sourcePlaylistId)
        playlistCoverUrl = spotifyPlaylist.images?.[0]?.url || ''
        const tracks = spotifyPlaylist.tracks.items
          .filter(item => item.track)
          .map(item => item.track)

        for (const track of tracks) {
          currentTrackIds.push(track.id)
          trackMap.set(track.id, {
            title: track.name,
            artist: track.artists.map(a => a.name).join(', ')
          })
        }
      } else {
        // Deezer playlist
        console.log(`[PlaylistSync] Fetching Deezer playlist ${playlist.sourcePlaylistId}...`)
        const [response, playlistMeta] = await Promise.all([
          this.fetchDeezerPlaylist(playlist.sourcePlaylistId),
          this.fetchDeezerPlaylistInfo(playlist.sourcePlaylistId)
        ])
        playlistCoverUrl = playlistMeta.picture_xl || playlistMeta.picture_big || ''
        console.log(`[PlaylistSync] Fetched ${response.tracks.length} tracks from Deezer`)
        for (const track of response.tracks) {
          const trackId = String(track.id)
          currentTrackIds.push(trackId)
          trackMap.set(trackId, {
            title: track.title,
            artist: track.artist?.name || 'Unknown'
          })
        }
      }

      // Compute diff
      const knownSet = new Set(playlist.knownTrackIds)
      const newTrackIds = currentTrackIds.filter(id => !knownSet.has(id))

      this.emit('sync:progress', id, {
        current: 0,
        total: newTrackIds.length,
        phase: 'resolving'
      })

      // Convert new tracks to Deezer IDs for download
      let deezerTrackIds: number[] = []
      // Map Deezer track ID → source track ID (for marking known after download)
      const deezerToSourceId: Map<number, string> = new Map()
      const failed: SyncedPlaylist['failedTracks'] = []

      if (playlist.source === 'spotify' && newTrackIds.length > 0) {
        // Get full Spotify track objects for conversion
        const spotifyPlaylist = await spotifyAPI.getPlaylist(playlist.sourcePlaylistId)
        const newSpotifyTracks = spotifyPlaylist.tracks.items
          .filter(item => item.track && newTrackIds.includes(item.track.id))
          .map(item => item.track)

        const result = await spotifyConverter.convertPlaylist({
          tracks: { items: newSpotifyTracks.map(t => ({ track: t })), total: newSpotifyTracks.length }
        } as any)

        for (const match of result.matched) {
          if (match.deezerTrack) {
            deezerTrackIds.push(match.deezerTrack.id)
            // Map back to Spotify ID so we can mark it as known
            deezerToSourceId.set(match.deezerTrack.id, match.spotifyTrack?.id || String(match.deezerTrack.id))
          }
        }
        for (const unmatched of result.unmatched) {
          failed.push({
            sourceTrackId: unmatched.id,
            title: unmatched.name,
            artist: unmatched.artists.map(a => a.name).join(', '),
            error: 'No Deezer match found'
          })
        }
      } else if (playlist.source === 'deezer') {
        deezerTrackIds = newTrackIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id))
        for (const did of deezerTrackIds) {
          deezerToSourceId.set(did, String(did))
        }
      }

      // Build position map: source track ID → playlist position (1-based)
      const sourceIdToPosition = new Map<string, number>()
      for (let i = 0; i < currentTrackIds.length; i++) {
        sourceIdToPosition.set(currentTrackIds[i], i + 1)
      }

      // Download new tracks using current app settings
      // Each download is queued and we wait for it to actually complete before
      // marking the track as "known". This ensures failed or interrupted tracks
      // will be retried on the next sync.
      const settings = this.settingsProvider?.()
      let downloadedCount = 0
      const successfullyDownloadedIds: string[] = []

      // Register playlist for automatic M3U generation. Each sync run gets a
      // timestamped M3U snapshot so users can see what changed when. The
      // downloader auto-generates the M3U from real file paths as tracks
      // complete (or after a 30s activity timeout).
      // We resolve the timestamp ONCE here (sync start) and bake it into the
      // template literal — otherwise the prediction below could disagree
      // with the downloader's own resolution at write time.
      const m3uOutputDir = playlist.downloadPath || settings?.downloadPath || join(process.env.HOME || process.env.USERPROFILE || '/tmp', 'Music', 'Deemix')
      const m3uTrackerId = `sync_${playlist.id}_${Date.now()}`
      const shouldGenerateM3U = !!settings?.createPlaylistFile && deezerTrackIds.length > 0
      const syncStart = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const syncDateStr = `${syncStart.getFullYear()}-${pad(syncStart.getMonth() + 1)}-${pad(syncStart.getDate())}`
      const syncTimeStr = `${pad(syncStart.getHours())}-${pad(syncStart.getMinutes())}-${pad(syncStart.getSeconds())}`
      const syncTimestamp = `${syncDateStr}_${syncTimeStr}`
      if (shouldGenerateM3U) {
        downloader.registerPlaylistForM3U(
          m3uTrackerId,
          playlist.sourcePlaylistName,
          m3uOutputDir,
          deezerTrackIds.length,
          `%playlist% - ${syncTimestamp}`
        )
      }

      // Parallel download pool capped by maxConcurrentDownloads. Previously
      // this loop awaited each track to fully complete before queueing the
      // next, which serialized everything to a single in-flight download
      // regardless of the user's concurrency setting. We now run N workers
      // (N = maxConcurrentDownloads, default 5) and emit progress as each
      // track completes. For a 400-track playlist this is the difference
      // between ~30 min and ~6 min at the default setting.
      const poolConcurrency = Math.max(1, settings?.maxConcurrentDownloads ?? 5)
      let completedCount = 0

      const trackResults = await runPool(
        deezerTrackIds,
        poolConcurrency,
        async (trackId) => {
          // Capture per-track context up front so error paths can populate
          // the failed-tracks list with meaningful title/artist info.
          const sourceId = deezerToSourceId.get(trackId) || String(trackId)
          const playlistPosition = sourceIdToPosition.get(sourceId) || 0

          const downloadOpts: DownloadOptions = {
            trackId,
            outputPath: playlist.downloadPath || settings?.downloadPath || join(process.env.HOME || process.env.USERPROFILE || '/tmp', 'Music', 'Deemix'),
            quality: settings?.quality || 'MP3_320',
            bitrateFallback: settings?.bitrateFallback ?? true,
            isrcFallback: settings?.isrcFallback ?? true,
            createFolders: true,
            artistFolder: settings?.createArtistFolder ?? false,
            albumFolder: settings?.createAlbumFolder ?? true,
            saveArtwork: settings?.saveArtwork ?? true,
            embedArtwork: settings?.embedArtwork ?? true,
            saveLyrics: settings?.saveLyrics ?? true,
            syncedLyrics: settings?.syncedLyrics ?? true,
            isSingle: false,
            isFromPlaylist: true,
            playlistName: playlist.sourcePlaylistName,
            playlistCoverUrl: playlistCoverUrl || undefined,
            playlistPosition: playlistPosition,
            createErrorLog: settings?.createErrorLog ?? true,
            savePlaylistAsCompilation: settings?.savePlaylistAsCompilation ?? false,
            // Safe-side default: scheduled/unattended sync must not destroy
            // existing files unless the user explicitly opted in via the
            // global setting. Downloader's own default is 'overwrite'.
            overwriteMode: settings?.overwriteFiles ?? 'no',
            skipDuplicateTracks: settings?.skipDuplicateTracks ?? false,
            folderSettings: settings?.folderSettings,
            trackTemplates: settings?.trackTemplates,
            metadataSettings: settings?.metadataSettings,
            ...(shouldGenerateM3U ? { _m3uTrackerId: m3uTrackerId } : {})
          }

          try {
            const downloadId = await downloader.download(downloadOpts)

            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                cleanup()
                reject(new Error('Download timed out'))
              }, 5 * 60 * 1000) // 5 minute timeout per track

              const onComplete = (progress: any) => {
                if (progress.id === downloadId) { cleanup(); resolve() }
              }
              const onError = (progress: any) => {
                if (progress.id === downloadId) {
                  cleanup()
                  reject(new Error(progress.error || 'Download failed'))
                }
              }
              const onCancelled = (progress: any) => {
                if (progress.id === downloadId) {
                  cleanup()
                  reject(new Error('Download cancelled'))
                }
              }
              const cleanup = () => {
                clearTimeout(timeout)
                downloader.removeListener('complete', onComplete)
                downloader.removeListener('error', onError)
                downloader.removeListener('cancelled', onCancelled)
              }

              // Check if already completed (e.g., duplicate/skipped)
              const current = downloader.getAllProgress().find(p => p.id === downloadId)
              if (current?.status === 'completed') { cleanup(); resolve(); return }
              if (current?.status === 'error') {
                cleanup()
                reject(new Error(current.error || 'Download failed'))
                return
              }

              downloader.on('complete', onComplete)
              downloader.on('error', onError)
              downloader.on('cancelled', onCancelled)
            })

            // Emit progress as each track *completes*, not as it starts —
            // with parallel workers, completion order is what matters.
            completedCount++
            this.emit('sync:progress', id, {
              current: completedCount,
              total: deezerTrackIds.length,
              phase: 'downloading'
            })
            return { ok: true as const, sourceId }
          } catch (err: any) {
            completedCount++
            this.emit('sync:progress', id, {
              current: completedCount,
              total: deezerTrackIds.length,
              phase: 'downloading'
            })
            const info = trackMap.get(String(trackId))
            return {
              ok: false as const,
              failure: {
                sourceTrackId: String(trackId),
                title: info?.title || `Track ${trackId}`,
                artist: info?.artist || 'Unknown',
                error: err.message || 'Download failed'
              }
            }
          }
        }
      )

      // Aggregate worker results into the existing accounting structures.
      for (const r of trackResults) {
        if (r.ok) {
          downloadedCount++
          successfullyDownloadedIds.push(r.sourceId)
        } else {
          failed.push(r.failure)
        }
      }

      // Update state — only mark successfully downloaded tracks as "known"
      // Failed tracks stay out of knownTrackIds so they'll be retried next sync
      const previousKnown = new Set(playlist.knownTrackIds)
      for (const sid of successfullyDownloadedIds) {
        previousKnown.add(sid)
      }
      playlist.knownTrackIds = currentTrackIds.filter(id => previousKnown.has(id))
      playlist.failedTracks = failed
      playlist.totalTracksDownloaded += downloadedCount
      playlist.lastSyncAt = new Date().toISOString()
      playlist.lastSyncStatus = failed.length > 0
        ? (downloadedCount > 0 ? 'partial' : 'error')
        : 'success'
      playlist.lastSyncError = failed.length > 0
        ? `${failed.length} track(s) failed`
        : null

      await this.saveState()

      // Predict the M3U output path so the UI/result can surface it. The
      // timestamp was baked into the template at sync start, so this matches
      // exactly what the downloader will write when all tracks complete.
      let m3uPath: string | null = null
      if (shouldGenerateM3U && downloadedCount > 0) {
        const resolvedName = `${playlist.sourcePlaylistName} - ${syncTimestamp}`
        const sanitized = downloader.sanitizeFilename(resolvedName)
        m3uPath = join(m3uOutputDir, `${sanitized}.m3u8`)
        playlist.m3uPath = m3uPath
        await this.saveState()
      }

      const result: SyncResult = {
        playlistId: id,
        newTracks: downloadedCount,
        failedTracks: failed.length,
        totalTracks: currentTrackIds.length,
        m3uPath: m3uPath || playlist.m3uPath,
        error: null
      }

      this.emit('sync:complete', id, result)
      this.emit('playlists:changed', this.state.playlists)
      return result

    } catch (err: any) {
      playlist.lastSyncAt = new Date().toISOString()
      playlist.lastSyncStatus = 'error'
      // Store the explained form, not the raw API text. "Resource not found"
      // told users nothing and was indistinguishable from the premium-block
      // failure, which is why #117 and #137 read as the same bug (#137).
      playlist.lastSyncError = playlist.source === 'spotify'
        ? describeSpotifyError(err, playlist.sourcePlaylistId)
        : err.message
      await this.saveState()

      const result: SyncResult = {
        playlistId: id,
        newTracks: 0,
        failedTracks: 0,
        totalTracks: 0,
        m3uPath: null,
        error: err.message
      }
      this.emit('sync:error', id, err.message)
      this.emit('playlists:changed', this.state.playlists)
      return result
    } finally {
      this.activeSyncs.delete(id)
    }
  }

  async syncAll(): Promise<SyncResult[]> {
    const enabled = this.state.playlists.filter(p => p.enabled)
    const results: SyncResult[] = []
    for (const playlist of enabled) {
      if (this.activeSyncs.has(playlist.id)) continue
      try {
        const result = await this.syncPlaylist(playlist.id)
        results.push(result)
      } catch (err: any) {
        results.push({
          playlistId: playlist.id,
          newTracks: 0,
          failedTracks: 0,
          totalTracks: 0,
          m3uPath: null,
          error: err.message
        })
      }
    }
    return results
  }

  cancelSync(id: string): void {
    this.activeSyncs.delete(id)
  }

  isSyncing(id: string): boolean {
    return this.activeSyncs.has(id)
  }

  getActiveSyncIds(): string[] {
    return Array.from(this.activeSyncs.keys())
  }

  // Playlist artwork — best-effort, never fails a sync. Routed through the paced
  // client so it can't contribute to a quota burst (#84, #93).
  private async fetchDeezerPlaylistInfo(playlistId: string): Promise<{ picture_xl?: string; picture_big?: string }> {
    try {
      return await fetchDeezerPublicJson<{ picture_xl?: string; picture_big?: string }>(
        `https://api.deezer.com/playlist/${playlistId}`,
        { label: `playlist ${playlistId} info` }
      )
    } catch {
      return {}
    }
  }

  // Playlist tracklist via the paced, quota-aware client — a quota trip now backs
  // off and retries instead of failing the whole sync (#84, #93).
  private async fetchDeezerPlaylist(playlistId: string): Promise<{ tracks: Array<{ id: number; title: string; artist: { name: string } }> }> {
    const parsed = await fetchDeezerPublicJson<{ data?: Array<{ id: number; title: string; artist: { name: string } }> }>(
      `https://api.deezer.com/playlist/${playlistId}/tracks?limit=2000`,
      { label: `playlist ${playlistId} tracks` }
    )
    return { tracks: parsed.data || [] }
  }
}

export const playlistSync = new PlaylistSyncEngine()
