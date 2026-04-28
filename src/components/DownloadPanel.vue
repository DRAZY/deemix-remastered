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

function getProgressText(item: any): string {
  if (item.type === 'album' || item.type === 'playlist') {
    const completed = item.completedTracks || 0
    const total = item.totalTracks || 0
    return `${completed}/${total}`
  }
  return item.status === 'completed' ? '100%' : `${item.progress || 0}%`
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
  <div class="download-panel" :class="{ collapsed: isCollapsed }">
    <!-- Collapsed state - vertical tab -->
    <div v-if="isCollapsed" class="collapsed-tab" @click="toggleCollapsed">
      <button class="collapse-btn" @click.stop="toggleCollapsed">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      <span class="vertical-text">{{ t('downloadPanel.downloads') }}</span>
      <div class="download-count" v-if="allDownloads.length > 0">
        {{ allDownloads.length }}
      </div>
    </div>

    <!-- Expanded state - full panel -->
    <div v-else class="expanded-panel">
      <!-- Header -->
      <div class="panel-header">
        <button class="collapse-btn" @click="toggleCollapsed" :title="t('downloadPanel.collapse')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
        <div class="header-actions">
          <button class="action-btn" @click="openDownloadFolder" :title="t('downloadPanel.openFolder')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
          </button>
          <button class="action-btn" @click="clearFinished" :title="t('downloadPanel.clearFinished')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <button class="action-btn danger" @click="cancelAllDownloads" :title="t('downloadPanel.cancelAll')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>

      <!-- Download List -->
      <div class="download-list">
        <div v-if="!hasDownloads" class="empty-state">
          <p>{{ t('downloadPanel.noDownloads') }}</p>
        </div>
        <div
          v-for="item in allDownloads"
          :key="item.id"
          class="download-item"
          :class="[item.status, { 'clickable': item.status === 'error', 'selected': selectedFailedId === item.id }]"
          @click="handleItemClick(item)"
        >
          <!-- Album Art -->
          <div class="item-cover">
            <img
              v-if="getCoverUrl(item)"
              :src="getCoverUrl(item)"
              :alt="item.title"
              loading="lazy"
            />
            <div v-else class="cover-placeholder">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </div>
          </div>

          <!-- Info -->
          <div class="item-info">
            <div class="item-title" :title="item.title">{{ item.title }}</div>
            <div class="item-artist" :title="getArtistName(item)">{{ getArtistName(item) }}</div>
          </div>

          <!-- Progress -->
          <div class="item-progress">
            <span class="progress-text">{{ getProgressText(item) }}</span>
            <div class="status-icon" :class="item.status">
              <!-- Completed checkmark -->
              <svg v-if="item.status === 'completed'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <!-- Error X -->
              <svg v-else-if="item.status === 'error'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="15" y1="9" x2="9" y2="15"></line>
                <line x1="9" y1="9" x2="15" y2="15"></line>
              </svg>
              <!-- Downloading spinner -->
              <div v-else-if="item.status === 'downloading'" class="spinner"></div>
              <!-- Pending dot -->
              <div v-else class="pending-dot"></div>
            </div>
          </div>

          <!-- Progress bar -->
          <div class="progress-bar-container">
            <div
              class="progress-bar"
              :class="item.status"
              :style="{ width: `${item.progress || 0}%` }"
            ></div>
          </div>

          <!-- Error message and delete options for failed downloads -->
          <div v-if="item.status === 'error'" class="error-section">
            <div class="error-row">
              <div class="error-message" :title="getErrorMessage(item)">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <span>{{ getErrorMessage(item) }}</span>
              </div>
              <!-- Info button to show details (!) -->
              <button
                v-if="hasFailedDetails(item)"
                class="info-btn"
                @click="showFailedDetails(item, $event)"
                :title="t('downloadPanel.viewDetails')"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M12 8v4"></path>
                  <circle cx="12" cy="16" r="0.5" fill="currentColor"></circle>
                </svg>
              </button>
            </div>

            <!-- Delete options (shown when selected) -->
            <div v-if="selectedFailedId === item.id" class="delete-options">
              <button
                class="delete-btn remove-only"
                @click.stop="removeFromList(item.id)"
                :title="t('downloadPanel.remove')"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
                {{ t('downloadPanel.remove') }}
              </button>
              <button
                v-if="hasFiles(item)"
                class="delete-btn delete-files"
                @click.stop="removeAndDeleteFiles(item.id)"
                :title="t('downloadPanel.deleteFiles')"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                {{ t('downloadPanel.deleteFiles') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Failed Downloads Details Modal -->
    <div v-if="showFailedModal && selectedItemForDetails" class="modal-overlay" @click="closeFailedModal">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h3>{{ t('downloadPanel.errorDetails') }}</h3>
          <button class="modal-close" @click="closeFailedModal">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <!-- Item info -->
          <div class="item-details">
            <div class="detail-cover" v-if="getCoverUrl(selectedItemForDetails)">
              <img :src="getCoverUrl(selectedItemForDetails)" :alt="selectedItemForDetails.title" />
            </div>
            <div class="detail-info">
              <h4>{{ selectedItemForDetails.title }}</h4>
              <p class="detail-artist">{{ getArtistName(selectedItemForDetails) }}</p>
              <p class="detail-type">{{ selectedItemForDetails.type === 'album' ? t('analyzer.types.album') : selectedItemForDetails.type === 'playlist' ? t('analyzer.types.playlist') : t('analyzer.types.track') }}</p>
            </div>
          </div>

          <!-- Error summary for single tracks -->
          <div v-if="selectedItemForDetails.type === 'track' && selectedItemForDetails.error" class="error-details">
            <h5>{{ t('common.error') }}</h5>
            <p class="error-text">{{ selectedItemForDetails.error }}</p>
          </div>

          <!-- Failed tracks list for albums/playlists -->
          <div v-if="selectedItemForDetails.failedTracks && selectedItemForDetails.failedTracks.length > 0" class="failed-tracks-section">
            <h5>{{ t('downloadPanel.failedTracks') }} ({{ selectedItemForDetails.failedTracks.length }})</h5>
            <div class="failed-tracks-list">
              <div v-for="track in selectedItemForDetails.failedTracks" :key="track.id" class="failed-track-item">
                <div class="failed-track-line">
                  <span class="failed-track-id">{{ track.trackId || track.id }}</span>
                  <span class="failed-track-separator">|</span>
                  <span class="failed-track-name">{{ track.artist ? `${track.artist} - ${track.title}` : track.title }}</span>
                  <span class="failed-track-separator">|</span>
                  <span class="failed-track-error">{{ track.error || 'Unknown error' }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Folder path if available -->
          <div v-if="selectedItemForDetails.path" class="folder-path-section">
            <h5>{{ t('downloadPanel.downloadLocation') }}</h5>
            <div class="folder-path">
              <span class="path-text">{{ selectedItemForDetails.path }}</span>
              <button class="open-folder-btn" @click="openItemFolder(selectedItemForDetails)" :title="t('downloadPanel.openFolderBtn')">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.download-panel {
  background-color: rgb(var(--bg-secondary));
  border-left: 1px solid rgb(var(--bg-tertiary));
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease;
  height: 100%;
}

.download-panel:not(.collapsed) {
  width: 320px;
  min-width: 320px;
}

.download-panel.collapsed {
  width: 32px;
  min-width: 32px;
}

/* Collapsed tab */
.collapsed-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  height: 100%;
  cursor: pointer;
}

.collapsed-tab:hover {
  background-color: rgb(var(--bg-tertiary));
}

.vertical-text {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  transform: rotate(180deg);
  font-size: 12px;
  font-weight: 500;
  color: rgb(var(--fg-muted));
  margin-top: 12px;
  letter-spacing: 1px;
}

.download-count {
  margin-top: auto;
  margin-bottom: 8px;
  background-color: rgb(var(--primary-500));
  color: white;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

/* Expanded panel */
.expanded-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid rgb(var(--bg-tertiary));
  background-color: rgb(var(--bg-main));
}

.collapse-btn {
  background: none;
  border: none;
  color: rgb(var(--fg-muted));
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.collapse-btn:hover {
  color: rgb(var(--fg-default));
  background-color: rgb(var(--bg-tertiary));
}

.header-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  background: none;
  border: none;
  color: rgb(var(--fg-muted));
  cursor: pointer;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.action-btn:hover {
  color: rgb(var(--fg-default));
  background-color: rgb(var(--bg-tertiary));
}

.action-btn.danger:hover {
  color: #ef4444;
}

/* Download list */
.download-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: rgb(var(--fg-muted));
  font-size: 14px;
}

.download-item {
  display: grid;
  grid-template-columns: 48px 1fr auto;
  grid-template-rows: auto auto auto;
  gap: 0 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgb(var(--bg-tertiary));
  transition: background-color 0.15s ease;
}

.download-item:hover {
  background-color: rgb(var(--bg-tertiary));
}

.download-item.clickable {
  cursor: pointer;
}

.download-item.clickable:hover {
  background-color: rgba(239, 68, 68, 0.1);
}

.download-item.selected {
  background-color: rgba(239, 68, 68, 0.15);
  border-left: 3px solid #ef4444;
  padding-left: 9px;
}

.item-cover {
  grid-row: 1 / 4;
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  background-color: rgb(var(--bg-main));
}

.item-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgb(var(--fg-muted));
}

.item-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding-right: 8px;
}

.item-title {
  font-size: 13px;
  font-weight: 500;
  color: rgb(var(--fg-default));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.item-artist {
  font-size: 11px;
  color: rgb(var(--fg-muted));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.item-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-self: end;
}

.progress-text {
  font-size: 11px;
  color: rgb(var(--fg-muted));
  font-variant-numeric: tabular-nums;
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
}

.status-icon.completed {
  color: #22c55e;
}

.status-icon.error {
  color: #ef4444;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgb(var(--fg-muted));
  border-top-color: #22c55e; /* Green to match completed state */
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.pending-dot {
  width: 8px;
  height: 8px;
  background-color: rgb(var(--fg-muted));
  border-radius: 50%;
}

.progress-bar-container {
  grid-column: 2 / 4;
  height: 3px;
  background-color: rgb(var(--bg-main));
  border-radius: 2px;
  margin-top: 4px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background-color: #22c55e; /* Green for active downloads */
  border-radius: 2px;
  transition: width 0.3s ease;
}

.progress-bar.completed {
  background-color: #22c55e; /* Green for completed */
}

.progress-bar.error {
  background-color: #ef4444;
}

/* Scrollbar styling */
.download-list::-webkit-scrollbar {
  width: 6px;
}

.download-list::-webkit-scrollbar-track {
  background: transparent;
}

.download-list::-webkit-scrollbar-thumb {
  background-color: rgb(var(--bg-tertiary));
  border-radius: 3px;
}

.download-list::-webkit-scrollbar-thumb:hover {
  background-color: rgb(var(--fg-muted));
}

/* Error section styles */
.error-section {
  grid-column: 2 / 4;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.error-message {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #ef4444;
  font-size: 11px;
  line-height: 1.3;
  padding: 4px 8px;
  background-color: rgba(239, 68, 68, 0.1);
  border-radius: 4px;
}

.error-message svg {
  flex-shrink: 0;
}

.error-message span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delete-options {
  display: flex;
  gap: 8px;
  animation: slideDown 0.15s ease;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.delete-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 500;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.delete-btn.remove-only {
  background-color: rgb(var(--bg-main));
  color: rgb(var(--fg-muted));
}

.delete-btn.remove-only:hover {
  background-color: rgb(var(--bg-tertiary));
  color: rgb(var(--fg-default));
}

.delete-btn.delete-files {
  background-color: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.delete-btn.delete-files:hover {
  background-color: #ef4444;
  color: white;
}

.delete-btn svg {
  flex-shrink: 0;
}

/* Error row with info button */
.error-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.error-row .error-message {
  flex: 1;
}

.info-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: rgba(59, 130, 246, 0.2);
  border: none;
  border-radius: 50%;
  color: #3b82f6;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}

.info-btn:hover {
  background: #3b82f6;
  color: white;
}

/* Modal styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-content {
  background: rgb(var(--bg-secondary));
  border-radius: 12px;
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
  from {
    opacity: 0;
    transform: scale(0.95) translateY(-10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgb(var(--bg-tertiary));
}

.modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: rgb(var(--fg-default));
}

.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 6px;
  color: rgb(var(--fg-muted));
  cursor: pointer;
  transition: all 0.15s ease;
}

.modal-close:hover {
  background: rgb(var(--bg-tertiary));
  color: rgb(var(--fg-default));
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Item details */
.item-details {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.detail-cover {
  width: 80px;
  height: 80px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  background: rgb(var(--bg-main));
}

.detail-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.detail-info {
  flex: 1;
  min-width: 0;
}

.detail-info h4 {
  margin: 0 0 4px 0;
  font-size: 16px;
  font-weight: 600;
  color: rgb(var(--fg-default));
  line-height: 1.3;
}

.detail-artist {
  margin: 0 0 4px 0;
  font-size: 14px;
  color: rgb(var(--fg-muted));
}

.detail-type {
  margin: 0;
  font-size: 12px;
  color: rgb(var(--fg-muted));
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Error details */
.error-details h5,
.failed-tracks-section h5,
.folder-path-section h5 {
  margin: 0 0 8px 0;
  font-size: 12px;
  font-weight: 600;
  color: rgb(var(--fg-muted));
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.error-text {
  margin: 0;
  padding: 12px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 6px;
  color: #ef4444;
  font-size: 13px;
  line-height: 1.5;
}

/* Failed tracks list */
.failed-tracks-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
  font-size: 11px;
  background: rgb(var(--bg-main));
  border-radius: 6px;
  padding: 8px;
}

.failed-track-item {
  padding: 8px 10px;
  background: rgba(239, 68, 68, 0.05);
  border-radius: 4px;
  border-left: 2px solid #ef4444;
}

.failed-track-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  line-height: 1.6;
}

.failed-track-id {
  color: rgb(var(--fg-muted));
  font-weight: 500;
  flex-shrink: 0;
}

.failed-track-separator {
  color: rgb(var(--fg-muted) / 0.6);
  flex-shrink: 0;
}

.failed-track-name {
  color: rgb(var(--fg-default));
  font-weight: 500;
}

.failed-track-error {
  color: #ef4444;
  word-break: break-word;
}

/* Folder path */
.folder-path {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgb(var(--bg-main));
  border-radius: 6px;
}

.path-text {
  flex: 1;
  font-size: 12px;
  color: rgb(var(--fg-muted));
  font-family: monospace;
  word-break: break-all;
}

.open-folder-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: rgb(var(--bg-tertiary));
  border: none;
  border-radius: 4px;
  color: rgb(var(--fg-muted));
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}

.open-folder-btn:hover {
  background: rgb(var(--primary-500));
  color: white;
}
</style>
