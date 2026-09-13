<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useDownloadStore } from '../stores/downloadStore'
import { useFavoritesStore } from '../stores/favoritesStore'
import { usePlayerStore } from '../stores/playerStore'
import { useContextMenu } from '../composables/useContextMenu'
import ContextMenu from './ContextMenu.vue'
import type { Track } from '../types'

const { t } = useI18n()
const router = useRouter()

const props = withDefaults(defineProps<{
  track: Track
  index?: number
  showAlbum?: boolean
}>(), {
  showAlbum: true
})

const downloadStore = useDownloadStore()
const favoritesStore = useFavoritesStore()
const playerStore = usePlayerStore()

const duration = computed(() => {
  const mins = Math.floor(props.track.duration / 60)
  const secs = props.track.duration % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
})

const candidateUrls = computed(() =>
  [
    props.track.album?.cover_small,
    props.track.album?.cover_medium,
    props.track.cover
  ].filter((u): u is string => !!u)
)

const candidateIndex = ref(0)
const allCoversFailed = ref(false)

const coverUrl = computed(() => candidateUrls.value[candidateIndex.value] ?? '')

function handleImageError() {
  if (candidateIndex.value < candidateUrls.value.length - 1) {
    candidateIndex.value++
  } else {
    allCoversFailed.value = true
  }
}

watch(() => props.track.id, () => {
  candidateIndex.value = 0
  allCoversFailed.value = false
})

const isFavorite = computed(() => favoritesStore.isFavorite(props.track.id, 'track'))
const isPlaying = computed(() => playerStore.isTrackPlaying(props.track.id))
const isInQueue = computed(() => downloadStore.isTrackInQueue(props.track.id))
const isCompleted = computed(() => downloadStore.isTrackCompleted(props.track.id))

// Combined state for download button
const downloadState = computed(() => {
  if (isInQueue.value) return 'downloading'
  if (isCompleted.value) return 'completed'
  return 'available'
})

function download() {
  if (downloadState.value !== 'available') return // Already downloading or completed
  downloadStore.addDownload(props.track)
}

function toggleFavorite() {
  favoritesStore.toggleFavorite(props.track, 'track')
}

function togglePlay() {
  playerStore.play(props.track)
}

// Qobuz-sourced tracks carry Qobuz ids — their artist/album pages load from the
// Qobuz backend, flagged via the source query param (mirrors AlbumCard).
function goToArtist() {
  if (props.track.artist?.id != null) {
    const query = props.track.source === 'qobuz' ? { source: 'qobuz' } : undefined
    router.push({ path: `/artist/${props.track.artist.id}`, query })
  }
}

function goToAlbum() {
  if (props.track.album?.id != null) {
    const query = props.track.source === 'qobuz' ? { source: 'qobuz' } : undefined
    router.push({ path: `/album/${props.track.album.id}`, query })
  }
}

// Context menu
const { menuState, openMenu, closeMenu, copyToClipboard } = useContextMenu()

const contextMenuItems = computed(() => [
  {
    label: t('contextMenu.copyTitle'),
    icon: 'copy',
    action: () => copyToClipboard(props.track.title, t('contextMenu.title'))
  },
  {
    label: t('contextMenu.copyArtist'),
    icon: 'copy',
    action: () => copyToClipboard(props.track.artist?.name || '', t('contextMenu.artist')),
    disabled: !props.track.artist?.name
  },
  {
    label: t('contextMenu.copyBoth'),
    icon: 'copy',
    action: () => copyToClipboard(`${props.track.artist?.name || 'Unknown'} - ${props.track.title}`, t('contextMenu.trackInfo'))
  }
])
</script>

<template>
  <div
    class="track-card group flex items-center gap-3 px-2 py-2 border-b border-white/[0.05] transition-colors"
    :class="[
      isPlaying ? 'bg-primary-500/10' : 'hover:bg-primary-500/[0.04]',
      track.source === 'qobuz' ? 'border-l-2 border-l-qobuz-500/60' : ''
    ]"
    @contextmenu="openMenu"
  >
    <!-- Index / Play button -->
    <div class="w-8 text-center">
      <!-- Show stop button when this track is playing -->
      <button
        v-if="isPlaying"
        @click="togglePlay"
        class="flex items-center justify-center w-5 h-5 mx-auto text-primary-500 hover:text-primary-400"
        :title="t('trackCard.stop')"
      >
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
      </button>
      <!-- Show index normally, play button on hover -->
      <template v-else>
        <span class="group-hover:hidden font-mono text-[12px] text-foreground-muted">{{ index || '' }}</span>
        <!-- Shown unless Deezer has said there is no clip (preview === '').
             Qobuz rows and Deezer rows from list endpoints carry no preview
             field at all; the player resolves both on demand (#153). -->
        <button
          v-if="track.preview !== ''"
          @click="togglePlay"
          class="hidden group-hover:block text-foreground-muted"
          :class="track.source === 'qobuz' ? 'hover:text-qobuz-400' : 'hover:text-primary-400'"
          :title="t('trackCard.play')"
        >
          <svg class="w-5 h-5 mx-auto" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      </template>
    </div>

    <!-- Cover art -->
    <img
      v-if="coverUrl && !allCoversFailed"
      :src="coverUrl"
      :alt="track.title"
      loading="lazy"
      decoding="async"
      class="w-9 h-9 object-cover bg-background-tertiary"
      @error="handleImageError"
    />
    <!-- Fallback placeholder when no image or image fails to load -->
    <div
      v-else
      class="w-9 h-9 bg-background-tertiary flex items-center justify-center"
    >
      <svg class="w-5 h-5 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
      </svg>
    </div>

    <!-- Track info -->
    <div class="flex-1 min-w-0">
      <p class="text-[14.5px] font-semibold truncate" :class="isPlaying ? 'text-primary-400' : (track.explicit_lyrics ? 'text-primary-400' : '')">
        {{ track.title }}
        <span v-if="track.explicit_lyrics" class="font-mono text-[9px] border border-white/20 text-foreground-muted px-1 ml-1 align-middle">E</span>
      </p>
      <div class="flex items-center gap-1 text-[12.5px] text-foreground-muted truncate">
        <span
          v-if="track.artist?.id != null"
          @click.stop="goToArtist"
          class="hover:text-primary-400 hover:underline cursor-pointer"
        >
          {{ track.artist.name }}
        </span>
        <span v-else-if="track.artist" class="text-foreground-muted">
          {{ track.artist.name }}
        </span>
        <template v-if="showAlbum && track.album">
          <span>&bull;</span>
          <span
            v-if="track.album.id != null"
            @click.stop="goToAlbum"
            class="hover:text-primary-400 hover:underline truncate cursor-pointer"
          >
            {{ track.album.title }}
          </span>
          <span v-else class="truncate text-foreground-muted">
            {{ track.album.title }}
          </span>
        </template>
      </div>
    </div>

    <!-- Duration -->
    <span class="font-mono text-[12px] text-foreground-muted w-12 text-right">{{ duration }}</span>

    <!-- Actions -->
    <div class="flex items-center gap-1.5">
      <button
        @click="toggleFavorite"
        class="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all"
        :title="isFavorite ? t('trackCard.removeFromFavorites') : t('trackCard.addToFavorites')"
      >
        <svg
          class="w-4.5 h-4.5"
          :class="isFavorite ? 'fill-primary-500 text-primary-500' : 'text-foreground-muted'"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
        </svg>
      </button>
      <button
        @click="download"
        class="get-btn"
        :class="{
          'get-btn-queued': downloadState === 'downloading',
          'get-btn-stored': downloadState === 'completed',
          'get-btn-qobuz': track.source === 'qobuz' && downloadState === 'available'
        }"
        :title="downloadState === 'downloading' ? t('trackCard.inQueue') : downloadState === 'completed' ? t('trackCard.alreadyDownloaded') : t('trackCard.download')"
        :disabled="downloadState !== 'available'"
      >
        <template v-if="downloadState === 'downloading'">QUEUED</template>
        <template v-else-if="downloadState === 'completed'">STORED</template>
        <template v-else>GET&nbsp;↓</template>
      </button>
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

<style scoped>
/* Mockup .get — mono bordered acquisition button; fills chartreuse on hover */
.get-btn {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: rgb(var(--primary-500));
  border: 1px solid rgb(var(--primary-600) / 0.7);
  padding: 4px 10px;
  background: none;
  white-space: nowrap;
  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}
.get-btn:not(:disabled):hover {
  background: rgb(var(--primary-500));
  color: rgb(var(--bg-main));
  border-color: rgb(var(--primary-500));
  box-shadow: 0 0 14px rgb(var(--primary-500) / 0.35);
}
/* Channel Q — Qobuz-sourced tracks acquire in the fixed brand cyan */
.get-btn-qobuz {
  color: #59C2D6;
  border-color: rgb(89 194 214 / 0.7);
}
.get-btn-qobuz:not(:disabled):hover {
  background: #59C2D6;
  color: rgb(var(--bg-main));
  border-color: #59C2D6;
  box-shadow: 0 0 14px rgb(89 194 214 / 0.35);
}
.get-btn-queued {
  color: #ffb454;
  border-color: rgb(255 180 84 / 0.5);
  cursor: default;
}
.get-btn-stored {
  color: #22c55e;
  border-color: rgb(34 197 94 / 0.5);
  cursor: default;
}
</style>
