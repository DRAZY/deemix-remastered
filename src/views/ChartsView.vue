<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { deezerAPI } from '../services/deezerAPI'
import { useDownloadStore } from '../stores/downloadStore'
import { useAuthStore } from '../stores/authStore'
import TrackCard from '../components/TrackCard.vue'
import AlbumCard from '../components/AlbumCard.vue'
import ArtistCard from '../components/ArtistCard.vue'
import BackButton from '../components/BackButton.vue'
import type { Track, Album, Artist, Playlist } from '../types'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const downloadStore = useDownloadStore()
const authStore = useAuthStore()

const activeTab = ref<'tracks' | 'albums' | 'artists' | 'playlists'>('tracks')
const isLoading = ref(true)
const isLoadingCountries = ref(true)
const showCountryDropdown = ref(false)

// Country selection
const countries = ref<{ id: string; name: string; code: string }[]>([])
const selectedCountry = ref<{ id: string; name: string; code: string }>({ id: '0', name: 'Worldwide', code: 'WW' })

const charts = ref<{
  tracks: Track[]
  albums: Album[]
  artists: Artist[]
  playlists: Playlist[]
}>({
  tracks: [],
  albums: [],
  artists: [],
  playlists: []
})

// Check if we're viewing worldwide charts (which have all tabs) or country charts (tracks only)
const isWorldwide = computed(() => selectedCountry.value.id === '0')

const allTabs = [
  { id: 'tracks', label: t('charts.tracks'), icon: 'M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3' },
  { id: 'albums', label: t('charts.albums'), icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
  { id: 'artists', label: t('charts.artists'), icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
  { id: 'playlists', label: t('charts.playlists'), icon: 'M4 6h16M4 10h16M4 14h16M4 18h16' }
]

// Country charts only have tracks, worldwide has all types
const tabs = computed(() => isWorldwide.value ? allTabs : [allTabs[0]])

const currentCount = computed(() => {
  return charts.value[activeTab.value]?.length || 0
})

// Filter countries for search
const countrySearch = ref('')
const filteredCountries = computed(() => {
  if (!countrySearch.value) return countries.value
  const search = countrySearch.value.toLowerCase()
  return countries.value.filter(c =>
    c.name.toLowerCase().includes(search) ||
    c.code.toLowerCase().includes(search)
  )
})

onMounted(async () => {
  // Set initial tab from route query — if a type is specified (e.g. from
  // Home "See all" links), force Worldwide so all tabs are available
  if (route.query.type) {
    const type = route.query.type as string
    if (['tracks', 'albums', 'artists', 'playlists'].includes(type)) {
      activeTab.value = type as typeof activeTab.value
      // Reset to Worldwide so the requested tab is visible
      selectedCountry.value = { id: '0', name: 'Worldwide', code: 'WW' }
    }
  } else {
    // No type specified — restore saved country from localStorage
    const savedCountryId = localStorage.getItem('charts_country_id')
    const savedCountryName = localStorage.getItem('charts_country_name')
    const savedCountryCode = localStorage.getItem('charts_country_code')

    if (savedCountryId && savedCountryName && savedCountryCode) {
      selectedCountry.value = { id: savedCountryId, name: savedCountryName, code: savedCountryCode }
    }
  }

  // Load countries list
  await loadCountries()

  // Load charts for selected country
  await loadAllCharts()
})

watch(() => route.query.type, (newType) => {
  if (newType && ['tracks', 'albums', 'artists', 'playlists'].includes(newType as string)) {
    activeTab.value = newType as typeof activeTab.value
  }
})

async function loadCountries() {
  isLoadingCountries.value = true
  try {
    countries.value = await deezerAPI.getChartCountries()
  } catch (error) {
    console.error('Failed to load countries:', error)
    // Fallback to just worldwide
    countries.value = [{ id: '0', name: 'Worldwide', code: 'WW' }]
  } finally {
    isLoadingCountries.value = false
  }
}

async function loadAllCharts() {
  isLoading.value = true

  try {
    const isWorldwide = selectedCountry.value.id === '0'

    if (isWorldwide) {
      // For worldwide charts, load all types from /chart/0/{type}
      const [tracksData, albumsData, artistsData, playlistsData] = await Promise.all([
        deezerAPI.getChartFromServer('tracks', '0', 100),
        deezerAPI.getChartFromServer('albums', '0', 100),
        deezerAPI.getChartFromServer('artists', '0', 100),
        deezerAPI.getChartFromServer('playlists', '0', 100)
      ])

      charts.value = {
        tracks: tracksData,
        albums: albumsData,
        artists: artistsData,
        playlists: playlistsData
      }

      console.log(`[ChartsView] Loaded Worldwide charts - Tracks: ${tracksData.length}, Albums: ${albumsData.length}, Artists: ${artistsData.length}, Playlists: ${playlistsData.length}`)
    } else {
      // For country charts, only tracks are available (it's a playlist)
      const tracksData = await deezerAPI.getChartFromServer('tracks', selectedCountry.value.id, 100)

      charts.value = {
        tracks: tracksData,
        albums: [], // Country charts only have tracks
        artists: [],
        playlists: []
      }

      // Auto-switch to tracks tab for country charts
      if (activeTab.value !== 'tracks') {
        activeTab.value = 'tracks'
        router.replace({ query: { type: 'tracks' } })
      }

      console.log(`[ChartsView] Loaded ${selectedCountry.value.name} chart - Tracks: ${tracksData.length}`)
    }
  } catch (error) {
    console.error('Failed to load charts:', error)
  } finally {
    isLoading.value = false
  }
}

function changeTab(tab: typeof activeTab.value) {
  activeTab.value = tab
  router.replace({ query: { type: tab } })
}

async function selectCountry(country: { id: string; name: string; code: string }) {
  selectedCountry.value = country
  showCountryDropdown.value = false
  countrySearch.value = ''

  // Save to localStorage
  localStorage.setItem('charts_country_id', country.id)
  localStorage.setItem('charts_country_name', country.name)
  localStorage.setItem('charts_country_code', country.code)

  // Reload charts
  await loadAllCharts()
}

async function downloadChart() {
  if (!authStore.isLoggedIn) {
    alert(t('charts.loginRequired'))
    return
  }

  const tracks = charts.value.tracks
  if (tracks.length === 0) {
    return
  }

  // Download each track in the chart
  for (const track of tracks) {
    await downloadStore.addDownload({
      id: track.id,
      title: track.title,
      artist: track.artist || { id: 0, name: 'Unknown Artist' },
      album: track.album,
      duration: track.duration || 0,
      cover: track.album?.cover_medium || ''
    })
  }
}

// Close dropdown when clicking outside
function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (!target.closest('.country-selector')) {
    showCountryDropdown.value = false
  }
}

// Get country flag emoji from country code
function getCountryFlag(code: string): string {
  if (code === 'WW') return '🌍'
  // Convert country code to flag emoji
  const codePoints = code
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0))
  return String.fromCodePoint(...codePoints)
}
</script>

<template>
  <div class="space-y-6" @click="handleClickOutside">
    <!-- Back Button -->
    <BackButton />

    <!-- Header with Country Selector -->
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div class="flex items-center gap-4">
        <h1 class="text-2xl font-bold">{{ t('charts.title') }}</h1>

        <!-- Country Selector -->
        <div class="country-selector relative">
          <button
            @click.stop="showCountryDropdown = !showCountryDropdown"
            class="flex items-center gap-2 px-3 py-2 bg-background-secondary rounded-lg hover:bg-background-tertiary transition-colors"
          >
            <span class="text-lg">{{ getCountryFlag(selectedCountry.code) }}</span>
            <span class="font-medium">{{ selectedCountry.name }}</span>
            <svg
              class="w-4 h-4 transition-transform"
              :class="{ 'rotate-180': showCountryDropdown }"
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <!-- Country Dropdown -->
          <div
            v-if="showCountryDropdown"
            class="absolute top-full left-0 mt-2 w-72 max-h-96 bg-background-secondary rounded-lg shadow-xl border border-zinc-700 overflow-hidden z-50"
            @click.stop
          >
            <!-- Search -->
            <div class="p-2 border-b border-zinc-700">
              <input
                v-model="countrySearch"
                type="text"
                :placeholder="t('charts.searchCountry')"
                class="w-full px-3 py-2 bg-background-main rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>

            <!-- Country List -->
            <div class="overflow-y-auto max-h-72">
              <button
                v-for="country in filteredCountries"
                :key="country.id + country.code"
                @click="selectCountry(country)"
                class="w-full flex items-center gap-3 px-4 py-2 hover:bg-background-tertiary transition-colors text-left"
                :class="{ 'bg-primary-500/20': country.id === selectedCountry.id && country.code === selectedCountry.code }"
              >
                <span class="text-lg">{{ getCountryFlag(country.code) }}</span>
                <span>{{ country.name }}</span>
              </button>

              <div v-if="filteredCountries.length === 0" class="px-4 py-3 text-foreground-muted text-sm">
                {{ t('charts.noCountriesFound') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Download Chart Button -->
      <button
        v-if="activeTab === 'tracks' && charts.tracks.length > 0 && authStore.isLoggedIn"
        @click="downloadChart"
        class="flex items-center gap-2 px-4 py-2 bg-primary-500 hover:bg-primary-600 rounded-lg font-medium transition-colors"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {{ t('charts.downloadChart') }}
      </button>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2 flex-wrap border-b border-zinc-700 pb-4">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        @click="changeTab(tab.id as typeof activeTab)"
        class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        :class="activeTab === tab.id
          ? 'bg-primary-500 text-white'
          : 'bg-background-tertiary text-foreground-muted hover:text-foreground'"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="tab.icon" />
        </svg>
        {{ tab.label }}
        <span
          v-if="charts[tab.id as keyof typeof charts]?.length"
          class="text-xs px-1.5 py-0.5 rounded-full"
          :class="activeTab === tab.id ? 'bg-white/20' : 'bg-background-main'"
        >
          {{ charts[tab.id as keyof typeof charts].length }}
        </span>
      </button>
    </div>

    <!-- Loading State -->
    <div v-if="isLoading" class="flex items-center justify-center py-20">
      <div class="animate-spin w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
    </div>

    <!-- Content -->
    <div v-else>
      <!-- Top Tracks -->
      <section v-if="activeTab === 'tracks'" class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">
            {{ t('charts.topTracksIn', { country: selectedCountry.name, count: currentCount }) }}
          </h2>
        </div>
        <div class="space-y-1">
          <TrackCard
            v-for="(track, index) in charts.tracks"
            :key="track.id"
            :track="track"
            :index="index + 1"
          />
        </div>
      </section>

      <!-- Top Albums -->
      <section v-if="activeTab === 'albums'" class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">
            {{ t('charts.topAlbumsIn', { country: selectedCountry.name, count: currentCount }) }}
          </h2>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          <AlbumCard
            v-for="album in charts.albums"
            :key="album.id"
            :album="album"
          />
        </div>
      </section>

      <!-- Top Artists -->
      <section v-if="activeTab === 'artists'" class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">
            {{ t('charts.topArtistsIn', { country: selectedCountry.name, count: currentCount }) }}
          </h2>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          <ArtistCard
            v-for="artist in charts.artists"
            :key="artist.id"
            :artist="artist"
          />
        </div>
      </section>

      <!-- Top Playlists -->
      <section v-if="activeTab === 'playlists'" class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">
            {{ t('charts.topPlaylistsIn', { country: selectedCountry.name, count: currentCount }) }}
          </h2>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          <AlbumCard
            v-for="playlist in charts.playlists"
            :key="playlist.id"
            :album="{
              id: playlist.id,
              title: playlist.title,
              cover_medium: playlist.picture_medium,
              artist: { id: 0, name: playlist.creator?.name || (playlist as any).user?.name || 'Deezer' },
              nb_tracks: playlist.nb_tracks
            }"
            type="playlist"
          />
        </div>
      </section>

      <!-- Empty State -->
      <div v-if="currentCount === 0" class="text-center py-20">
        <svg class="w-16 h-16 mx-auto text-foreground-muted mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
            d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
        <p class="text-foreground-muted">{{ t('charts.noChartData') }}</p>
      </div>
    </div>
  </div>
</template>
