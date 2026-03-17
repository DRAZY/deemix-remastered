import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

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

export const useSyncStore = defineStore('sync', () => {
  const playlists = ref<SyncedPlaylist[]>([])
  const activeSyncIds = ref<string[]>([])
  const syncProgress = ref<Map<string, { current: number; total: number; phase: string }>>(new Map())
  const serverPort = ref(6595)
  const isLoading = ref(false)
  let initialized = false
  let fetchInFlight = false

  const enabledPlaylists = computed(() => playlists.value.filter(p => p.enabled))

  async function init() {
    if (initialized) return // Prevent duplicate init
    initialized = true

    if (window.electronAPI) {
      serverPort.value = await window.electronAPI.getServerPort()

      // Setup IPC listeners for real-time sync events
      window.electronAPI.playlistSync.onSyncStart((data) => {
        if (!activeSyncIds.value.includes(data.playlistId)) {
          activeSyncIds.value.push(data.playlistId)
        }
      })

      window.electronAPI.playlistSync.onSyncProgress((data) => {
        syncProgress.value.set(data.playlistId, {
          current: data.current,
          total: data.total,
          phase: data.phase
        })
      })

      window.electronAPI.playlistSync.onSyncComplete((data) => {
        activeSyncIds.value = activeSyncIds.value.filter(id => id !== data.playlistId)
        syncProgress.value.delete(data.playlistId)
        fetchPlaylists() // Refresh data
      })

      window.electronAPI.playlistSync.onSyncError((data) => {
        activeSyncIds.value = activeSyncIds.value.filter(id => id !== data.playlistId)
        syncProgress.value.delete(data.playlistId)
        fetchPlaylists() // Refresh data
      })
    }

    await fetchPlaylists()
  }

  async function fetchPlaylists() {
    if (fetchInFlight) return // Deduplicate concurrent fetches
    fetchInFlight = true
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/playlists`)
      if (!response.ok) {
        console.warn(`[SyncStore] Fetch playlists returned ${response.status}, skipping`)
        return
      }
      const data = await response.json()
      playlists.value = data.playlists || []
      activeSyncIds.value = data.activeSyncIds || []
    } catch (e) {
      console.error('[SyncStore] Failed to fetch playlists:', e)
    } finally {
      fetchInFlight = false
    }
  }

  async function addPlaylist(config: {
    source: 'spotify' | 'deezer'
    sourcePlaylistId: string
    sourcePlaylistName: string
    sourcePlaylistUrl: string
    schedule: SyncSchedule
    downloadPath: string
  }) {
    isLoading.value = true
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/playlists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      })
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        return { success: false, error: errData.error || `Server returned ${response.status}` }
      }
      const data = await response.json()
      if (data.success) {
        // Refresh playlist list (non-blocking — don't let this fail the add)
        fetchPlaylists().catch(() => {})
      }
      return data
    } catch (e: any) {
      return { success: false, error: e.message }
    } finally {
      isLoading.value = false
    }
  }

  async function removePlaylist(id: string) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/playlists`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      await fetchPlaylists()
    } catch (e) {
      console.error('[SyncStore] Failed to remove playlist:', e)
    }
  }

  async function updatePlaylist(id: string, updates: Partial<SyncedPlaylist>) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/playlists`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates })
      })
      await fetchPlaylists()
    } catch (e) {
      console.error('[SyncStore] Failed to update playlist:', e)
    }
  }

  async function syncPlaylist(id: string) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
    } catch (e) {
      console.error('[SyncStore] Failed to trigger sync:', e)
    }
  }

  async function syncAll() {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/run-all`, {
        method: 'POST'
      })
    } catch (e) {
      console.error('[SyncStore] Failed to trigger sync all:', e)
    }
  }

  async function cancelSync(id: string) {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/sync/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      activeSyncIds.value = activeSyncIds.value.filter(i => i !== id)
      syncProgress.value.delete(id)
    } catch (e) {
      console.error('[SyncStore] Failed to cancel sync:', e)
    }
  }

  function isSyncing(id: string): boolean {
    return activeSyncIds.value.includes(id)
  }

  function getProgress(id: string) {
    return syncProgress.value.get(id)
  }

  return {
    playlists,
    activeSyncIds,
    syncProgress,
    serverPort,
    isLoading,
    enabledPlaylists,
    init,
    fetchPlaylists,
    addPlaylist,
    removePlaylist,
    updatePlaylist,
    syncPlaylist,
    syncAll,
    cancelSync,
    isSyncing,
    getProgress
  }
})
