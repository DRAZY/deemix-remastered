<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFavoritesStore } from '../stores/favoritesStore'
import { useAuthStore } from '../stores/authStore'
import { useDownloadStore } from '../stores/downloadStore'
import { useToastStore } from '../stores/toastStore'
import { deezerAPI } from '../services/deezerAPI'
import TrackCard from '../components/TrackCard.vue'
import AlbumCard from '../components/AlbumCard.vue'
import ArtistCard from '../components/ArtistCard.vue'
import EmptyState from '../components/EmptyState.vue'

const { t } = useI18n()
const favoritesStore = useFavoritesStore()
const authStore = useAuthStore()
const downloadStore = useDownloadStore()
const toastStore = useToastStore()
const activeTab = ref<'tracks' | 'albums' | 'artists' | 'playlists'>('tracks')
const isDownloading = ref(false)
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
  { id: 'tracks', label: t('favorites.tracks'), count: () => favoritesStore.favoriteTracks.length },
  { id: 'albums', label: t('favorites.albums'), count: () => favoritesStore.favoriteAlbums.length },
  { id: 'artists', label: t('favorites.artists'), count: () => favoritesStore.favoriteArtists.length },
  { id: 'playlists', label: t('favorites.playlists'), count: () => favoritesStore.favoritePlaylists.length }
])

onMounted(async () => {
  if (window.electronAPI) {
    serverPort.value = await window.electronAPI.getServerPort()
  }
  favoritesStore.loadFavorites()
})

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
      for (const album of favoritesStore.favoriteAlbums) {
        try {
          const tracks = await deezerAPI.getAlbumTracks(album.id)
          if (tracks?.length > 0) {
            await downloadStore.addAlbumDownload(album, tracks)
            queued++
          }
        } catch (e) {
          console.error(`[Favorites] Failed to download album ${album.id}:`, e)
        }
      }
    } else if (activeTab.value === 'playlists') {
      for (const playlist of favoritesStore.favoritePlaylists) {
        try {
          const tracks = await deezerAPI.getPlaylistTracks(playlist.id)
          if (tracks?.length > 0) {
            await downloadStore.addPlaylistDownload(playlist, tracks)
            queued++
          }
        } catch (e) {
          console.error(`[Favorites] Failed to download playlist ${playlist.id}:`, e)
        }
      }
    }

    if (queued > 0) {
      toastStore.success(`Queued ${queued} ${activeTab.value} for download`)
    }
  } catch (e: any) {
    toastStore.error(e.message || 'Failed to start downloads')
  } finally {
    isDownloading.value = false
  }
}

async function importFromDeezer() {
  try {
    const { imported, skipped } = await favoritesStore.importDeezerFavorites(serverPort.value)
    if (imported > 0) {
      toastStore.success(`Imported ${imported} favorites from Deezer${skipped > 0 ? ` (${skipped} already existed)` : ''}`)
    } else if (skipped > 0) {
      toastStore.info('All Deezer favorites are already imported')
    } else {
      toastStore.info('No favorites found on your Deezer account')
    }
  } catch (e: any) {
    toastStore.error(e.message || 'Failed to import Deezer favorites')
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">{{ t('favorites.title') }}</h1>
      <div class="flex gap-2">
        <button
          v-if="authStore.isLoggedIn && activeTab !== 'artists' && ((activeTab === 'tracks' && favoritesStore.favoriteTracks.length > 0) || (activeTab === 'albums' && favoritesStore.favoriteAlbums.length > 0) || (activeTab === 'playlists' && favoritesStore.favoritePlaylists.length > 0))"
          @click="downloadAllFavorites"
          :disabled="isDownloading"
          class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
          v-if="authStore.isLoggedIn"
          @click="importFromDeezer"
          :disabled="favoritesStore.isImporting"
          class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg v-if="favoritesStore.isImporting" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        {{ favoritesStore.isImporting ? 'Importing...' : 'Import from Deezer' }}
      </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2 border-b border-zinc-800 pb-2">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        @click="activeTab = tab.id as typeof activeTab"
        class="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        :class="activeTab === tab.id
          ? 'bg-primary-500 text-white'
          : 'text-foreground-muted hover:text-foreground'"
      >
        {{ tab.label }}
        <span
          v-if="tab.count() > 0"
          class="px-1.5 py-0.5 text-xs rounded-full"
          :class="activeTab === tab.id ? 'bg-white/20' : 'bg-background-tertiary'"
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
        class="text-sm bg-background-secondary text-foreground rounded-lg px-3 py-1.5 border border-zinc-700 focus:border-primary-500 outline-none"
      >
        <option value="added">Date Added</option>
        <option value="name-asc">Name A-Z</option>
        <option value="name-desc">Name Z-A</option>
      </select>
    </div>

    <!-- Tracks -->
    <div v-if="activeTab === 'tracks'">
      <div v-if="sortedTracks.length > 0" class="space-y-1">
        <TrackCard
          v-for="track in sortedTracks"
          :key="track.id"
          :track="track"
        />
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
        <ArtistCard
          v-for="artist in sortedArtists"
          :key="artist.id"
          :artist="artist"
        />
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
        <AlbumCard
          v-for="playlist in sortedPlaylists"
          :key="playlist.id"
          :album="{
            id: playlist.id,
            title: playlist.title,
            cover_medium: playlist.picture_medium,
            artist: { id: 0, name: playlist.creator?.name || t('common.unknown') }
          }"
          type="playlist"
        />
      </div>
      <EmptyState
        v-else
        type="playlist"
        :title="t('favorites.noFavorites')"
        :subtitle="t('favorites.noFavoritesHint')"
      />
    </div>
  </div>
</template>
