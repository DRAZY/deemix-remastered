import { EventEmitter } from 'events'
import * as https from 'https'
import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { spotifyAPI } from './spotifyAPI'
import { spotifyConverter } from './spotifyConverter'
import { deezerAuth } from './deezerAuth'
import { downloader, type DownloadOptions, type FolderSettings, type TrackTemplates, type MetadataSettings } from './downloader'

export interface SyncDownloadSettings {
  downloadPath: string
  quality: 'MP3_128' | 'MP3_320' | 'FLAC'
  bitrateFallback: boolean
  createArtistFolder: boolean
  createAlbumFolder: boolean
  saveArtwork: boolean
  embedArtwork: boolean
  saveLyrics: boolean
  syncedLyrics: boolean
  createErrorLog: boolean
  savePlaylistAsCompilation: boolean
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
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[PlaylistSync] Failed to load state:', err)
      }
      this.state = { playlists: [] }
    }
  }

  private async saveState(): Promise<void> {
    try {
      await mkdir(app.getPath('userData'), { recursive: true })
      await writeFile(this.getStatePath(), JSON.stringify(this.state, null, 2))
    } catch (err) {
      console.error('[PlaylistSync] Failed to save state:', err)
    }
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
  }): Promise<SyncedPlaylist> {
    const playlist: SyncedPlaylist = {
      id: generateId(),
      ...config,
      enabled: true,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      knownTrackIds: [],
      failedTracks: [],
      totalTracksDownloaded: 0,
      m3uPath: null,
      createdAt: new Date().toISOString()
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

  // Sync Operations
  async syncPlaylist(id: string): Promise<SyncResult> {
    const playlist = this.state.playlists.find(p => p.id === id)
    if (!playlist) {
      throw new Error(`Playlist ${id} not found`)
    }
    if (this.activeSyncs.has(id)) {
      throw new Error(`Playlist ${id} is already syncing`)
    }

    // Limit concurrent syncs
    if (this.activeSyncs.size >= 3) {
      throw new Error('Maximum concurrent syncs reached (3)')
    }

    this.activeSyncs.set(id, true)
    this.emit('sync:start', id)
    console.log(`[PlaylistSync] Starting sync for "${playlist.sourcePlaylistName}" (${playlist.source}:${playlist.sourcePlaylistId})`)

    try {
      // Fetch current track list from source
      let currentTrackIds: string[] = []
      let trackMap = new Map<string, { title: string; artist: string }>()

      if (playlist.source === 'spotify') {
        console.log(`[PlaylistSync] Spotify credentials available: ${spotifyAPI.hasCredentials()}`)
        if (!spotifyAPI.hasCredentials()) {
          throw new Error('Spotify credentials not configured. Go to Settings > Spotify and click Test Connection.')
        }
        console.log(`[PlaylistSync] Fetching Spotify playlist ${playlist.sourcePlaylistId}...`)
        const spotifyPlaylist = await spotifyAPI.getPlaylist(playlist.sourcePlaylistId)
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
        const response = await this.fetchDeezerPlaylist(playlist.sourcePlaylistId)
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
      }

      // Download new tracks using current app settings
      const settings = this.settingsProvider?.()
      let downloadedCount = 0
      for (let i = 0; i < deezerTrackIds.length; i++) {
        const trackId = deezerTrackIds[i]
        try {
          this.emit('sync:progress', id, {
            current: i + 1,
            total: deezerTrackIds.length,
            phase: 'downloading'
          })
          const downloadOpts: DownloadOptions = {
            trackId,
            outputPath: playlist.downloadPath || settings?.downloadPath || join(process.env.HOME || process.env.USERPROFILE || '/tmp', 'Music', 'Deemix'),
            quality: settings?.quality || 'MP3_320',
            bitrateFallback: settings?.bitrateFallback ?? true,
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
            createErrorLog: settings?.createErrorLog ?? true,
            savePlaylistAsCompilation: settings?.savePlaylistAsCompilation ?? false,
            folderSettings: settings?.folderSettings,
            trackTemplates: settings?.trackTemplates,
            metadataSettings: settings?.metadataSettings
          }
          await downloader.download(downloadOpts)
          downloadedCount++
        } catch (err: any) {
          const info = trackMap.get(String(trackId))
          failed.push({
            sourceTrackId: String(trackId),
            title: info?.title || `Track ${trackId}`,
            artist: info?.artist || 'Unknown',
            error: err.message || 'Download failed'
          })
        }
      }

      // Update state
      playlist.knownTrackIds = currentTrackIds
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

      const result: SyncResult = {
        playlistId: id,
        newTracks: downloadedCount,
        failedTracks: failed.length,
        totalTracks: currentTrackIds.length,
        m3uPath: playlist.m3uPath,
        error: null
      }

      this.emit('sync:complete', id, result)
      this.emit('playlists:changed', this.state.playlists)
      return result

    } catch (err: any) {
      playlist.lastSyncAt = new Date().toISOString()
      playlist.lastSyncStatus = 'error'
      playlist.lastSyncError = err.message
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

  private async fetchDeezerPlaylist(playlistId: string): Promise<{ tracks: Array<{ id: number; title: string; artist: { name: string } }> }> {
    return new Promise((resolve, reject) => {
      const url = `https://api.deezer.com/playlist/${playlistId}/tracks?limit=2000`
      https.get(url, (res) => {
        let data = ''
        res.on('data', (chunk: string) => data += chunk)
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.error) {
              reject(new Error(parsed.error.message || 'Deezer API error'))
            } else {
              resolve({ tracks: parsed.data || [] })
            }
          } catch (e) {
            reject(new Error('Failed to parse Deezer response'))
          }
        })
      }).on('error', reject)
    })
  }
}

export const playlistSync = new PlaylistSyncEngine()
