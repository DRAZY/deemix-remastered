<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useDownloadStore } from '../stores/downloadStore'
import { useAuthStore } from '../stores/authStore'
import { useSettingsStore } from '../stores/settingsStore'
import LoginModal from './LoginModal.vue'

const route = useRoute()
const { t } = useI18n()
const downloadStore = useDownloadStore()
const authStore = useAuthStore()
const settingsStore = useSettingsStore()

const showLoginModal = ref(false)
const activeDownloadsCount = computed(() => downloadStore.activeDownloads.length)

// Appearance settings
const isSlim = computed(() => settingsStore.settings.appearance?.slimSidebar ?? false)
const showSearchButton = computed(() => settingsStore.settings.appearance?.showSearchButton ?? true)

const navItems = computed(() => {
  const items = [
    { path: '/', icon: 'home', label: t('nav.home') },
    { path: '/search', icon: 'search', label: t('nav.search'), hidden: !showSearchButton.value },
    { path: '/charts', icon: 'chart', label: t('nav.charts') },
    // Genre browse (#106) — literal label like the Qobuz channel; i18n keys in
    // the pre-release localization pass.
    { path: '/genres', icon: 'genres', label: t('nav.genres') },
    // Channel Q — visible only when a Qobuz account is connected. Brand name,
    // not translated (matches the QOBUZ badges elsewhere).
    { path: '/qobuz', icon: 'qobuz', label: 'Qobuz', hidden: !settingsStore.isQobuzConnected },
    { path: '/downloads', icon: 'download', label: t('nav.downloads'), badge: activeDownloadsCount },
    { path: '/favorites', icon: 'heart', label: t('nav.favorites') },
    { path: '/analyzer', icon: 'link', label: t('nav.linkAnalyzer') },
    { path: '/sync', icon: 'sync', label: t('nav.playlistSync') },
    { path: '/retag', icon: 'tag', label: t('nav.retag') },
    { path: '/settings', icon: 'settings', label: t('nav.settings') },
    { path: '/about', icon: 'info', label: t('nav.about') }
  ]
  return items.filter(item => !item.hidden)
})

const isActive = (path: string) => {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}

const throughput = computed(() => {
  const bps = downloadStore.totalDownloadSpeed
  if (!bps) return '0 KB/S'
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/S`
  return `${(bps / 1024).toFixed(0)} KB/S`
})

function handleAuthClick() {
  if (authStore.isLoggedIn) {
    // Show user menu or logout
    authStore.logout()
  } else {
    showLoginModal.value = true
  }
}
</script>

<template>
  <nav
    role="navigation"
    :aria-label="t('accessibility.mainNavigation')"
    class="bg-background-secondary border-r border-white/[0.06] flex flex-col transition-all duration-300"
    :class="isSlim ? 'w-16' : 'w-60'"
  >
    <!-- Brand block -->
    <div class="p-4" :class="isSlim ? 'pb-2' : 'p-5 pb-3'">
      <div class="flex items-center gap-2.5" :class="isSlim ? 'justify-center' : ''">
        <!-- Brand mark: the DM/RM Console Stack app icon, in its fixed brand
             colors (chartreuse letters, cyan cursor on blue-black) so it
             matches the Dock/desktop icon on every theme. -->
        <div
          class="w-9 h-9 flex-shrink-0 border border-white/[0.1]"
          role="img"
          :aria-label="t('sidebar.appName')"
        >
          <svg viewBox="0 0 512 512" class="w-full h-full" aria-hidden="true">
            <rect width="512" height="512" fill="#0A0E12" />
            <text x="230" y="242" text-anchor="middle" font-size="158" letter-spacing="4" class="font-display" fill="#C8F135">DM</text>
            <text x="230" y="420" text-anchor="middle" font-size="158" letter-spacing="4" class="font-display" fill="#C8F135">RM</text>
            <rect x="400" y="292" width="42" height="128" fill="#59C2D6" />
          </svg>
        </div>
        <div v-if="!isSlim" class="min-w-0">
          <h1 class="text-sm font-semibold leading-tight truncate">{{ t('sidebar.appName') }}</h1>
          <p class="font-mono text-[9.5px] tracking-[0.18em] text-foreground-muted uppercase">{{ t('sidebar.appTagline') }}</p>
        </div>
      </div>
    </div>

    <!-- Channels label -->
    <div v-if="!isSlim" class="px-5 pt-2 pb-2 font-mono text-[9.5px] tracking-[0.3em] text-foreground-muted">
      CHANNELS
    </div>

    <!-- Navigation -->
    <div class="flex-1 overflow-y-auto" :class="isSlim ? 'px-2' : ''">
      <div :class="isSlim ? 'space-y-1' : ''">
        <router-link
          v-for="(item, idx) in navItems"
          :key="item.path"
          :to="item.path"
          :aria-label="item.label"
          :aria-current="isActive(item.path) ? 'page' : undefined"
          class="relative flex items-center transition-all duration-150"
          :class="[
            isSlim
              ? 'justify-center p-2.5 rounded-lg'
              : 'gap-3 px-5 py-2 border-l-2',
            isActive(item.path)
              ? (isSlim
                  ? 'bg-primary-500/15 text-primary-500'
                  : 'text-primary-500 border-primary-500 bg-gradient-to-r from-primary-500/10 to-transparent')
              : (isSlim
                  ? 'text-foreground-muted hover:bg-white/5 hover:text-foreground'
                  : 'text-foreground-muted border-transparent hover:text-foreground hover:bg-white/[0.03]')
          ]"
          :title="isSlim ? item.label : ''"
        >
          <!-- Channel number (full mode) -->
          <span
            v-if="!isSlim"
            class="font-mono text-[10px] w-5 flex-shrink-0"
            :class="isActive(item.path) ? 'text-primary-600' : 'text-foreground-muted'"
          >{{ String(idx + 1).padStart(2, '0') }}</span>

          <!-- Icons (slim mode only) -->
          <template v-if="isSlim">
            <!-- Home icon -->
            <svg v-if="item.icon === 'home'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>

            <!-- Search icon -->
            <svg v-else-if="item.icon === 'search'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>

            <!-- Chart icon -->
            <svg v-else-if="item.icon === 'chart'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>

            <!-- Genres icon — category grid (tag glyph belongs to Retag) -->
            <svg v-else-if="item.icon === 'genres'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>

            <!-- Channel Q icon — block Q in the fixed Qobuz brand cyan -->
            <span
              v-else-if="item.icon === 'qobuz'"
              class="w-5 h-5 flex-shrink-0 flex items-center justify-center border border-qobuz-500/60 font-mono text-[11px] font-bold leading-none text-qobuz-500"
            >Q</span>

            <!-- Download icon -->
            <svg v-else-if="item.icon === 'download'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>

            <!-- Heart icon -->
            <svg v-else-if="item.icon === 'heart'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>

            <!-- Link icon -->
            <svg v-else-if="item.icon === 'link'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>

            <!-- Sync icon -->
            <svg v-else-if="item.icon === 'sync'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>

            <!-- Tag icon -->
            <svg v-else-if="item.icon === 'tag'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-5 5a2 2 0 01-2.828 0l-7-7A2 2 0 013 11V6a3 3 0 013-3z" />
            </svg>

            <!-- Settings icon -->
            <svg v-else-if="item.icon === 'settings'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>

            <!-- Info icon -->
            <svg v-else-if="item.icon === 'info'" class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </template>

          <span v-if="!isSlim" class="flex-1 text-[14.5px] font-medium truncate">{{ item.label }}</span>

          <!-- Badge -->
          <span
            v-if="item.badge && item.badge.value > 0"
            class="min-w-[20px] h-[18px] px-1.5 flex items-center justify-center font-mono text-[10px] font-bold bg-primary-500 text-background-main rounded-sm"
            :class="isSlim ? 'absolute -top-1 -right-1' : ''"
          >
            {{ item.badge.value }}
          </span>
        </router-link>
      </div>
    </div>

    <!-- Throughput meter (visible while downloading, full mode) -->
    <div
      v-if="!isSlim && activeDownloadsCount > 0"
      class="mx-4 mb-3 p-3 border border-white/[0.08] bg-background-main/60"
    >
      <div class="flex justify-between font-mono text-[9px] tracking-[0.24em] text-foreground-muted mb-2">
        <span>THROUGHPUT</span>
        <span class="text-primary-500">{{ throughput }}</span>
      </div>
      <div class="spark flex items-end gap-[2px] h-8" aria-hidden="true">
        <i v-for="n in 16" :key="n" class="flex-1 bg-gradient-to-t from-primary-700 to-primary-500 opacity-85"></i>
      </div>
    </div>

    <!-- User section / Login prompt -->
    <div class="p-4 border-t border-white/[0.06]" :class="isSlim ? 'px-2' : ''">
      <!-- Logged in state -->
      <div v-if="authStore.isLoggedIn" :class="isSlim ? '' : 'space-y-3'">
        <div class="flex items-center" :class="isSlim ? 'justify-center' : 'gap-3'">
          <img
            v-if="authStore.user?.picture"
            :src="authStore.user.picture"
            :alt="authStore.user.name"
            class="w-9 h-9 rounded-sm object-cover flex-shrink-0"
            :title="isSlim ? authStore.user.name : ''"
          />
          <div v-else class="w-9 h-9 rounded-sm bg-primary-500/20 flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div v-if="!isSlim" class="flex-1 min-w-0">
            <p class="text-[13px] font-medium truncate">{{ authStore.user?.name }}</p>
            <p class="font-mono text-[9.5px] tracking-[0.14em] uppercase text-foreground-muted truncate">
              {{ authStore.user?.subscription?.type || t('sidebar.free') }}
            </p>
          </div>
        </div>
        <button
          v-if="!isSlim"
          @click="handleAuthClick"
          class="w-full btn btn-ghost text-sm text-foreground-muted hover:text-foreground mt-3"
        >
          {{ t('sidebar.logout') }}
        </button>
      </div>

      <!-- Logged out state -->
      <button
        v-else
        @click="handleAuthClick"
        class="w-full btn btn-secondary flex items-center justify-center"
        :class="isSlim ? 'p-2.5' : 'gap-2'"
        :title="isSlim ? t('sidebar.loginWithDeezer') : ''"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        <span v-if="!isSlim">{{ t('sidebar.loginWithDeezer') }}</span>
      </button>

      <!-- Auth required notice -->
      <p v-if="!authStore.isLoggedIn && !isSlim" class="text-xs text-foreground-muted text-center mt-2">
        {{ t('sidebar.loginRequired') }}
      </p>
    </div>

    <!-- Login Modal -->
    <LoginModal
      :show="showLoginModal"
      @close="showLoginModal = false"
    />
  </nav>
</template>

<style scoped>
.spark i {
  transform-origin: bottom;
  animation: spark-pulse 1.6s ease-in-out infinite;
}
.spark i:nth-child(2n) { animation-delay: 0.2s; }
.spark i:nth-child(3n) { animation-delay: 0.45s; }
.spark i:nth-child(5n) { animation-delay: 0.7s; }
.spark i:nth-child(1) { height: 40%; }
.spark i:nth-child(2) { height: 65%; }
.spark i:nth-child(3) { height: 50%; }
.spark i:nth-child(4) { height: 80%; }
.spark i:nth-child(5) { height: 60%; }
.spark i:nth-child(6) { height: 95%; }
.spark i:nth-child(7) { height: 45%; }
.spark i:nth-child(8) { height: 70%; }
.spark i:nth-child(9) { height: 55%; }
.spark i:nth-child(10) { height: 85%; }
.spark i:nth-child(11) { height: 65%; }
.spark i:nth-child(12) { height: 40%; }
.spark i:nth-child(13) { height: 75%; }
.spark i:nth-child(14) { height: 55%; }
.spark i:nth-child(15) { height: 90%; }
.spark i:nth-child(16) { height: 60%; }
@keyframes spark-pulse {
  0%, 100% { transform: scaleY(0.55); }
  50% { transform: scaleY(1); }
}
@media (prefers-reduced-motion: reduce) {
  .spark i { animation: none; }
}
</style>
