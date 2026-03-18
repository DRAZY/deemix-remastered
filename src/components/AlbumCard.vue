<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useDownloadStore } from '../stores/downloadStore'
import { deezerAPI } from '../services/deezerAPI'
import { useContextMenu } from '../composables/useContextMenu'
import ContextMenu from './ContextMenu.vue'
import type { Album } from '../types'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  album: Album
  type?: 'album' | 'playlist'
}>(), {
  type: 'album'
})

const router = useRouter()
const downloadStore = useDownloadStore()
const isDownloading = ref(false)
const imageError = ref(false)

const coverUrl = computed(() => {
  return props.album.cover_medium ||
         props.album.cover_big ||
         props.album.cover_small ||
         ''
})

function handleImageError() {
  imageError.value = true
}

function navigate(event: Event) {
  event.stopPropagation()
  if (props.type === 'playlist') {
    router.push(`/playlist/${props.album.id}`)
  } else {
    router.push(`/album/${props.album.id}`)
  }
}

async function downloadAlbum() {
  if (isDownloading.value) return
  isDownloading.value = true

  try {
    if (props.type === 'playlist') {
      const tracks = await deezerAPI.getPlaylistTracks(props.album.id)
      if (tracks && tracks.length > 0) {
        await downloadStore.addPlaylistDownload({
          id: props.album.id,
          title: props.album.title,
          creator: props.album.artist || { id: 0, name: 'Unknown' },
          picture_medium: props.album.cover_medium || '',
          picture_big: props.album.cover_big || '',
          nb_tracks: tracks.length
        }, tracks)
      }
    } else {
      const tracks = await deezerAPI.getAlbumTracks(props.album.id)
      if (tracks && tracks.length > 0) {
        await downloadStore.addAlbumDownload(props.album, tracks)
      }
    }
  } catch (error) {
    console.error('Failed to download:', error)
  } finally {
    isDownloading.value = false
  }
}

function navigateToArtist(event: Event) {
  event.stopPropagation()
  if (props.album.artist?.id != null) {
    router.push(`/artist/${props.album.artist.id}`)
  }
}

// Context menu
const { menuState, openMenu, closeMenu, copyToClipboard } = useContextMenu()

const contextMenuItems = computed(() => [
  {
    label: t('contextMenu.copyAlbum'),
    icon: 'copy',
    action: () => copyToClipboard(props.album.title, t('contextMenu.album'))
  },
  {
    label: t('contextMenu.copyArtist'),
    icon: 'copy',
    action: () => copyToClipboard(props.album.artist?.name || '', t('contextMenu.artist')),
    disabled: !props.album.artist?.name
  }
])
</script>

<template>
  <div class="album-card group" @contextmenu="openMenu">
    <!-- Album cover - click to download -->
    <div
      @click="downloadAlbum"
      class="relative aspect-square mb-3 cursor-pointer"
      :class="{ 'opacity-50 pointer-events-none': isDownloading }"
    >
      <!-- Album cover image -->
      <img
        v-if="coverUrl && !imageError"
        :src="coverUrl"
        :alt="album.title"
        loading="lazy"
        decoding="async"
        class="w-full h-full object-cover rounded-lg bg-background-tertiary shadow-md
               group-hover:shadow-lg transition-shadow duration-200"
        @error="handleImageError"
      />
      <!-- Fallback placeholder when no image or image fails to load -->
      <div
        v-else
        class="w-full h-full rounded-lg bg-background-tertiary shadow-md
               group-hover:shadow-lg transition-shadow duration-200
               flex items-center justify-center"
      >
        <svg class="w-12 h-12 text-foreground-muted/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
            d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
      </div>
      <!-- Download overlay -->
      <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity
                  rounded-lg flex items-center justify-center">
        <div class="w-12 h-12 bg-primary-500 rounded-full flex items-center justify-center
                    transform scale-90 group-hover:scale-100 transition-transform shadow-lg">
          <!-- Download icon -->
          <svg v-if="!isDownloading" class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 18h16" />
          </svg>
          <!-- Loading spinner -->
          <svg v-else class="w-6 h-6 text-white animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
      </div>
    </div>
    <!-- Title - click to navigate to album details -->
    <h3
      @click="navigate"
      class="font-medium truncate hover:text-primary-400 transition-colors cursor-pointer"
    >
      {{ album.title }}
    </h3>
    <p class="text-sm text-foreground-muted truncate">
      <span
        v-if="album.artist?.id != null"
        @click="navigateToArtist"
        class="hover:text-primary-400 cursor-pointer transition-colors"
      >
        {{ album.artist.name }}
      </span>
      <span v-else>
        {{ album.artist?.name || t('common.variousArtists') }}
      </span>
    </p>

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
