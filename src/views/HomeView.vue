<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { deezerAPI } from '../services/deezerAPI'
import TrackCard from '../components/TrackCard.vue'
import AlbumCard from '../components/AlbumCard.vue'
import ErrorState from '../components/ErrorState.vue'
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu } from '../composables/useContextMenu'
import type { Track, Album, Playlist } from '../types'

const router = useRouter()
const { t } = useI18n()
const searchQuery = ref('')
const newReleases = ref<Album[]>([])
const topTracks = ref<Track[]>([])
const topAlbums = ref<Album[]>([])
const popularPlaylists = ref<Playlist[]>([])
const isLoading = ref(true)
const hasError = ref(false)

async function loadContent() {
  isLoading.value = true
  hasError.value = false
  try {
    // Load chart data and new releases for all sections
    const [releasesResponse, tracksResponse, albumsResponse, playlistsResponse] = await Promise.all([
      deezerAPI.getNewReleases(10),
      deezerAPI.getChart('tracks'),
      deezerAPI.getChart('albums'),
      deezerAPI.getChart('playlists')
    ])
    newReleases.value = releasesResponse.slice(0, 10)
    topTracks.value = tracksResponse.slice(0, 10)
    topAlbums.value = albumsResponse.slice(0, 10)
    popularPlaylists.value = playlistsResponse.slice(0, 10)
  } catch (error) {
    console.error('Failed to load charts:', error)
    hasError.value = true
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  loadContent()
})

function handleSearch() {
  if (searchQuery.value.trim()) {
    router.push({ path: '/search', query: { q: searchQuery.value } })
  }
}

// Context menu for search input
const { menuState, openMenu, closeMenu, copyToClipboard, pasteFromClipboard } = useContextMenu()

function openSearchMenu(e: MouseEvent) {
  openMenu(e)
}

const contextMenuItems = computed(() => [
  {
    label: t('contextMenu.paste'),
    icon: 'paste',
    action: async () => {
      const text = await pasteFromClipboard()
      if (text) {
        searchQuery.value = text
      }
    }
  },
  {
    label: t('contextMenu.copy'),
    icon: 'copy',
    action: () => copyToClipboard(searchQuery.value),
    disabled: !searchQuery.value
  }
])

</script>

<template>
  <div class="space-y-8">
    <!-- Hero Search -->
    <div class="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary-600 to-primary-900 p-8">
      <div class="relative z-10">
        <h1 class="text-3xl font-bold mb-2">{{ t('home.welcome') }}</h1>
        <p class="text-white/70 mb-6">{{ t('home.subtitle') }}</p>

        <form @submit.prevent="handleSearch" class="max-w-xl">
          <div class="relative">
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('home.searchPlaceholder')"
              class="w-full px-5 py-3 pl-12 bg-white/10 backdrop-blur-sm border border-white/20 rounded-xl
                     text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-white/30"
              @contextmenu="openSearchMenu"
            />
            <svg
              class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/50"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </form>
      </div>

      <!-- Background decoration -->
      <div class="absolute inset-0 opacity-10">
        <svg class="absolute -right-20 -top-20 w-96 h-96" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="80" fill="white" />
        </svg>
        <svg class="absolute -left-10 -bottom-10 w-64 h-64" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="60" fill="white" />
        </svg>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="isLoading" class="flex items-center justify-center py-20">
      <div class="animate-spin w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
    </div>

    <!-- Error State -->
    <ErrorState
      v-else-if="hasError"
      :title="t('errors.loadingFailed')"
      :message="t('errors.tryAgainLater')"
      @retry="loadContent"
    />

    <!-- Content -->
    <template v-else>
      <!-- New Releases -->
      <section v-if="newReleases.length > 0">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-bold">{{ t('home.newReleases') }}</h2>
          <router-link to="/new-releases" class="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1">
            {{ t('home.seeAll') }}
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </router-link>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <AlbumCard
            v-for="album in newReleases"
            :key="album.id"
            :album="album"
          />
        </div>
      </section>

      <!-- Top Tracks -->
      <section v-if="topTracks.length > 0">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-bold">{{ t('home.topTracks') }}</h2>
          <router-link to="/charts?type=tracks" class="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1">
            {{ t('home.seeAll') }}
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </router-link>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
          <TrackCard
            v-for="track in topTracks"
            :key="track.id"
            :track="track"
          />
        </div>
      </section>

      <!-- Most Streamed Albums -->
      <section v-if="topAlbums.length > 0">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-bold">{{ t('home.mostStreamedAlbums') }}</h2>
          <router-link to="/charts?type=albums" class="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1">
            {{ t('home.seeAll') }}
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </router-link>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <AlbumCard
            v-for="album in topAlbums"
            :key="album.id"
            :album="album"
          />
        </div>
      </section>

      <!-- Popular Playlists -->
      <section v-if="popularPlaylists.length > 0">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-bold">{{ t('home.popularPlaylists') }}</h2>
          <router-link to="/charts?type=playlists" class="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1">
            {{ t('home.seeAll') }}
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </router-link>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <AlbumCard
            v-for="playlist in popularPlaylists"
            :key="playlist.id"
            :album="{
              id: playlist.id,
              title: playlist.title,
              cover_medium: playlist.picture_medium,
              artist: { id: 0, name: playlist.creator?.name || (playlist as any).user?.name || 'Deezer' },
              nb_tracks: playlist.nb_tracks
            }"
            type="playlist"
          />
        </div>
      </section>
    </template>

    <!-- Empty State -->
    <div v-if="!isLoading && newReleases.length === 0 && topTracks.length === 0 && topAlbums.length === 0 && popularPlaylists.length === 0" class="text-center py-20">
      <svg class="w-16 h-16 mx-auto text-foreground-muted mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
      </svg>
      <p class="text-foreground-muted">{{ t('home.searchToStart') }}</p>
    </div>

    <!-- Context Menu -->
    <ContextMenu
      :show="menuState.show"
      :x="menuState.x"
      :y="menuState.y"
      :items="contextMenuItems"
      @close="closeMenu"
    />
  </div>
</template>
