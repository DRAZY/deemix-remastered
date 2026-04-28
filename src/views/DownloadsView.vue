<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDownloadStore } from '../stores/downloadStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useToastStore } from '../stores/toastStore'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import EmptyState from '../components/EmptyState.vue'
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu } from '../composables/useContextMenu'
import type { DownloadItem } from '../types'

const { t } = useI18n()
const downloadStore = useDownloadStore()
const settingsStore = useSettingsStore()
const toastStore = useToastStore()

// Appearance settings
const isSlim = computed(() => settingsStore.settings.appearance?.slimDownloadTab ?? false)
const showQualityTag = computed(() => settingsStore.settings.appearance?.showQualityTag ?? true)

// Track which items have expanded failed tracks view
const expandedItems = ref<Set<string>>(new Set())
const showHistory = ref(false)
const showStats = ref(false)

const downloadStats = computed(() => {
  const history = downloadStore.downloadHistory
  if (!history.length) return null

  const completed = history.filter(h => h.status === 'completed')
  const failed = history.filter(h => h.status === 'error')

  // Count total tracks (albums/playlists contribute their track count)
  let totalTracks = 0
  for (const entry of completed) {
    totalTracks += entry.totalTracks || 1
  }

  // Top artists (from completed downloads)
  const artistCounts = new Map<string, number>()
  for (const entry of completed) {
    const artist = entry.artist || 'Unknown'
    artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1)
  }
  const topArtists = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  // Format breakdown (normalize to uppercase so FLAC/flac count together)
  const formatCounts = new Map<string, number>()
  for (const entry of completed) {
    const raw = entry.actualFormat || entry.quality || 'Unknown'
    const fmt = raw.toUpperCase()
    formatCounts.set(fmt, (formatCounts.get(fmt) || 0) + 1)
  }

  // This week
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)
  const thisWeek = completed.filter(e => new Date(e.completedAt) > weekAgo).length

  return {
    totalDownloads: completed.length,
    totalTracks,
    failedCount: failed.length,
    topArtists,
    formats: [...formatCounts.entries()].sort((a, b) => b[1] - a[1]),
    thisWeek
  }
})

function toggleExpanded(id: string) {
  if (expandedItems.value.has(id)) {
    expandedItems.value.delete(id)
  } else {
    expandedItems.value.add(id)
  }
}

// Drag and drop reordering
const draggedItem = ref<string | null>(null)
const dragOverItem = ref<string | null>(null)
const dragOverPosition = ref<'before' | 'after' | null>(null)

function handleDragStart(e: DragEvent, itemId: string) {
  draggedItem.value = itemId
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', itemId)
  }
  // Add a slight delay to allow the drag image to be set
  setTimeout(() => {
    const el = e.target as HTMLElement
    el.style.opacity = '0.5'
  }, 0)
}

function handleDragEnd(e: DragEvent) {
  const el = e.target as HTMLElement
  el.style.opacity = '1'
  draggedItem.value = null
  dragOverItem.value = null
  dragOverPosition.value = null
}

function handleDragOver(e: DragEvent, itemId: string) {
  e.preventDefault()
  if (!draggedItem.value || draggedItem.value === itemId) return

  dragOverItem.value = itemId

  // Determine if dropping before or after based on mouse position
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const midY = rect.top + rect.height / 2
  dragOverPosition.value = e.clientY < midY ? 'before' : 'after'
}

function handleDragLeave() {
  dragOverItem.value = null
  dragOverPosition.value = null
}

function handleDrop(e: DragEvent, targetId: string) {
  e.preventDefault()
  if (!draggedItem.value || draggedItem.value === targetId) return

  // Reorder the downloads array
  downloadStore.reorderDownload(draggedItem.value, targetId, dragOverPosition.value || 'after')

  draggedItem.value = null
  dragOverItem.value = null
  dragOverPosition.value = null
}

// Confirmation dialog state
const deleteConfirm = ref<{ id: string; title: string } | null>(null)

// Error details modal state - enhanced with full error information
const errorDetails = ref<{
  title: string
  artist: string
  error: string
  trackId?: string
  errorCode?: string
  httpStatus?: number
  serverResponse?: string
  suggestion?: string
  timestamp?: string
} | null>(null)

function showErrorDetails(item: DownloadItem) {
  const details = item.errorDetails
  errorDetails.value = {
    title: item.title,
    artist: item.artist || 'Unknown Artist',
    error: details?.message || item.error || 'Unknown error',
    trackId: item.track?.id?.toString() || details?.trackId?.toString(),
    errorCode: details?.code,
    httpStatus: details?.httpStatus,
    serverResponse: details?.serverResponse,
    suggestion: details?.suggestion,
    timestamp: details?.timestamp
  }
}

function showFailedTrackError(failed: { title: string; artist?: string; error?: string; id?: string; errorDetails?: any }) {
  const details = failed.errorDetails
  errorDetails.value = {
    title: failed.title,
    artist: failed.artist || 'Unknown Artist',
    error: details?.message || failed.error || 'Unknown error',
    trackId: failed.id || details?.trackId?.toString(),
    errorCode: details?.code,
    httpStatus: details?.httpStatus,
    serverResponse: details?.serverResponse,
    suggestion: details?.suggestion,
    timestamp: details?.timestamp
  }
}

function closeErrorDetails() {
  errorDetails.value = null
}

function confirmDelete(item: DownloadItem) {
  deleteConfirm.value = { id: item.id, title: item.title }
}

async function executeDelete(deleteFiles: boolean) {
  if (deleteConfirm.value) {
    await downloadStore.deleteDownload(deleteConfirm.value.id, deleteFiles)
    deleteConfirm.value = null
  }
}

function cancelDelete() {
  deleteConfirm.value = null
}

// Clear confirmation dialogs
const showClearAllConfirm = ref(false)
const showClearCompletedConfirm = ref(false)

function confirmClearAll() {
  showClearAllConfirm.value = true
}

function executeClearAll() {
  const count = downloadStore.downloads.length
  downloadStore.clearAll()
  showClearAllConfirm.value = false
  toastStore.info(`Cleared ${count} download${count !== 1 ? 's' : ''}`)
}

function confirmClearCompleted() {
  showClearCompletedConfirm.value = true
}

function executeClearCompleted() {
  const count = downloadStore.completedDownloads.length
  downloadStore.clearCompleted()
  showClearCompletedConfirm.value = false
  toastStore.info(`Cleared ${count} completed download${count !== 1 ? 's' : ''}`)
}

// Get the best available cover image for a download item
function getCoverUrl(item: DownloadItem): string {
  // First try the direct cover property
  if (item.cover) return item.cover

  // For tracks, try album covers
  if (item.track?.album) {
    const album = item.track.album
    return album.cover_medium || album.cover_big || album.cover_small || album.cover || ''
  }

  // For albums, try all cover variants
  if (item.album) {
    const album = item.album
    return album.cover_medium || album.cover_big || album.cover_small || album.cover || ''
  }

  // For playlists, try all picture variants
  if (item.playlist) {
    const playlist = item.playlist
    return playlist.picture_medium || playlist.picture_big || playlist.picture_small || playlist.picture || ''
  }

  return ''
}

// Handle image load errors
function handleImageError(event: Event) {
  const img = event.target as HTMLImageElement
  if (img.src !== '/placeholder.png') {
    img.src = '/placeholder.png'
  }
}

function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
  } else if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`
  }
  return `${bytesPerSecond.toFixed(0)} B/s`
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  } else if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  } else if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`
  }
  return `${bytes} B`
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'downloading': return 'text-primary-400'
    case 'completed': return 'text-green-400'
    case 'error': return 'text-red-400'
    case 'paused': return 'text-yellow-400'
    default: return 'text-foreground-muted'
  }
}

function getStatusText(status: string): string {
  switch (status) {
    case 'pending': return t('downloads.status.pending')
    case 'downloading': return t('downloads.status.downloading')
    case 'completed': return t('downloads.status.completed')
    case 'error': return t('downloads.status.error')
    case 'paused': return t('downloads.status.paused')
    default: return status
  }
}

// Get display format - prefer actualFormat (what was downloaded) over quality (what was requested)
function getDisplayFormat(item: DownloadItem): string | undefined {
  // actualFormat is like 'FLAC', 'MP3_320', 'MP3_128'
  // quality is like 'flac', '320', '128'
  return item.actualFormat || item.quality
}

function getQualityLabel(format?: string): string {
  if (!format) return ''
  const f = format.toUpperCase()
  switch (f) {
    case '128':
    case 'MP3_128': return 'MP3 128'
    case '320':
    case 'MP3_320': return 'MP3 320'
    case 'FLAC':
    case 'flac': return 'FLAC'
    default: return format
  }
}

function getQualityColor(format?: string): string {
  if (!format) return 'bg-zinc-500/20 text-zinc-400'
  const f = format.toUpperCase()
  if (f === 'FLAC' || f === 'flac') return 'bg-amber-500/20 text-amber-400'
  if (f === '320' || f === 'MP3_320') return 'bg-green-500/20 text-green-400'
  if (f === '128' || f === 'MP3_128') return 'bg-blue-500/20 text-blue-400'
  return 'bg-zinc-500/20 text-zinc-400'
}

// Open the folder containing the downloaded file
async function openItemFolder(path: string) {
  if (path && window.electronAPI) {
    await window.electronAPI.openPath(path)
  }
}

async function moveToFront(item: DownloadItem) {
  // For album/playlist items, move all their pending track IDs to front
  // For single tracks, move just the one download ID
  const ids = item.trackIds?.length ? item.trackIds : [item.id]
  for (const id of ids) {
    try {
      await fetch(`http://127.0.0.1:${downloadStore.serverPort}/api/queue/priority`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
    } catch { /* ignore individual failures */ }
  }
}

// Context menu for error details
const { menuState, openMenu, closeMenu, copyToClipboard } = useContextMenu()
const contextMenuValue = ref('')
const contextMenuLabel = ref('')

function openErrorContextMenu(e: MouseEvent, label: string, value: string) {
  if (value) {
    contextMenuValue.value = value
    contextMenuLabel.value = label
    openMenu(e)
  }
}

const contextMenuItems = computed(() => [
  {
    label: t('contextMenu.copyError'),
    icon: 'copy',
    action: () => copyToClipboard(contextMenuValue.value, contextMenuLabel.value)
  }
])

// Copy all error details
function copyAllErrorDetails() {
  if (!errorDetails.value) return
  const details = [
    `Track: ${errorDetails.value.title}`,
    `Artist: ${errorDetails.value.artist}`,
    errorDetails.value.trackId ? `ID: ${errorDetails.value.trackId}` : '',
    errorDetails.value.errorCode ? `Error Code: ${errorDetails.value.errorCode}` : '',
    errorDetails.value.httpStatus ? `HTTP Status: ${errorDetails.value.httpStatus}` : '',
    `Error: ${errorDetails.value.error}`,
    errorDetails.value.suggestion ? `Suggestion: ${errorDetails.value.suggestion}` : '',
    errorDetails.value.serverResponse ? `Server Response: ${errorDetails.value.serverResponse}` : ''
  ].filter(Boolean).join('\n')
  copyToClipboard(details, t('contextMenu.error'))
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">{{ t('downloads.title') }}</h1>
      <div class="flex gap-2">
        <!-- Pause/Resume Button -->
        <button
          v-if="downloadStore.activeDownloads.length > 0"
          @click="downloadStore.isPaused ? downloadStore.resumeQueue() : downloadStore.pauseQueue()"
          class="btn text-sm flex items-center gap-2"
          :class="downloadStore.isPaused ? 'btn-primary' : 'btn-ghost text-yellow-400 hover:text-yellow-300'"
        >
          <!-- Pause Icon -->
          <svg v-if="!downloadStore.isPaused" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <!-- Resume/Play Icon -->
          <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {{ downloadStore.isPaused ? t('downloads.resume') : t('downloads.pause') }}
        </button>
        <button
          v-if="downloadStore.completedDownloads.length > 0"
          @click="confirmClearCompleted"
          class="btn btn-ghost text-sm"
        >
          {{ t('downloads.clearCompleted') }}
        </button>
        <button
          v-if="downloadStore.downloads.length > 0"
          @click="confirmClearAll"
          class="btn btn-ghost text-sm text-red-400 hover:text-red-300"
        >
          {{ t('downloads.clearAll') }}
        </button>
      </div>
    </div>

    <!-- Paused Banner -->
    <div
      v-if="downloadStore.isPaused && downloadStore.activeDownloads.length > 0"
      class="bg-yellow-500/20 border border-yellow-500/30 rounded-lg px-4 py-3 flex items-center justify-between"
    >
      <div class="flex items-center gap-3">
        <svg class="w-5 h-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-yellow-400 font-medium">{{ t('downloads.status.paused') }}</span>
        <span class="text-foreground-muted text-sm">{{ downloadStore.activeDownloads.length }} downloads waiting</span>
      </div>
      <button
        @click="downloadStore.resumeQueue()"
        class="btn btn-primary text-sm"
      >
        {{ t('downloads.resume') }}
      </button>
    </div>

    <!-- Stats - hidden in slim mode -->
    <div v-if="!isSlim" class="grid grid-cols-3 gap-4">
      <div class="card">
        <p class="text-sm text-foreground-muted">{{ t('downloads.active') }}</p>
        <div class="flex items-baseline gap-2">
          <p class="text-2xl font-bold text-primary-400">{{ downloadStore.activeDownloads.length }}</p>
          <span v-if="downloadStore.totalDownloadSpeed > 0" class="text-sm text-primary-300 flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
            </svg>
            {{ formatSpeed(downloadStore.totalDownloadSpeed) }}
          </span>
        </div>
      </div>
      <div class="card">
        <p class="text-sm text-foreground-muted">{{ t('downloads.completed') }}</p>
        <p class="text-2xl font-bold text-green-400">{{ downloadStore.completedDownloads.length }}</p>
      </div>
      <div class="card">
        <p class="text-sm text-foreground-muted">{{ t('downloads.failed') }}</p>
        <p class="text-2xl font-bold text-red-400">{{ downloadStore.failedDownloads.length }}</p>
      </div>
    </div>
    <!-- Download Statistics (below session counters) -->
    <div v-if="downloadStats && !isSlim" class="mt-4">
      <button
        @click="showStats = !showStats"
        class="flex items-center gap-2 text-foreground-muted hover:text-foreground transition-colors mb-3"
      >
        <svg class="w-4 h-4 transition-transform" :class="{ 'rotate-90': showStats }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
        <span class="text-sm font-medium">Download Statistics</span>
      </button>

      <div v-if="showStats" class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div class="card p-4 text-center">
          <div class="text-2xl font-bold text-primary-400">{{ downloadStats.totalDownloads }}</div>
          <div class="text-xs text-foreground-muted mt-1">Downloads</div>
        </div>
        <div class="card p-4 text-center">
          <div class="text-2xl font-bold text-green-400">{{ downloadStats.totalTracks }}</div>
          <div class="text-xs text-foreground-muted mt-1">Total Tracks</div>
        </div>
        <div class="card p-4 text-center">
          <div class="text-2xl font-bold text-blue-400">{{ downloadStats.thisWeek }}</div>
          <div class="text-xs text-foreground-muted mt-1">This Week</div>
        </div>
        <div class="card p-4 text-center">
          <div class="text-2xl font-bold text-red-400">{{ downloadStats.failedCount }}</div>
          <div class="text-xs text-foreground-muted mt-1">Failed</div>
        </div>
      </div>

      <div v-if="showStats && downloadStats.topArtists.length > 0" class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div class="card p-4">
          <h4 class="text-xs font-medium text-foreground-muted mb-3 uppercase tracking-wider">Top Artists</h4>
          <div class="space-y-2">
            <div v-for="([artist, count], i) in downloadStats.topArtists" :key="artist" class="flex items-center justify-between">
              <span class="text-sm truncate">
                <span class="text-foreground-muted mr-2">{{ i + 1 }}.</span>
                {{ artist }}
              </span>
              <span class="text-xs text-foreground-muted ml-2 flex-shrink-0">{{ count }}</span>
            </div>
          </div>
        </div>
        <div class="card p-4">
          <h4 class="text-xs font-medium text-foreground-muted mb-3 uppercase tracking-wider">Formats</h4>
          <div class="space-y-2">
            <div v-for="([format, count]) in downloadStats.formats" :key="format" class="flex items-center justify-between">
              <span class="text-sm">{{ format }}</span>
              <span class="text-xs text-foreground-muted">{{ count }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- Compact stats bar in slim mode -->
    <div v-else class="flex items-center gap-4 text-sm">
      <span v-if="downloadStore.isPaused" class="text-yellow-400 font-medium flex items-center gap-1">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Paused
      </span>
      <span class="text-foreground-muted">
        <span class="text-primary-400 font-medium">{{ downloadStore.activeDownloads.length }}</span> active
      </span>
      <span v-if="downloadStore.totalDownloadSpeed > 0" class="text-primary-300 flex items-center gap-1">
        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
        </svg>
        {{ formatSpeed(downloadStore.totalDownloadSpeed) }}
      </span>
      <span class="text-foreground-muted">
        <span class="text-green-400 font-medium">{{ downloadStore.completedDownloads.length }}</span> done
      </span>
      <span v-if="downloadStore.failedDownloads.length > 0" class="text-foreground-muted">
        <span class="text-red-400 font-medium">{{ downloadStore.failedDownloads.length }}</span> failed
      </span>
    </div>

    <!-- Download List -->
    <div v-if="downloadStore.downloads.length > 0" :class="isSlim ? 'space-y-1' : 'space-y-2'">
      <div
        v-for="item in downloadStore.downloads"
        :key="item.id"
        draggable="true"
        class="card relative transition-transform"
        :class="[
          isSlim ? 'p-2' : '',
          draggedItem === item.id ? 'opacity-50' : '',
          dragOverItem === item.id && dragOverPosition === 'before' ? 'before:absolute before:top-0 before:left-0 before:right-0 before:h-0.5 before:bg-primary-500' : '',
          dragOverItem === item.id && dragOverPosition === 'after' ? 'after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary-500' : ''
        ]"
        @dragstart="handleDragStart($event, item.id)"
        @dragend="handleDragEnd"
        @dragover="handleDragOver($event, item.id)"
        @dragleave="handleDragLeave"
        @drop="handleDrop($event, item.id)"
      >
        <div class="flex items-center" :class="isSlim ? 'gap-2' : 'gap-4'">
          <!-- Drag handle -->
          <div class="flex-shrink-0 cursor-grab active:cursor-grabbing text-foreground-muted/40 hover:text-foreground-muted">
            <svg :class="isSlim ? 'w-3 h-3' : 'w-4 h-4'" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="9" cy="6" r="1.5" />
              <circle cx="15" cy="6" r="1.5" />
              <circle cx="9" cy="12" r="1.5" />
              <circle cx="15" cy="12" r="1.5" />
              <circle cx="9" cy="18" r="1.5" />
              <circle cx="15" cy="18" r="1.5" />
            </svg>
          </div>
          <!-- Album art -->
          <div class="relative flex-shrink-0">
            <img
              :src="getCoverUrl(item) || '/placeholder.png'"
              :alt="item.title"
              loading="lazy"
              decoding="async"
              class="rounded object-cover bg-background-tertiary"
              :class="isSlim ? 'w-8 h-8' : 'w-12 h-12'"
              @error="handleImageError"
            />
            <!-- Type badge for album/playlist -->
            <span
              v-if="(item.type === 'album' || item.type === 'playlist') && !isSlim"
              class="absolute -bottom-1 -right-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary-500 text-white"
            >
              {{ item.type === 'album' ? t('common.album') : t('common.playlist') }}
            </span>
          </div>

          <!-- Track/Album/Playlist info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <p class="font-medium truncate" :class="isSlim ? 'text-sm' : ''">{{ item.title }}</p>
              <!-- Quality tag - shows actual downloaded format (not just requested) -->
              <span
                v-if="showQualityTag && getDisplayFormat(item)"
                class="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded"
                :class="getQualityColor(getDisplayFormat(item))"
              >
                {{ getQualityLabel(getDisplayFormat(item)) }}
              </span>
              <!-- Type badge in slim mode (inline) -->
              <span
                v-if="isSlim && (item.type === 'album' || item.type === 'playlist')"
                class="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary-500/20 text-primary-400"
              >
                {{ item.type === 'album' ? t('common.album') : t('common.playlist') }}
              </span>
            </div>
            <p class="text-foreground-muted truncate" :class="isSlim ? 'text-xs' : 'text-sm'">
              {{ item.artist || t('common.unknownArtist') }}
            </p>
          </div>

          <!-- Progress / Status -->
          <div :class="isSlim ? 'w-44' : 'w-64'" class="text-right flex-shrink-0">
            <div v-if="item.status === 'downloading' || item.status === 'pending'" class="space-y-1">
              <div class="flex items-center justify-end gap-2">
                <!-- Download speed -->
                <span v-if="item.speed && item.speed > 0" class="text-xs text-primary-300 flex items-center gap-0.5">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {{ formatSpeed(item.speed) }}
                </span>
                <!-- Track count for albums/playlists -->
                <span v-if="(item.totalTracks || item.originalTotalTracks) && !isSlim" class="text-sm font-medium text-primary-400">
                  {{ (item.previouslyCompletedTracks || 0) + (item.completedTracks || 0) }}/{{ item.originalTotalTracks || item.totalTracks }}
                </span>
                <span :class="isSlim ? 'text-[10px]' : 'text-xs'" class="text-foreground-muted">{{ item.progress }}%</span>
              </div>
              <div :class="isSlim ? 'h-1' : 'h-1.5'" class="bg-background-tertiary rounded-full overflow-hidden">
                <div
                  class="h-full bg-primary-500 transition-all duration-300"
                  :style="{ width: `${item.progress}%` }"
                />
              </div>
              <!-- Bytes downloaded info -->
              <div v-if="item.bytesDownloaded && item.totalBytes && !isSlim" class="text-[10px] text-foreground-muted">
                {{ formatBytes(item.bytesDownloaded) }} / {{ formatBytes(item.totalBytes) }}
              </div>
            </div>
            <div v-else>
              <p :class="[getStatusColor(item.status), isSlim ? 'text-xs' : 'text-sm']" class="font-medium">
                {{ getStatusText(item.status) }}
                <span v-if="(item.status === 'completed' || item.status === 'error') && (item.totalTracks || item.originalTotalTracks)" class="text-foreground-muted font-normal">
                  ({{ (item.previouslyCompletedTracks || 0) + (item.completedTracks || 0) }}/{{ item.originalTotalTracks || item.totalTracks }})
                </span>
              </p>
              <!-- Clickable error message -->
              <button
                v-if="item.error"
                @click="showErrorDetails(item)"
                class="text-xs text-red-400 truncate max-w-full text-left hover:text-red-300 hover:underline cursor-pointer flex items-center gap-1"
                :title="t('downloads.clickForDetails')"
              >
                <svg class="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span class="truncate">{{ item.error }}</span>
              </button>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center" :class="isSlim ? 'gap-0.5' : 'gap-1'">
            <!-- Expand failed tracks button -->
            <button
              v-if="item.failedTracks && item.failedTracks.length > 0"
              @click="toggleExpanded(item.id)"
              class="hover:bg-white/10 rounded-lg transition-colors text-yellow-400"
              :class="isSlim ? 'p-1' : 'p-2'"
              title="Show failed tracks"
            >
              <svg :class="isSlim ? 'w-4 h-4' : 'w-5 h-5'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </button>
            <button
              v-if="item.status === 'completed' && item.path"
              @click="openItemFolder(item.path)"
              class="hover:bg-white/10 rounded-lg transition-colors"
              :class="isSlim ? 'p-1' : 'p-2'"
              title="Open folder"
            >
              <svg :class="isSlim ? 'w-4 h-4' : 'w-5 h-5'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
            <!-- Retry button for failed items -->
            <button
              v-if="item.status === 'error'"
              @click="downloadStore.retryDownload(item.id)"
              class="hover:bg-primary-500/20 rounded-lg transition-colors text-primary-400"
              :class="isSlim ? 'p-1' : 'p-2'"
              :title="t('downloads.retry')"
            >
              <svg :class="isSlim ? 'w-4 h-4' : 'w-5 h-5'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <!-- Retry failed tracks only (for albums/playlists with partial failures) -->
            <button
              v-if="item.status === 'error' && item.failedTracks && item.failedTracks.length > 0 && item.type !== 'track'"
              @click="downloadStore.retryFailedTracks(item.id)"
              class="hover:bg-yellow-500/20 rounded-lg transition-colors text-yellow-400 flex items-center gap-1"
              :class="isSlim ? 'p-1 text-xs' : 'p-2 text-xs'"
              :title="`Retry ${item.failedTracks.length} failed track${item.failedTracks.length > 1 ? 's' : ''}`"
            >
              <svg :class="isSlim ? 'w-3 h-3' : 'w-4 h-4'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span v-if="!isSlim">{{ item.failedTracks.length }} failed</span>
            </button>
            <!-- Download Next button for pending items -->
            <button
              v-if="item.status === 'pending'"
              @click="moveToFront(item)"
              class="hover:bg-primary-500/20 rounded-lg transition-colors text-primary-400"
              :class="isSlim ? 'p-1' : 'p-2'"
              title="Download next"
            >
              <svg :class="isSlim ? 'w-4 h-4' : 'w-5 h-5'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <!-- Delete button for completed/error items -->
            <button
              v-if="item.status === 'completed' || item.status === 'error'"
              @click="confirmDelete(item)"
              class="hover:bg-red-500/20 rounded-lg transition-colors text-red-400"
              :class="isSlim ? 'p-1' : 'p-2'"
              title="Delete"
            >
              <svg :class="isSlim ? 'w-4 h-4' : 'w-5 h-5'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <!-- Remove from list button for pending/downloading -->
            <button
              v-else
              @click="downloadStore.cancelDownload(item.id)"
              class="hover:bg-white/10 rounded-lg transition-colors"
              :class="isSlim ? 'p-1' : 'p-2'"
              title="Remove"
            >
              <svg :class="isSlim ? 'w-4 h-4' : 'w-5 h-5'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Expanded failed tracks section -->
        <div
          v-if="item.failedTracks && item.failedTracks.length > 0 && expandedItems.has(item.id)"
          class="mt-4 pt-4 border-t border-zinc-700"
        >
          <p class="text-sm font-medium text-red-400 mb-2">
            {{ t('downloads.failedTracks') }} ({{ item.failedTracks.length }}):
          </p>
          <div class="space-y-1 max-h-48 overflow-y-auto">
            <button
              v-for="failed in item.failedTracks"
              :key="failed.id"
              @click="showFailedTrackError(failed)"
              class="flex items-center gap-2 text-sm py-1.5 px-2 w-full text-left hover:bg-white/5 rounded-lg transition-colors cursor-pointer group"
            >
              <svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <span class="truncate">{{ failed.title }}</span>
              <span v-if="failed.artist" class="text-foreground-muted truncate">- {{ failed.artist }}</span>
              <span class="text-xs text-red-400 ml-auto flex-shrink-0 flex items-center gap-1 group-hover:text-red-300">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ t('downloads.viewError') }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Delete Confirmation Modal -->
    <div
      v-if="deleteConfirm"
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      @click.self="cancelDelete"
    >
      <div class="bg-background-secondary rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <h3 class="text-lg font-bold mb-2">{{ t('downloads.remove') }}</h3>
        <p class="text-foreground-muted mb-4">
          {{ t('downloads.deleteFiles') }} "{{ deleteConfirm.title }}"?
        </p>
        <div class="flex flex-col gap-2">
          <button
            @click="executeDelete(true)"
            class="btn bg-red-500 hover:bg-red-600 text-white w-full"
          >
            {{ t('downloads.deleteFiles') }}
          </button>
          <button
            @click="executeDelete(false)"
            class="btn btn-secondary w-full"
          >
            {{ t('downloads.remove') }}
          </button>
          <button
            @click="cancelDelete"
            class="btn btn-ghost w-full"
          >
            {{ t('downloads.cancel') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Error Details Modal -->
    <div
      v-if="errorDetails"
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      @click.self="closeErrorDetails"
    >
      <div class="bg-background-secondary rounded-xl p-6 max-w-xl w-full mx-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div class="flex items-start justify-between mb-4">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-red-500/20 rounded-lg">
              <svg class="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h3 class="text-lg font-bold">{{ t('downloads.errorDetails') }}</h3>
              <p class="text-sm text-foreground-muted">{{ t('downloads.downloadFailed') }}</p>
            </div>
          </div>
          <button
            @click="closeErrorDetails"
            class="p-1 hover:bg-white/10 rounded-lg transition-colors"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Track Info -->
        <div class="bg-background-tertiary rounded-lg p-4 mb-4">
          <div class="space-y-2">
            <div class="flex">
              <span class="text-foreground-muted text-sm w-16">{{ t('common.track') }}:</span>
              <span
                class="font-medium cursor-context-menu hover:text-primary-400 transition-colors"
                @contextmenu="openErrorContextMenu($event, t('contextMenu.title'), errorDetails.title)"
              >{{ errorDetails.title }}</span>
            </div>
            <div class="flex">
              <span class="text-foreground-muted text-sm w-16">{{ t('common.artist') }}:</span>
              <span
                class="cursor-context-menu hover:text-primary-400 transition-colors"
                @contextmenu="openErrorContextMenu($event, t('contextMenu.artist'), errorDetails.artist)"
              >{{ errorDetails.artist }}</span>
            </div>
            <div v-if="errorDetails.trackId" class="flex">
              <span class="text-foreground-muted text-sm w-16">ID:</span>
              <span
                class="text-xs font-mono text-foreground-muted cursor-context-menu hover:text-primary-400 transition-colors"
                @contextmenu="openErrorContextMenu($event, 'ID', errorDetails.trackId || '')"
              >{{ errorDetails.trackId }}</span>
            </div>
          </div>
        </div>

        <!-- Error Code Badge -->
        <div v-if="errorDetails.errorCode || errorDetails.httpStatus" class="flex items-center gap-2 mb-4">
          <span v-if="errorDetails.errorCode" class="px-2 py-1 text-xs font-mono bg-red-500/20 text-red-400 rounded">
            {{ errorDetails.errorCode }}
          </span>
          <span v-if="errorDetails.httpStatus" class="px-2 py-1 text-xs font-mono bg-orange-500/20 text-orange-400 rounded">
            HTTP {{ errorDetails.httpStatus }}
          </span>
          <span v-if="errorDetails.timestamp" class="text-xs text-foreground-muted ml-auto">
            {{ new Date(errorDetails.timestamp).toLocaleTimeString() }}
          </span>
        </div>

        <!-- Error Message -->
        <div class="mb-4">
          <p class="text-sm font-medium text-red-400 mb-2">{{ t('downloads.errorMessage') }}:</p>
          <div
            class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 cursor-context-menu"
            @contextmenu="openErrorContextMenu($event, t('contextMenu.error'), errorDetails.error)"
          >
            <p class="text-sm text-red-300 whitespace-pre-wrap break-words">{{ errorDetails.error }}</p>
          </div>
        </div>

        <!-- Suggestion (if available) -->
        <div v-if="errorDetails.suggestion" class="mb-4">
          <p class="text-sm font-medium text-blue-400 mb-2">{{ t('downloads.suggestion') }}:</p>
          <div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
            <p class="text-sm text-blue-300">{{ errorDetails.suggestion }}</p>
          </div>
        </div>

        <!-- Server Response (if available) -->
        <div v-if="errorDetails.serverResponse" class="mb-4">
          <details class="group">
            <summary class="text-sm font-medium text-foreground-muted mb-2 cursor-pointer hover:text-foreground-secondary">
              {{ t('downloads.serverResponse') }}
              <svg class="w-4 h-4 inline-block ml-1 transform group-open:rotate-90 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </summary>
            <div class="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3 mt-2">
              <pre class="text-xs text-zinc-400 whitespace-pre-wrap break-words font-mono max-h-32 overflow-y-auto">{{ errorDetails.serverResponse }}</pre>
            </div>
          </details>
        </div>

        <!-- Possible Causes (only show if no specific suggestion) -->
        <div v-if="!errorDetails.suggestion" class="text-sm text-foreground-muted mb-4">
          <p class="font-medium mb-2">{{ t('downloads.possibleCauses') }}:</p>
          <ul class="list-disc list-inside space-y-1 text-xs">
            <li>{{ t('downloads.causeGeoRestriction') }}</li>
            <li>{{ t('downloads.causeUnavailable') }}</li>
            <li>{{ t('downloads.causeSession') }}</li>
            <li>{{ t('downloads.causeNetwork') }}</li>
          </ul>
        </div>

        <div class="flex gap-3">
          <button
            @click="copyAllErrorDetails"
            class="btn btn-secondary flex-1 flex items-center justify-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {{ t('contextMenu.copyAll') }}
          </button>
          <button
            @click="closeErrorDetails"
            class="btn btn-primary flex-1"
          >
            {{ t('common.close') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <EmptyState
      v-else
      type="downloads"
      :title="t('downloads.noDownloads')"
      :subtitle="t('downloads.startDownloading')"
    />

    <!-- Clear All Confirmation Dialog -->
    <ConfirmDialog
      :show="showClearAllConfirm"
      title="Clear All Downloads"
      :message="`Are you sure you want to clear all ${downloadStore.downloads.length} downloads? This will remove all items from the download list but will not delete downloaded files.`"
      confirm-text="Clear All"
      cancel-text="Cancel"
      confirm-style="danger"
      @confirm="executeClearAll"
      @cancel="showClearAllConfirm = false"
    />

    <!-- Clear Completed Confirmation Dialog -->
    <ConfirmDialog
      :show="showClearCompletedConfirm"
      title="Clear Completed Downloads"
      :message="`Are you sure you want to clear ${downloadStore.completedDownloads.length} completed downloads? This will remove them from the download list but will not delete downloaded files.`"
      confirm-text="Clear Completed"
      cancel-text="Cancel"
      confirm-style="warning"
      @confirm="executeClearCompleted"
      @cancel="showClearCompletedConfirm = false"
    />

    <!-- Download History Toggle -->
    <div class="mt-8 border-t border-zinc-800 pt-6">
      <div class="flex items-center justify-between mb-4">
        <button
          @click="showHistory = !showHistory"
          class="flex items-center gap-2 text-sm text-foreground-muted hover:text-foreground transition-colors"
        >
          <svg class="w-4 h-4 transition-transform" :class="{ 'rotate-90': showHistory }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
          Download History ({{ downloadStore.downloadHistory.length }})
        </button>
        <button
          v-if="showHistory && downloadStore.downloadHistory.length > 0"
          @click="downloadStore.clearHistory()"
          class="text-xs text-red-400 hover:text-red-300 transition-colors"
        >
          Clear History
        </button>
      </div>

      <div v-if="showHistory" class="space-y-1">
        <div v-if="downloadStore.downloadHistory.length === 0" class="text-sm text-foreground-muted text-center py-8">
          No download history yet
        </div>
        <div
          v-for="entry in downloadStore.downloadHistory"
          :key="entry.id"
          class="flex items-center gap-3 px-3 py-2 rounded-lg bg-background-secondary/30 text-sm"
        >
          <!-- Status icon -->
          <div class="flex-shrink-0">
            <svg v-if="entry.status === 'completed'" class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <svg v-else class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <!-- Info -->
          <div class="flex-1 min-w-0">
            <p class="truncate font-medium">{{ entry.title }}</p>
            <p class="text-xs text-foreground-muted truncate">
              {{ entry.artist || 'Unknown Artist' }}
              <span v-if="entry.actualFormat"> · {{ entry.actualFormat }}</span>
              <span v-if="entry.type !== 'track'"> · {{ entry.totalTracks }} tracks<span v-if="entry.failedTracks"> ({{ entry.failedTracks }} failed)</span></span>
            </p>
          </div>
          <!-- Type badge -->
          <span class="text-xs px-2 py-0.5 rounded-full bg-background-tertiary text-foreground-muted flex-shrink-0">
            {{ entry.type }}
          </span>
          <!-- Timestamp -->
          <span class="text-xs text-foreground-muted/50 flex-shrink-0 w-20 text-right">
            {{ new Date(entry.completedAt).toLocaleDateString() }}
          </span>
        </div>
      </div>
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
