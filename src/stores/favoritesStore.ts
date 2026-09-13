import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Track, Album, Artist, Playlist } from '../types'
import { useToastStore } from './toastStore'
import i18n from '../i18n'

interface FavoriteItem {
  id: string
  type: 'track' | 'album' | 'artist' | 'playlist'
  data: Track | Album | Artist | Playlist
  addedAt: string
}

export const useFavoritesStore = defineStore('favorites', () => {
  const favorites = ref<FavoriteItem[]>([])

  const favoriteTracks = computed(() =>
    favorites.value.filter(f => f.type === 'track').map(f => f.data as Track)
  )

  const favoriteAlbums = computed(() =>
    favorites.value.filter(f => f.type === 'album').map(f => f.data as Album)
  )

  const favoriteArtists = computed(() =>
    favorites.value.filter(f => f.type === 'artist').map(f => f.data as Artist)
  )

  const favoritePlaylists = computed(() =>
    favorites.value.filter(f => f.type === 'playlist').map(f => f.data as Playlist)
  )

  function loadFavorites() {
    const saved = localStorage.getItem('favorites')
    if (saved) {
      try {
        favorites.value = JSON.parse(saved)
      } catch (e) {
        console.error('Failed to load favorites:', e)
      }
    }
  }

  function saveFavorites() {
    localStorage.setItem('favorites', JSON.stringify(favorites.value))
  }

  function addFavorite(item: Track | Album | Artist | Playlist, type: FavoriteItem['type']) {
    const id = `${type}_${item.id}`
    if (!favorites.value.find(f => f.id === id)) {
      favorites.value.unshift({
        id,
        type,
        data: item,
        addedAt: new Date().toISOString()
      })
      saveFavorites()
    }
  }

  function removeFavorite(id: string) {
    const index = favorites.value.findIndex(f => f.id === id)
    if (index !== -1) {
      favorites.value.splice(index, 1)
      saveFavorites()
    }
  }

  function isFavorite(itemId: string | number, type: FavoriteItem['type']): boolean {
    return favorites.value.some(f => f.id === `${type}_${itemId}`)
  }

  function toggleFavorite(item: Track | Album | Artist | Playlist, type: FavoriteItem['type']) {
    const toastStore = useToastStore()
    const id = `${type}_${item.id}`
    const itemName = 'title' in item ? item.title : 'name' in item ? item.name : 'Item'

    if (isFavorite(item.id, type)) {
      removeFavorite(id)
      toastStore.info(i18n.global.t('notifications.removedFromFavorites', { name: itemName }))
    } else {
      addFavorite(item, type)
      toastStore.success(i18n.global.t('notifications.addedToFavorites', { name: itemName }))
    }
  }

  const isImporting = ref(false)

  // #149: per-section import progress so the view can show which tabs are
  // still loading while the others are already usable.
  const importingSections = ref<Record<FavoriteItem['type'], boolean>>({
    track: false, album: false, artist: false, playlist: false
  })

  // v1.6.3 — was additive-only (issue #64). Now bidirectional: imports new
  // favorites AND prunes locally-cached entries that have been un-favorited
  // on Deezer's side. Also pings the sync engine to refresh membership so
  // SyncView can flag favorites-origin sync entries that no longer have a
  // backing favorite ("No longer in your Deezer favorites" prompt).
  async function importDeezerFavorites(serverPort: number): Promise<{
    imported: number
    skipped: number
    pruned: number
    failed: FavoriteItem['type'][]
    syncStale: { playlists: number; artists: number }
  }> {
    isImporting.value = true
    let imported = 0
    let skipped = 0
    let pruned = 0
    const failed: FavoriteItem['type'][] = []

    // #149: each section is its own request and is applied the moment it
    // lands, so a 7,000-track list no longer delays albums, artists and
    // playlists. A section that fails is left untouched locally (no prune
    // against a missing response) and reported to the caller.
    const sectionOf: Record<FavoriteItem['type'], string> = {
      track: 'tracks', album: 'albums', artist: 'artists', playlist: 'playlists'
    }
    const deezerIds: Record<FavoriteItem['type'], Set<string> | null> = {
      track: null, album: null, artist: null, playlist: null
    }

    const importSection = async (type: FavoriteItem['type']): Promise<void> => {
      const section = sectionOf[type]
      importingSections.value[type] = true
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort}/api/user/favorites?type=${section}`)
        if (!response.ok) {
          const err = await response.json().catch(() => ({}))
          throw new Error(err.error || `Server returned ${response.status}`)
        }
        const data = await response.json()
        const items: any[] = data[section] || []
        const ids = new Set(items.map((i: any) => String(i.id)))
        deezerIds[type] = ids

        let changed = false
        for (const item of items) {
          if (!isFavorite(item.id, type)) {
            favorites.value.push({
              id: `${type}_${item.id}`,
              type,
              data: item,
              addedAt: new Date().toISOString()
            })
            imported++
            changed = true
          } else {
            skipped++
          }
        }

        // Prune: anything in our local cache of this type whose ID is no
        // longer in the Deezer response.
        const before = favorites.value.length
        favorites.value = favorites.value.filter(f => f.type !== type || ids.has(String((f.data as any).id)))
        const prunedHere = before - favorites.value.length
        pruned += prunedHere
        if (prunedHere > 0) changed = true

        if (changed) saveFavorites()
      } catch (e: any) {
        console.error(`[FavoritesStore] Import of ${section} failed:`, e?.message ?? e)
        failed.push(type)
      } finally {
        importingSections.value[type] = false
      }
    }

    try {
      await Promise.all((['track', 'album', 'artist', 'playlist'] as FavoriteItem['type'][]).map(importSection))

      if (failed.length === 4) {
        throw new Error('Failed to import Deezer favorites')
      }

      // Ask the sync engines to refresh favorites-membership against the
      // same ID sets we just used. We pass the IDs we already have rather
      // than making the server hit Deezer a second time. The server treats a
      // missing list as empty and would flag every entry stale, so the
      // refresh only runs when both the playlist and artist sections arrived.
      let syncStale = { playlists: 0, artists: 0 }
      if (deezerIds.playlist && deezerIds.artist) {
        try {
          const refreshRes = await fetch(`http://127.0.0.1:${serverPort}/api/sync/refresh-favorites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              playlistIds: Array.from(deezerIds.playlist),
              artistIds: Array.from(deezerIds.artist)
            })
          })
          if (refreshRes.ok) {
            const r = await refreshRes.json()
            syncStale = {
              playlists: r.playlists?.stale ?? 0,
              artists: r.artists?.stale ?? 0
            }
          }
        } catch (e) {
          console.warn('[FavoritesStore] sync refresh-favorites call failed (non-fatal):', e)
        }
      }

      return { imported, skipped, pruned, failed, syncStale }
    } finally {
      isImporting.value = false
    }
  }

  return {
    favorites,
    favoriteTracks,
    favoriteAlbums,
    favoriteArtists,
    favoritePlaylists,
    isImporting,
    importingSections,
    loadFavorites,
    addFavorite,
    removeFavorite,
    isFavorite,
    toggleFavorite,
    importDeezerFavorites
  }
})
