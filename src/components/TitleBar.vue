<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/authStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useDownloadStore } from '../stores/downloadStore'

const { t } = useI18n()
const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const downloadStore = useDownloadStore()
const isMaximized = ref(false)

// Detect platform - check multiple sources for reliability
const detectPlatform = (): boolean => {
  // Check navigator.platform
  const navPlatform = navigator.platform?.toLowerCase() || ''
  if (navPlatform.includes('mac')) return true

  // Check userAgent as fallback
  const userAgent = navigator.userAgent?.toLowerCase() || ''
  if (userAgent.includes('macintosh') || userAgent.includes('mac os')) return true

  return false
}

const isMac = detectPlatform()

// On Linux the window is natively framed (#125, for WM snapping), so the OS
// draws the title bar and window buttons — hide our custom ones to avoid a
// duplicate set. The status bar itself stays.
const detectLinux = (): boolean => {
  const nav = navigator.platform?.toLowerCase() || ''
  const ua = navigator.userAgent?.toLowerCase() || ''
  return (nav.includes('linux') || ua.includes('linux')) && !ua.includes('android')
}
const isLinux = detectLinux()

// Live clock cell
const clock = ref('')
let clockTimer: ReturnType<typeof setInterval> | undefined
function tick() {
  clock.value = new Date().toLocaleTimeString(undefined, { hour12: false })
}

const qualityLabel = computed(() => {
  const q = settingsStore.settings.quality
  if (q === 'flac') return 'FLAC/1411'
  if (q === '320') return 'MP3/320'
  return 'MP3/128'
})

const region = computed(() => authStore.user?.country || '')

const throughput = computed(() => {
  const bps = downloadStore.totalDownloadSpeed
  if (!bps || downloadStore.activeDownloads.length === 0) return ''
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/S`
  return `${(bps / 1024).toFixed(0)} KB/S`
})

onMounted(async () => {
  tick()
  clockTimer = setInterval(tick, 1000)
  if (window.electronAPI) {
    try {
      isMaximized.value = await window.electronAPI.isMaximized()
      window.electronAPI.onMaximizeChange((maximized) => {
        isMaximized.value = maximized
      })
    } catch (error) {
      console.error('Failed to get window state:', error)
    }
  }
})

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer)
})

const minimize = () => window.electronAPI?.minimize()
const maximize = () => window.electronAPI?.maximize()
const close = () => window.electronAPI?.close()
</script>

<template>
  <div
    class="h-10 flex items-center bg-background-secondary border-b border-white/[0.06] drag-region select-none"
    :class="{ 'pl-20': isMac }"
  >
    <!-- Brand -->
    <div class="flex items-center h-full px-4 border-r border-white/[0.06]">
      <span class="font-display text-[13px] tracking-wide text-foreground">DEEMIX<span class="text-primary-500">▮</span>RMSTD</span>
    </div>

    <!-- Link status -->
    <div class="hidden sm:flex items-center gap-2 h-full px-4 border-r border-white/[0.06] font-mono text-[10.5px] tracking-[0.08em] text-foreground-muted">
      <span
        class="w-[7px] h-[7px] rounded-[1px] status-led"
        :class="authStore.isLoggedIn
          ? 'bg-primary-500 shadow-[0_0_8px] shadow-primary-500/70'
          : 'bg-red-500 shadow-[0_0_8px] shadow-red-500/70'"
      ></span>
      {{ authStore.isLoggedIn ? 'LINK ESTABLISHED' : 'LINK DOWN' }}
    </div>

    <!-- Channel Q link status — permanent readout so a missing/dead Qobuz
         link is as visible as a live one: lit cyan LED when linked, dark LED
         + Q:OFFLINE when disconnected or the session expired -->
    <div
      class="hidden sm:flex items-center gap-2 h-full px-4 border-r border-white/[0.06] font-mono text-[10.5px] tracking-[0.08em]"
      :class="settingsStore.isQobuzLinked ? 'text-foreground-muted' : 'text-foreground-muted'"
      v-tooltip="settingsStore.isQobuzLinked ? t('titleBar.qobuzLinkedTip') : t('titleBar.qobuzOfflineTip')"
    >
      <span
        class="w-[7px] h-[7px] rounded-[1px] status-led"
        :class="settingsStore.isQobuzLinked
          ? 'bg-qobuz-500 shadow-[0_0_8px] shadow-qobuz-500/70'
          : 'bg-white/[0.12]'"
      ></span>
      {{ settingsStore.isQobuzLinked ? 'Q:LINKED' : 'Q:OFFLINE' }}
    </div>

    <!-- Region -->
    <div v-if="region" class="hidden md:flex items-center h-full px-4 border-r border-white/[0.06] font-mono text-[10.5px] tracking-[0.08em] text-foreground-muted">
      {{ t('titleBar.region') }} · {{ region }}
    </div>

    <!-- Quality -->
    <div class="hidden md:flex items-center h-full px-4 border-r border-white/[0.06] font-mono text-[10.5px] tracking-[0.08em] text-foreground-muted">
      {{ t('titleBar.quality') }} · {{ qualityLabel }}
    </div>

    <!-- Live throughput (only while downloading) -->
    <div v-if="throughput" class="hidden sm:flex items-center h-full px-4 border-r border-white/[0.06] font-mono text-[10.5px] tracking-[0.08em] text-primary-500">
      RECV · {{ throughput }}
    </div>

    <!-- Flexible drag space -->
    <div class="flex-1 h-full"></div>

    <!-- Clock -->
    <div class="hidden sm:flex items-center h-full px-4 font-mono text-[10.5px] tracking-[0.08em] text-foreground">
      {{ clock }}
    </div>

    <!-- Window controls (Windows only — Mac shows native traffic lights, Linux
         is natively framed for WM snapping so the OS draws these). -->
    <div v-if="!isMac && !isLinux" class="flex items-center h-full no-drag" role="group" :aria-label="t('accessibility.windowControls')">
      <button
        @click="minimize"
        :aria-label="t('accessibility.minimizeWindow')"
        class="w-12 h-full flex items-center justify-center hover:bg-white/10 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
        </svg>
      </button>
      <button
        @click="maximize"
        :aria-label="t('accessibility.maximizeWindow')"
        class="w-12 h-full flex items-center justify-center hover:bg-white/10 transition-colors"
      >
        <svg v-if="!isMaximized" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="1" stroke-width="2" />
        </svg>
        <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="1" stroke-width="2" />
          <path stroke-width="2" d="M8 6V5a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1h-1" />
        </svg>
      </button>
      <button
        @click="close"
        :aria-label="t('accessibility.closeWindow')"
        class="w-12 h-full flex items-center justify-center hover:bg-red-500 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.status-led {
  animation: led-blink 3s steps(1) infinite;
}
@keyframes led-blink {
  0%, 92% { opacity: 1; }
  94%, 97% { opacity: 0.3; }
  98%, 100% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .status-led { animation: none; }
}
</style>
