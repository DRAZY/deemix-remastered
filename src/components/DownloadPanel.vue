<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDownloadStore } from '../stores/downloadStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { DownloadItem } from '../types'

const { t } = useI18n()

const downloadStore = useDownloadStore()
const settingsStore = useSettingsStore()

const isCollapsed = ref(false)
const selectedFailedId = ref<string | null>(null)
const showFailedModal = ref(false)
const selectedItemForDetails = ref<DownloadItem | null>(null)

const allDownloads = computed(() => downloadStore.downloads)
const hasDownloads = computed(() => downloadStore.downloads.length > 0)

// Rack header counters
const liveCount = computed(() => allDownloads.value.filter(d => d.status === 'downloading').length)
const storedCount = computed(() => allDownloads.value.filter(d => d.status === 'completed').length)

// Hardware status vocabulary — design constants, not user-facing prose
// (tooltips and messages stay i18n).
const STAT_WORD: Record<string, string> = {
  downloading: 'RECV',
  pending: 'QUEUE',
  completed: 'STORED',
  error: 'FAULT',
  paused: 'HOLD'
}

const VU_SEGMENTS = 16
const AGG_SEGMENTS = 18

// Per-unit VU meter: filled segments follow progress; the leading edge burns
// amber while receiving; stored units read back solid cyan; faults show the
// filled extent in red.
function vuSegments(item: DownloadItem): string[] {
  const segs: string[] = new Array(VU_SEGMENTS).fill('')
  if (item.status === 'completed') return segs.fill('fc')
  const filled = Math.min(VU_SEGMENTS, Math.round(((item.progress || 0) / 100) * VU_SEGMENTS))
  for (let i = 0; i < filled; i++) segs[i] = item.status === 'error' ? 'fe' : 'f'
  if (item.status === 'downloading' && filled > 0 && filled < VU_SEGMENTS) segs[filled - 1] = 'fa'
  return segs
}

// Aggregate meter in the totals strip — average progress across live units.
const aggregateSegments = computed(() => {
  const active = downloadStore.activeDownloads
  const segs: string[] = new Array(AGG_SEGMENTS).fill('')
  if (active.length === 0) return segs
  const avg = active.reduce((sum, d) => sum + (d.progress || 0), 0) / active.length
  const filled = Math.min(AGG_SEGMENTS, Math.round((avg / 100) * AGG_SEGMENTS))
  for (let i = 0; i < filled; i++) segs[i] = 'f'
  if (filled > 0 && filled < AGG_SEGMENTS) segs[filled - 1] = 'fa'
  return segs
})

const aggregateRate = computed(() => formatSpeed(downloadStore.totalDownloadSpeed))

function formatSpeed(bps?: number): string {
  if (!bps) return ''
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/S`
  return `${(bps / 1024).toFixed(0)} KB/S`
}

function formatMB(bytes: number): string {
  return (bytes / 1048576).toFixed(1)
}

// Second line of a unit: artist, live telemetry while receiving, and how many
// tracks were fulfilled from alternate releases (drill-down list lives in the
// Downloads view badge).
function getUnitSub(item: DownloadItem): string {
  const parts = [getArtistName(item)]
  if (item.status === 'downloading' && item.speed) parts.push(formatSpeed(item.speed))
  if (item.substitutedTracks?.length) parts.push(`${item.substitutedTracks.length} ALT`)
  return parts.join(' · ')
}

// Unit footer left cell: track fraction for sets, byte telemetry for singles.
function getUnitDetail(item: DownloadItem): string {
  if (item.type === 'album' || item.type === 'playlist') {
    return `${item.completedTracks || 0}/${item.totalTracks || 0} TRK`
  }
  if (item.totalBytes) {
    return `${formatMB(item.bytesDownloaded || 0)} / ${formatMB(item.totalBytes)} MB`
  }
  const q = item.quality
  return q === 'flac' ? 'FLAC' : q ? `MP3 ${q}` : 'TRACK'
}

function getUnitPercent(item: DownloadItem): string {
  if (item.status === 'completed') return '100%'
  if (item.status === 'pending') return '—'
  return `${item.progress || 0}%`
}

function toggleCollapsed() {
  isCollapsed.value = !isCollapsed.value
}

async function openDownloadFolder() {
  if (window.electronAPI && settingsStore.settings.downloadPath) {
    await window.electronAPI.openPath(settingsStore.settings.downloadPath)
  }
}

function clearFinished() {
  downloadStore.clearCompleted()
}

function cancelAllDownloads() {
  downloadStore.clearAll()
}

// Safely extract artist name (handles both string and object)
function getArtistName(item: any): string {
  if (!item.artist) return t('common.unknownArtist')
  if (typeof item.artist === 'string') return item.artist
  if (typeof item.artist === 'object' && item.artist.name) return item.artist.name
  return t('common.unknownArtist')
}

// Safely extract cover URL
function getCoverUrl(item: any): string | undefined {
  if (!item.cover) return undefined
  if (typeof item.cover === 'string') return item.cover
  return undefined
}

// Handle click on a failed download item
function handleItemClick(item: DownloadItem) {
  if (item.status === 'error') {
    // Toggle selection for failed items
    selectedFailedId.value = selectedFailedId.value === item.id ? null : item.id
  }
}

// Remove from list only (keep files if any)
function removeFromList(id: string) {
  downloadStore.deleteDownload(id, false)
  selectedFailedId.value = null
}

// Remove from list and delete files
async function removeAndDeleteFiles(id: string) {
  await downloadStore.deleteDownload(id, true)
  selectedFailedId.value = null
}

// Get error message for display
function getErrorMessage(item: DownloadItem): string {
  if (item.error) return item.error
  if (item.failedTracks && item.failedTracks.length > 0) {
    return t('downloadPanel.tracksFailed', { count: item.failedTracks.length })
  }
  return t('errors.downloadFailed')
}

// Check if item has downloadable files (path exists)
function hasFiles(item: DownloadItem): boolean {
  return !!item.path
}

// Show details modal for failed downloads
function showFailedDetails(item: DownloadItem, event: Event) {
  event.stopPropagation()
  selectedItemForDetails.value = item
  showFailedModal.value = true
}

// Close the failed details modal
function closeFailedModal() {
  showFailedModal.value = false
  selectedItemForDetails.value = null
}

// Check if item has failed tracks with details to show
function hasFailedDetails(item: DownloadItem): boolean {
  return item.status === 'error' && (
    !!item.error ||
    !!(item.failedTracks && item.failedTracks.length > 0)
  )
}

// Open folder containing the downloaded files
async function openItemFolder(item: DownloadItem) {
  if (item.path && window.electronAPI) {
    await window.electronAPI.openPath(item.path)
  }
}
</script>

<template>
  <div
    class="flex flex-col h-full bg-background-secondary border-l border-white/[0.06] select-none"
    :class="isCollapsed ? 'w-8 min-w-8' : 'w-80 min-w-80'"
  >
    <!-- Collapsed state - vertical tab -->
    <div
      v-if="isCollapsed"
      class="flex flex-col items-center py-2 h-full cursor-pointer hover:bg-background-tertiary transition-colors"
      @click="toggleCollapsed"
    >
      <button
        class="p-1 text-foreground-muted hover:text-foreground transition-colors"
        @click.stop="toggleCollapsed"
        :title="t('downloadPanel.downloads')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
      <span class="vertical-label font-mono text-[9.5px] tracking-[0.24em] text-foreground-muted mt-3 uppercase">
        {{ t('downloadPanel.downloads') }}
      </span>
      <div
        v-if="allDownloads.length > 0"
        class="mt-auto mb-2 font-mono text-[10px] font-bold bg-primary-500 text-background-main px-1.5 py-0.5 rounded-sm min-w-[18px] text-center"
      >
        {{ allDownloads.length }}
      </div>
    </div>

    <!-- Expanded state - the Transfer Rack -->
    <div v-else class="flex flex-col h-full overflow-hidden">
      <!-- Rack header -->
      <div class="border-b border-white/[0.06]">
        <div class="flex items-center gap-2 px-3 pt-3 pb-2">
          <button
            class="p-1 -ml-1 text-foreground-muted hover:text-foreground transition-colors"
            @click="toggleCollapsed"
            :title="t('downloadPanel.collapse')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
          <h4 class="font-display text-[12px] uppercase tracking-[0.08em] text-foreground">Transfer Rack</h4>
          <span class="ml-auto font-mono text-[9.5px] tracking-[0.12em] text-foreground-muted">
            {{ liveCount }} LIVE · {{ storedCount }} STORED
          </span>
        </div>
        <div class="flex items-center gap-1.5 px-3 pb-2">
          <button class="rack-btn" @click="openDownloadFolder" :title="t('downloadPanel.openFolder')">FOLDER</button>
          <button class="rack-btn" @click="clearFinished" :title="t('downloadPanel.clearFinished')">CLEAR</button>
          <button class="rack-btn rack-btn-danger" @click="cancelAllDownloads" :title="t('downloadPanel.cancelAll')">ABORT</button>
        </div>
      </div>

      <!-- Units -->
      <div class="flex-1 overflow-y-auto overflow-x-hidden p-3 rack-scroll">
        <div v-if="!hasDownloads" class="flex flex-col items-center justify-center h-full gap-2">
          <span class="font-mono text-[10px] tracking-[0.24em] text-foreground-muted">NO SIGNAL</span>
          <p class="text-[12px] text-foreground-muted">{{ t('downloadPanel.noDownloads') }}</p>
        </div>

        <div
          v-for="item in allDownloads"
          :key="item.id"
          class="unit"
          :class="[`unit-${item.status}`, { 'cursor-pointer': item.status === 'error', 'unit-selected': selectedFailedId === item.id }]"
          @click="handleItemClick(item)"
        >
          <div class="flex justify-between items-baseline gap-2.5">
            <span class="text-[12px] font-semibold text-foreground whitespace-nowrap overflow-hidden text-ellipsis" v-tooltip.overflow="item.title">
              <span
                v-if="item.source === 'qobuz'"
                class="mr-1 px-1 py-px font-mono text-[8.5px] font-bold tracking-[0.08em] border border-qobuz-500/50 text-qobuz-400 bg-qobuz-500/10 align-middle"
              >Q</span><span
                v-else-if="item.source === 'deezer'"
                class="mr-1 px-1 py-px font-mono text-[8.5px] font-bold tracking-[0.08em] border border-deezer-500/50 text-deezer-400 bg-deezer-500/10 align-middle"
              >D</span>{{ item.title }}
            </span>
            <span class="u-stat font-mono text-[9.5px] tracking-[0.1em] flex-shrink-0">
              {{ STAT_WORD[item.status] || item.status.toUpperCase() }}
            </span>
          </div>
          <div class="font-mono text-[11.5px] text-foreground-muted mt-1 whitespace-nowrap overflow-hidden text-ellipsis" :title="getUnitSub(item)">
            {{ getUnitSub(item) }}
          </div>

          <!-- VU meter -->
          <div class="vu" aria-hidden="true">
            <i v-for="(seg, idx) in vuSegments(item)" :key="idx" :class="seg"></i>
          </div>

          <div class="flex justify-between font-mono text-[11px] text-foreground-muted mt-2">
            <span>{{ getUnitDetail(item) }}</span>
            <b class="font-medium text-foreground/70">{{ getUnitPercent(item) }}</b>
          </div>

          <!-- Fault readout + purge controls -->
          <div v-if="item.status === 'error'" class="mt-2 flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <div class="flex-1 flex items-center gap-1.5 font-mono text-[9.5px] text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-1 overflow-hidden" :title="getErrorMessage(item)">
                <svg class="flex-shrink-0" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <span class="overflow-hidden text-ellipsis whitespace-nowrap">{{ getErrorMessage(item) }}</span>
              </div>
              <button
                v-if="hasFailedDetails(item)"
                class="rack-btn flex-shrink-0"
                @click="showFailedDetails(item, $event)"
                :title="t('downloadPanel.viewDetails')"
              >LOG</button>
            </div>
            <div v-if="selectedFailedId === item.id" class="flex gap-1.5 delete-options">
              <button class="rack-btn" @click.stop="removeFromList(item.id)" :title="t('downloadPanel.remove')">
                {{ t('downloadPanel.remove') }}
              </button>
              <button
                v-if="hasFiles(item)"
                class="rack-btn rack-btn-danger"
                @click.stop="removeAndDeleteFiles(item.id)"
                :title="t('downloadPanel.deleteFiles')"
              >
                {{ t('downloadPanel.deleteFiles') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Totals strip -->
      <div v-if="liveCount > 0" class="border-t border-white/[0.06] px-4 py-3 bg-background-main/60">
        <div class="flex justify-between font-mono text-[10px] tracking-[0.08em] text-foreground-muted mb-1.5">
          <span>AGGREGATE RATE</span>
          <b class="text-primary-500 font-medium">{{ aggregateRate || '—' }}</b>
        </div>
        <div class="bigmeter" aria-hidden="true">
          <i v-for="(seg, idx) in aggregateSegments" :key="idx" :class="seg"></i>
        </div>
      </div>
    </div>

    <!-- Failed Downloads Details Modal -->
    <div v-if="showFailedModal && selectedItemForDetails" class="modal-overlay" @click="closeFailedModal">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h3 class="font-display text-[13px] uppercase tracking-[0.08em]">{{ t('downloadPanel.errorDetails') }}</h3>
          <button class="modal-close" @click="closeFailedModal">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <!-- Item info -->
          <div class="flex gap-4 items-start">
            <div v-if="getCoverUrl(selectedItemForDetails)" class="w-20 h-20 overflow-hidden flex-shrink-0 bg-background-main border border-white/[0.08]">
              <img class="w-full h-full object-cover" :src="getCoverUrl(selectedItemForDetails)" :alt="selectedItemForDetails.title" />
            </div>
            <div class="flex-1 min-w-0">
              <h4 class="m-0 mb-1 text-[15px] font-semibold text-foreground leading-tight">{{ selectedItemForDetails.title }}</h4>
              <p class="m-0 mb-1 text-[13px] text-foreground-muted">{{ getArtistName(selectedItemForDetails) }}</p>
              <p class="m-0 font-mono text-[10px] uppercase tracking-[0.12em] text-foreground-muted">
                {{ (selectedItemForDetails.type === 'playlist' || selectedItemForDetails.album?.qobuzType === 'playlist') ? t('analyzer.types.playlist') : selectedItemForDetails.type === 'album' ? t('analyzer.types.album') : t('analyzer.types.track') }}
              </p>
            </div>
          </div>

          <!-- Error summary for single tracks -->
          <div v-if="selectedItemForDetails.type === 'track' && selectedItemForDetails.error">
            <h5 class="section-label">{{ t('common.error') }}</h5>
            <p class="m-0 p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-[12.5px] leading-relaxed font-mono">{{ selectedItemForDetails.error }}</p>
          </div>

          <!-- Failed tracks list for albums/playlists -->
          <div v-if="selectedItemForDetails.failedTracks && selectedItemForDetails.failedTracks.length > 0">
            <h5 class="section-label">{{ t('downloadPanel.failedTracks') }} ({{ selectedItemForDetails.failedTracks.length }})</h5>
            <div class="flex flex-col gap-1 max-h-[300px] overflow-y-auto font-mono text-[11px] bg-background-main border border-white/[0.06] p-2 rack-scroll">
              <div v-for="track in selectedItemForDetails.failedTracks" :key="track.id" class="px-2.5 py-2 bg-red-500/5 border-l-2 border-red-500">
                <div class="flex flex-wrap items-baseline gap-1 leading-relaxed">
                  <span class="text-foreground-muted font-medium flex-shrink-0">{{ track.trackId || track.id }}</span>
                  <span class="text-foreground-muted flex-shrink-0">|</span>
                  <span class="text-foreground font-medium">{{ track.artist ? `${track.artist} - ${track.title}` : track.title }}</span>
                  <span class="text-foreground-muted flex-shrink-0">|</span>
                  <span class="text-red-400 break-words">{{ track.error || t('common.unknownError') }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Folder path if available -->
          <div v-if="selectedItemForDetails.path">
            <h5 class="section-label">{{ t('downloadPanel.downloadLocation') }}</h5>
            <div class="flex items-center gap-2 px-3 py-2.5 bg-background-main border border-white/[0.06]">
              <span class="flex-1 font-mono text-[11px] text-foreground-muted break-all">{{ selectedItemForDetails.path }}</span>
              <button
                class="rack-btn flex-shrink-0"
                @click="openItemFolder(selectedItemForDetails)"
                :title="t('downloadPanel.openFolderBtn')"
              >OPEN</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vertical-label {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  transform: rotate(180deg);
}

/* Rack action buttons — flat mono hardware labels */
.rack-btn {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 9.5px;
  letter-spacing: 0.12em;
  padding: 4px 8px;
  color: rgb(var(--fg-muted));
  background: rgb(var(--bg-main) / 0.6);
  border: 1px solid rgb(255 255 255 / 0.08);
  transition: color 0.15s ease, border-color 0.15s ease;
}
.rack-btn:hover {
  color: rgb(var(--primary-500));
  border-color: rgb(var(--primary-500) / 0.5);
}
.rack-btn-danger:hover {
  color: #f87171;
  border-color: rgb(248 113 113 / 0.5);
}

/* Rack unit — status-coded edge light via ::before */
.unit {
  position: relative;
  border: 1px solid rgb(255 255 255 / 0.07);
  background: rgb(var(--bg-tertiary) / 0.5);
  padding: 10px 12px 9px;
  margin-bottom: 10px;
}
.unit::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgb(var(--fg-muted) / 0.5);
}
.unit-downloading::before {
  background: rgb(var(--primary-500));
  box-shadow: 0 0 10px rgb(var(--primary-500) / 0.5);
}
.unit-completed::before {
  background: #22c55e;
}
.unit-error::before {
  background: #ef4444;
  box-shadow: 0 0 10px rgb(239 68 68 / 0.4);
}
.unit-paused::before {
  background: #ffb454;
}
.unit-error:hover {
  background: rgb(239 68 68 / 0.08);
}
.unit-selected {
  background: rgb(239 68 68 / 0.12);
}

/* Status word color per state */
.u-stat { color: rgb(var(--fg-muted)); }
.unit-downloading .u-stat { color: rgb(var(--primary-500)); }
.unit-completed .u-stat { color: #22c55e; }
.unit-error .u-stat { color: #ef4444; }
.unit-paused .u-stat { color: #ffb454; }

/* Segmented VU meter */
.vu {
  display: flex;
  gap: 3px;
  margin-top: 9px;
  height: 12px;
}
.vu i {
  flex: 1;
  background: rgb(var(--bg-main) / 0.8);
  border: 1px solid rgb(255 255 255 / 0.06);
}
.vu i.f {
  background: rgb(var(--primary-500));
  border-color: rgb(var(--primary-600));
  box-shadow: 0 0 6px rgb(var(--primary-500) / 0.4);
}
.vu i.fa {
  background: #ffb454;
  border-color: #a06a20;
  box-shadow: 0 0 6px rgb(255 180 84 / 0.4);
}
.vu i.fc {
  background: #22c55e;
  border-color: #15803d;
}
.vu i.fe {
  background: #ef4444;
  border-color: #991b1b;
}

/* Aggregate meter in the totals strip */
.bigmeter {
  display: flex;
  gap: 3px;
  height: 14px;
}
.bigmeter i {
  flex: 1;
  background: rgb(var(--bg-tertiary) / 0.7);
  border: 1px solid rgb(255 255 255 / 0.06);
}
.bigmeter i.f {
  background: rgb(var(--primary-500));
  border-color: rgb(var(--primary-600));
  box-shadow: 0 0 8px rgb(var(--primary-500) / 0.45);
}
.bigmeter i.fa {
  background: #ffb454;
  border-color: #a06a20;
}

.delete-options {
  animation: slideDown 0.15s ease;
}
@keyframes slideDown {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .delete-options { animation: none; }
}

/* Scrollbar — always visible and grabbable. The thumb used to be
   --bg-tertiary, which is indistinguishable from the Signal background, so a
   400-unit rack looked unscrollable except by mouse wheel. */
.rack-scroll {
  scrollbar-gutter: stable;
}
.rack-scroll::-webkit-scrollbar { width: 10px; }
.rack-scroll::-webkit-scrollbar-track {
  background: rgb(255 255 255 / 0.04);
}
.rack-scroll::-webkit-scrollbar-thumb {
  background-color: rgb(var(--fg-muted) / 0.4);
  border: 2px solid transparent;
  background-clip: padding-box;
}
.rack-scroll::-webkit-scrollbar-thumb:hover,
.rack-scroll::-webkit-scrollbar-thumb:active {
  background-color: rgb(var(--primary-500) / 0.7);
}

/* Fault details modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}
.modal-content {
  background: rgb(var(--bg-secondary));
  border: 1px solid rgb(255 255 255 / 0.1);
  width: 100%;
  max-width: 500px;
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  animation: modalSlideIn 0.2s ease;
}
@keyframes modalSlideIn {
  from { opacity: 0; transform: scale(0.97) translateY(-8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .modal-content { animation: none; }
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid rgb(255 255 255 / 0.06);
}
.modal-header h3 {
  margin: 0;
  color: rgb(var(--fg-default));
}
.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background: none;
  border: none;
  color: rgb(var(--fg-muted));
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.modal-close:hover {
  background: rgb(var(--bg-tertiary));
  color: rgb(var(--fg-default));
}
.modal-body {
  padding: 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.section-label {
  margin: 0 0 8px 0;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 9.5px;
  font-weight: 500;
  color: rgb(var(--fg-muted));
  text-transform: uppercase;
  letter-spacing: 0.24em;
}
</style>
