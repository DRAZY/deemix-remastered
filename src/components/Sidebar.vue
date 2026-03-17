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
    { path: '/downloads', icon: 'download', label: t('nav.downloads'), badge: activeDownloadsCount },
    { path: '/favorites', icon: 'heart', label: t('nav.favorites') },
    { path: '/analyzer', icon: 'link', label: t('nav.linkAnalyzer') },
    { path: '/sync', icon: 'sync', label: t('nav.playlistSync') },
    { path: '/settings', icon: 'settings', label: t('nav.settings') },
    { path: '/about', icon: 'info', label: t('nav.about') }
  ]
  return items.filter(item => !item.hidden)
})

const isActive = (path: string) => {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}

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
    class="bg-background-secondary border-r border-zinc-800 flex flex-col transition-all duration-300"
    :class="isSlim ? 'w-16' : 'w-64'"
  >
    <!-- Logo -->
    <div class="p-4" :class="isSlim ? 'pb-2' : 'p-5 pb-4'">
      <div class="flex items-center gap-2.5" :class="isSlim ? 'justify-center' : ''">
        <div class="w-9 h-9 rounded-xl overflow-hidden flex-shrink-0">
          <svg viewBox="0 0 512 512" class="w-full h-full">
            <defs>
              <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" class="logo-gradient-start"/>
                <stop offset="50%" class="logo-gradient-mid"/>
                <stop offset="100%" class="logo-gradient-end"/>
              </linearGradient>
            </defs>
            <circle cx="256" cy="256" r="256" fill="url(#logoGrad)"/>
            <path d="M140 100 L140 412 L270 412 C370 412 440 330 440 256 C440 182 370 100 270 100 Z"
                  fill="none" stroke="white" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
            <g fill="white" opacity="0.9">
              <rect x="190" y="195" width="18" height="122" rx="9"/>
              <rect x="225" y="160" width="18" height="192" rx="9"/>
              <rect x="260" y="180" width="18" height="152" rx="9"/>
              <rect x="295" y="150" width="18" height="212" rx="9"/>
              <rect x="330" y="175" width="18" height="162" rx="9"/>
            </g>
          </svg>
        </div>
        <div v-if="!isSlim" class="min-w-0">
          <h1 class="text-base font-bold leading-tight">{{ t('sidebar.appName') }}</h1>
          <p class="text-[11px] text-foreground-muted">{{ t('sidebar.appTagline') }}</p>
        </div>
      </div>
    </div>

    <!-- Navigation -->
    <div class="flex-1" :class="isSlim ? 'px-2' : 'px-3'">
      <div class="space-y-1">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          :aria-label="item.label"
          :aria-current="isActive(item.path) ? 'page' : undefined"
          class="flex items-center rounded-lg transition-all duration-200"
          :class="[
            isSlim ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5',
            isActive(item.path)
              ? 'bg-primary-500/20 text-primary-400'
              : 'text-foreground-muted hover:bg-white/5 hover:text-foreground'
          ]"
          :title="isSlim ? item.label : ''"
        >
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

          <span v-if="!isSlim" class="flex-1">{{ item.label }}</span>

          <!-- Badge -->
          <span
            v-if="item.badge && item.badge.value > 0"
            class="min-w-[20px] h-5 px-1.5 flex items-center justify-center text-xs font-medium bg-primary-500 text-white rounded-full"
            :class="isSlim ? 'absolute -top-1 -right-1' : ''"
          >
            {{ item.badge.value }}
          </span>
        </router-link>
      </div>
    </div>

    <!-- User section / Login prompt -->
    <div class="p-4 border-t border-zinc-800" :class="isSlim ? 'px-2' : ''">
      <!-- Logged in state -->
      <div v-if="authStore.isLoggedIn" :class="isSlim ? '' : 'space-y-3'">
        <div class="flex items-center" :class="isSlim ? 'justify-center' : 'gap-3'">
          <img
            v-if="authStore.user?.picture"
            :src="authStore.user.picture"
            :alt="authStore.user.name"
            class="w-10 h-10 rounded-full object-cover flex-shrink-0"
            :title="isSlim ? authStore.user.name : ''"
          />
          <div v-else class="w-10 h-10 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div v-if="!isSlim" class="flex-1 min-w-0">
            <p class="font-medium truncate">{{ authStore.user?.name }}</p>
            <p class="text-xs text-foreground-muted truncate">
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
