<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore, type ColorTheme } from '../stores/settingsStore'
import { useProfileStore } from '../stores/profileStore'
import { SUPPORTED_LOCALES, setLocale, getCurrentLocale } from '../i18n'
import FlagIcon from '../components/FlagIcon.vue'
import ProfileSelector from '../components/ProfileSelector.vue'
import { useContextMenu } from '../composables/useContextMenu'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const profileStore = useProfileStore()

// Settings search
const settingsSearch = ref('')

// Define searchable content for each section
const sectionSearchTerms: Record<string, string[]> = {
  profiles: ['profile', 'preset', 'audiophile', 'quick', 'balanced', 'flac', 'mp3', 'import', 'export', 'save profile'],
  appearance: ['appearance', 'theme', 'color', 'violet', 'spotify', 'rose', 'ocean', 'sunset', 'mint', 'dracula', 'nord', 'slim', 'sidebar', 'download tab', 'quality tag', 'search button'],
  languages: ['language', 'languages', 'locale', 'translation'],
  downloads: ['download', 'path', 'location', 'folder', 'concurrent', 'bitrate', 'quality', 'mp3', 'flac', '128', '320', 'overwrite', 'fallback', 'isrc', 'log', 'cdn', 'lrc', 'lyrics', 'playlist', 'queue'],
  folders: ['folder', 'structure', 'template', 'artist', 'album', 'playlist', 'cd', 'singles'],
  templates: ['template', 'trackname', 'filename', 'format', 'variable', 'pattern'],
  metadata: ['metadata', 'artwork', 'embed', 'lyrics', 'save'],
  albumCovers: ['cover', 'artwork', 'image', 'jpeg', 'png', 'size', 'quality'],
  tags: ['tags', 'id3', 'title', 'artist', 'album', 'genre', 'year', 'track number', 'disc', 'isrc', 'bpm', 'lyrics', 'composer', 'copyright'],
  other: ['other', 'update', 'compilation', 'separator', 'null', 'id3v1', 'various artists', 'casing', 'date format', 'preview', 'volume'],
  accounts: ['account', 'deezer', 'arl', 'login', 'token', 'authentication'],
  spotify: ['spotify', 'client', 'secret', 'import', 'playlist', 'username']
}

const filteredSections = computed(() => {
  const query = settingsSearch.value.toLowerCase().trim()
  if (!query) {
    return null // Show all sections
  }
  const matching: string[] = []
  for (const [section, terms] of Object.entries(sectionSearchTerms)) {
    if (terms.some(term => term.toLowerCase().includes(query)) ||
        section.toLowerCase().includes(query)) {
      matching.push(section)
    }
  }
  return matching
})

function isSectionVisible(section: string): boolean {
  if (!filteredSections.value) return true
  return filteredSections.value.includes(section)
}

function clearSearch() {
  settingsSearch.value = ''
}

// Watch all settings changes and save immediately
// This ensures any v-model change triggers a save
watch(
  () => settingsStore.settings,
  () => {
    if (settingsStore.isLoaded) {
      console.log('[SettingsView] Settings changed, saving...')
      settingsStore.saveSettings()
    }
  },
  { deep: true }
)
const currentLocale = ref(getCurrentLocale())

async function changeLanguage(code: string) {
  await setLocale(code)
  currentLocale.value = code
  settingsStore.settings.language = code
  settingsStore.saveSettings()
}
const showCustomConcurrent = ref(false)

// ARL authentication state
const arlLoading = ref(false)
const arlStatus = ref<'idle' | 'success' | 'error'>('idle')
const arlMessage = ref('')
const serverPort = ref(6595)

// Spotify authentication state
const spotifyLoading = ref(false)
const spotifyStatus = ref<'idle' | 'success' | 'error'>('idle')
const spotifyMessage = ref('')
const spotifyClientId = ref('')
const spotifyClientSecret = ref('')
const spotifyUsername = ref('')

// Collapsible section states (true = expanded, false = collapsed)
const expandedSections = ref({
  profiles: true,
  appearance: true,
  languages: true,
  downloads: true,
  folders: false,
  templates: false,
  metadata: false,
  albumCovers: false,
  tags: false,
  other: false,
  accounts: true,
  spotify: true
})

function toggleSection(section: keyof typeof expandedSections.value) {
  expandedSections.value[section] = !expandedSections.value[section]
}

onMounted(async () => {
  // Note: Settings are already loaded by App.vue - don't reload here
  // Check if current value is custom (not a preset)
  const val = settingsStore.settings.maxConcurrentDownloads
  if (![2, 3, 5, 10].includes(val)) {
    showCustomConcurrent.value = true
  }
  // Get server port
  if (window.electronAPI) {
    serverPort.value = await window.electronAPI.getServerPort()
  }
  // Check current auth status
  await checkAuthStatus()
  // Load Spotify credentials and check status
  spotifyClientId.value = settingsStore.settings.spotifyClientId || ''
  spotifyClientSecret.value = settingsStore.settings.spotifyClientSecret || ''
  spotifyUsername.value = settingsStore.settings.spotifyUsername || ''
  await checkSpotifyStatus()
})

async function checkAuthStatus() {
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/auth/status`)
    const data = await response.json()
    if (data.authenticated && data.user) {
      arlStatus.value = 'success'
      arlMessage.value = `Logged in as ${data.user.name || 'User'}`
    }
  } catch (e) {
    // Ignore errors on status check
  }
}

async function applyArl() {
  const arl = settingsStore.settings.arl?.trim()
  if (!arl) {
    arlStatus.value = 'error'
    arlMessage.value = 'Please enter an ARL token'
    return
  }

  arlLoading.value = true
  arlStatus.value = 'idle'
  arlMessage.value = ''

  try {
    const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arl })
    })

    const data = await response.json()

    if (response.ok && data.success) {
      arlStatus.value = 'success'
      arlMessage.value = `Logged in as ${data.user?.name || 'User'}`
      settingsStore.saveSettings()
    } else {
      arlStatus.value = 'error'
      arlMessage.value = data.error || 'Authentication failed'
    }
  } catch (error: any) {
    arlStatus.value = 'error'
    arlMessage.value = error.message || 'Failed to connect to server'
  } finally {
    arlLoading.value = false
  }
}

// Clipboard functions for paste buttons
const { pasteFromClipboard } = useContextMenu()

async function pasteArl() {
  const text = await pasteFromClipboard()
  if (text) {
    settingsStore.settings.arl = text.trim()
  }
}

async function pasteSpotifyClientId() {
  const text = await pasteFromClipboard()
  if (text) {
    spotifyClientId.value = text.trim()
  }
}

async function pasteSpotifyClientSecret() {
  const text = await pasteFromClipboard()
  if (text) {
    spotifyClientSecret.value = text.trim()
  }
}

async function checkSpotifyStatus() {
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/spotify/status`)
    const data = await response.json()
    if (data.authenticated) {
      spotifyStatus.value = 'success'
      spotifyMessage.value = t('settings.spotify.connected')
    }
  } catch (e) {
    // Ignore errors on status check
  }
}

async function testSpotifyConnection() {
  const clientId = spotifyClientId.value.trim()
  const clientSecret = spotifyClientSecret.value.trim()

  if (!clientId || !clientSecret) {
    spotifyStatus.value = 'error'
    spotifyMessage.value = t('settings.spotify.credentialsRequired')
    return
  }

  spotifyLoading.value = true
  spotifyStatus.value = 'idle'
  spotifyMessage.value = ''

  try {
    const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/spotify/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret })
    })

    const data = await response.json()

    if (response.ok && data.success) {
      spotifyStatus.value = 'success'
      spotifyMessage.value = t('settings.spotify.connectionSuccess')
      // Save credentials securely (including username)
      await settingsStore.setSpotifyCredentials(clientId, clientSecret, spotifyUsername.value.trim())
    } else {
      spotifyStatus.value = 'error'
      spotifyMessage.value = data.error || t('settings.spotify.connectionFailed')
    }
  } catch (error: any) {
    spotifyStatus.value = 'error'
    spotifyMessage.value = error.message || t('settings.spotify.connectionFailed')
  } finally {
    spotifyLoading.value = false
  }
}

function openSpotifyDeveloper() {
  window.open('https://developer.spotify.com/dashboard', '_blank')
}

function openSpotifyInfo() {
  window.open(`http://127.0.0.1:${serverPort.value}/info-spotify`, '_blank')
}

const qualityOptions = [
  { value: '128', label: 'MP3 128kbps', description: 'Smaller file size, lower quality' },
  { value: '320', label: 'MP3 320kbps', description: 'Good balance of size and quality' },
  { value: 'flac', label: 'FLAC', description: 'Lossless, highest quality' }
]

const concurrentPresets = [
  { value: 2, label: '2', description: 'Conservative - gentle on network' },
  { value: 3, label: '3', description: 'Balanced (default)' },
  { value: 5, label: '5', description: 'Faster downloads' },
  { value: 10, label: '10', description: 'Fast - good for fast connections' }
]

function setConcurrentDownloads(value: number) {
  showCustomConcurrent.value = false
  settingsStore.settings.maxConcurrentDownloads = value
}

function enableCustomConcurrent() {
  showCustomConcurrent.value = true
}

function updateCustomConcurrent(event: Event) {
  const input = event.target as HTMLInputElement
  let value = parseInt(input.value) || 3
  // Clamp between 2 and 50
  value = Math.max(2, Math.min(50, value))
  settingsStore.settings.maxConcurrentDownloads = value
}

const themeOptions: { value: ColorTheme; label: string; colors: string[] }[] = [
  { value: 'violet', label: 'Violet', colors: ['#8B5CF6', '#6366F1', '#3B82F6'] },
  { value: 'spotify', label: 'Spotify', colors: ['#1DB954', '#1ED760', '#17A34A'] },
  { value: 'rose', label: 'Rose', colors: ['#F43F5E', '#EC4899', '#DB2777'] },
  { value: 'ocean', label: 'Ocean', colors: ['#3B82F6', '#2563EB', '#1D4ED8'] },
  { value: 'sunset', label: 'Sunset', colors: ['#F97316', '#EA580C', '#DC2626'] },
  { value: 'mint', label: 'Mint', colors: ['#06B6D4', '#14B8A6', '#0D9488'] },
  { value: 'dracula', label: 'Dracula', colors: ['#BD93F9', '#FF79C6', '#8BE9FD'] },
  { value: 'nord', label: 'Nord', colors: ['#5E81AC', '#81A1C1', '#88C0D0'] }
]

// Template section state
const showTrackVars = ref(false)
const showAlbumTrackVars = ref(false)
const showPlaylistTrackVars = ref(false)

// Available template variables
const templateVariables = [
  '%title%', '%artist%', '%artists%', '%allartists%', '%mainartists%', '%featartists%',
  '%album%', '%albumartist%', '%tracknumber%', '%tracktotal%', '%discnumber%', '%disctotal%',
  '%genre%', '%year%', '%date%', '%bpm%', '%label%', '%isrc%', '%upc%',
  '%explicit%', '%track_id%', '%album_id%', '%artist_id%', '%playlist_id%', '%position%'
]

// Default templates
const defaultTemplates = {
  trackNameTemplate: '%artist% - %title%',
  albumTrackTemplate: '%tracknumber% - %title%',
  playlistTrackTemplate: '%position% - %artist% - %title%'
}

function resetTemplates() {
  settingsStore.settings.trackNameTemplate = defaultTemplates.trackNameTemplate
  settingsStore.settings.albumTrackTemplate = defaultTemplates.albumTrackTemplate
  settingsStore.settings.playlistTrackTemplate = defaultTemplates.playlistTrackTemplate
}

function insertVariable(template: 'trackNameTemplate' | 'albumTrackTemplate' | 'playlistTrackTemplate', variable: string) {
  settingsStore.settings[template] += variable
  saveNow()
}

// Explicit save function - call this on every settings change
function saveNow() {
  console.log('[SettingsView] Saving settings...')
  settingsStore.saveSettings()
}
</script>

<template>
  <div class="space-y-8 max-w-3xl">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold">{{ t('settings.title') }}</h1>
      <!-- Settings Search -->
      <div class="relative w-64">
        <input
          v-model="settingsSearch"
          type="text"
          :placeholder="t('settings.searchSettings')"
          class="input w-full pl-10 pr-8 py-2 text-sm"
        />
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <button
          v-if="settingsSearch"
          @click="clearSearch"
          class="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-background-tertiary rounded transition-colors"
        >
          <svg class="w-4 h-4 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- No results message -->
    <div v-if="filteredSections && filteredSections.length === 0" class="card text-center py-8">
      <svg class="w-12 h-12 mx-auto text-foreground-muted mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p class="text-foreground-muted">{{ t('settings.noResults') }}</p>
      <button @click="clearSearch" class="text-primary-400 hover:text-primary-300 text-sm mt-2">
        {{ t('settings.clearSearch') }}
      </button>
    </div>

    <!-- Settings Profiles -->
    <section v-if="isSectionVisible('profiles')" class="card">
      <h2
        @click="toggleSection('profiles')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        {{ t('settings.profiles.title') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.profiles }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.profiles" class="space-y-6 pt-6">
        <ProfileSelector />
      </div>
    </section>

    <!-- Appearance Settings -->
    <section v-if="isSectionVisible('appearance')" class="card">
      <h2
        @click="toggleSection('appearance')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        {{ t('settings.appearance') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.appearance }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.appearance" class="space-y-6 pt-6">
        <!-- Theme Mode Toggle -->
        <div>
          <label class="block text-sm font-medium mb-3">{{ t('settings.themeMode') }}</label>
          <div class="flex gap-2">
            <button
              @click="settingsStore.setTheme('dark')"
              class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg transition-all duration-200 border-2"
              :class="settingsStore.settings.theme === 'dark'
                ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                : 'border-transparent bg-background-main hover:bg-background-tertiary text-foreground-muted'"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
              <span class="font-medium">{{ t('settings.themeDark') }}</span>
            </button>
            <button
              @click="settingsStore.setTheme('light')"
              class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg transition-all duration-200 border-2"
              :class="settingsStore.settings.theme === 'light'
                ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                : 'border-transparent bg-background-main hover:bg-background-tertiary text-foreground-muted'"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <span class="font-medium">{{ t('settings.themeLight') }}</span>
            </button>
            <button
              @click="settingsStore.setTheme('system')"
              class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg transition-all duration-200 border-2"
              :class="settingsStore.settings.theme === 'system'
                ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                : 'border-transparent bg-background-main hover:bg-background-tertiary text-foreground-muted'"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span class="font-medium">{{ t('settings.themeSystem') }}</span>
            </button>
          </div>
        </div>

        <!-- Color Theme -->
        <div>
          <label class="block text-sm font-medium mb-3">{{ t('settings.colorTheme') }}</label>
          <div class="grid grid-cols-4 gap-3">
            <button
              v-for="theme in themeOptions"
              :key="theme.value"
              @click="settingsStore.setColorTheme(theme.value)"
              class="group relative p-3 rounded-xl transition-all duration-200 border-2"
              :class="settingsStore.settings.colorTheme === theme.value
                ? 'border-primary-500 bg-primary-500/10'
                : 'border-transparent bg-background-main hover:bg-background-tertiary'"
            >
              <!-- Color preview gradient -->
              <div
                class="w-full h-8 rounded-lg mb-2"
                :style="{
                  background: `linear-gradient(135deg, ${theme.colors[0]} 0%, ${theme.colors[1]} 50%, ${theme.colors[2]} 100%)`
                }"
              />
              <span class="text-sm font-medium">{{ theme.label }}</span>
              <!-- Checkmark for selected theme -->
              <div
                v-if="settingsStore.settings.colorTheme === theme.value"
                class="absolute top-2 right-2 w-5 h-5 bg-primary-500 rounded-full flex items-center justify-center"
              >
                <svg class="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </button>
          </div>
        </div>

        <!-- UI Layout Options -->
        <div class="space-y-3 pt-2">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.appearance.slimDownloadTab"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.slimDownloadTab') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.appearance.slimSidebar"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.slimSidebar') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.appearance.showQualityTag"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.showQualityTag') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.appearance.showSearchButton"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.showSearchButton') }}</span>
          </label>
        </div>
      </div>
    </section>

    <!-- Languages Section -->
    <section v-if="isSectionVisible('languages')" class="card">
      <h2
        @click="toggleSection('languages')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {{ t('settings.languages') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.languages }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.languages" class="pt-6">
        <div class="flex flex-wrap gap-3">
        <button
          v-for="locale in SUPPORTED_LOCALES"
          :key="locale.code"
          @click="changeLanguage(locale.code)"
          class="w-12 h-12 rounded-lg transition-all duration-200 border-2 flex items-center justify-center hover:scale-110"
          :class="currentLocale === locale.code
            ? 'border-primary-500 bg-primary-500/20'
            : 'border-transparent bg-background-main hover:bg-background-tertiary'"
          :title="`${locale.name} (${locale.nativeName})`"
        >
          <FlagIcon :code="locale.code" :size="32" />
        </button>
        </div>
      </div>
    </section>

    <!-- Downloads Settings -->
    <section v-if="isSectionVisible('downloads')" class="card">
      <h2
        @click="toggleSection('downloads')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {{ t('downloads.title') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.downloads }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.downloads" class="space-y-6 pt-6">
        <!-- Download Path -->
        <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.downloadLocation') }}</label>
        <div class="flex gap-2">
          <input
            :value="settingsStore.settings.downloadPath || t('settings.notSet')"
            readonly
            class="input flex-1 bg-background-main cursor-default"
          />
          <button
            @click="settingsStore.selectDownloadPath()"
            class="btn btn-secondary"
          >
            {{ t('common.browse') }}
          </button>
          <button
            v-if="settingsStore.settings.downloadPath"
            @click="settingsStore.openDownloadPath()"
            class="btn btn-ghost"
            :title="t('settings.openFolder')"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Concurrent Downloads -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.concurrentDownloads') }}</label>
        <input
          type="number"
          min="1"
          max="50"
          v-model.number="settingsStore.settings.maxConcurrentDownloads"
          class="input w-full"
        />
      </div>

      <!-- Preferred Bitrate -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.preferredBitrate') }}</label>
        <select
          v-model="settingsStore.settings.quality"
          @change="saveNow"
          class="input w-full bg-background-main"
        >
          <option value="128">{{ t('settings.bitrateOptions.mp3_128') }}</option>
          <option value="320">{{ t('settings.bitrateOptions.mp3_320') }}</option>
          <option value="flac">{{ t('settings.bitrateOptions.flac') }}</option>
        </select>
      </div>

      <!-- Overwrite Files -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.overwriteFiles') }}</label>
        <select
          v-model="settingsStore.settings.overwriteFiles"
          @change="saveNow"
          class="input w-full bg-background-main"
        >
          <option value="no">{{ t('settings.overwriteOptions.no') }}</option>
          <option value="overwrite">{{ t('settings.overwriteOptions.overwrite') }}</option>
          <option value="rename">{{ t('settings.overwriteOptions.rename') }}</option>
        </select>
      </div>

      <!-- Download Options Grid -->
      <div class="grid grid-cols-3 gap-x-6 gap-y-3 pt-2">
        <!-- Column 1 -->
        <div class="space-y-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.bitrateFallback"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.bitrateFallback') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.searchFallback"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.searchFallback') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.isrcFallback"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.isrcFallback') }}</span>
          </label>
        </div>

        <!-- Column 2 -->
        <div class="space-y-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.createErrorLog"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.createLogFiles') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.createSearchLog"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.createSearchLog') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.gambleCDNs"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.gambleCDNs') }}</span>
          </label>
        </div>

        <!-- Column 3 -->
        <div class="space-y-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.createLrcFiles"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.createLrcFiles') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.createPlaylistFile"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.createPlaylistFile') }}</span>
          </label>
        </div>
      </div>

        <!-- Clear Queue Option -->
        <div class="pt-2 border-t border-zinc-700/50">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.clearQueueOnClose"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.clearQueueOnClose') }}</span>
          </label>
        </div>
      </div>
    </section>

    <!-- Folders Settings -->
    <section v-if="isSectionVisible('folders')" class="card">
      <h2
        @click="toggleSection('folders')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        {{ t('settings.folders') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.folders }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.folders" class="space-y-6 pt-6">
        <!-- Primary folder options - 3 columns -->
        <div class="grid grid-cols-3 gap-6">
        <!-- Create folder for playlists -->
        <div>
          <label class="flex items-center gap-3 cursor-pointer mb-3">
            <input
              type="checkbox"
              v-model="settingsStore.settings.createPlaylistFolder"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.createPlaylistFolder') }}</span>
          </label>
          <div v-if="settingsStore.settings.createPlaylistFolder">
            <label class="block text-xs text-foreground-muted mb-1">{{ t('settings.playlistFolderTemplate') }}</label>
            <input
              v-model="settingsStore.settings.playlistFolderTemplate"
              type="text"
              placeholder="%playlist%"
              class="input w-full text-sm"
            />
          </div>
        </div>

        <!-- Create folder for artist -->
        <div>
          <label class="flex items-center gap-3 cursor-pointer mb-3">
            <input
              type="checkbox"
              v-model="settingsStore.settings.createArtistFolder"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.createArtistFolder') }}</span>
          </label>
          <div v-if="settingsStore.settings.createArtistFolder">
            <label class="block text-xs text-foreground-muted mb-1">{{ t('settings.artistFolderTemplate') }}</label>
            <input
              v-model="settingsStore.settings.artistFolderTemplate"
              type="text"
              placeholder="%artist%"
              class="input w-full text-sm"
            />
          </div>
        </div>

        <!-- Create folder for album -->
        <div>
          <label class="flex items-center gap-3 cursor-pointer mb-3">
            <input
              type="checkbox"
              v-model="settingsStore.settings.createAlbumFolder"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.createAlbumFolder') }}</span>
          </label>
          <div v-if="settingsStore.settings.createAlbumFolder">
            <label class="block text-xs text-foreground-muted mb-1">{{ t('settings.albumFolderTemplate') }}</label>
            <input
              v-model="settingsStore.settings.albumFolderTemplate"
              type="text"
              placeholder="%artist% - %album%"
              class="input w-full text-sm"
            />
          </div>
        </div>
      </div>

      <!-- Additional folder options -->
      <div class="space-y-3 pt-2 border-t border-zinc-700/50">
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            v-model="settingsStore.settings.createCDFolder"
            class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
          />
          <span class="text-sm">{{ t('settings.createCDFolder') }}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            v-model="settingsStore.settings.createPlaylistStructure"
            class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
          />
          <span class="text-sm">{{ t('settings.createPlaylistStructure') }}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            v-model="settingsStore.settings.createSinglesStructure"
            class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
          />
          <span class="text-sm">{{ t('settings.createSinglesStructure') }}</span>
        </label>
      </div>

        <!-- Available template variables -->
        <div class="p-3 bg-background-main rounded-lg">
          <p class="text-xs text-foreground-muted mb-2">{{ t('settings.availableTemplateVars') }}</p>
          <div class="flex flex-wrap gap-2">
            <code class="text-xs px-2 py-1 bg-background-tertiary rounded">%artist%</code>
            <code class="text-xs px-2 py-1 bg-background-tertiary rounded">%album%</code>
            <code class="text-xs px-2 py-1 bg-background-tertiary rounded">%playlist%</code>
            <code class="text-xs px-2 py-1 bg-background-tertiary rounded">%year%</code>
            <code class="text-xs px-2 py-1 bg-background-tertiary rounded">%genre%</code>
            <code class="text-xs px-2 py-1 bg-background-tertiary rounded">%label%</code>
          </div>
        </div>

        <!-- Folder structure preview -->
        <div class="p-3 bg-background-main rounded-lg">
          <p class="text-xs text-foreground-muted mb-1">{{ t('settings.examplePath') }}</p>
          <code class="text-sm text-primary-400">
            ~/Music/Deemix/<span v-if="settingsStore.settings.createArtistFolder">{{ settingsStore.settings.artistFolderTemplate.replace('%artist%', 'Artist Name') }}/</span><span v-if="settingsStore.settings.createAlbumFolder">{{ settingsStore.settings.albumFolderTemplate.replace('%artist%', 'Artist').replace('%album%', 'Album') }}/</span>01 - Track.mp3
          </code>
        </div>
      </div>
    </section>

    <!-- Templates Settings -->
    <section v-if="isSectionVisible('templates')" class="card">
      <h2
        @click="toggleSection('templates')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 6h16M4 12h16M4 18h7" />
        </svg>
        {{ t('settings.templates') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.templates }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.templates" class="space-y-6 pt-6">
        <!-- Trackname template -->
        <div class="space-y-3">
        <label class="block text-sm font-medium">{{ t('settings.tracknameTemplate') }}</label>
        <input
          v-model="settingsStore.settings.trackNameTemplate"
          type="text"
          placeholder="%artist% - %title%"
          class="input w-full font-mono text-sm"
        />

        <!-- Collapsible variables -->
        <button
          @click="showTrackVars = !showTrackVars"
          class="flex items-center gap-2 text-sm text-foreground-muted hover:text-foreground transition-colors"
        >
          <svg
            class="w-4 h-4 transition-transform"
            :class="{ 'rotate-90': showTrackVars }"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
          {{ t('settings.availableTracknameVars') }}
        </button>
        <div v-if="showTrackVars" class="p-3 bg-background-main rounded-lg">
          <div class="flex flex-wrap gap-2">
            <button
              v-for="variable in templateVariables"
              :key="'track-' + variable"
              @click="insertVariable('trackNameTemplate', variable)"
              class="text-xs px-2 py-1 bg-background-tertiary rounded hover:bg-primary-500/20 hover:text-primary-400 transition-colors font-mono"
            >
              {{ variable }}
            </button>
          </div>
        </div>
      </div>

      <!-- Album track template -->
      <div class="space-y-3">
        <label class="block text-sm font-medium">{{ t('settings.albumTrackTemplate') }}</label>
        <input
          v-model="settingsStore.settings.albumTrackTemplate"
          type="text"
          placeholder="%tracknumber% - %title%"
          class="input w-full font-mono text-sm"
        />

        <!-- Collapsible variables -->
        <button
          @click="showAlbumTrackVars = !showAlbumTrackVars"
          class="flex items-center gap-2 text-sm text-foreground-muted hover:text-foreground transition-colors"
        >
          <svg
            class="w-4 h-4 transition-transform"
            :class="{ 'rotate-90': showAlbumTrackVars }"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
          {{ t('settings.availableAlbumTrackVars') }}
        </button>
        <div v-if="showAlbumTrackVars" class="p-3 bg-background-main rounded-lg">
          <div class="flex flex-wrap gap-2">
            <button
              v-for="variable in templateVariables"
              :key="'album-' + variable"
              @click="insertVariable('albumTrackTemplate', variable)"
              class="text-xs px-2 py-1 bg-background-tertiary rounded hover:bg-primary-500/20 hover:text-primary-400 transition-colors font-mono"
            >
              {{ variable }}
            </button>
          </div>
        </div>
      </div>

      <!-- Playlist track template -->
      <div class="space-y-3">
        <label class="block text-sm font-medium">{{ t('settings.playlistTrackTemplate') }}</label>
        <input
          v-model="settingsStore.settings.playlistTrackTemplate"
          type="text"
          placeholder="%position% - %artist% - %title%"
          class="input w-full font-mono text-sm"
        />

        <!-- Collapsible variables -->
        <button
          @click="showPlaylistTrackVars = !showPlaylistTrackVars"
          class="flex items-center gap-2 text-sm text-foreground-muted hover:text-foreground transition-colors"
        >
          <svg
            class="w-4 h-4 transition-transform"
            :class="{ 'rotate-90': showPlaylistTrackVars }"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
          {{ t('settings.availablePlaylistTrackVars') }}
        </button>
        <div v-if="showPlaylistTrackVars" class="p-3 bg-background-main rounded-lg">
          <div class="flex flex-wrap gap-2">
            <button
              v-for="variable in templateVariables"
              :key="'playlist-' + variable"
              @click="insertVariable('playlistTrackTemplate', variable)"
              class="text-xs px-2 py-1 bg-background-tertiary rounded hover:bg-primary-500/20 hover:text-primary-400 transition-colors font-mono"
            >
              {{ variable }}
            </button>
          </div>
        </div>
      </div>

        <!-- Reset and Save buttons -->
        <div class="flex justify-end gap-3 pt-4 border-t border-zinc-700/50">
          <button
            @click="resetTemplates"
            class="btn btn-secondary text-sm"
          >
            {{ t('settings.resetToDefault') }}
          </button>
          <button
            @click="settingsStore.saveSettings()"
            class="btn btn-primary text-sm"
          >
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </section>

    <!-- Metadata Settings -->
    <section v-if="isSectionVisible('metadata')" class="card">
      <h2
        @click="toggleSection('metadata')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {{ t('settings.metadata') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.metadata }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.metadata" class="space-y-3 pt-6">
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            v-model="settingsStore.settings.saveArtwork"
            class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
          />
          <span>{{ t('settings.saveArtwork') }}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            v-model="settingsStore.settings.embedArtwork"
            class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
          />
          <span>{{ t('settings.embedArtwork') }}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            v-model="settingsStore.settings.saveLyrics"
            class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
          />
          <span>{{ t('settings.saveLyrics') }}</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer ml-6">
          <input
            type="checkbox"
            v-model="settingsStore.settings.syncedLyrics"
            :disabled="!settingsStore.settings.saveLyrics"
            class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main disabled:opacity-50"
          />
          <span :class="{ 'opacity-50': !settingsStore.settings.saveLyrics }">
            {{ t('settings.syncedLyrics') }}
          </span>
        </label>
      </div>
    </section>

    <!-- Album Covers Settings -->
    <section v-if="isSectionVisible('albumCovers')" class="card">
      <h2
        @click="toggleSection('albumCovers')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        {{ t('settings.albumCovers') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.albumCovers }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.albumCovers" class="space-y-6 pt-6">
        <!-- Save Covers -->
      <label class="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          v-model="settingsStore.settings.albumCovers.saveCovers"
          class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
        />
        <span>{{ t('settings.saveCovers') }}</span>
      </label>

      <!-- Cover name template -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.coverNameTemplate') }}</label>
        <input
          v-model="settingsStore.settings.albumCovers.coverNameTemplate"
          type="text"
          placeholder="cover"
          class="input w-full"
        />
      </div>

      <!-- Save artist image -->
      <label class="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          v-model="settingsStore.settings.albumCovers.saveArtistImage"
          class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
        />
        <span>{{ t('settings.saveArtistImage') }}</span>
      </label>

      <!-- Local artwork size -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.localArtwork') }}</label>
        <input
          v-model.number="settingsStore.settings.albumCovers.localArtworkSize"
          type="number"
          min="100"
          max="3000"
          placeholder="1200"
          class="input w-full"
        />
      </div>

      <!-- Embedded artwork size -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.embeddedArtwork') }}</label>
        <input
          v-model.number="settingsStore.settings.albumCovers.embeddedArtworkSize"
          type="number"
          min="100"
          max="3000"
          placeholder="800"
          class="input w-full"
        />
      </div>

      <!-- Local artwork format -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.localArtworkFormat') }}</label>
        <select
          v-model="settingsStore.settings.albumCovers.localArtworkFormat"
          class="input w-full bg-background-main"
        >
          <option value="jpeg">{{ t('settings.formatJpeg') }}</option>
          <option value="png">{{ t('settings.formatPng') }}</option>
          <option value="both">{{ t('settings.formatBoth') }}</option>
        </select>
      </div>

      <!-- Save embedded artwork as PNG -->
      <label class="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          v-model="settingsStore.settings.albumCovers.saveEmbeddedArtworkAsPNG"
          class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
        />
        <span>{{ t('settings.saveEmbeddedAsPng') }}</span>
      </label>

      <!-- Save cover description using UTF8 -->
      <label class="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          v-model="settingsStore.settings.albumCovers.coverDescriptionUTF8"
          class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
        />
        <span>{{ t('settings.coverDescriptionUTF8') }}</span>
      </label>

        <!-- JPEG image quality -->
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('settings.jpegQuality') }}</label>
          <input
            v-model.number="settingsStore.settings.albumCovers.jpegImageQuality"
            type="number"
            min="1"
            max="100"
            placeholder="90"
            class="input w-full"
          />
          <p class="text-xs text-foreground-muted mt-1">{{ t('settings.jpegQualityDesc') }}</p>
        </div>
      </div>
    </section>

    <!-- Which tags to save -->
    <section v-if="isSectionVisible('tags')" class="card">
      <h2
        @click="toggleSection('tags')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
        {{ t('settings.tagsToSave') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.tags }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.tags" class="pt-6">
        <div class="grid grid-cols-2 gap-x-12 gap-y-3">
        <!-- Column 1 -->
        <div class="space-y-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.title"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.title') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.artist"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.artist') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.album"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.album') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.cover"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.cover') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.trackNumber"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.trackNumber') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.trackTotal"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.trackTotal') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.discNumber"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.discNumber') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.discTotal"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.discTotal') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.albumArtist"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.albumArtist') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.genre"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.genre') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.year"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.year') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.date"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.date') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.explicitLyrics"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.explicitLyrics') }}</span>
          </label>
        </div>

        <!-- Column 2 -->
        <div class="space-y-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.isrc"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.isrc') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.trackLength"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.trackLength') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.albumBarcode"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.albumBarcode') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.bpm"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.bpm') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.replayGain"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.replayGain') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.albumLabel"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.albumLabel') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.unsyncLyrics"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.unsyncLyrics') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.syncLyrics"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.syncLyrics') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.copyright"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.copyright') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.composer"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.composer') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.involvedPeople"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.involvedPeople') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.tags.sourceId"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.tags.sourceId') }}</span>
          </label>
        </div>
        </div>
      </div>
    </section>

    <!-- Other Settings -->
    <section v-if="isSectionVisible('other')" class="card">
      <h2
        @click="toggleSection('other')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        {{ t('settings.other') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.other }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.other" class="space-y-6 pt-6">
        <!-- Checkbox options - 2 columns -->
        <div class="grid grid-cols-2 gap-x-8 gap-y-3">
        <!-- Column 1 -->
        <div class="space-y-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.checkForUpdates"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.checkUpdates') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.savePlaylistAsCompilation"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.playlistAsCompilation') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.useNullSeparator"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.useNullSeparator') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.saveID3v1"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.saveId3v1') }}</span>
          </label>
        </div>

        <!-- Column 2 -->
        <div class="space-y-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.saveOnlyMainArtist"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.mainArtistOnly') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.keepVariousArtists"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.keepVA') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.removeAlbumVersion"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.removeAlbumVersion') }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              v-model="settingsStore.settings.removeArtistCombinations"
              class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
            />
            <span class="text-sm">{{ t('settings.removeArtistCombinations') }}</span>
          </label>
        </div>
      </div>

      <!-- Dropdown options -->
      <div class="grid grid-cols-2 gap-6 pt-4 border-t border-zinc-700/50">
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('settings.artistSeparator') }}</label>
          <select
            v-model="settingsStore.settings.artistSeparator"
            class="input w-full bg-background-main"
          >
            <option value="standard">{{ t('settings.separatorOptions.standard') }}</option>
            <option value="comma">{{ t('settings.separatorOptions.comma') }}</option>
            <option value="slash">{{ t('settings.separatorOptions.slash') }}</option>
            <option value="semicolon">{{ t('settings.separatorOptions.semicolon') }}</option>
            <option value="ampersand">{{ t('settings.separatorOptions.ampersand') }}</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('settings.flacDateFormat') }}</label>
          <select
            v-model="settingsStore.settings.dateFormatFlac"
            class="input w-full bg-background-main"
          >
            <option value="YYYY-MM-DD">YYYY-MM-DD</option>
            <option value="DD-MM-YYYY">DD-MM-YYYY</option>
            <option value="MM-DD-YYYY">MM-DD-YYYY</option>
            <option value="YYYY">YYYY</option>
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('settings.featuredArtists') }}</label>
          <select
            v-model="settingsStore.settings.featuredArtistsHandling"
            class="input w-full bg-background-main"
          >
            <option value="nothing">{{ t('settings.featOptions.nothing') }}</option>
            <option value="remove">{{ t('settings.featOptions.remove') }}</option>
            <option value="moveToTitle">{{ t('settings.featOptions.moveToTitle') }}</option>
            <option value="removeFromTitle">{{ t('settings.featOptions.removeFromTitle') }}</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('settings.titleCasing') }}</label>
          <select
            v-model="settingsStore.settings.titleCasing"
            class="input w-full bg-background-main"
          >
            <option value="unchanged">{{ t('settings.casingOptions.unchanged') }}</option>
            <option value="lowercase">{{ t('settings.casingOptions.lowercase') }}</option>
            <option value="uppercase">{{ t('settings.casingOptions.uppercase') }}</option>
            <option value="titlecase">{{ t('settings.casingOptions.titlecase') }}</option>
            <option value="sentencecase">{{ t('settings.casingOptions.sentencecase') }}</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('settings.artistCasing') }}</label>
          <select
            v-model="settingsStore.settings.artistCasing"
            class="input w-full bg-background-main"
          >
            <option value="unchanged">{{ t('settings.casingOptions.unchanged') }}</option>
            <option value="lowercase">{{ t('settings.casingOptions.lowercase') }}</option>
            <option value="uppercase">{{ t('settings.casingOptions.uppercase') }}</option>
            <option value="titlecase">{{ t('settings.casingOptions.titlecase') }}</option>
            <option value="sentencecase">{{ t('settings.casingOptions.sentencecase') }}</option>
          </select>
        </div>
      </div>

      <!-- Preview Volume -->
      <div class="pt-4 border-t border-zinc-700/50">
        <label class="block text-sm font-medium mb-3">
          {{ t('settings.previewVolume') }}: {{ settingsStore.settings.previewVolume }}%
        </label>
        <div class="flex items-center gap-4">
          <svg class="w-5 h-5 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
          <input
            type="range"
            min="0"
            max="100"
            v-model.number="settingsStore.settings.previewVolume"
            class="flex-1 h-2 bg-background-tertiary rounded-lg appearance-none cursor-pointer accent-primary-500"
          />
          <svg class="w-5 h-5 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
        </div>
      </div>

        <!-- executeAfterDownload removed - security risk (arbitrary command execution) -->
      </div>
    </section>

    <!-- Account Settings -->
    <section v-if="isSectionVisible('accounts')" class="card">
      <h2
        @click="toggleSection('accounts')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        {{ t('settings.deezerAccount') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.accounts }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.accounts" class="space-y-6 pt-6">
        <div>
        <label class="block text-sm font-medium mb-2">{{ t('login.arlToken') }}</label>
        <div class="flex gap-2">
          <input
            v-model="settingsStore.settings.arl"
            type="password"
            :placeholder="t('login.arlPlaceholder')"
            class="input flex-1"
            @keyup.enter="applyArl"
          />
          <!-- Paste Button -->
          <button
            type="button"
            @click="pasteArl"
            class="btn btn-secondary"
            title="Paste from clipboard"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </button>
          <button
            @click="applyArl"
            :disabled="arlLoading"
            class="btn btn-primary px-6"
            :class="{ 'opacity-50 cursor-not-allowed': arlLoading }"
          >
            <span v-if="arlLoading" class="flex items-center gap-2">
              <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ t('settings.applying') }}
            </span>
            <span v-else>{{ t('settings.apply') }}</span>
          </button>
        </div>
        <!-- Status message -->
        <div v-if="arlMessage" class="mt-2 flex items-center gap-2">
          <svg v-if="arlStatus === 'success'" class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <svg v-else-if="arlStatus === 'error'" class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span :class="arlStatus === 'success' ? 'text-green-400' : 'text-red-400'" class="text-sm">
            {{ arlMessage }}
          </span>
        </div>
          <p class="text-sm text-foreground-muted mt-2">
            {{ t('settings.arlRequired') }}
          </p>
        </div>
      </div>
    </section>

    <!-- Spotify Integration -->
    <section v-if="isSectionVisible('spotify')" class="card">
      <h2
        @click="toggleSection('spotify')"
        class="text-lg font-semibold border-b border-zinc-700 pb-2 flex items-center gap-2 cursor-pointer hover:text-primary-400 transition-colors select-none"
      >
        <svg class="w-5 h-5 text-[#1DB954]" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
        </svg>
        {{ t('settings.spotify.title') }}
        <svg
          class="w-4 h-4 ml-auto transition-transform duration-200"
          :class="{ 'rotate-180': expandedSections.spotify }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </h2>

      <div v-show="expandedSections.spotify" class="space-y-6 pt-6">
        <p class="text-sm text-foreground-muted">
        {{ t('settings.spotify.description') }}
      </p>

      <!-- Client ID -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.spotify.clientId') }}</label>
        <div class="flex gap-2">
          <input
            v-model="spotifyClientId"
            type="text"
            :placeholder="t('settings.spotify.clientIdPlaceholder')"
            class="input flex-1 font-mono text-sm"
          />
          <button
            type="button"
            @click="pasteSpotifyClientId"
            class="btn btn-secondary"
            title="Paste from clipboard"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Client Secret -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.spotify.clientSecret') }}</label>
        <div class="flex gap-2">
          <input
            v-model="spotifyClientSecret"
            type="password"
            :placeholder="t('settings.spotify.clientSecretPlaceholder')"
            class="input flex-1 font-mono text-sm"
          />
          <button
            type="button"
            @click="pasteSpotifyClientSecret"
            class="btn btn-secondary"
            title="Paste from clipboard"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Spotify Username -->
      <div>
        <label class="block text-sm font-medium mb-2">{{ t('settings.spotify.username') }}</label>
        <input
          v-model="spotifyUsername"
          type="text"
          :placeholder="t('settings.spotify.usernamePlaceholder')"
          class="input w-full font-mono text-sm"
        />
        <p class="text-xs text-foreground-muted mt-1">{{ t('settings.spotify.usernameHelp') }}</p>
      </div>

      <!-- Test Connection Button -->
      <div class="flex items-center gap-4">
        <button
          @click="testSpotifyConnection"
          :disabled="spotifyLoading"
          class="btn btn-primary"
          :class="{ 'opacity-50 cursor-not-allowed': spotifyLoading }"
        >
          <span v-if="spotifyLoading" class="flex items-center gap-2">
            <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ t('settings.spotify.testing') }}
          </span>
          <span v-else>{{ t('settings.spotify.testConnection') }}</span>
        </button>

        <!-- Status message -->
        <div v-if="spotifyMessage" class="flex items-center gap-2">
          <svg v-if="spotifyStatus === 'success'" class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <svg v-else-if="spotifyStatus === 'error'" class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span :class="spotifyStatus === 'success' ? 'text-green-400' : 'text-red-400'" class="text-sm">
            {{ spotifyMessage }}
          </span>
        </div>
      </div>

      <!-- Fallback search toggle -->
      <label class="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          v-model="settingsStore.settings.spotifyFallbackSearch"
          class="w-4 h-4 rounded border-zinc-600 text-primary-500 focus:ring-primary-500 bg-background-main"
        />
        <div>
          <span class="text-sm">{{ t('settings.spotify.fallbackSearch') }}</span>
          <p class="text-xs text-foreground-muted">{{ t('settings.spotify.fallbackSearchDesc') }}</p>
        </div>
      </label>

        <!-- Help links -->
        <div class="pt-4 border-t border-zinc-700/50 space-y-3">
          <button
            @click="openSpotifyInfo"
            class="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-2 transition-colors"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {{ t('settings.spotify.howToEnable') }}
          </button>
          <button
            @click="openSpotifyDeveloper"
            class="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-2 transition-colors"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            {{ t('settings.spotify.getCredentials') }}
          </button>
          <p class="text-xs text-foreground-muted mt-2">
            {{ t('settings.spotify.credentialsHelp') }}
          </p>
        </div>
      </div>
    </section>

    <!-- Reset -->
    <div class="flex justify-end gap-2">
      <button
        @click="settingsStore.resetSettings()"
        class="btn btn-ghost text-red-400 hover:text-red-300"
      >
        {{ t('settings.resetToDefaults') }}
      </button>
    </div>
  </div>
</template>
