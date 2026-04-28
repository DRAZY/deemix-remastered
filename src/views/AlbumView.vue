<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { deezerAPI } from '../services/deezerAPI'
import { useFavoritesStore } from '../stores/favoritesStore'
import { useDownloadStore } from '../stores/downloadStore'
import TrackCard from '../components/TrackCard.vue'
import BackButton from '../components/BackButton.vue'
import ErrorState from '../components/ErrorState.vue'
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu } from '../composables/useContextMenu'
import type { Album, Track } from '../types'

const { t } = useI18n()

const route = useRoute()
const favoritesStore = useFavoritesStore()
const downloadStore = useDownloadStore()

const album = ref<Album | null>(null)
const tracks = ref<Track[]>([])
const isLoading = ref(true)
const hasError = ref(false)

// Track selection state
const selectedTracks = ref<Set<number | string>>(new Set())
const isSelectionMode = ref(false)

const totalDuration = computed(() => {
  const total = tracks.value.reduce((sum, t) => sum + (t.duration || 0), 0)
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours} hr ${mins} min` : `${mins} min`
})

const selectedCount = computed(() => selectedTracks.value.size)
const allSelected = computed(() =>
  tracks.value.length > 0 && selectedTracks.value.size === tracks.value.length
)

// Format release date as "Month Day, Year" (e.g., "June 5, 2020")
const formattedReleaseDate = computed(() => {
  if (!album.value?.release_date) return ''
  try {
    const date = new Date(album.value.release_date + 'T00:00:00')
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  } catch {
    // Fallback to just the year if parsing fails
    return album.value.release_date.split('-')[0]
  }
})

async function loadAlbum() {
  const albumId = route.params.id as string
  isLoading.value = true
  hasError.value = false
  try {
    const [albumData, tracksData] = await Promise.all([
      deezerAPI.getAlbum(albumId),
      deezerAPI.getAlbumTracks(albumId)
    ])
    album.value = albumData
    tracks.value = tracksData
  } catch (error) {
    console.error('Failed to load album:', error)
    hasError.value = true
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  loadAlbum()
})

const isFavorite = () => album.value && favoritesStore.isFavorite(album.value.id, 'album')

// Check if this album is already in the download queue or completed
const isAlbumInQueue = computed(() => {
  if (!album.value) return false
  return downloadStore.isAlbumInQueue(album.value.id)
})

const isAlbumCompleted = computed(() => {
  if (!album.value) return false
  return downloadStore.isAlbumCompleted(album.value.id)
})

// Combined state for download button
const albumDownloadState = computed(() => {
  if (isAlbumInQueue.value) return 'downloading'
  if (isAlbumCompleted.value) return 'completed'
  return 'available'
})

function toggleFavorite() {
  if (album.value) {
    favoritesStore.toggleFavorite(album.value, 'album')
  }
}

function toggleSelectionMode() {
  isSelectionMode.value = !isSelectionMode.value
  if (!isSelectionMode.value) {
    selectedTracks.value.clear()
  }
}

function toggleTrackSelection(trackId: number | string) {
  if (selectedTracks.value.has(trackId)) {
    selectedTracks.value.delete(trackId)
  } else {
    selectedTracks.value.add(trackId)
  }
  // Force reactivity
  selectedTracks.value = new Set(selectedTracks.value)
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedTracks.value.clear()
  } else {
    tracks.value.forEach(t => selectedTracks.value.add(t.id))
  }
  // Force reactivity
  selectedTracks.value = new Set(selectedTracks.value)
}

async function downloadAlbum() {
  if (albumDownloadState.value !== 'available') return // Already downloading or completed
  if (album.value && tracks.value.length > 0) {
    await downloadStore.addAlbumDownload(album.value, tracks.value)
  }
}

async function downloadSelectedTracks() {
  if (selectedTracks.value.size === 0) return

  const tracksToDownload = tracks.value.filter(t => selectedTracks.value.has(t.id))

  // Download each selected track individually
  for (const track of tracksToDownload) {
    await downloadStore.addDownload({
      ...track,
      album: album.value || undefined,
      artist: track.artist || album.value?.artist
    })
  }

  // Clear selection after download
  selectedTracks.value.clear()
  isSelectionMode.value = false
}

// Context menu
const { menuState, openMenu, closeMenu, copyToClipboard } = useContextMenu()

const contextMenuItems = computed(() => {
  if (!album.value) return []
  return [
    {
      label: t('contextMenu.copyAlbum'),
      icon: 'copy',
      action: () => copyToClipboard(album.value!.title, t('contextMenu.album'))
    },
    {
      label: t('contextMenu.copyArtist'),
      icon: 'copy',
      action: () => copyToClipboard(album.value!.artist?.name || '', t('contextMenu.artist')),
      disabled: !album.value!.artist?.name
    }
  ]
})
</script>

<template>
  <div class="space-y-8">
    <BackButton />

    <!-- Loading -->
    <div v-if="isLoading" class="flex items-center justify-center py-20">
      <div class="animate-spin w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
    </div>

    <!-- Error State -->
    <ErrorState
      v-else-if="hasError"
      :title="t('errors.loadingFailed')"
      :message="t('errors.tryAgainLater')"
      @retry="loadAlbum"
    />

    <template v-else-if="album">
      <!-- Album Header -->
      <div class="flex items-end gap-6" @contextmenu="openMenu">
        <img
          :src="album.cover_xl || album.cover_big || album.cover_medium"
          :alt="album.title"
          class="w-48 h-48 rounded-xl object-cover shadow-2xl"
        />
        <div class="flex-1">
          <p class="text-sm text-foreground-muted uppercase tracking-wider mb-2">
            {{ album.record_type || 'Album' }}
          </p>
          <h1 class="text-4xl font-bold mb-2">{{ album.title }}</h1>
          <p class="text-foreground-muted mb-4">
            <router-link
              v-if="album.artist?.id != null"
              :to="`/artist/${album.artist.id}`"
              class="hover:text-primary-400 transition-colors"
            >
              {{ album.artist.name }}
            </router-link>
            <span v-else-if="album.artist" class="text-foreground-muted">
              {{ album.artist.name }}
            </span>
            &bull;
            {{ formattedReleaseDate }}
            &bull;
            {{ t('albumView.tracksCount', { count: tracks.length, duration: totalDuration }) }}
          </p>
          <div class="flex flex-wrap gap-3">
            <button
              @click="downloadAlbum"
              class="btn flex items-center gap-2"
              :class="{
                'btn-secondary cursor-default opacity-75': albumDownloadState === 'downloading',
                'btn-secondary cursor-default': albumDownloadState === 'completed',
                'btn-primary': albumDownloadState === 'available'
              }"
              :disabled="albumDownloadState !== 'available'"
            >
              <!-- Downloading checkmark -->
              <svg v-if="albumDownloadState === 'downloading'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M5 13l4 4L19 7" />
              </svg>
              <!-- Already downloaded indicator -->
              <svg v-else-if="albumDownloadState === 'completed'" class="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <!-- Download icon -->
              <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {{ albumDownloadState === 'downloading' ? t('albumView.inQueue') : albumDownloadState === 'completed' ? t('albumView.alreadyDownloaded') : t('albumView.downloadAlbum') }}
            </button>
            <button
              @click="toggleSelectionMode"
              class="btn flex items-center gap-2"
              :class="isSelectionMode ? 'btn-primary' : 'btn-secondary'"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              {{ isSelectionMode ? t('albumView.cancelSelection') : t('albumView.selectTracks') }}
            </button>
            <button
              @click="toggleFavorite"
              class="btn btn-secondary flex items-center gap-2"
            >
              <svg
                class="w-5 h-5"
                :class="isFavorite() ? 'fill-primary-500 text-primary-500' : ''"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              {{ isFavorite() ? t('common.favorited') : t('common.addToFavorites') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Track List -->
      <section>
        <!-- Selection Bar -->
        <div
          v-if="isSelectionMode"
          class="flex items-center justify-between mb-4 p-3 bg-background-secondary rounded-lg"
        >
          <div class="flex items-center gap-4">
            <button
              @click="toggleSelectAll"
              class="flex items-center gap-2 text-sm font-medium hover:text-primary-400 transition-colors"
            >
              <div
                class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors"
                :class="allSelected
                  ? 'bg-primary-500 border-primary-500'
                  : 'border-zinc-500 hover:border-primary-400'"
              >
                <svg v-if="allSelected" class="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              {{ allSelected ? t('albumView.deselectAll') : t('albumView.selectAll') }}
            </button>
            <span class="text-foreground-muted text-sm">
              {{ t('albumView.selected', { count: selectedCount, total: tracks.length }) }}
            </span>
          </div>
          <button
            v-if="selectedCount > 0"
            @click="downloadSelectedTracks"
            class="btn btn-primary btn-sm flex items-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {{ t('common.download') }} {{ selectedCount }} {{ selectedCount > 1 ? t('common.tracks') : t('common.track') }}
          </button>
        </div>

        <div class="space-y-1">
          <div
            v-for="(track, index) in tracks"
            :key="track.id"
            class="flex items-center gap-2"
          >
            <!-- Checkbox (shown in selection mode) -->
            <button
              v-if="isSelectionMode"
              @click="toggleTrackSelection(track.id)"
              class="flex-shrink-0 w-6 h-6 rounded border-2 flex items-center justify-center transition-all"
              :class="selectedTracks.has(track.id)
                ? 'bg-primary-500 border-primary-500'
                : 'border-zinc-500 hover:border-primary-400'"
            >
              <svg v-if="selectedTracks.has(track.id)" class="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
              </svg>
            </button>
            <!-- Track Card -->
            <div class="flex-1">
              <TrackCard
                :track="{ ...track, album, artist: track.artist || album.artist }"
                :index="index + 1"
                :show-album="false"
              />
            </div>
          </div>
        </div>
      </section>
    </template>

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
