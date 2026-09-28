import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import i18n from '../i18n'

export type SyncSchedule = 'launch' | '1h' | '6h' | '12h' | '24h' | 'manual'
export type FirstSyncMode = 'subscribe-forward' | 'download-backlog' | 'date-threshold'

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
  totalAlbumsDownloaded: number
  totalTracksDownloaded: number
  downloadPath: string
  filters: ArtistSyncFilters
  firstSyncMode: FirstSyncMode
  createdAt: string
  origin?: 'favorites' | 'manual'
  lastSeenInFavoritesAt?: string | null
}

export const useArtistSyncStore = defineStore('artistSync', () => {
  const artists = ref<SyncedArtist[]>([])
  const activeSyncIds = ref<string[]>([])
  const syncProgress = ref<Map<string, { current: number; total: number; phase: string; albumTitle?: string }>>(new Map())
  const serverPort = ref(6595)
  const isLoading = ref(false)
  const lastFavoritesRefreshAt = ref<string | null>(null)
  let initialized = false
  let fetchInFlight = false

  const enabledArtists = computed(() => artists.value.filter(a => a.enabled))

  function isStale(artist: SyncedArtist): boolean {
    if (artist.origin !== 'favorites') return false
    if (!lastFavoritesRefreshAt.value) return false
    if (!artist.lastSeenInFavoritesAt) return true
    return artist.lastSeenInFavoritesAt < lastFavoritesRefreshAt.value
  }

  async function init() {
    if (initialized) return
    initialized = true

    if (window.electronAPI) {
      serverPort.value = await window.electronAPI.getServerPort()

      window.electronAPI.artistSync.onSyncStart((data) => {
        if (!activeSyncIds.value.includes(data.artistId)) {
          activeSyncIds.value.push(data.artistId)
        }
      })

      window.electronAPI.artistSync.onSyncProgress((data) => {
        syncProgress.value.set(data.artistId, {
          current: data.current,
          total: data.total,
          phase: data.phase,
          albumTitle: data.albumTitle
        })
      })

      window.electronAPI.artistSync.onSyncComplete((data) => {
        activeSyncIds.value = activeSyncIds.value.filter(id => id !== data.artistId)
        syncProgress.value.delete(data.artistId)
        fetchArtists()
      })

      window.electronAPI.artistSync.onSyncError((data) => {
        activeSyncIds.value = activeSyncIds.value.filter(id => id !== data.artistId)
        syncProgress.value.delete(data.artistId)
        fetchArtists()
      })
    }

    await fetchArtists()
  }

  async function fetchArtists() {
    if (fetchInFlight) return
    fetchInFlight = true
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists`)
      if (!response.ok) {
        console.warn(`[ArtistSyncStore] Fetch artists returned ${response.status}, skipping`)
        return
      }
      const data = await response.json()
      artists.value = data.artists || []
      activeSyncIds.value = data.activeSyncIds || []
      lastFavoritesRefreshAt.value = data.lastFavoritesRefreshAt ?? null
    } catch (e) {
      console.error('[ArtistSyncStore] Failed to fetch artists:', e)
    } finally {
      fetchInFlight = false
    }
  }

  async function addArtist(config: {
    sourceArtistId: string
    sourceArtistName: string
    sourceArtistUrl: string
    schedule: SyncSchedule
    downloadPath: string
    firstSyncMode?: FirstSyncMode
    filters?: Partial<ArtistSyncFilters>
    origin?: 'favorites' | 'manual'
  }) {
    isLoading.value = true
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      })
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        return { success: false, error: errData.error || i18n.global.t('common.serverReturned', { status: response.status }) }
      }
      const data = await response.json()
      if (data.success) {
        fetchArtists().catch(() => {})
      }
      return data
    } catch (e: any) {
      return { success: false, error: e.message }
    } finally {
      isLoading.value = false
    }
  }

  // Bulk add — see syncStore.addPlaylistsBulk for the contract & rationale (#70).
  async function addArtistsBulk(configs: Array<{
    sourceArtistId: string
    sourceArtistName: string
    sourceArtistUrl: string
    schedule: SyncSchedule
    downloadPath: string
    firstSyncMode?: FirstSyncMode
    filters?: Partial<ArtistSyncFilters>
    origin?: 'favorites' | 'manual'
  }>): Promise<{
    success: boolean
    added: number
    failed: number
    results: Array<{ ok: boolean; artist?: SyncedArtist; error?: string }>
    error?: string
  }> {
    isLoading.value = true
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: configs })
      })
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        return {
          success: false,
          added: 0,
          failed: configs.length,
          results: configs.map(() => ({ ok: false, error: errData.error || i18n.global.t('common.serverReturned', { status: response.status }) })),
          error: errData.error || i18n.global.t('common.serverReturned', { status: response.status })
        }
      }
      const data = await response.json()
      fetchArtists().catch(err => console.warn('[ArtistSyncStore] post-bulk refresh failed:', err))
      return data
    } catch (e: any) {
      return {
        success: false,
        added: 0,
        failed: configs.length,
        results: configs.map(() => ({ ok: false, error: e.message })),
        error: e.message
      }
    } finally {
      isLoading.value = false
    }
  }

  async function removeArtist(id: string) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      await fetchArtists()
    } catch (e) {
      console.error('[ArtistSyncStore] Failed to remove artist:', e)
    }
  }

  async function updateArtist(id: string, updates: Partial<SyncedArtist>) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates })
      })
      await fetchArtists()
    } catch (e) {
      console.error('[ArtistSyncStore] Failed to update artist:', e)
    }
  }

  async function syncArtist(id: string) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
    } catch (e) {
      console.error('[ArtistSyncStore] Failed to trigger sync:', e)
    }
  }

  async function forceSync(id: string) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      await fetchArtists()
      await syncArtist(id)
    } catch (e) {
      console.error('[ArtistSyncStore] Failed to force sync:', e)
    }
  }

  async function syncAll() {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists/run-all`, {
        method: 'POST'
      })
    } catch (e) {
      console.error('[ArtistSyncStore] Failed to trigger sync all:', e)
    }
  }

  async function cancelSync(id: string) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/artists/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      activeSyncIds.value = activeSyncIds.value.filter(i => i !== id)
      syncProgress.value.delete(id)
    } catch (e) {
      console.error('[ArtistSyncStore] Failed to cancel sync:', e)
    }
  }

  function isSyncing(id: string): boolean {
    return activeSyncIds.value.includes(id)
  }

  function getProgress(id: string) {
    return syncProgress.value.get(id)
  }

  return {
    artists,
    activeSyncIds,
    syncProgress,
    serverPort,
    isLoading,
    lastFavoritesRefreshAt,
    enabledArtists,
    init,
    fetchArtists,
    addArtist,
    addArtistsBulk,
    removeArtist,
    updateArtist,
    syncArtist,
    forceSync,
    syncAll,
    cancelSync,
    isSyncing,
    isStale,
    getProgress
  }
})
