import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Track, Album, Artist, Playlist } from '../types'
import { useToastStore } from './toastStore'
import i18n from '../i18n'
import { readFavorites, writeFavorites, migrateLegacyFavorites } from '../utils/favoritesStorage'

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

  // Favourites persist in IndexedDB (#149: localStorage's 5 MB cap rejected
  // large libraries). The first load after upgrade migrates the legacy key.
  async function loadFavorites(): Promise<void> {
    try {
      let stored = await readFavorites<FavoriteItem>()
      if (stored === null) {
        const migrated = await migrateLegacyFavorites()
        if (migrated !== null) {
          console.log(`[FavoritesStore] Migrated ${migrated} favourites from localStorage to IndexedDB`)
          stored = await readFavorites<FavoriteItem>()
        }
      }
      favorites.value = stored ?? []
    } catch (e) {
      console.error('Failed to load favorites:', e)
    }
  }

  // Rejects on failure after telling the user; callers that cannot act on the
  // failure swallow the rejection, callers that can (import) roll back.
  async function saveFavorites(): Promise<void> {
    try {
      await writeFavorites(favorites.value)
    } catch (e: any) {
      console.error('[FavoritesStore] Save failed:', e?.message ?? e)
      useToastStore().error(i18n.global.t('notifications.favoritesSaveFailed', { error: e?.message ?? String(e) }))
      throw e
    }
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
      saveFavorites().catch(() => {})
    }
  }

  function removeFavorite(id: string) {
    const index = favorites.value.findIndex(f => f.id === id)
    if (index !== -1) {
      favorites.value.splice(index, 1)
      saveFavorites().catch(() => {})
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

    let rolledBack = false
    const importSection = async (type: FavoriteItem['type']): Promise<void> => {
      const section = sectionOf[type]
      importingSections.value[type] = true
      // Snapshot this section so a failed save can put it back exactly, and
      // tally per section so the totals only count what actually persisted.
      const previous = favorites.value.filter(f => f.type === type)
      let sectionImported = 0, sectionSkipped = 0, sectionPruned = 0
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
            sectionImported++
            changed = true
          } else {
            sectionSkipped++
          }
        }

        // Prune: anything in our local cache of this type whose ID is no
        // longer in the Deezer response.
        const before = favorites.value.length
        favorites.value = favorites.value.filter(f => f.type !== type || ids.has(String((f.data as any).id)))
        sectionPruned = before - favorites.value.length
        if (sectionPruned > 0) changed = true

        if (changed) await saveFavorites()
        imported += sectionImported
        skipped += sectionSkipped
        pruned += sectionPruned
      } catch (e: any) {
        console.error(`[FavoritesStore] Import of ${section} failed:`, e?.message ?? e)
        failed.push(type)
        deezerIds[type] = null
        favorites.value = [...favorites.value.filter(f => f.type !== type), ...previous]
        rolledBack = true
      } finally {
        importingSections.value[type] = false
      }
    }

    try {
      await Promise.all((['track', 'album', 'artist', 'playlist'] as FavoriteItem['type'][]).map(importSection))

      // A concurrent section may have persisted the array while a failed one
      // was still in it; write the rolled-back state so storage matches memory.
      if (rolledBack) await saveFavorites().catch(() => {})

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
