<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDownloadStore } from '../stores/downloadStore'

const { t } = useI18n()
const downloadStore = useDownloadStore()

// Find the first download that's actually in 'downloading' status, not just 'pending'
const currentDownload = computed(() => {
  // First try to find one that's actively downloading
  const downloading = downloadStore.activeDownloads.find(d => d.status === 'downloading')
  if (downloading) return downloading
  // Fall back to first pending if nothing is downloading yet
  return downloadStore.activeDownloads[0]
})

const queueCount = computed(() => Math.max(0, downloadStore.activeDownloads.length - 1))

// Calculate overall progress across all active downloads
const progress = computed(() => {
  const active = downloadStore.activeDownloads
  if (active.length === 0) return 0

  // If showing a single download, use its progress
  if (active.length === 1) {
    return currentDownload.value?.progress || 0
  }

  // For multiple downloads, calculate weighted average based on track counts
  let totalTracks = 0
  let completedProgress = 0

  for (const download of active) {
    if (download.type === 'album' || download.type === 'playlist') {
      const tracks = download.totalTracks || 1
      totalTracks += tracks
      completedProgress += (download.progress || 0) * tracks
    } else {
      // Single track
      totalTracks += 1
      completedProgress += download.progress || 0
    }
  }

  return totalTracks > 0 ? Math.round(completedProgress / totalTracks) : 0
})

// Safely extract artist name (handles both string and object)
function getArtistName(item: any): string {
  if (!item?.artist) return t('common.unknownArtist')
  if (typeof item.artist === 'string') return item.artist
  if (typeof item.artist === 'object' && item.artist.name) return item.artist.name
  return t('common.unknownArtist')
}
</script>

<template>
  <div class="h-16 bg-background-secondary border-t border-white/[0.06] flex items-center px-4 gap-4">
    <!-- Current download info -->
    <div v-if="currentDownload" class="flex items-center gap-3 flex-1 min-w-0">
      <!-- Album art -->
      <img
        v-if="currentDownload.cover"
        :src="currentDownload.cover"
        :alt="currentDownload.title"
        class="w-10 h-10 object-cover bg-background-tertiary border border-white/[0.08]"
      />
      <div v-else class="w-10 h-10 bg-background-tertiary border border-white/[0.08] flex items-center justify-center text-foreground-muted">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <circle cx="12" cy="12" r="10" stroke-width="2"/>
          <circle cx="12" cy="12" r="3" stroke-width="2"/>
        </svg>
      </div>

      <!-- Track info -->
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium truncate">{{ currentDownload.title }}</p>
        <p class="text-xs text-foreground-muted truncate">{{ getArtistName(currentDownload) }}</p>
      </div>

      <!-- Progress bar -->
      <div class="w-48">
        <div class="h-1.5 bg-background-main border border-white/[0.06] overflow-hidden">
          <div
            class="h-full bg-primary-500 transition-all duration-300"
            :style="{ width: `${progress}%` }"
          />
        </div>
        <div class="flex justify-between mt-1 font-mono text-[10px] tracking-[0.08em] text-foreground-muted">
          <span class="text-primary-500">{{ progress }}%</span>
          <span v-if="queueCount > 0" class="uppercase">
            +{{ queueCount }} in queue
          </span>
        </div>
      </div>

      <!-- Controls -->
      <div class="flex items-center gap-2">
        <button
          class="p-2 hover:bg-white/10 transition-colors"
          :title="downloadStore.isPaused ? t('downloads.resume') : t('downloads.pause')"
          @click="downloadStore.isPaused ? downloadStore.resumeQueue() : downloadStore.pauseQueue()"
        >
          <!-- Pause icon (when running) -->
          <svg v-if="!downloadStore.isPaused" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6" />
          </svg>
          <!-- Play/Resume icon (when paused) -->
          <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          </svg>
        </button>
        <button
          class="p-2 hover:bg-white/10 transition-colors"
          :title="t('common.cancel')"
          @click="downloadStore.cancelDownload(currentDownload.id)"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
