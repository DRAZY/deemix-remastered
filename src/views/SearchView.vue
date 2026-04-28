<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { deezerAPI } from '../services/deezerAPI'
import { useSearchHistory } from '../composables/useSearchHistory'
import { useDownloadStore } from '../stores/downloadStore'
import { useAuthStore } from '../stores/authStore'
import { useToastStore } from '../stores/toastStore'
import TrackCard from '../components/TrackCard.vue'
import AlbumCard from '../components/AlbumCard.vue'
import ArtistCard from '../components/ArtistCard.vue'
import BackButton from '../components/BackButton.vue'
import SkeletonLoader from '../components/SkeletonLoader.vue'
import ErrorState from '../components/ErrorState.vue'
import EmptyState from '../components/EmptyState.vue'
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu } from '../composables/useContextMenu'
import type { Track, Album, Artist, Playlist } from '../types'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const downloadStore = useDownloadStore()
const authStore = useAuthStore()
const toastStore = useToastStore()
const serverPort = ref(6595)
const isBulkDownloading = ref(false)
const bulkAborted = ref(false)

const searchQuery = ref('')
const activeTab = ref<'all' | 'track' | 'album' | 'artist' | 'playlist'>('all')
const isLoading = ref(false)
const hasError = ref(false)
const showHistory = ref(false)

// Batch selection state
const isSelectionMode = ref(false)
const selectedTracks = ref<Set<number | string>>(new Set())
const selectedAlbums = ref<Set<number | string>>(new Set())

const selectedCount = computed(() => selectedTracks.value.size + selectedAlbums.value.size)

function toggleSelectionMode() {
  isSelectionMode.value = !isSelectionMode.value
  if (!isSelectionMode.value) {
    selectedTracks.value.clear()
    selectedAlbums.value.clear()
  }
}

function toggleTrackSelection(trackId: number | string) {
  if (selectedTracks.value.has(trackId)) {
    selectedTracks.value.delete(trackId)
  } else {
    selectedTracks.value.add(trackId)
  }
}

function toggleAlbumSelection(albumId: number | string) {
  if (selectedAlbums.value.has(albumId)) {
    selectedAlbums.value.delete(albumId)
  } else {
    selectedAlbums.value.add(albumId)
  }
}

function selectAllTracks() {
  results.value.tracks.forEach(track => selectedTracks.value.add(track.id))
}

function selectAllAlbums() {
  results.value.albums.forEach(album => selectedAlbums.value.add(album.id))
}

function clearSelection() {
  selectedTracks.value.clear()
  selectedAlbums.value.clear()
}

const isDownloadingSelected = ref(false)

async function downloadSelected() {
  if (selectedCount.value === 0) return

  isDownloadingSelected.value = true
  const trackCount = selectedTracks.value.size
  const albumCount = selectedAlbums.value.size

  try {
    // Download selected tracks
    for (const trackId of selectedTracks.value) {
      const track = results.value.tracks.find(t => t.id === trackId)
      if (track) {
        await downloadStore.addDownload(track)
      }
    }

    // Download selected albums
    for (const albumId of selectedAlbums.value) {
      const album = results.value.albums.find(a => a.id === albumId)
      if (album) {
        const tracks = await deezerAPI.getAlbumTracks(albumId)
        await downloadStore.addAlbumDownload(album, tracks)
      }
    }

    toastStore.success(`Added ${trackCount + albumCount} item${trackCount + albumCount > 1 ? 's' : ''} to download queue`)

    // Clear selection and exit selection mode
    clearSelection()
    isSelectionMode.value = false
  } catch (error) {
    console.error('Failed to download selected:', error)
    toastStore.error('Failed to add some items to download queue')
  } finally {
    isDownloadingSelected.value = false
  }
}

const { searchHistory, addToHistory, removeFromHistory, clearHistory } = useSearchHistory()

function selectFromHistory(query: string) {
  searchQuery.value = query
  showHistory.value = false
  performSearch()
}

function handleSearchFocus() {
  if (searchHistory.value.length > 0 && !searchQuery.value.trim()) {
    showHistory.value = true
  }
}

function handleSearchBlur() {
  // Delay to allow click on history items
  setTimeout(() => {
    showHistory.value = false
  }, 200)
}

// Pagination state for each type
const RESULTS_PER_PAGE = 50
const pagination = ref({
  tracks: { index: 0, hasMore: true, loading: false, total: 0 },
  albums: { index: 0, hasMore: true, loading: false, total: 0 },
  artists: { index: 0, hasMore: true, loading: false, total: 0 },
  playlists: { index: 0, hasMore: true, loading: false, total: 0 }
})

const results = ref<{
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

const tabs = computed(() => [
  { id: 'all', label: t('search.all') },
  { id: 'track', label: t('search.tracks') },
  { id: 'album', label: t('search.albums') },
  { id: 'artist', label: t('search.artists') },
  { id: 'playlist', label: t('search.playlists') }
])

// Result counts for tabs
const resultCounts = computed(() => ({
  tracks: pagination.value.tracks.total || results.value.tracks.length,
  albums: pagination.value.albums.total || results.value.albums.length,
  artists: pagination.value.artists.total || results.value.artists.length,
  playlists: pagination.value.playlists.total || results.value.playlists.length
}))

onMounted(async () => {
  if (window.electronAPI) {
    serverPort.value = await window.electronAPI.getServerPort()
  }
  if (route.query.paste) {
    // Global paste routed here — trigger bulk download
    const pasteText = route.query.paste as string
    searchQuery.value = pasteText
    // Simulate a paste event to trigger handlePaste
    setTimeout(() => {
      const fakeEvent = { clipboardData: { getData: () => pasteText }, preventDefault: () => {} } as any
      handlePaste(fakeEvent)
    }, 500)
  } else if (route.query.q) {
    searchQuery.value = route.query.q as string
    performSearch()
  }
  if (route.query.type) {
    activeTab.value = route.query.type as typeof activeTab.value
  }

  // Abort bulk download if user clears all downloads
  watch(() => downloadStore.downloads.length, (newLen) => {
    if (newLen === 0 && isBulkDownloading.value) {
      bulkAborted.value = true
    }
  })
})

watch(() => route.query.q, (newQuery) => {
  if (newQuery && newQuery !== searchQuery.value) {
    searchQuery.value = newQuery as string
    performSearch()
  }
})

function resetPagination() {
  pagination.value = {
    tracks: { index: 0, hasMore: true, loading: false, total: 0 },
    albums: { index: 0, hasMore: true, loading: false, total: 0 },
    artists: { index: 0, hasMore: true, loading: false, total: 0 },
    playlists: { index: 0, hasMore: true, loading: false, total: 0 }
  }
  results.value = { tracks: [], albums: [], artists: [], playlists: [] }
}

async function performSearch() {
  if (!searchQuery.value.trim()) return

  // Detect Deezer/Spotify links and redirect to Link Analyzer
  const query = searchQuery.value.trim()
  if (query.includes('deezer.com') || query.includes('link.deezer.com') ||
      query.includes('deezer.page.link') || query.includes('spotify.com') ||
      query.includes('spotify.link')) {
    router.push({ path: '/analyzer', query: { url: query } })
    return
  }

  isLoading.value = true
  hasError.value = false
  showHistory.value = false
  resetPagination()
  addToHistory(searchQuery.value)
  router.replace({ query: { q: searchQuery.value, type: activeTab.value } })

  try {
    if (activeTab.value === 'all') {
      // Load initial results for all types with pagination info
      const [tracksResult, albumsResult, artistsResult, playlistsResult] = await Promise.all([
        deezerAPI.searchWithPagination(searchQuery.value, 'track', 20),
        deezerAPI.searchWithPagination(searchQuery.value, 'album', 20),
        deezerAPI.searchWithPagination(searchQuery.value, 'artist', 20),
        deezerAPI.searchWithPagination(searchQuery.value, 'playlist', 20)
      ])

      results.value = {
        tracks: tracksResult.data,
        albums: albumsResult.data,
        artists: artistsResult.data,
        playlists: playlistsResult.data
      }

      pagination.value = {
        tracks: { index: tracksResult.nextIndex, hasMore: tracksResult.hasMore, loading: false, total: tracksResult.total },
        albums: { index: albumsResult.nextIndex, hasMore: albumsResult.hasMore, loading: false, total: albumsResult.total },
        artists: { index: artistsResult.nextIndex, hasMore: artistsResult.hasMore, loading: false, total: artistsResult.total },
        playlists: { index: playlistsResult.nextIndex, hasMore: playlistsResult.hasMore, loading: false, total: playlistsResult.total }
      }
    } else {
      // Load more results for specific type
      const result = await deezerAPI.searchWithPagination(searchQuery.value, activeTab.value, RESULTS_PER_PAGE)

      results.value = {
        tracks: activeTab.value === 'track' ? result.data : [],
        albums: activeTab.value === 'album' ? result.data : [],
        artists: activeTab.value === 'artist' ? result.data : [],
        playlists: activeTab.value === 'playlist' ? result.data : []
      }

      const typeKey = activeTab.value === 'track' ? 'tracks' :
                      activeTab.value === 'album' ? 'albums' :
                      activeTab.value === 'artist' ? 'artists' : 'playlists'

      pagination.value[typeKey] = {
        index: result.nextIndex,
        hasMore: result.hasMore,
        loading: false,
        total: result.total
      }
    }
  } catch (error) {
    console.error('Search failed:', error)
    hasError.value = true
  } finally {
    isLoading.value = false
  }
}

async function loadMore(type: 'track' | 'album' | 'artist' | 'playlist') {
  const typeKey = type === 'track' ? 'tracks' :
                  type === 'album' ? 'albums' :
                  type === 'artist' ? 'artists' : 'playlists'

  if (!pagination.value[typeKey].hasMore || pagination.value[typeKey].loading) return

  pagination.value[typeKey].loading = true

  try {
    const result = await deezerAPI.searchWithPagination(
      searchQuery.value,
      type,
      RESULTS_PER_PAGE,
      pagination.value[typeKey].index
    )

    // Append new results
    results.value[typeKey] = [...results.value[typeKey], ...result.data]

    pagination.value[typeKey] = {
      index: result.nextIndex,
      hasMore: result.hasMore,
      loading: false,
      total: result.total
    }
  } catch (error) {
    console.error(`Failed to load more ${type}s:`, error)
    pagination.value[typeKey].loading = false
  }
}

// Extract Deezer URLs from text (supports newlines, spaces, commas as separators)
function extractDeezerUrls(text: string): Array<{ type: string; id: string }> {
  const links: Array<{ type: string; id: string }> = []
  // Match standard Deezer URLs
  const urlPattern = /(?:https?:\/\/)?(?:www\.)?deezer\.com(?:\/[a-z]{2})?\/(track|album|artist|playlist)\/(\d+)/gi
  let match
  while ((match = urlPattern.exec(text)) !== null) {
    links.push({ type: match[1].toLowerCase(), id: match[2] })
  }
  return links
}

async function handlePaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text') || ''
  const links = extractDeezerUrls(text)

  // Only trigger bulk mode if 2+ links found
  if (links.length < 2) return

  // Prevent the paste from going into the search input
  e.preventDefault()

  if (!authStore.isLoggedIn) {
    toastStore.error('Login required to download')
    return
  }

  isBulkDownloading.value = true
  bulkAborted.value = false
  toastStore.info(`Processing ${links.length} links...`)
  await downloadStore.syncSettingsToServer()

  let queued = 0
  let failed = 0

  for (const link of links) {
    // Check if user canceled all downloads during bulk processing
    if (bulkAborted.value) {
      console.log('[Search] Bulk download aborted by user')
      break
    }
    try {
      const id = parseInt(link.id)

      if (link.type === 'track') {
        // Fetch track info and add through download store for proper tracking
        const trackData = await deezerAPI.getTrack(id)
        if (trackData?.id) {
          await downloadStore.addDownload(trackData, { skipSync: true })
          queued++
        } else {
          failed++
        }
      } else if (link.type === 'album') {
        const albumData = await deezerAPI.getAlbum(id)
        const tracks = await deezerAPI.getAlbumTracks(id)
        if (albumData?.id && tracks?.length > 0) {
          await downloadStore.addAlbumDownload(albumData, tracks)
          queued++
        } else {
          failed++
        }
      } else if (link.type === 'playlist') {
        const playlistData = await deezerAPI.getPlaylist(id)
        const tracks = await deezerAPI.getPlaylistTracks(id)
        if (playlistData?.id && tracks?.length > 0) {
          await downloadStore.addPlaylistDownload(playlistData, tracks)
          queued++
        } else {
          failed++
        }
      } else if (link.type === 'artist') {
        // Download full discography — fetch artist info + all albums
        const artistInfo = await deezerAPI.getArtist(id)
        const albums = await deezerAPI.getArtistAlbums(id)
        if (albums.length > 0) {
          let albumsQueued = 0
          let albumsFailed = 0
          for (const album of albums) {
            if (bulkAborted.value) break
            try {
              // Inject artist info — /artist/{id}/albums doesn't include it
              if (!album.artist && artistInfo) {
                album.artist = { id: artistInfo.id, name: artistInfo.name }
              }
              const tracks = await deezerAPI.getAlbumTracks(album.id)
              if (tracks?.length > 0) {
                await downloadStore.addAlbumDownload(album, tracks)
                albumsQueued++
              } else {
                console.warn(`[Search] Album ${album.id} "${album.title}" has no tracks — skipping`)
                albumsFailed++
              }
            } catch (e: any) {
              console.error(`[Search] Failed to queue album ${album.id} "${album.title}":`, e.message || e)
              albumsFailed++
            }
          }
          if (albumsQueued > 0) queued++
          else failed++
          if (albumsFailed > 0) {
            console.warn(`[Search] Artist ${artistInfo?.name}: ${albumsQueued} albums queued, ${albumsFailed} failed/skipped`)
          }
        } else {
          failed++
        }
      }
    } catch (err) {
      console.error(`[Search] Bulk download failed for ${link.type}/${link.id}:`, err)
      failed++
    }
  }

  isBulkDownloading.value = false

  if (queued > 0) {
    toastStore.success(`Queued ${queued} item${queued > 1 ? 's' : ''} from ${links.length} links${failed > 0 ? ` (${failed} failed)` : ''}`)
  } else {
    toastStore.error('No downloads could be queued — check that you are logged in')
  }
}

function handleSearch() {
  performSearch()
}

function changeTab(tab: typeof activeTab.value) {
  activeTab.value = tab
  if (searchQuery.value) {
    performSearch()
  }
}

const hasResults = () => {
  return results.value.tracks.length > 0 ||
         results.value.albums.length > 0 ||
         results.value.artists.length > 0 ||
         results.value.playlists.length > 0
}

// Context menu for search input and results
const { menuState, openMenu, closeMenu, copyToClipboard, pasteFromClipboard } = useContextMenu()
const contextMenuMode = ref<'input' | 'result'>('input')
const contextMenuValue = ref('')
const contextMenuLabel = ref('')

function openSearchInputMenu(e: MouseEvent) {
  contextMenuMode.value = 'input'
  openMenu(e)
}

const contextMenuItems = computed(() => {
  if (contextMenuMode.value === 'input') {
    return [
      {
        label: t('contextMenu.paste'),
        icon: 'paste',
        action: async () => {
          const text = await pasteFromClipboard()
          if (text) {
            searchQuery.value = text
          }
        }
      },
      {
        label: t('contextMenu.copy'),
        icon: 'copy',
        action: () => copyToClipboard(searchQuery.value),
        disabled: !searchQuery.value
      }
    ]
  }
  return [
    {
      label: `${t('contextMenu.copyTitle').replace('Title', contextMenuLabel.value)}`,
      icon: 'copy',
      action: () => copyToClipboard(contextMenuValue.value, contextMenuLabel.value)
    }
  ]
})

</script>

<template>
  <div class="space-y-6">
    <!-- Back Button -->
    <BackButton />

    <!-- Search Header -->
    <div class="sticky top-0 z-10 bg-background-main pt-2 pb-4">
      <form @submit.prevent="handleSearch" class="mb-4">
          <div class="relative">
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('search.placeholder')"
              class="input pl-12 text-lg"
              @paste="handlePaste"
              @focus="handleSearchFocus"
              @blur="handleSearchBlur"
              @contextmenu="openSearchInputMenu"
            />
            <svg
              class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>

          <!-- Search History Dropdown -->
          <div
            v-if="showHistory && searchHistory.length > 0"
            class="absolute top-full left-0 right-0 mt-1 bg-background-secondary rounded-lg shadow-xl border border-white/10 overflow-hidden z-20"
          >
            <div class="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <span class="text-xs text-foreground-muted">{{ t('search.recentSearches') }}</span>
              <button
                type="button"
                @click.stop="clearHistory"
                class="text-xs text-foreground-muted hover:text-red-400 transition-colors"
              >
                {{ t('search.clearHistory') }}
              </button>
            </div>
            <div class="max-h-64 overflow-y-auto">
              <button
                v-for="query in searchHistory"
                :key="query"
                type="button"
                @click.stop="selectFromHistory(query)"
                class="w-full px-3 py-2 text-left hover:bg-white/5 flex items-center gap-3 group"
              >
                <svg class="w-4 h-4 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span class="flex-1 truncate">{{ query }}</span>
                <button
                  type="button"
                  @click.stop="removeFromHistory(query)"
                  class="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-all"
                >
                  <svg class="w-4 h-4 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </button>
            </div>
          </div>
          </div>
      </form>

      <!-- Tabs with result counts -->
      <div class="flex items-center justify-between gap-4">
        <div class="flex gap-2 flex-wrap">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            @click="changeTab(tab.id as typeof activeTab)"
            class="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            :class="activeTab === tab.id
              ? 'bg-primary-500 text-white'
              : 'bg-background-tertiary text-foreground-muted hover:text-foreground'"
          >
            {{ tab.label }}
            <span
              v-if="tab.id !== 'all' && resultCounts[tab.id + 's' as keyof typeof resultCounts] > 0"
              class="text-xs px-1.5 py-0.5 rounded-full"
              :class="activeTab === tab.id ? 'bg-white/20' : 'bg-background-main'"
            >
              {{ resultCounts[tab.id + 's' as keyof typeof resultCounts].toLocaleString() }}
            </span>
          </button>
        </div>

        <!-- Selection Mode Toggle -->
        <button
          v-if="results.tracks.length > 0 || results.albums.length > 0"
          @click="toggleSelectionMode"
          class="px-3 py-2 text-sm rounded-lg transition-colors flex items-center gap-2"
          :class="isSelectionMode ? 'bg-primary-500 text-white' : 'bg-background-tertiary text-foreground-muted hover:text-foreground'"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          {{ isSelectionMode ? t('search.cancelSelection') : t('search.select') }}
        </button>
      </div>

      <!-- Selection Toolbar -->
      <div
        v-if="isSelectionMode"
        class="flex items-center justify-between bg-background-tertiary rounded-lg px-4 py-2 mt-3"
      >
        <div class="flex items-center gap-4">
          <span class="text-sm text-foreground-muted">
            {{ selectedCount }} {{ t('search.selected') }}
          </span>
          <button
            v-if="results.tracks.length > 0 && (activeTab === 'all' || activeTab === 'track')"
            @click="selectAllTracks"
            class="text-sm text-primary-400 hover:text-primary-300"
          >
            {{ t('search.selectAllTracks') }}
          </button>
          <button
            v-if="results.albums.length > 0 && (activeTab === 'all' || activeTab === 'album')"
            @click="selectAllAlbums"
            class="text-sm text-primary-400 hover:text-primary-300"
          >
            {{ t('search.selectAllAlbums') }}
          </button>
          <button
            v-if="selectedCount > 0"
            @click="clearSelection"
            class="text-sm text-foreground-muted hover:text-foreground"
          >
            {{ t('search.clearSelection') }}
          </button>
        </div>
        <button
          v-if="selectedCount > 0"
          @click="downloadSelected"
          :disabled="isDownloadingSelected"
          class="btn btn-primary text-sm flex items-center gap-2"
        >
          <svg v-if="!isDownloadingSelected" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <div v-else class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          {{ t('search.downloadSelected') }}
        </button>
      </div>
    </div>

    <!-- Loading State with Skeletons -->
    <div v-if="isLoading" class="space-y-8">
      <!-- Tracks Skeleton -->
      <section>
        <div class="skeleton-loader h-6 w-24 rounded mb-4" style="background: var(--color-background-secondary)" />
        <SkeletonLoader type="track" :count="5" />
      </section>
      <!-- Albums Skeleton -->
      <section>
        <div class="skeleton-loader h-6 w-24 rounded mb-4" style="background: var(--color-background-secondary)" />
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <SkeletonLoader type="card" v-for="i in 5" :key="i" />
        </div>
      </section>
    </div>

    <!-- Error State -->
    <ErrorState
      v-else-if="hasError"
      :title="t('errors.loadingFailed')"
      :message="t('errors.tryAgainLater')"
      @retry="performSearch"
    />

    <!-- Results -->
    <div v-else-if="hasResults()" class="space-y-8">
      <!-- Tracks -->
      <section v-if="results.tracks.length > 0 && (activeTab === 'all' || activeTab === 'track')">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">
            {{ t('search.tracks') }}
            <span v-if="pagination.tracks.total" class="text-sm font-normal text-foreground-muted ml-2">
              ({{ results.tracks.length.toLocaleString() }} {{ t('search.of') }} {{ pagination.tracks.total.toLocaleString() }})
            </span>
          </h2>
        </div>
        <div class="space-y-1">
          <div
            v-for="track in results.tracks"
            :key="track.id"
            class="flex items-center gap-2"
            :class="{ 'bg-primary-500/10 rounded-lg': isSelectionMode && selectedTracks.has(track.id) }"
          >
            <!-- Selection checkbox -->
            <button
              v-if="isSelectionMode"
              @click="toggleTrackSelection(track.id)"
              class="flex-shrink-0 w-6 h-6 rounded border-2 flex items-center justify-center transition-all ml-2"
              :class="selectedTracks.has(track.id)
                ? 'bg-primary-500 border-primary-500 text-white'
                : 'border-foreground-muted/50 hover:border-primary-400'"
            >
              <svg v-if="selectedTracks.has(track.id)" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </button>
            <div class="flex-1 min-w-0">
              <TrackCard :track="track" />
            </div>
          </div>
        </div>
        <!-- Load More Button -->
        <div v-if="pagination.tracks.hasMore" class="mt-4 text-center">
          <button
            @click="loadMore('track')"
            :disabled="pagination.tracks.loading"
            class="btn btn-secondary px-8"
          >
            <span v-if="pagination.tracks.loading" class="flex items-center gap-2">
              <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              {{ t('search.loading') }}
            </span>
            <span v-else>{{ t('search.loadMoreTracks') }}</span>
          </button>
        </div>
      </section>

      <!-- Albums -->
      <section v-if="results.albums.length > 0 && (activeTab === 'all' || activeTab === 'album')">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">
            {{ t('search.albums') }}
            <span v-if="pagination.albums.total" class="text-sm font-normal text-foreground-muted ml-2">
              ({{ results.albums.length.toLocaleString() }} {{ t('search.of') }} {{ pagination.albums.total.toLocaleString() }})
            </span>
          </h2>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <div
            v-for="album in results.albums"
            :key="album.id"
            class="relative"
          >
            <!-- Selection checkbox overlay -->
            <button
              v-if="isSelectionMode"
              @click.stop="toggleAlbumSelection(album.id)"
              class="absolute top-2 left-2 z-10 w-7 h-7 rounded-full flex items-center justify-center transition-all shadow-lg"
              :class="selectedAlbums.has(album.id)
                ? 'bg-primary-500 text-white'
                : 'bg-black/60 hover:bg-primary-500/80 text-white/80 hover:text-white'"
            >
              <svg v-if="selectedAlbums.has(Number(album.id))" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <!-- Selected ring -->
            <div
              v-if="isSelectionMode && selectedAlbums.has(Number(album.id))"
              class="absolute inset-0 ring-2 ring-primary-500 rounded-lg pointer-events-none"
            />
            <AlbumCard :album="album" />
          </div>
        </div>
        <!-- Load More Button -->
        <div v-if="pagination.albums.hasMore" class="mt-4 text-center">
          <button
            @click="loadMore('album')"
            :disabled="pagination.albums.loading"
            class="btn btn-secondary px-8"
          >
            <span v-if="pagination.albums.loading" class="flex items-center gap-2">
              <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              {{ t('search.loading') }}
            </span>
            <span v-else>{{ t('search.loadMoreAlbums') }}</span>
          </button>
        </div>
      </section>

      <!-- Artists -->
      <section v-if="results.artists.length > 0 && (activeTab === 'all' || activeTab === 'artist')">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">
            {{ t('search.artists') }}
            <span v-if="pagination.artists.total" class="text-sm font-normal text-foreground-muted ml-2">
              ({{ results.artists.length.toLocaleString() }} {{ t('search.of') }} {{ pagination.artists.total.toLocaleString() }})
            </span>
          </h2>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <ArtistCard
            v-for="artist in results.artists"
            :key="artist.id"
            :artist="artist"
          />
        </div>
        <!-- Load More Button -->
        <div v-if="pagination.artists.hasMore" class="mt-4 text-center">
          <button
            @click="loadMore('artist')"
            :disabled="pagination.artists.loading"
            class="btn btn-secondary px-8"
          >
            <span v-if="pagination.artists.loading" class="flex items-center gap-2">
              <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              {{ t('search.loading') }}
            </span>
            <span v-else>{{ t('search.loadMoreArtists') }}</span>
          </button>
        </div>
      </section>

      <!-- Playlists -->
      <section v-if="results.playlists.length > 0 && (activeTab === 'all' || activeTab === 'playlist')">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">
            {{ t('search.playlists') }}
            <span v-if="pagination.playlists.total" class="text-sm font-normal text-foreground-muted ml-2">
              ({{ results.playlists.length.toLocaleString() }} {{ t('search.of') }} {{ pagination.playlists.total.toLocaleString() }})
            </span>
          </h2>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <AlbumCard
            v-for="playlist in results.playlists"
            :key="playlist.id"
            :album="{
              id: playlist.id,
              title: playlist.title,
              cover_medium: playlist.picture_medium,
              artist: { id: 0, name: playlist.creator?.name || (playlist as any).user?.name || 'Unknown' },
              nb_tracks: playlist.nb_tracks
            }"
            type="playlist"
          />
        </div>
        <!-- Load More Button -->
        <div v-if="pagination.playlists.hasMore" class="mt-4 text-center">
          <button
            @click="loadMore('playlist')"
            :disabled="pagination.playlists.loading"
            class="btn btn-secondary px-8"
          >
            <span v-if="pagination.playlists.loading" class="flex items-center gap-2">
              <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              {{ t('search.loading') }}
            </span>
            <span v-else>{{ t('search.loadMorePlaylists') }}</span>
          </button>
        </div>
      </section>
    </div>

    <!-- No Results State -->
    <EmptyState
      v-else-if="searchQuery"
      type="noResults"
      :title="t('search.noResults', { query: searchQuery })"
      :subtitle="t('search.tryDifferentKeywords')"
    />

    <!-- Initial State -->
    <EmptyState
      v-else
      type="search"
      :title="t('search.startTyping')"
      :subtitle="t('search.searchHint')"
    />

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
