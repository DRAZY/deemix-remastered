<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import Sidebar from './components/Sidebar.vue'
import TitleBar from './components/TitleBar.vue'
import DownloadBar from './components/DownloadBar.vue'
import DownloadPanel from './components/DownloadPanel.vue'
import ToastContainer from './components/ToastContainer.vue'
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal.vue'
import OfflineBanner from './components/OfflineBanner.vue'
import { useDownloadStore } from './stores/downloadStore'
import { useAuthStore } from './stores/authStore'
import { useSettingsStore } from './stores/settingsStore'
import { useProfileStore } from './stores/profileStore'
import { useSyncStore } from './stores/syncStore'
import { useFavoritesStore } from './stores/favoritesStore'
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts'

const router = useRouter()
const downloadStore = useDownloadStore()
const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const profileStore = useProfileStore()
const syncStore = useSyncStore()
const favoritesStore = useFavoritesStore()
const isLoading = ref(true)
const loadingMessage = ref('Loading settings...')
const showAuthExpiredBanner = ref(false)

// Watch for auth expiration and show banner
watch(() => authStore.authExpired, (expired) => {
  if (expired) {
    showAuthExpiredBanner.value = true
  }
})

function dismissAuthExpiredBanner() {
  showAuthExpiredBanner.value = false
  authStore.clearAuthExpired()
}

function goToLogin() {
  showAuthExpiredBanner.value = false
  authStore.clearAuthExpired()
  router.push('/settings')
}

// Register global keyboard shortcuts
const { showShortcutsHelp } = useKeyboardShortcuts()

// Ensure settings are saved before app closes
const handleBeforeUnload = () => {
  // Trigger a synchronous save attempt
  settingsStore.saveSettings()
}

onMounted(async () => {
  console.log('[App] Starting initialization...')

  // Initialize stores - settings must load first since auth depends on saved ARL
  loadingMessage.value = 'Loading settings...'
  await settingsStore.loadSettings()
  console.log('[App] Settings loaded')

  // Load profiles after settings
  await profileStore.loadProfiles()
  console.log('[App] Profiles loaded')

  // Initialize sync store (non-blocking, after settings)
  syncStore.init().then(() => console.log('[App] Sync store initialized'))
    .catch((e: any) => console.warn('[App] Sync store init failed:', e.message))

  // Now initialize remaining stores
  loadingMessage.value = 'Connecting to Deezer...'
  await downloadStore.init()
  console.log('[App] Download store initialized')

  // Auth initialization with timeout - don't block app loading if Deezer is unreachable
  loadingMessage.value = 'Authenticating...'
  const authTimeout = 10000 // 10 second timeout for auth
  try {
    await Promise.race([
      authStore.init(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Auth timeout')), authTimeout)
      )
    ])
    console.log('[App] Auth initialized, isAuthenticated:', authStore.isAuthenticated)
  } catch (e: any) {
    console.warn('[App] Auth initialization failed or timed out:', e.message)
    // App continues to load - user can try logging in manually
  }

  // Load favorites (will work even without auth - just shows empty state)
  loadingMessage.value = 'Loading favorites...'
  try {
    await favoritesStore.loadFavorites()
    console.log('[App] Favorites loaded')
  } catch (e: any) {
    console.warn('[App] Failed to load favorites:', e.message)
  }

  // Add beforeunload handler to save settings on close
  window.addEventListener('beforeunload', handleBeforeUnload)

  isLoading.value = false
  console.log('[App] Initialization complete')
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<template>
  <div class="flex flex-col h-screen bg-background-main text-foreground">
    <!-- Toast Notifications -->
    <ToastContainer />

    <!-- Offline Status Banner -->
    <OfflineBanner />

    <!-- Keyboard Shortcuts Help Modal -->
    <KeyboardShortcutsModal
      :show="showShortcutsHelp"
      @close="showShortcutsHelp = false"
    />

    <!-- Title Bar (for frameless window) -->
    <TitleBar />

    <!-- Loading Screen -->
    <div v-if="isLoading" class="flex-1 flex items-center justify-center">
      <div class="text-center">
        <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center animate-pulse">
          <svg class="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
        </div>
        <p class="text-foreground-muted">{{ loadingMessage }}</p>
      </div>
    </div>

    <!-- Auth Expired Banner -->
    <transition name="slide-down">
      <div
        v-if="showAuthExpiredBanner"
        class="bg-red-600 text-white px-4 py-3 flex items-center justify-between z-50"
      >
        <div class="flex items-center gap-3">
          <svg class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span class="font-medium">Session expired. Please log in again to continue downloading.</span>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="goToLogin"
            class="px-3 py-1 bg-white text-red-600 rounded-md text-sm font-medium hover:bg-red-50 transition-colors"
          >
            Log In
          </button>
          <button
            @click="dismissAuthExpiredBanner"
            class="p-1 hover:bg-red-700 rounded transition-colors"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </transition>

    <!-- Main App (only shown after loading) -->
    <div v-if="!isLoading" class="flex flex-1 overflow-hidden">
      <!-- Sidebar Navigation -->
      <Sidebar />

      <!-- Main Content -->
      <main class="flex-1 overflow-hidden flex flex-col">
        <div class="flex-1 overflow-y-auto p-6">
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </div>

        <!-- Download Progress Bar (bottom bar for active download feedback) -->
        <DownloadBar v-if="downloadStore.activeDownloads.length > 0" />
      </main>

      <!-- Download Panel (right sidebar) -->
      <DownloadPanel />
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
