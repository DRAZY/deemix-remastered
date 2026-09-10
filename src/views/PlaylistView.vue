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
import { publicLink } from '../utils/sourceLinks'
import type { Playlist, Track } from '../types'

const { t } = useI18n()

const route = useRoute()
const favoritesStore = useFavoritesStore()
const downloadStore = useDownloadStore()

const playlist = ref<Playlist | null>(null)
const tracks = ref<Track[]>([])
const isLoading = ref(true)
const hasError = ref(false)
const loadingProgress = ref(0)
const loadingTotal = ref(0)
const isLoadingTracks = ref(false)

// A creator is browsable only on the Deezer path (Qobuz owners carry no id) and
// only when the profile is not anonymous. Deezer returns the same "no data"
// error for a private profile and a missing one, so a name check up front is
// what keeps users out of a dead end they cannot act on.
const creatorIsBrowsable = computed(() => {
  const c: any = playlist.value?.creator
  if (!c?.id || (playlist.value as any)?.source === 'qobuz') return false
  return String(c.name || '').trim().toLowerCase() !== 'anonymous'
})

const totalDuration = computed(() => {
  const total = tracks.value.reduce((sum, t) => sum + (t.duration || 0), 0)
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours} hr ${mins} min` : `${mins} min`
})

const loadingPercentage = computed(() => {
  if (loadingTotal.value === 0) return 0
  return Math.round((loadingProgress.value / loadingTotal.value) * 100)
})

// Extracted from onMounted so the ErrorState retry button can re-run it —
// a failed load previously logged to console and left a permanently blank page.
async function loadPlaylist() {
  const playlistId = route.params.id as string
  isLoading.value = true
  hasError.value = false

  // Qobuz playlist: load from the Qobuz backend (its id isn't a Deezer id).
  if (route.query.source === 'qobuz') {
    try {
      const port = window.electronAPI ? await window.electronAPI.getServerPort() : (downloadStore.serverPort || 6595)
      const resp = await fetch(`http://127.0.0.1:${port}/api/qobuz/playlist?id=${playlistId}`)
      if (!resp.ok) throw new Error('Qobuz playlist load failed')
      const p = await resp.json()
      const cover = p.images300?.[0] || p.images?.[0] || p.image_rectangle?.[0]
      playlist.value = {
        id: p.id, title: p.name,
        creator: { name: p.owner?.name || '' } as any,
        picture_medium: cover, picture_big: cover,
        nb_tracks: p.tracks_count,
        source: 'qobuz', qobuzId: p.id, qobuzType: 'playlist',
      } as any
      tracks.value = (p.tracks?.items || []).map((t: any) => ({
        id: t.id, title: t.title, duration: t.duration,
        artist: { id: t.performer?.id, name: t.performer?.name || '' },
        album: { id: t.album?.id, title: t.album?.title, cover_small: t.album?.image?.small, cover_medium: t.album?.image?.large },
        source: 'qobuz', qobuzId: t.id,
      })) as any
    } catch (error) {
      console.error('Failed to load Qobuz playlist:', error)
      hasError.value = true
    } finally {
      isLoading.value = false
      isLoadingTracks.value = false
    }
    return
  }

  try {
    // First, get the playlist metadata
    const playlistData = await deezerAPI.getPlaylist(playlistId)
    playlist.value = playlistData

    // For large playlists (100+ tracks), show progress
    const totalTracks = playlistData.nb_tracks || 0
    if (totalTracks > 100) {
      isLoadingTracks.value = true
      loadingTotal.value = totalTracks
      loadingProgress.value = 0

      const tracksData = await deezerAPI.getPlaylistTracksWithProgress(
        playlistId,
        totalTracks,
        (loaded, total) => {
          loadingProgress.value = loaded
          loadingTotal.value = total
        }
      )
      tracks.value = tracksData
      isLoadingTracks.value = false
    } else {
      // Small playlist - load normally
      const tracksData = await deezerAPI.getPlaylistTracks(playlistId)
      tracks.value = tracksData
    }
  } catch (error) {
    console.error('Failed to load playlist:', error)
    hasError.value = true
  } finally {
    isLoading.value = false
    isLoadingTracks.value = false
  }
}

onMounted(loadPlaylist)

const isFavorite = () => playlist.value && favoritesStore.isFavorite(playlist.value.id, 'playlist')

// Check if this playlist is already in the download queue or completed
const isPlaylistInQueue = computed(() => {
  if (!playlist.value) return false
  return downloadStore.isPlaylistInQueue(playlist.value.id)
})

const isPlaylistCompleted = computed(() => {
  if (!playlist.value) return false
  return downloadStore.isPlaylistCompleted(playlist.value.id)
})

// Combined state for download button
const playlistDownloadState = computed(() => {
  if (isPlaylistInQueue.value) return 'downloading'
  if (isPlaylistCompleted.value) return 'completed'
  return 'available'
})

function toggleFavorite() {
  if (playlist.value) {
    favoritesStore.toggleFavorite(playlist.value, 'playlist')
  }
}

// Track diff — how many tracks are already downloaded vs new
const trackDiff = computed(() => {
  if (!tracks.value.length) return null
  const existing = tracks.value.filter(t => downloadStore.isTrackCompleted(t.id)).length
  const newTracks = tracks.value.length - existing
  return existing > 0 ? { existing, newTracks, total: tracks.value.length } : null
})

async function downloadPlaylist() {
  if (playlistDownloadState.value !== 'available') return // Already downloading or completed
  if (playlist.value && tracks.value.length > 0) {
    await downloadStore.addPlaylistDownload(playlist.value, tracks.value)
  }
}

// Refresh tags on already-downloaded playlist files (no re-download).
async function refreshPlaylistTags() {
  if (playlist.value && tracks.value.length > 0) {
    await downloadStore.addPlaylistDownload(playlist.value, tracks.value, true)
  }
}

// Context menu
const { menuState, openMenu, closeMenu, copyToClipboard } = useContextMenu()

const playlistLink = computed(() => playlist.value
  ? publicLink('playlist', (playlist.value as any).qobuzId ?? playlist.value.id, (playlist.value as any).source)
  : null)

const contextMenuItems = computed(() => {
  if (!playlist.value) return []
  return [
    {
      label: t('contextMenu.copyLink'),
      icon: 'link',
      action: () => copyToClipboard(playlistLink.value || '', t('contextMenu.link')),
      disabled: !playlistLink.value
    },
    {
      label: t('contextMenu.copyPlaylist'),
      icon: 'copy',
      action: () => copyToClipboard(playlist.value!.title, t('contextMenu.playlist'))
    },
    {
      label: t('contextMenu.copyCreator'),
      icon: 'copy',
      action: () => copyToClipboard(playlist.value!.creator?.name || '', t('contextMenu.creator')),
      disabled: !playlist.value!.creator?.name
    }
  ]
})
</script>

<template>
  <div class="space-y-8">
    <BackButton />

    <!-- Loading -->
    <div v-if="isLoading && !playlist" class="flex items-center justify-center py-20">
      <div class="animate-spin w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
    </div>

    <!-- Error State -->
    <ErrorState
      v-else-if="hasError && !playlist"
      :title="t('errors.loadingFailed')"
      :message="t('errors.tryAgainLater')"
      @retry="loadPlaylist"
    />

    <template v-else-if="playlist">
      <!-- Playlist Header -->
      <div class="flex items-end gap-6" @contextmenu="openMenu">
        <img
          :src="playlist.picture_xl || playlist.picture_big || playlist.picture_medium"
          :alt="playlist.title"
          class="w-48 h-48 object-cover border border-white/[0.1] shadow-2xl"
        />
        <div class="flex-1">
          <p class="font-mono text-[10px] tracking-[0.3em] uppercase text-primary-500 mb-2">{{ t('common.playlist') }}</p>
          <h1 class="font-display uppercase text-[34px] leading-[1.02] tracking-[-0.01em] mb-2">{{ playlist.title }}</h1>
          <p v-if="playlist.description" class="text-foreground-muted mb-2">
            {{ playlist.description }}
          </p>
          <p class="text-foreground-muted mb-4">
            <span v-if="playlist.creator">
              <!-- Deezer creators with a public profile link through to their
                   other playlists (#135). Qobuz gives an owner name with no id,
                   and creators shown as "Anonymous" have no public profile, so
                   both render as plain text rather than a link into an error. -->
              <router-link
                v-if="creatorIsBrowsable"
                :to="`/user/${playlist.creator.id}`"
                class="hover:text-primary-500 transition-colors underline decoration-dotted underline-offset-4"
              >{{ playlist.creator.name }}</router-link>
              <template v-else>{{ playlist.creator.name }}</template>
              &bull;
            </span>
            {{ t('playlistView.tracksCount', { count: tracks.length, duration: totalDuration }) }}
          </p>
          <div class="flex gap-3">
            <button
              @click="downloadPlaylist"
              class="btn flex items-center gap-2"
              :class="{
                'btn-secondary cursor-default opacity-75': playlistDownloadState === 'downloading',
                'btn-secondary cursor-default': playlistDownloadState === 'completed',
                'btn-primary': playlistDownloadState === 'available'
              }"
              :disabled="playlistDownloadState !== 'available'"
            >
              <!-- Downloading checkmark -->
              <svg v-if="playlistDownloadState === 'downloading'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M5 13l4 4L19 7" />
              </svg>
              <!-- Already downloaded indicator -->
              <svg v-else-if="playlistDownloadState === 'completed'" class="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <!-- Download icon -->
              <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {{ playlistDownloadState === 'downloading' ? t('playlistView.inQueue') : playlistDownloadState === 'completed' ? t('playlistView.alreadyDownloaded') : t('playlistView.downloadPlaylist') }}
            </button>
            <button
              @click="refreshPlaylistTags"
              class="btn btn-secondary flex items-center gap-2"
              :title="t('retag.refreshTagsHint')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {{ t('retag.refreshTagsAction') }}
            </button>
            <span v-if="trackDiff" class="text-xs text-foreground-muted flex items-center gap-1">
              <svg class="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
              {{ trackDiff.existing }} already downloaded &middot; {{ trackDiff.newTracks }} new
            </span>
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

      <!-- Track Loading Progress -->
      <div v-if="isLoadingTracks" class="card">
        <div class="flex items-center gap-4">
          <div class="animate-spin w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full flex-shrink-0"></div>
          <div class="flex-1">
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-medium">{{ t('playlistView.loadingTracks') }}</span>
              <span class="text-sm text-foreground-muted">{{ loadingProgress }} / {{ loadingTotal }}</span>
            </div>
            <div class="h-2 bg-background-tertiary rounded-full overflow-hidden">
              <div
                class="h-full bg-primary-500 transition-all duration-300 ease-out"
                :style="{ width: `${loadingPercentage}%` }"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Track List -->
      <section v-if="tracks.length > 0">
        <div class="space-y-1">
          <TrackCard
            v-for="(track, index) in tracks"
            :key="track.id"
            :track="track"
            :index="index + 1"
          />
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
