<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFavoritesStore } from '../stores/favoritesStore'
import { useAuthStore } from '../stores/authStore'
import { useDownloadStore } from '../stores/downloadStore'
import { useToastStore } from '../stores/toastStore'
import { useSyncStore, type SyncedPlaylist } from '../stores/syncStore'
import { useArtistSyncStore, type SyncedArtist, type FirstSyncMode } from '../stores/artistSyncStore'
import { useSettingsStore, type FavoritesTab } from '../stores/settingsStore'
import { deezerAPI } from '../services/deezerAPI'
import TrackCard from '../components/TrackCard.vue'
import AlbumCard from '../components/AlbumCard.vue'
import ArtistCard from '../components/ArtistCard.vue'
import EmptyState from '../components/EmptyState.vue'
import type { Playlist, Artist } from '../types'

const { t } = useI18n()
const favoritesStore = useFavoritesStore()
const authStore = useAuthStore()
const downloadStore = useDownloadStore()
const toastStore = useToastStore()
const syncStore = useSyncStore()
const artistSyncStore = useArtistSyncStore()
const settingsStore = useSettingsStore()
// #149: open on the tab chosen in Settings > Appearance (default: tracks)
const activeTab = ref<FavoritesTab>(settingsStore.settings.appearance.favoritesDefaultTab || 'tracks')
const isDownloading = ref(false)
const isBulkSyncing = ref(false)

// #93: pinning an artist from Favourites now asks how to handle the existing
// catalog (instead of silently using subscribe-forward, which downloaded nothing).
// `pinModalTarget` is the single Artist being pinned, or 'bulk' for "sync all".
const showPinModal = ref(false)
const pinModalTarget = ref<Artist | 'bulk' | null>(null)
const pinModalMode = ref<FirstSyncMode>('download-backlog')
const pinModalDate = ref('')
const pinModalName = computed(() =>
  pinModalTarget.value && pinModalTarget.value !== 'bulk' ? pinModalTarget.value.name : ''
)
const serverPort = ref(6595)
const sortOrder = ref<'added' | 'name-asc' | 'name-desc'>(
  (localStorage.getItem('favorites_sort') as any) || 'added'
)
watch(sortOrder, (val) => localStorage.setItem('favorites_sort', val))

// Sorted favorites — sorts the store's arrays without mutating them
function sortByName(items: any[], key: string, order: string): any[] {
  const copy = items.slice()
  if (order === 'name-asc') {
    copy.sort((a, b) => {
      const aVal = (a[key] || '').toLowerCase()
      const bVal = (b[key] || '').toLowerCase()
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0
    })
  } else if (order === 'name-desc') {
    copy.sort((a, b) => {
      const aVal = (a[key] || '').toLowerCase()
      const bVal = (b[key] || '').toLowerCase()
      return aVal > bVal ? -1 : aVal < bVal ? 1 : 0
    })
  }
  return copy
}

const sortedTracks = computed(() => sortByName(favoritesStore.favoriteTracks, 'title', sortOrder.value))
const sortedAlbums = computed(() => sortByName(favoritesStore.favoriteAlbums, 'title', sortOrder.value))
const sortedArtists = computed(() => sortByName(favoritesStore.favoriteArtists, 'name', sortOrder.value))
const sortedPlaylists = computed(() => sortByName(favoritesStore.favoritePlaylists, 'title', sortOrder.value))

const tabs = computed(() => [
  { id: 'tracks', label: t('favorites.tracks'), count: () => favoritesStore.favoriteTracks.length, loading: () => favoritesStore.importingSections.track },
  { id: 'albums', label: t('favorites.albums'), count: () => favoritesStore.favoriteAlbums.length, loading: () => favoritesStore.importingSections.album },
  { id: 'artists', label: t('favorites.artists'), count: () => favoritesStore.favoriteArtists.length, loading: () => favoritesStore.importingSections.artist },
  { id: 'playlists', label: t('favorites.playlists'), count: () => favoritesStore.favoritePlaylists.length, loading: () => favoritesStore.importingSections.playlist }
])

// #149: a 7,000-track library rendered every card at once, which held the
// page black for several seconds on every open. Render the sorted list in
// windows of TRACK_WINDOW and grow it as the sentinel scrolls into view. The
// full sortedTracks stays the source for search, sort and Download All.
const TRACK_WINDOW = 150
const trackLimit = ref(TRACK_WINDOW)
const trackSentinel = ref<HTMLElement | null>(null)
const visibleTracks = computed(() => sortedTracks.value.slice(0, trackLimit.value))
let trackObserver: IntersectionObserver | null = null
watch(trackSentinel, (el) => {
  trackObserver?.disconnect()
  trackObserver = null
  if (!el) return
  trackObserver = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) trackLimit.value += TRACK_WINDOW
  }, { rootMargin: '600px 0px' })
  trackObserver.observe(el)
})
watch(() => [activeTab.value, sortOrder.value], () => { trackLimit.value = TRACK_WINDOW })
onBeforeUnmount(() => trackObserver?.disconnect())

onMounted(async () => {
  if (window.electronAPI) {
    serverPort.value = await window.electronAPI.getServerPort()
  }
  favoritesStore.loadFavorites()
  syncStore.init().catch(e => console.error('[Favorites] syncStore.init failed:', e))
  artistSyncStore.init().catch(e => console.error('[Favorites] artistSyncStore.init failed:', e))
})

// Lookup of synced Deezer playlists keyed by sourcePlaylistId for O(1) badge/button state.
const syncedDeezerById = computed<Map<string, SyncedPlaylist>>(() => {
  const m = new Map<string, SyncedPlaylist>()
  for (const p of syncStore.playlists) {
    if (p.source === 'deezer') m.set(p.sourcePlaylistId, p)
  }
  return m
})

function getSyncEntry(playlistId: number | string): SyncedPlaylist | undefined {
  return syncedDeezerById.value.get(String(playlistId))
}

type SyncBadgeStatus = 'none' | 'syncing' | 'success' | 'partial' | 'error' | 'pending'

function getSyncStatus(playlistId: number | string): SyncBadgeStatus {
  const entry = getSyncEntry(playlistId)
  if (!entry) return 'none'
  if (syncStore.isSyncing(entry.id)) return 'syncing'
  switch (entry.lastSyncStatus) {
    case 'success': return 'success'
    case 'partial': return 'partial'
    case 'error': return 'error'
    default: return 'pending'
  }
}

// When a sync is in flight, show "Syncing X/Y" so the user can see the engine
// is actually working through the tracklist instead of just spinning.
function getPlaylistSyncingLabel(playlistId: number | string): string {
  const entry = getSyncEntry(playlistId)
  if (!entry) return t('favorites.syncing')
  const progress = syncStore.getProgress(entry.id)
  if (progress && progress.total > 0) {
    return `${t('favorites.syncing')} ${progress.current}/${progress.total}`
  }
  return t('favorites.syncing')
}

// Local-only unfavorite from the card. Removes from favoritesStore AND
// removes any sync entry sourced from this playlist — the user's intent
// is clearly "make this go away", and leaving the sync entry running on
// a just-unfavorited playlist would defeat the purpose. Doesn't touch
// Deezer; the playlist will reappear on the next "Import from Deezer"
// run if the user re-favorites it on Deezer's side.
async function unfavoritePlaylist(playlist: Playlist) {
  const id = `playlist_${playlist.id}`
  const entry = getSyncEntry(playlist.id)
  if (entry) {
    await syncStore.removePlaylist(entry.id)
  }
  favoritesStore.removeFavorite(id)
  toastStore.info(t('favorites.removedFromFavorites', { name: playlist.title }))
}

async function unfavoriteArtist(artist: Artist) {
  const id = `artist_${artist.id}`
  const entry = getArtistSyncEntry(artist.id)
  if (entry) {
    await artistSyncStore.removeArtist(entry.id)
  }
  favoritesStore.removeFavorite(id)
  toastStore.info(t('favorites.removedFromFavorites', { name: artist.name }))
}

// Toggles a playlist's sync state. If not synced → adds; if synced → removes
// the sync entry (keeps the playlist in favorites — just stops syncing it).
async function toggleSyncPlaylist(playlist: Playlist) {
  const entry = getSyncEntry(playlist.id)
  if (entry) {
    await syncStore.removePlaylist(entry.id)
    toastStore.info(t('favorites.syncRemoved', { name: playlist.title }))
    return
  }
  await addOneToSync(playlist)
}

// Same toggle behavior for artist sync. Unpinning keeps the artist
// favorited — only the sync entry is removed.
async function toggleSyncArtist(artist: Artist) {
  const entry = getArtistSyncEntry(artist.id)
  if (entry) {
    await artistSyncStore.removeArtist(entry.id)
    toastStore.info(t('favorites.artistSyncRemoved', { name: artist.name }))
    return
  }
  await pinArtistToSync(artist)
}

async function addOneToSync(playlist: Playlist) {
  if (getSyncEntry(playlist.id)) return // idempotent — already in sync
  const result = await syncStore.addPlaylist({
    source: 'deezer',
    sourcePlaylistId: String(playlist.id),
    sourcePlaylistName: playlist.title,
    sourcePlaylistUrl: `https://www.deezer.com/playlist/${playlist.id}`,
    schedule: '24h',
    downloadPath: settingsStore.settings.downloadPath,
    origin: 'favorites'
  })
  if (result?.success) {
    toastStore.success(t('favorites.syncAdded', { name: playlist.title }))
  } else {
    toastStore.error(result?.error || t('favorites.syncFailed'))
  }
}

async function syncAllFavorites() {
  if (isBulkSyncing.value) return
  isBulkSyncing.value = true
  try {
    // Filter out already-synced playlists locally so the server doesn't have
    // to dedupe across 300 entries — and we know the skipped count up front.
    const toAdd: Playlist[] = []
    let skipped = 0
    for (const playlist of favoritesStore.favoritePlaylists) {
      if (getSyncEntry(playlist.id)) {
        skipped++
        continue
      }
      toAdd.push(playlist)
    }

    if (toAdd.length === 0) {
      if (skipped > 0) toastStore.info(t('favorites.syncAllNoneAdded'))
      return
    }

    // Single bulk call — replaces the N-roundtrip loop that got truncated by
    // the per-IP 'sync' rate limit (issue #70). One HTTP request, one server
    // saveState, one rate-limit budget hit regardless of how many favorites
    // the user has.
    const configs = toAdd.map(p => ({
      source: 'deezer' as const,
      sourcePlaylistId: String(p.id),
      sourcePlaylistName: p.title,
      sourcePlaylistUrl: `https://www.deezer.com/playlist/${p.id}`,
      schedule: '24h' as const,
      downloadPath: settingsStore.settings.downloadPath,
      origin: 'favorites' as const
    }))
    const result = await syncStore.addPlaylistsBulk(configs)
    const added = result?.added ?? 0
    const failed = result?.failed ?? (configs.length - added)

    if (!result?.success) {
      toastStore.error(result?.error || t('favorites.syncFailed'))
    } else if (failed > 0) {
      toastStore.error(t('favorites.syncBulkPartial', { added, failed, skipped }))
      console.error('[Favorites] Bulk sync partial — per-item errors:',
        (result.results || []).filter(r => !r.ok))
    } else if (added > 0) {
      toastStore.success(t('favorites.syncBulkResult', { added, skipped }))
    } else if (skipped > 0) {
      toastStore.info(t('favorites.syncAllNoneAdded'))
    }
  } finally {
    isBulkSyncing.value = false
  }
}

// Artist-sync mirror of the playlist-sync helpers above. Same UX pattern,
// different store + different default first-sync mode (subscribe-forward).
const syncedArtistsById = computed<Map<string, SyncedArtist>>(() => {
  const m = new Map<string, SyncedArtist>()
  for (const a of artistSyncStore.artists) {
    if (a.source === 'deezer') m.set(a.sourceArtistId, a)
  }
  return m
})

function getArtistSyncEntry(artistId: number | string): SyncedArtist | undefined {
  return syncedArtistsById.value.get(String(artistId))
}

function getArtistSyncStatus(artistId: number | string): SyncBadgeStatus {
  const entry = getArtistSyncEntry(artistId)
  if (!entry) return 'none'
  if (artistSyncStore.isSyncing(entry.id)) return 'syncing'
  switch (entry.lastSyncStatus) {
    case 'success': return 'success'
    case 'partial': return 'partial'
    case 'error': return 'error'
    default: return 'pending'
  }
}

// Artist progress unit is albums, not tracks — show "Album X/Y" so the
// label reads accurately for the artist sync surface.
function getArtistSyncingLabel(artistId: number | string): string {
  const entry = getArtistSyncEntry(artistId)
  if (!entry) return t('favorites.syncing')
  const progress = artistSyncStore.getProgress(entry.id)
  if (progress && progress.total > 0) {
    return `${t('favorites.syncing')} ${progress.current}/${progress.total}`
  }
  return t('favorites.syncing')
}

// Opens the mode-choice modal for a single artist (#93). The actual add runs in
// confirmPinMode → doPinArtist once the user picks a first-sync mode.
function pinArtistToSync(artist: Artist) {
  if (getArtistSyncEntry(artist.id)) return
  pinModalTarget.value = artist
  pinModalMode.value = 'download-backlog'
  pinModalDate.value = ''
  showPinModal.value = true
}

async function doPinArtist(artist: Artist, mode: FirstSyncMode, date: string) {
  const result = await artistSyncStore.addArtist({
    sourceArtistId: String(artist.id),
    sourceArtistName: artist.name,
    sourceArtistUrl: `https://www.deezer.com/artist/${artist.id}`,
    schedule: '24h',
    downloadPath: settingsStore.settings.downloadPath,
    firstSyncMode: mode,
    origin: 'favorites',
    ...(mode === 'date-threshold' && date ? { filters: { minReleaseDate: date } } : {})
  })
  if (result?.success) {
    toastStore.success(t('favorites.artistSyncAdded', { name: artist.name }))
  } else {
    toastStore.error(result?.error || t('favorites.artistSyncFailed'))
  }
}

// Confirm handler shared by single + bulk pin. Dispatches to the right "do".
async function confirmPinMode() {
  const target = pinModalTarget.value
  const mode = pinModalMode.value
  const date = mode === 'date-threshold' ? pinModalDate.value : ''
  showPinModal.value = false
  pinModalTarget.value = null
  if (!target) return
  if (target === 'bulk') await doSyncAllFavoriteArtists(mode, date)
  else await doPinArtist(target, mode, date)
}

// Opens the mode-choice modal for "sync all favourite artists" (#93). Skips the
// modal if there's nothing to add. The actual bulk add runs in doSyncAllFavoriteArtists.
function syncAllFavoriteArtists() {
  if (isBulkSyncing.value) return
  const anyToAdd = favoritesStore.favoriteArtists.some(a => !getArtistSyncEntry(a.id))
  if (!anyToAdd) {
    toastStore.info(t('favorites.artistSyncAllNoneAdded'))
    return
  }
  pinModalTarget.value = 'bulk'
  pinModalMode.value = 'download-backlog'
  pinModalDate.value = ''
  showPinModal.value = true
}

async function doSyncAllFavoriteArtists(mode: FirstSyncMode, date: string) {
  if (isBulkSyncing.value) return
  isBulkSyncing.value = true
  try {
    const toAdd: Artist[] = []
    let skipped = 0
    for (const artist of favoritesStore.favoriteArtists) {
      if (getArtistSyncEntry(artist.id)) {
        skipped++
        continue
      }
      toAdd.push(artist)
    }

    if (toAdd.length === 0) {
      if (skipped > 0) toastStore.info(t('favorites.artistSyncAllNoneAdded'))
      return
    }

    // Single bulk call — see syncAllFavorites for #70 rationale.
    const configs = toAdd.map(a => ({
      sourceArtistId: String(a.id),
      sourceArtistName: a.name,
      sourceArtistUrl: `https://www.deezer.com/artist/${a.id}`,
      schedule: '24h' as const,
      downloadPath: settingsStore.settings.downloadPath,
      firstSyncMode: mode,
      origin: 'favorites' as const,
      ...(mode === 'date-threshold' && date ? { filters: { minReleaseDate: date } } : {})
    }))
    const result = await artistSyncStore.addArtistsBulk(configs)
    const added = result?.added ?? 0
    const failed = result?.failed ?? (configs.length - added)

    if (!result?.success) {
      toastStore.error(result?.error || t('favorites.artistSyncFailed'))
    } else if (failed > 0) {
      toastStore.error(t('favorites.artistSyncBulkPartial', { added, failed, skipped }))
      console.error('[Favorites] Bulk artist sync partial — per-item errors:',
        (result.results || []).filter(r => !r.ok))
    } else if (added > 0) {
      toastStore.success(t('favorites.artistSyncBulkResult', { added, skipped }))
    } else if (skipped > 0) {
      toastStore.info(t('favorites.artistSyncAllNoneAdded'))
    }
  } finally {
    isBulkSyncing.value = false
  }
}

async function downloadAllFavorites() {
  if (isDownloading.value) return
  isDownloading.value = true

  try {
    await downloadStore.syncSettingsToServer()
    let queued = 0

    if (activeTab.value === 'tracks') {
      for (const track of favoritesStore.favoriteTracks) {
        await downloadStore.addDownload(track, { skipSync: true })
        queued++
      }
    } else if (activeTab.value === 'albums') {
      // Pace each album lookup and retry quota-failed albums in a second pass so
      // a large favorites list doesn't burst past Deezer's rate limit and drop
      // albums silently (issue #84).
      const pending: typeof favoritesStore.favoriteAlbums = []
      for (const album of favoritesStore.favoriteAlbums) {
        // Qobuz-sourced favorites route straight to the Qobuz pipeline — the
        // Deezer track fetch below can't resolve a Qobuz id and would silently
        // drop them from download-all.
        if ((album as any).source === 'qobuz') {
          await downloadStore.addAlbumDownload(album, [])
          queued++
          continue
        }
        try {
          const tracks = await deezerAPI.getAlbumTracks(album.id)
          if (tracks?.length > 0) {
            await downloadStore.addAlbumDownload(album, tracks)
            queued++
          } else {
            pending.push(album)
          }
        } catch (e) {
          console.warn(`[Favorites] Album ${album.id} failed (will retry):`, e)
          pending.push(album)
        }
        await deezerAPI.pace()
      }
      const stillFailed: typeof favoritesStore.favoriteAlbums = []
      if (pending.length > 0) {
        await deezerAPI.cooldown()
        for (const album of pending) {
          try {
            const tracks = await deezerAPI.getAlbumTracks(album.id)
            if (tracks?.length > 0) {
              await downloadStore.addAlbumDownload(album, tracks)
              queued++
            } else {
              stillFailed.push(album)
            }
          } catch {
            stillFailed.push(album)
          }
          await deezerAPI.pace()
        }
      }
      if (stillFailed.length > 0) {
        toastStore.warning(t('notifications.rateLimitedAlbums', { count: stillFailed.length }, stillFailed.length))
      }
    } else if (activeTab.value === 'playlists') {
      let skipped = 0
      for (const playlist of favoritesStore.favoritePlaylists) {
        if ((playlist as any).source === 'qobuz') {
          await downloadStore.addPlaylistDownload(playlist as any, [])
          queued++
          continue
        }
        try {
          const tracks = await deezerAPI.getPlaylistTracks(playlist.id)
          if (tracks?.length > 0) {
            await downloadStore.addPlaylistDownload(playlist, tracks)
            queued++
          } else {
            console.warn(`[Favorites] Playlist "${playlist.title}" (${playlist.id}) has no available tracks — skipping`)
            skipped++
          }
        } catch (e: any) {
          console.error(`[Favorites] Failed to download playlist ${playlist.id}:`, e)
          skipped++
        }
        await deezerAPI.pace()
      }
      if (skipped > 0) {
        toastStore.info(t('notifications.playlistsSkipped', { count: skipped }, skipped))
      }
    }

    if (queued > 0) {
      toastStore.success(t('notifications.queuedForDownload', { count: queued, type: t('common.' + activeTab.value) }))
    }
  } catch (e: any) {
    toastStore.error(e.message || 'Failed to start downloads')
  } finally {
    isDownloading.value = false
  }
}

async function importFromDeezer() {
  try {
    const { imported, skipped, pruned, failed, syncStale } = await favoritesStore.importDeezerFavorites(serverPort.value)
    if (failed.length > 0) {
      toastStore.error(t('notifications.favoritesSectionsFailed', { sections: failed.map(f => t('common.' + f + 's')).join(', ') }))
    }
    const parts: string[] = []
    if (imported > 0) parts.push(t('favorites.importedCount', { n: imported }))
    if (pruned > 0) parts.push(t('favorites.prunedCount', { n: pruned }))
    if (skipped > 0) parts.push(t('favorites.unchangedCount', { n: skipped }))
    const summary = parts.length > 0 ? parts.join(', ') : t('favorites.noneOnAccount')

    if (imported > 0 || pruned > 0) {
      toastStore.success(t('notifications.favoritesSynced', { summary }))
    } else if (skipped > 0) {
      toastStore.info(t('notifications.favoritesAlreadyImported'))
    } else {
      toastStore.info(summary)
    }

    const staleTotal = (syncStale?.playlists ?? 0) + (syncStale?.artists ?? 0)
    if (staleTotal > 0) {
      const detail: string[] = []
      if (syncStale.playlists > 0) detail.push(`${syncStale.playlists} playlist${syncStale.playlists > 1 ? 's' : ''}`)
      if (syncStale.artists > 0) detail.push(`${syncStale.artists} artist${syncStale.artists > 1 ? 's' : ''}`)
      toastStore.info(t('notifications.favoritesStale', { detail: detail.join(' + ') }))
    }
  } catch (e: any) {
    toastStore.error(e.message || 'Failed to import Deezer favorites')
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="font-display uppercase text-[22px] tracking-[0.02em]">{{ t('favorites.title') }}</h1>
      <div class="flex gap-2">
        <button
          v-if="authStore.isLoggedIn && activeTab !== 'artists' && ((activeTab === 'tracks' && favoritesStore.favoriteTracks.length > 0) || (activeTab === 'albums' && favoritesStore.favoriteAlbums.length > 0) || (activeTab === 'playlists' && favoritesStore.favoritePlaylists.length > 0))"
          @click="downloadAllFavorites"
          :disabled="isDownloading"
          class="flex items-center gap-2 px-4 py-2 font-mono text-[10.5px] tracking-[0.1em] uppercase border bg-green-500/10 text-green-400 border-green-500/30 hover:bg-green-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg v-if="isDownloading" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {{ isDownloading ? 'Downloading...' : `Download All ${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}` }}
        </button>
        <button
          v-if="activeTab === 'playlists' && favoritesStore.favoritePlaylists.length > 0"
          @click="syncAllFavorites"
          :disabled="isBulkSyncing"
          class="flex items-center gap-2 px-4 py-2 font-mono text-[10.5px] tracking-[0.1em] uppercase border bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg v-if="isBulkSyncing" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('favorites.syncAllPlaylists') }}
        </button>
        <button
          v-if="activeTab === 'artists' && favoritesStore.favoriteArtists.length > 0"
          @click="syncAllFavoriteArtists"
          :disabled="isBulkSyncing"
          class="flex items-center gap-2 px-4 py-2 font-mono text-[10.5px] tracking-[0.1em] uppercase border bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg v-if="isBulkSyncing" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('favorites.syncAllArtists') }}
        </button>
        <button
          v-if="authStore.isLoggedIn"
          @click="importFromDeezer"
          :disabled="favoritesStore.isImporting"
          class="btn btn-primary flex items-center gap-2 font-mono text-[11px] tracking-[0.1em] uppercase disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg v-if="favoritesStore.isImporting" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        {{ favoritesStore.isImporting ? t('favorites.importing') : t('favorites.importFromDeezer') }}
      </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2 border-b border-white/[0.08] pb-2">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        @click="activeTab = tab.id as typeof activeTab"
        class="px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] border transition-colors flex items-center gap-2"
        :class="activeTab === tab.id
          ? 'text-primary-500 border-primary-500/60 bg-primary-500/10'
          : 'text-foreground-muted border-white/[0.08] hover:text-foreground hover:border-white/20'"
      >
        {{ tab.label }}
        <svg v-if="tab.loading()" class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span
          v-else-if="tab.count() > 0"
          class="text-[9.5px]"
          :class="activeTab === tab.id ? 'text-primary-500/80' : 'text-foreground-muted'"
        >
          {{ tab.count() }}
        </span>
      </button>
    </div>

    <!-- Sort Controls -->
    <div class="flex items-center gap-2">
      <svg class="w-4 h-4 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
      </svg>
      <select
        v-model="sortOrder"
        class="text-sm bg-background-secondary text-foreground px-3 py-1.5 border border-white/[0.1] focus:border-primary-500/50 outline-none"
      >
        <option value="added">{{ t('favorites.sortAdded') }}</option>
        <option value="name-asc">{{ t('common.sortNameAsc') }}</option>
        <option value="name-desc">{{ t('common.sortNameDesc') }}</option>
      </select>
    </div>

    <!-- Tracks -->
    <div v-if="activeTab === 'tracks'">
      <div v-if="sortedTracks.length > 0" class="space-y-1">
        <TrackCard
          v-for="track in visibleTracks"
          :key="track.id"
          :track="track"
        />
        <div v-if="visibleTracks.length < sortedTracks.length" ref="trackSentinel" class="py-3 text-center text-xs text-foreground-muted">
          {{ t('favorites.showingCount', { shown: visibleTracks.length, total: sortedTracks.length }) }}
        </div>
      </div>
      <EmptyState
        v-else
        type="favorites"
        :title="t('favorites.noFavorites')"
        :subtitle="t('favorites.noFavoritesHint')"
      />
    </div>

    <!-- Albums -->
    <div v-if="activeTab === 'albums'">
      <div v-if="favoritesStore.favoriteAlbums.length > 0" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <AlbumCard
          v-for="album in sortedAlbums"
          :key="album.id"
          :album="album"
        />
      </div>
      <EmptyState
        v-else
        type="favorites"
        :title="t('favorites.noFavorites')"
        :subtitle="t('favorites.noFavoritesHint')"
      />
    </div>

    <!-- Artists -->
    <div v-if="activeTab === 'artists'">
      <div v-if="favoritesStore.favoriteArtists.length > 0" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div
          v-for="artist in sortedArtists"
          :key="artist.id"
          class="relative flex flex-col gap-2"
        >
          <ArtistCard :artist="artist" />
          <!-- Remove from favorites (X in top-left); also auto-removes
               any artist-sync entry sourced from this artist. -->
          <button
            @click="unfavoriteArtist(artist)"
            class="absolute top-2 left-2 w-7 h-7 bg-black/70 backdrop-blur-sm text-white hover:bg-red-500/90 transition-colors flex items-center justify-center border border-white/15"
            :title="t('favorites.removeFromFavoritesTooltip')"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <!-- Sync status badge — overlays the card top-right -->
          <span
            v-if="getArtistSyncStatus(artist.id) !== 'none'"
            class="absolute top-2 right-2 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase border backdrop-blur-sm pointer-events-none flex items-center gap-1"
            :class="{
              'bg-blue-500/90 text-white border-blue-400/50': getArtistSyncStatus(artist.id) === 'syncing',
              'bg-green-500/90 text-white border-green-400/50': getArtistSyncStatus(artist.id) === 'success',
              'bg-yellow-500/90 text-black border-yellow-300/50': getArtistSyncStatus(artist.id) === 'partial',
              'bg-red-500/90 text-white border-red-400/50': getArtistSyncStatus(artist.id) === 'error',
              'bg-background-main/80 text-foreground-muted border-white/20': getArtistSyncStatus(artist.id) === 'pending'
            }"
            :title="
              getArtistSyncStatus(artist.id) === 'syncing' ? getArtistSyncingLabel(artist.id)
              : getArtistSyncStatus(artist.id) === 'success' ? t('favorites.synced')
              : getArtistSyncStatus(artist.id) === 'partial' ? t('favorites.syncPartial')
              : getArtistSyncStatus(artist.id) === 'error' ? t('favorites.syncError')
              : t('favorites.syncPending')
            "
          >
            <svg v-if="getArtistSyncStatus(artist.id) === 'syncing'" class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <svg v-else-if="getArtistSyncStatus(artist.id) === 'success'" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
            </svg>
            <svg v-else-if="getArtistSyncStatus(artist.id) === 'error'" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <svg v-else class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              {{ getArtistSyncStatus(artist.id) === 'syncing' ? getArtistSyncingLabel(artist.id)
                 : getArtistSyncStatus(artist.id) === 'success' ? t('favorites.synced')
                 : getArtistSyncStatus(artist.id) === 'partial' ? t('favorites.syncPartial')
                 : getArtistSyncStatus(artist.id) === 'error' ? t('favorites.syncError')
                 : t('favorites.syncPending') }}
            </span>
          </span>
          <!-- Per-card Pin toggle — click to pin, click again to unpin.
               Unpinning keeps the artist favorited; only the sync entry is removed. -->
          <button
            @click="toggleSyncArtist(artist)"
            :disabled="artistSyncStore.isLoading"
            class="w-full px-2 py-1 font-mono text-[10px] tracking-[0.1em] uppercase border transition-colors group"
            :class="getArtistSyncStatus(artist.id) === 'none'
              ? 'bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20'
              : 'bg-background-main/60 text-foreground-muted border-white/[0.1] hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30'"
            :title="getArtistSyncStatus(artist.id) === 'none' ? t('favorites.pinArtistTooltip') : t('favorites.unpinArtistTooltip')"
          >
            <span v-if="getArtistSyncStatus(artist.id) === 'none'">{{ t('favorites.pinArtistToSync') }}</span>
            <span v-else>
              <span class="group-hover:hidden">{{ t('favorites.artistSynced') }}</span>
              <span class="hidden group-hover:inline">{{ t('favorites.unpin') }}</span>
            </span>
          </button>
        </div>
      </div>
      <EmptyState
        v-else
        type="favorites"
        :title="t('favorites.noFavorites')"
        :subtitle="t('favorites.noFavoritesHint')"
      />
    </div>

    <!-- Playlists -->
    <div v-if="activeTab === 'playlists'">
      <div v-if="favoritesStore.favoritePlaylists.length > 0" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div
          v-for="playlist in sortedPlaylists"
          :key="playlist.id"
          class="relative flex flex-col gap-2"
        >
          <AlbumCard
            :album="{
              id: playlist.id,
              title: playlist.title,
              cover_medium: playlist.picture_medium,
              artist: { id: 0, name: playlist.creator?.name || t('common.unknown') }
            }"
            type="playlist"
          />
          <!-- Remove from favorites (X in top-left); also auto-removes
               any sync entry sourced from this playlist. -->
          <button
            @click="unfavoritePlaylist(playlist)"
            class="absolute top-2 left-2 w-7 h-7 bg-black/70 backdrop-blur-sm text-white hover:bg-red-500/90 transition-colors flex items-center justify-center border border-white/15"
            :title="t('favorites.removeFromFavoritesTooltip')"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <!-- Sync status badge — overlays the card top-right -->
          <span
            v-if="getSyncStatus(playlist.id) !== 'none'"
            class="absolute top-2 right-2 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase border backdrop-blur-sm pointer-events-none flex items-center gap-1"
            :class="{
              'bg-blue-500/90 text-white border-blue-400/50': getSyncStatus(playlist.id) === 'syncing',
              'bg-green-500/90 text-white border-green-400/50': getSyncStatus(playlist.id) === 'success',
              'bg-yellow-500/90 text-black border-yellow-300/50': getSyncStatus(playlist.id) === 'partial',
              'bg-red-500/90 text-white border-red-400/50': getSyncStatus(playlist.id) === 'error',
              'bg-background-main/80 text-foreground-muted border-white/20': getSyncStatus(playlist.id) === 'pending'
            }"
            :title="
              getSyncStatus(playlist.id) === 'syncing' ? getPlaylistSyncingLabel(playlist.id)
              : getSyncStatus(playlist.id) === 'success' ? t('favorites.synced')
              : getSyncStatus(playlist.id) === 'partial' ? t('favorites.syncPartial')
              : getSyncStatus(playlist.id) === 'error' ? t('favorites.syncError')
              : t('favorites.syncPending')
            "
          >
            <svg v-if="getSyncStatus(playlist.id) === 'syncing'" class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <svg v-else-if="getSyncStatus(playlist.id) === 'success'" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
            </svg>
            <svg v-else-if="getSyncStatus(playlist.id) === 'error'" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <svg v-else class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              {{ getSyncStatus(playlist.id) === 'syncing' ? getPlaylistSyncingLabel(playlist.id)
                 : getSyncStatus(playlist.id) === 'success' ? t('favorites.synced')
                 : getSyncStatus(playlist.id) === 'partial' ? t('favorites.syncPartial')
                 : getSyncStatus(playlist.id) === 'error' ? t('favorites.syncError')
                 : t('favorites.syncPending') }}
            </span>
          </span>
          <!-- Per-card Sync toggle — click to add, click again to unsync.
               Unsync keeps the playlist favorited; it only stops syncing it. -->
          <button
            @click="toggleSyncPlaylist(playlist)"
            :disabled="syncStore.isLoading"
            class="w-full px-2 py-1 font-mono text-[10px] tracking-[0.1em] uppercase border transition-colors group"
            :class="getSyncStatus(playlist.id) === 'none'
              ? 'bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20'
              : 'bg-background-main/60 text-foreground-muted border-white/[0.1] hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30'"
            :title="getSyncStatus(playlist.id) === 'none' ? t('favorites.syncPlaylistTooltip') : t('favorites.unsyncPlaylistTooltip')"
          >
            <span v-if="getSyncStatus(playlist.id) === 'none'">{{ t('favorites.syncPlaylist') }}</span>
            <span v-else>
              <span class="group-hover:hidden">{{ t('favorites.synced') }}</span>
              <span class="hidden group-hover:inline">{{ t('favorites.unsync') }}</span>
            </span>
          </button>
        </div>
      </div>
      <EmptyState
        v-else
        type="playlist"
        :title="t('favorites.noFavorites')"
        :subtitle="t('favorites.noFavoritesHint')"
      />
    </div>

    <!-- Pin-to-Sync mode chooser (#93) — replaces the silent subscribe-forward default -->
    <teleport to="body">
      <transition name="fade">
        <div v-if="showPinModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" @click.self="showPinModal = false">
          <div class="bg-background-secondary border border-white/[0.1] p-6 w-full max-w-md mx-4 shadow-xl">
            <h2 class="font-display text-[15px] uppercase tracking-[0.06em] mb-1">
              {{ t('sync.pinModeTitle') }}<span v-if="pinModalName"> — {{ pinModalName }}</span>
            </h2>
            <p class="text-sm text-foreground-muted mb-4">
              {{ pinModalTarget === 'bulk' ? t('sync.pinModeBulkPrompt') : t('sync.pinModePrompt') }}
            </p>

            <div class="space-y-2">
              <label
                class="flex items-start gap-3 p-3 border cursor-pointer transition-colors"
                :class="pinModalMode === 'download-backlog' ? 'border-primary-500 bg-primary-500/10' : 'border-white/[0.1] hover:border-white/20'"
              >
                <input type="radio" class="mt-1" value="download-backlog" v-model="pinModalMode" />
                <span>
                  <span class="block text-sm font-medium">{{ t('sync.firstSyncModeDownloadBacklog') }}</span>
                  <span class="block text-xs text-foreground-muted">{{ t('sync.firstSyncModeDownloadBacklogHelp') }}</span>
                </span>
              </label>

              <label
                class="flex items-start gap-3 p-3 border cursor-pointer transition-colors"
                :class="pinModalMode === 'subscribe-forward' ? 'border-primary-500 bg-primary-500/10' : 'border-white/[0.1] hover:border-white/20'"
              >
                <input type="radio" class="mt-1" value="subscribe-forward" v-model="pinModalMode" />
                <span>
                  <span class="block text-sm font-medium">{{ t('sync.firstSyncModeSubscribeForward') }}</span>
                  <span class="block text-xs text-foreground-muted">{{ t('sync.firstSyncModeSubscribeForwardHelp') }}</span>
                </span>
              </label>

              <label
                class="flex items-start gap-3 p-3 border cursor-pointer transition-colors"
                :class="pinModalMode === 'date-threshold' ? 'border-primary-500 bg-primary-500/10' : 'border-white/[0.1] hover:border-white/20'"
              >
                <input type="radio" class="mt-1" value="date-threshold" v-model="pinModalMode" />
                <span class="flex-1">
                  <span class="block text-sm font-medium">{{ t('sync.firstSyncModeDateThreshold') }}</span>
                  <span class="block text-xs text-foreground-muted">{{ t('sync.firstSyncModeDateThresholdHelp') }}</span>
                  <input
                    v-if="pinModalMode === 'date-threshold'"
                    type="date"
                    v-model="pinModalDate"
                    class="mt-2 px-3 py-1.5 bg-background-main text-sm border border-white/[0.1] focus:border-primary-500/50 outline-none"
                  />
                </span>
              </label>
            </div>

            <div class="flex justify-end gap-2 mt-6">
              <button
                @click="showPinModal = false"
                class="px-4 py-2 font-mono text-[10.5px] tracking-[0.1em] uppercase border border-white/[0.1] text-foreground-muted hover:text-foreground hover:border-white/20 transition-colors"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                @click="confirmPinMode"
                :disabled="pinModalMode === 'date-threshold' && !pinModalDate"
                class="px-4 py-2 font-mono text-[11px] tracking-[0.1em] uppercase border bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {{ t('sync.pinModeConfirm') }}
              </button>
            </div>
          </div>
        </div>
      </transition>
    </teleport>
  </div>
</template>
