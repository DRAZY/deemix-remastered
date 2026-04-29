<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const appVersion = ref('')
const runtimeInfo = ref<{ electron: string; chromium: string; node: string; v8: string; os: string } | null>(null)

onMounted(async () => {
  if (window.electronAPI) {
    appVersion.value = await window.electronAPI.getVersion()
    runtimeInfo.value = await window.electronAPI.getRuntimeInfo()
  }
})

function openLink(url: string) {
  if (window.electronAPI) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

const whatsNew = [
  'Playlist Sync M3U -- Each sync run now writes a timestamped M3U playlist file alongside the synced tracks (issue #59)',
  'Large Playlist Fix -- Playlists and albums with more than 500 tracks now download in full instead of being silently truncated at the first 500 (issue #58)',
  'Sync Toast Fix -- Adding or removing a playlist from Sync no longer throws an error when displaying the success/failure toast',
  'Artist Page Fix -- Artist discography now loads reliably (resolved a runtime error reading the server port)',
  'New App Icon -- Refreshed app icon with a vibrant paper-cut layered design (cobalt + lime palette) replacing the previous purple gradient',
  'New Releases Page -- Dedicated page showing all 100 of Deezer\'s latest album releases, accessible via "See all" on the Home page',
  'Download Statistics Dashboard -- View total downloads, tracks, top artists, formats, and weekly activity on the Downloads page',
  'Duplicate Album Detection -- Warns when an album already exists on disk before downloading',
  'Download Next -- Move pending items to the front of the download queue with one click',
  'Playlist Cover Artwork -- Playlist covers saved as cover.jpg in the playlist folder or as {playlist name}.jpg in the root download directory',
  'Spotify Public/Private Badge -- Link Analyzer shows playlist visibility status for Spotify playlists',
  'Playlist Sync Improvements -- Sync now waits for downloads to complete, only marks successful tracks as known, and supports Force Full Sync (right-click sync button)',
  'Compilation Album Fix -- Tracks from sampler/compilation albums now stay grouped under the album-level artist folder',
  'Download Timeout Protection -- Connection and stall timeouts on all HTTP calls prevent downloads from hanging indefinitely',
  'Track Number Preservation -- Resolved tracks keep their original album position instead of inheriting the alternative version\'s number',
  'Retry Improvements -- Retried tracks stay grouped under the parent album/playlist with preserved track counts',
  'Delete Files Fix -- Delete Files now removes the entire playlist folder, not just a subfolder',
  'Spotify Playlist Error Feedback -- Clear error messages when Spotify playlist conversion or download fails',
  'Default Concurrent Downloads -- Increased from 3 to 5 for better out-of-box performance'
]
</script>

<template>
  <div class="space-y-8 max-w-3xl">
    <!-- App Identity -->
    <div class="card p-8 text-center">
      <div class="flex justify-center mb-4">
        <div class="w-20 h-20 rounded-2xl overflow-hidden">
          <img src="/icon.png" alt="Deemix Remastered" class="w-full h-full object-cover" />
        </div>
      </div>
      <h1 class="text-3xl font-bold mb-1">{{ t('about.appName') }}</h1>
      <p class="text-foreground-muted mb-3">{{ t('about.tagline') }}</p>
      <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary-500/15 text-primary-400 text-sm font-medium">
        v{{ appVersion }}
      </div>
    </div>

    <!-- What's New -->
    <div class="card p-6">
      <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
        {{ t('about.whatsNew') }}
      </h2>
      <ul class="space-y-2">
        <li v-for="(item, i) in whatsNew" :key="i" class="flex items-start gap-2 text-sm text-foreground-muted">
          <span class="text-primary-400 mt-0.5 flex-shrink-0">&bull;</span>
          {{ item }}
        </li>
      </ul>
    </div>

    <!-- Runtime Info -->
    <div class="card p-6" v-if="runtimeInfo">
      <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
        {{ t('about.runtimeInfo') }}
      </h2>
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-background-tertiary rounded-lg p-3">
          <p class="text-xs text-foreground-muted mb-1">Electron</p>
          <p class="text-sm font-mono">{{ runtimeInfo.electron }}</p>
        </div>
        <div class="bg-background-tertiary rounded-lg p-3">
          <p class="text-xs text-foreground-muted mb-1">Chromium</p>
          <p class="text-sm font-mono">{{ runtimeInfo.chromium }}</p>
        </div>
        <div class="bg-background-tertiary rounded-lg p-3">
          <p class="text-xs text-foreground-muted mb-1">Node.js</p>
          <p class="text-sm font-mono">{{ runtimeInfo.node }}</p>
        </div>
        <div class="bg-background-tertiary rounded-lg p-3">
          <p class="text-xs text-foreground-muted mb-1">V8</p>
          <p class="text-sm font-mono">{{ runtimeInfo.v8 }}</p>
        </div>
      </div>
    </div>

    <!-- Links -->
    <div class="card p-6">
      <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        {{ t('about.links') }}
      </h2>
      <div class="space-y-2">
        <button
          @click="openLink('https://github.com/DRAZY/deemix-app')"
          class="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-background-tertiary transition-colors text-left"
        >
          <svg class="w-5 h-5 text-foreground-muted flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          <div>
            <p class="text-sm font-medium">{{ t('about.githubRepo') }}</p>
            <p class="text-xs text-foreground-muted">{{ t('about.githubRepoDesc') }}</p>
          </div>
          <svg class="w-4 h-4 text-foreground-muted ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
        <button
          @click="openLink('https://github.com/DRAZY/deemix-app/issues')"
          class="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-background-tertiary transition-colors text-left"
        >
          <svg class="w-5 h-5 text-foreground-muted flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p class="text-sm font-medium">{{ t('about.reportIssue') }}</p>
            <p class="text-xs text-foreground-muted">{{ t('about.reportIssueDesc') }}</p>
          </div>
          <svg class="w-4 h-4 text-foreground-muted ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Credits & License -->
    <div class="card p-6">
      <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
        </svg>
        {{ t('about.credits') }}
      </h2>
      <div class="space-y-3 text-sm text-foreground-muted">
        <p>{{ t('about.builtBy') }}</p>
        <p>{{ t('about.inspiredBy') }}</p>
        <div class="pt-3 border-t border-zinc-800">
          <p class="flex items-center gap-2">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            {{ t('about.license') }}
          </p>
        </div>
      </div>
    </div>

    <!-- Disclaimer -->
    <p class="text-xs text-foreground-muted text-center pb-4">
      {{ t('about.disclaimer') }}
    </p>
  </div>
</template>
