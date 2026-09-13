<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { deezerAPI } from '../services/deezerAPI'
import { useFavoritesStore } from '../stores/favoritesStore'
import { useDownloadStore } from '../stores/downloadStore'
import { useToastStore } from '../stores/toastStore'
import TrackCard from '../components/TrackCard.vue'
import BackButton from '../components/BackButton.vue'
import ErrorState from '../components/ErrorState.vue'
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu } from '../composables/useContextMenu'
import type { Artist, Track, Album } from '../types'
import { qobuzRecordType } from '../utils/qobuzMap'

const { t } = useI18n()

const route = useRoute()
const favoritesStore = useFavoritesStore()
const downloadStore = useDownloadStore()
const toastStore = useToastStore()

const artist = ref<Artist | null>(null)
const topTracks = ref<Track[]>([])
const albums = ref<Album[]>([])
const featuredInAlbums = ref<Album[]>([])
const isLoading = ref(true)
const isLoadingDetails = ref(false)
const isLoadingFeatured = ref(false)
const detailsLoadedCount = ref(0)
const detailsTotalCount = ref(0)
const hasError = ref(false)

// Discography filter tabs
type DiscographyFilter = 'all' | 'album' | 'ep' | 'single' | 'compile' | 'featured'
const activeFilter = ref<DiscographyFilter>('all')

// Primary release types for "All" tab (albums, EPs, singles only)
const primaryReleaseTypes = ['album', 'ep', 'single']

// Get count for each filter type
const getFilterCount = (filter: DiscographyFilter): number => {
  if (filter === 'all') {
    // "All" only counts albums, EPs, and singles (not compilations or other types)
    return albums.value.filter(a => primaryReleaseTypes.includes(a.record_type || 'album')).length
  }
  if (filter === 'featured') return featuredInAlbums.value.length
  return albums.value.filter(a => a.record_type === filter).length
}

// Qobuz artist pages must propagate the source on every album link — a Qobuz
// album id sent to the Deezer loader is a guaranteed "Failed to load".
const sourceQuery = computed(() => route.query.source === 'qobuz' ? { source: 'qobuz' } : undefined)

const filterTabs = computed(() => [
  { key: 'all' as DiscographyFilter, label: t('artistView.all'), count: getFilterCount('all') },
  { key: 'album' as DiscographyFilter, label: t('artistView.albums'), count: getFilterCount('album') },
  { key: 'ep' as DiscographyFilter, label: t('artistView.eps'), count: getFilterCount('ep') },
  { key: 'single' as DiscographyFilter, label: t('artistView.singles'), count: getFilterCount('single') },
  { key: 'compile' as DiscographyFilter, label: t('artistView.compilations'), count: getFilterCount('compile') },
  { key: 'featured' as DiscographyFilter, label: t('artistView.featuredIn'), count: getFilterCount('featured') }
])

// Sort order for discography
type DiscographySort = 'default' | 'name-asc' | 'name-desc' | 'date-newest' | 'date-oldest'
const discographySort = ref<DiscographySort>(
  (localStorage.getItem('discography_sort') as DiscographySort) || 'default'
)
watch(discographySort, (val) => localStorage.setItem('discography_sort', val))

// Filter albums based on active tab
const filteredAlbums = computed(() => {
  if (activeFilter.value === 'all') {
    // "All" shows only albums, EPs, and singles (cleaner view without compilations)
    return albums.value.filter(a => primaryReleaseTypes.includes(a.record_type || 'album'))
  }
  if (activeFilter.value === 'featured') {
    // Featured In = albums by other artists where this artist appears
    return featuredInAlbums.value
  }
  return albums.value.filter(a => a.record_type === activeFilter.value)
})

// Sorted discography
const sortedAlbums = computed(() => {
  const items = [...filteredAlbums.value]
  if (discographySort.value === 'name-asc') return items.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
  if (discographySort.value === 'name-desc') return items.sort((a, b) => (b.title || '').localeCompare(a.title || ''))
  if (discographySort.value === 'date-newest') return items.sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''))
  if (discographySort.value === 'date-oldest') return items.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''))
  return items // 'default' = Deezer's order
})

// Get the latest release (albums are already sorted newest-first)
const latestRelease = computed(() => {
  if (albums.value.length === 0) return null
  return albums.value[0]
})

// Check if album is new (released within last 14 days)
function isNewRelease(releaseDate?: string): boolean {
  if (!releaseDate) return false
  const release = new Date(releaseDate)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - release.getTime()) / (1000 * 60 * 60 * 24))
  return diffDays <= 14 && diffDays >= 0
}

// Format release date
function formatDate(dateStr?: string): string {
  if (!dateStr) return '-'
  return dateStr // Already in YYYY-MM-DD format from API
}

// Get album type label
function getTypeLabel(recordType?: string): string {
  const types: Record<string, string> = {
    'album': 'Album',
    'ep': 'EP',
    'single': 'Single',
    'compile': 'Compilation',
    'compilation': 'Compilation',
    'featured': 'Featured'
  }
  return types[recordType || ''] || recordType || 'Album'
}

// Helper to sort and inject artist info into albums
function processAlbums(albumsData: Album[], artistData: Artist): Album[] {
  return albumsData
    // Filter out any malformed albums (must have id and title)
    .filter(album => album && album.id && album.title)
    .map(album => ({
      ...album,
      artist: album.artist || {
        id: artistData.id,
        name: artistData.name,
        picture: artistData.picture,
        picture_small: artistData.picture_small,
        picture_medium: artistData.picture_medium,
        picture_big: artistData.picture_big,
        picture_xl: artistData.picture_xl
      }
    }))
    .sort((a, b) => {
      const dateA = a.release_date ? new Date(a.release_date).getTime() : 0
      const dateB = b.release_date ? new Date(b.release_date).getTime() : 0
      return dateB - dateA // Newest first
    })
}

// Load artist data - extracted to function for reuse
async function loadArtist(artistId: string) {
  // Reset state for new artist
  isLoading.value = true
  hasError.value = false
  artist.value = null
  topTracks.value = []
  albums.value = []
  featuredInAlbums.value = []
  activeFilter.value = 'all'

  // Qobuz artist: load from the Qobuz backend (its id isn't a Deezer id).
  if (route.query.source === 'qobuz') {
    try {
      const port = window.electronAPI ? await window.electronAPI.getServerPort() : (downloadStore.serverPort || 6595)
      const resp = await fetch(`http://127.0.0.1:${port}/api/qobuz/artist?id=${artistId}`)
      if (!resp.ok) throw new Error('Qobuz artist load failed')
      const a = await resp.json()
      // Qobuz has duplicate artist entities (e.g. one per catalog ingestion),
      // and the twin reached from album/track links often has image: null.
      // Self-heal: look the name up in artist search and borrow the image
      // from an exact-name sibling that has one. No match → the template's
      // initial-letter placeholder renders instead of a broken <img>.
      let image = a.image
      if (!image?.medium && a.name) {
        try {
          const sr = await fetch(`http://127.0.0.1:${port}/api/qobuz/search?q=${encodeURIComponent(a.name)}&limit=10`)
          if (sr.ok) {
            const sd = await sr.json()
            const sib = (sd.artists?.items || []).find((s: any) =>
              s.image?.medium && s.name?.toLowerCase() === a.name.toLowerCase())
            if (sib) image = sib.image
          }
        } catch { /* placeholder covers it */ }
      }
      artist.value = {
        id: a.id, name: a.name,
        picture_medium: image?.medium || image?.small || a.picture || '',
        picture_big: image?.large || image?.medium || a.picture || '',
        nb_album: a.albums_count,
      } as any
      albums.value = (a.albums?.items || []).map((al: any) => ({
        id: al.id, title: al.title, record_type: qobuzRecordType(al),
        cover_small: al.image?.small, cover_medium: al.image?.large, cover_big: al.image?.large,
        qobuzQuality: (al.maximum_bit_depth && al.maximum_sampling_rate)
          ? { hires: !!al.hires, bitDepth: al.maximum_bit_depth, samplingRate: al.maximum_sampling_rate }
          : undefined,
        artist: { id: a.id, name: a.name },
        nb_tracks: al.tracks_count,
        release_date: al.release_date_original || al.released_at,
        source: 'qobuz', qobuzId: al.id,
        qobuzData: { title: al.title, artist: { name: a.name }, image: al.image, tracks_count: al.tracks_count },
      }))
      // Top tracks load separately and non-blocking — a miss just hides the
      // section (and disables Download Top Tracks) instead of erroring the
      // page. Mapped defensively: artist/page and artist/get's tracks extra
      // don't guarantee identical shapes (e.g. name may be {display} object).
      fetch(`http://127.0.0.1:${port}/api/qobuz/artist-top-tracks?id=${artistId}`)
        .then(r => r.ok ? r.json() : { items: [] })
        .then(d => {
          const asName = (n: any): string =>
            (n && typeof n === 'object') ? (n.display || n.name || '') : (n || '')
          topTracks.value = (d.items || [])
            .filter((t: any) => t?.id && t?.title)
            .map((t: any) => ({
              id: t.id, title: t.title, duration: t.duration,
              artist: {
                id: t.performer?.id ?? t.artist?.id ?? a.id,
                name: asName(t.performer?.name) || asName(t.artist?.name) || a.name,
              },
              album: {
                id: t.album?.id, title: t.album?.title,
                cover_small: t.album?.image?.small || t.album?.image?.thumbnail,
                cover_medium: t.album?.image?.large || t.album?.image?.small,
                cover_big: t.album?.image?.large,
              },
              explicit_lyrics: !!t.parental_warning,
              source: 'qobuz', qobuzId: t.id,
            })) as any
        })
        .catch(() => { /* section stays hidden */ })
    } catch (e) {
      console.error('[ArtistView] Qobuz load error:', e)
      hasError.value = true
    } finally {
      isLoading.value = false
      isLoadingDetails.value = false
      isLoadingFeatured.value = false
    }
    return
  }

  try {
    // First load artist info and top tracks quickly
    const [artistData, tracksData] = await Promise.all([
      deezerAPI.getArtist(artistId),
      deezerAPI.getArtistTopTracks(artistId)
    ])
    artist.value = artistData
    topTracks.value = tracksData
    isLoading.value = false

    // Load discography from server (uses private API for proper categorization)
    isLoadingDetails.value = true
    isLoadingFeatured.value = true

    // Get server port from download store (it's a ref)
    const serverPort = downloadStore.serverPort || 6595

    // Try to fetch from server's private API first (proper categorization)
    const discography = await deezerAPI.getArtistDiscographyFromServer(artistId, serverPort)

    // Helper to add artist info and sort by date
    const processAndSort = (albumList: Album[]) => {
      return albumList
        .filter(album => album && album.id && album.title)
        .map(album => ({
          ...album,
          artist: album.artist || {
            id: artistData.id,
            name: artistData.name,
            picture: artistData.picture,
            picture_small: artistData.picture_small,
            picture_medium: artistData.picture_medium,
            picture_big: artistData.picture_big,
            picture_xl: artistData.picture_xl
          }
        }))
        .sort((a, b) => {
          const dateA = a.release_date ? new Date(a.release_date).getTime() : 0
          const dateB = b.release_date ? new Date(b.release_date).getTime() : 0
          return dateB - dateA
        })
    }

    // Check if server returned data
    if (discography.counts.total > 0) {
      // Use server's properly categorized data
      console.log('[ArtistView] Using server discography:', discography.counts)
      albums.value = processAndSort(discography.all)
      isLoadingDetails.value = false

      // Featured In from server (if available) or fallback to search
      if (discography.featured.length > 0) {
        featuredInAlbums.value = processAndSort(discography.featured)
        isLoadingFeatured.value = false
      } else {
        // Fallback: search for featured appearances
        try {
          const featured = await deezerAPI.getArtistFeaturedIn(artistId, artistData.name, 100)
          featuredInAlbums.value = processAndSort(featured)
        } catch (error) {
          console.error('Failed to load featured-in albums:', error)
        }
        isLoadingFeatured.value = false
      }
    } else {
      // Fallback to public API if server didn't return data
      console.log('[ArtistView] Server discography empty, falling back to public API')

      // Start fetching featured-in albums in parallel
      const featuredPromise = deezerAPI.getArtistFeaturedIn(artistId, artistData.name, 100)
        .then(featured => {
          featuredInAlbums.value = processAndSort(featured)
          isLoadingFeatured.value = false
        })
        .catch(error => {
          console.error('Failed to load featured-in albums:', error)
          isLoadingFeatured.value = false
        })

      // Fetch main discography with progressive loading
      await deezerAPI.getArtistAlbumsWithDetails(
        artistId,
        1000,
        (updatedAlbums, loaded, total) => {
          albums.value = processAlbums(updatedAlbums, artistData)
          detailsLoadedCount.value = loaded
          detailsTotalCount.value = total
        }
      )
      isLoadingDetails.value = false

      await featuredPromise
    }
  } catch (error) {
    console.error('Failed to load artist:', error)
    hasError.value = true
    isLoading.value = false
    isLoadingDetails.value = false
    isLoadingFeatured.value = false
  }
}

// Watch for route param changes to reload artist data
watch(
  () => route.params.id,
  (newId) => {
    if (newId && typeof newId === 'string') {
      loadArtist(newId)
    }
  }
)

onMounted(() => {
  const artistId = route.params.id as string
  if (artistId) {
    loadArtist(artistId)
  }
})

const isFavorite = () => artist.value && favoritesStore.isFavorite(artist.value.id, 'artist')

function toggleFavorite() {
  if (artist.value) {
    favoritesStore.toggleFavorite(artist.value, 'artist')
  }
}

async function downloadAllTracks() {
  for (const track of topTracks.value) {
    await downloadStore.addDownload(track)
  }
}

async function downloadAlbum(album: Album) {
  try {
    // Qobuz-sourced albums route straight to the Qobuz pipeline — the server
    // fetches the tracklist (a Qobuz id against Deezer returns nothing, which
    // made these buttons silently dead on Qobuz artist pages).
    if ((album as any).source === 'qobuz') {
      await downloadStore.addAlbumDownload(album, [])
      return
    }
    const tracks = await deezerAPI.getAlbumTracks(album.id)
    await downloadStore.addAlbumDownload(album, tracks)
  } catch (error) {
    console.error('Failed to download album:', error)
  }
}

const isDownloadingAll = ref(false)

async function downloadFilteredAlbums() {
  if (isDownloadingAll.value) return
  isDownloadingAll.value = true

  // Pace each album's track lookup and retry quota-failed releases in a second
  // pass, so a large discography doesn't burst past Deezer's rate limit and
  // silently drop releases from the queue (issue #84).
  const queueAlbum = async (album: Album): Promise<void> => {
    if ((album as any).source === 'qobuz') {
      await downloadStore.addAlbumDownload(album, [])
      return
    }
    const tracks = await deezerAPI.getAlbumTracks(album.id)
    await downloadStore.addAlbumDownload(album, tracks)
  }

  try {
    const pending: Album[] = []
    for (const album of filteredAlbums.value) {
      try {
        await queueAlbum(album)
      } catch (e) {
        console.warn(`[ArtistView] Album ${album.id} "${album.title}" failed (will retry):`, e)
        pending.push(album)
      }
      await deezerAPI.pace()
    }

    // Second pass — after the quota window resets, retry the stragglers.
    const stillFailed: Album[] = []
    if (pending.length > 0) {
      await deezerAPI.cooldown()
      for (const album of pending) {
        try {
          await queueAlbum(album)
        } catch {
          stillFailed.push(album)
        }
        await deezerAPI.pace()
      }
    }

    if (stillFailed.length > 0) {
      toastStore.warning(t('notifications.rateLimitedReleases', { count: stillFailed.length }, stillFailed.length))
    }
  } catch (error) {
    console.error('Failed to download albums:', error)
  } finally {
    isDownloadingAll.value = false
  }
}

// Context menu
const { menuState, openMenu, closeMenu, copyToClipboard } = useContextMenu()

const contextMenuItems = computed(() => {
  if (!artist.value) return []
  return [
    {
      label: t('contextMenu.copyArtist'),
      icon: 'copy',
      action: () => copyToClipboard(artist.value!.name, t('contextMenu.artist'))
    }
  ]
})
</script>

<template>
  <div class="space-y-8">
    <BackButton />

    <!-- Loading -->
    <div v-if="isLoading" class="flex items-center justify-center py-20">
      <div class="animate-spin w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
    </div>

    <!-- Error State -->
    <ErrorState
      v-else-if="hasError"
      :title="t('errors.loadingFailed')"
      :message="t('errors.tryAgainLater')"
      @retry="loadArtist(route.params.id as string)"
    />

    <template v-else-if="artist">
      <!-- Artist Header -->
      <div class="flex items-end gap-6" @contextmenu="openMenu">
        <img
          v-if="artist.picture_xl || artist.picture_big || artist.picture_medium"
          :src="artist.picture_xl || artist.picture_big || artist.picture_medium"
          :alt="artist.name"
          class="w-48 h-48 rounded-full object-cover shadow-2xl"
        />
        <!-- No artwork on this catalog entity: initial-letter tile instead of a
             broken <img> leaking clipped alt text through the circular crop. -->
        <div
          v-else
          class="w-48 h-48 rounded-full shadow-2xl bg-background-tertiary border border-white/[0.08] flex items-center justify-center"
        >
          <span class="font-display uppercase text-[64px] text-foreground-muted">{{ (artist.name || '?').charAt(0) }}</span>
        </div>
        <div class="flex-1">
          <p class="font-mono text-[10px] tracking-[0.3em] uppercase text-primary-500 mb-2">{{ t('common.artist') }}</p>
          <h1 class="font-display uppercase text-[34px] leading-[1.02] tracking-[-0.01em] mb-4">{{ artist.name }}</h1>
          <p v-if="artist.nb_fan" class="text-foreground-muted mb-4">
            {{ artist.nb_fan.toLocaleString() }} {{ t('common.fans') }}
          </p>
          <div class="flex gap-3">
            <button
              @click="downloadAllTracks"
              :disabled="topTracks.length === 0"
              class="btn btn-primary flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {{ t('artistView.downloadTopTracks') }}
            </button>
            <button
              @click="toggleFavorite"
              class="btn btn-secondary flex items-center gap-2"
            >
              <svg
                class="w-5 h-5"
                :class="isFavorite() ? 'fill-primary-500 text-primary-500' : ''"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              {{ isFavorite() ? t('common.favorited') : t('common.addToFavorites') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Latest Release Highlight -->
      <section v-if="latestRelease && !isLoadingDetails" class="mb-8">
        <h2 class="font-display text-[15px] uppercase tracking-[0.06em] mb-4">{{ t('artistView.latestRelease') }}</h2>
        <div class="flex gap-6 p-4 border border-white/[0.08] bg-background-secondary/70">
          <!-- Large album cover -->
          <img
            :src="latestRelease.cover_medium || latestRelease.cover_small"
            :alt="latestRelease.title"
            class="w-32 h-32 border border-white/[0.1] shadow-lg object-cover"
          />
          <div class="flex flex-col justify-center">
            <!-- Album title with badges -->
            <div class="flex items-center gap-2 flex-wrap">
              <router-link
                :to="{ path: `/album/${latestRelease.id}`, query: sourceQuery }"
                class="text-lg font-bold hover:text-primary-400 transition-colors"
              >
                {{ latestRelease.title }}
              </router-link>
              <span
                v-if="isNewRelease(latestRelease.release_date)"
                class="px-1.5 py-0.5 text-[10px] font-bold rounded bg-green-500 text-white"
              >
                NEW
              </span>
              <span class="px-1.5 py-0.5 text-[10px] font-bold rounded bg-primary-500/20 text-primary-400">
                {{ getTypeLabel(latestRelease.record_type) }}
              </span>
            </div>
            <!-- Release date and track count -->
            <p class="text-sm text-foreground-muted mt-1">
              {{ formatDate(latestRelease.release_date) }} · {{ latestRelease.nb_tracks || '?' }} {{ t('common.tracks') }}
            </p>
            <!-- Action buttons -->
            <div class="flex gap-2 mt-3">
              <router-link :to="{ path: `/album/${latestRelease.id}`, query: sourceQuery }" class="btn btn-secondary text-sm">
                {{ t('artistView.viewAlbum') }}
              </router-link>
              <button @click="downloadAlbum(latestRelease)" class="btn btn-primary text-sm">
                {{ t('common.download') }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Top Tracks -->
      <section v-if="topTracks.length > 0">
        <h2 class="font-display text-[15px] uppercase tracking-[0.06em] mb-4">{{ t('artistView.topTracks') }}</h2>
        <div class="space-y-1">
          <TrackCard
            v-for="(track, index) in topTracks.slice(0, 10)"
            :key="track.id"
            :track="track"
            :index="index + 1"
          />
        </div>
      </section>

      <!-- Discography Section -->
      <section v-if="albums.length > 0 || isLoadingDetails">
        <div class="flex items-center gap-3 mb-4">
          <h2 class="font-display text-[15px] uppercase tracking-[0.06em]">{{ t('artistView.discography') }}</h2>
          <!-- Loading indicator for album details -->
          <div v-if="isLoadingDetails" class="flex items-center gap-2 text-sm text-foreground-muted">
            <div class="animate-spin w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full"></div>
            <span>{{ t('artistView.loadingDetails', { loaded: detailsLoadedCount, total: detailsTotalCount }) }}</span>
          </div>
        </div>

        <!-- Filter Tabs with counts -->
        <div class="flex items-center gap-1 mb-6 border-b border-zinc-700/50 overflow-x-auto">
          <button
            v-for="tab in filterTabs"
            :key="tab.key"
            @click="activeFilter = tab.key"
            class="px-4 py-2.5 text-sm font-medium transition-all relative whitespace-nowrap flex items-center gap-2"
            :class="activeFilter === tab.key
              ? 'text-primary-400'
              : 'text-foreground-muted hover:text-foreground'"
          >
            {{ tab.label }}
            <!-- Loading indicator for Featured In tab -->
            <div
              v-if="tab.key === 'featured' && isLoadingFeatured"
              class="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin"
            ></div>
            <span
              v-else-if="tab.count > 0 || (tab.key !== 'featured')"
              class="px-1.5 py-0.5 text-[10px] font-medium rounded-full"
              :class="activeFilter === tab.key
                ? 'bg-primary-500/20 text-primary-400'
                : 'bg-zinc-700 text-zinc-400'"
            >
              {{ tab.count }}
            </span>
            <!-- Active indicator -->
            <span
              v-if="activeFilter === tab.key"
              class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary-500"
            ></span>
          </button>
        </div>

        <!-- Sort Controls -->
        <div class="flex items-center gap-2 mb-4">
          <svg class="w-4 h-4 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
          </svg>
          <select
            v-model="discographySort"
            class="text-sm bg-background-secondary text-foreground rounded-lg px-3 py-1.5 border border-zinc-700 focus:border-primary-500 outline-none"
          >
            <option value="default">Default</option>
            <option value="name-asc">{{ t('common.sortNameAsc') }}</option>
            <option value="name-desc">{{ t('common.sortNameDesc') }}</option>
            <option value="date-newest">{{ t('artistView.sortNewest') }}</option>
            <option value="date-oldest">{{ t('artistView.sortOldest') }}</option>
          </select>
        </div>

        <!-- Discography Table -->
        <div class="overflow-hidden border border-white/[0.06] bg-background-secondary/30">
          <!-- Table Header -->
          <div class="grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 px-4 py-3 border-b border-zinc-700/50 text-sm text-foreground-muted">
            <div class="w-12"></div>
            <div>{{ t('artistView.title') }}</div>
            <div class="w-28 text-center">{{ t('artistView.releaseDate') }}</div>
            <div class="w-16 text-center">{{ t('search.tracks') }}</div>
            <div class="w-12"></div>
          </div>

          <!-- Table Body -->
          <div class="divide-y divide-zinc-800/50">
            <router-link
              v-for="album in sortedAlbums"
              :key="album.id"
              :to="{ path: `/album/${album.id}`, query: sourceQuery }"
              class="grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 px-4 py-3 items-center hover:bg-white/5 transition-colors group"
            >
              <!-- Cover -->
              <img
                :src="album.cover_small || album.cover_medium || album.cover"
                :alt="album.title"
                class="w-12 h-12 rounded object-cover bg-background-tertiary"
              />

              <!-- Title & Type -->
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-medium truncate group-hover:text-primary-400 transition-colors">
                    {{ album.title }}
                  </span>
                  <!-- NEW Badge -->
                  <span
                    v-if="isNewRelease(album.release_date)"
                    class="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold bg-primary-500 text-white rounded"
                  >
                    {{ t('common.new') }}
                  </span>
                </div>
                <!-- Show artist name for Featured In albums (regardless of tab), type for artist's own releases -->
                <span v-if="album.record_type === 'featured'" class="text-sm text-foreground-muted">
                  {{ t('common.by') }} {{ album.artist?.name || t('common.unknownArtist') }}
                </span>
                <span v-else class="text-sm text-foreground-muted">{{ getTypeLabel(album.record_type) }}</span>
              </div>

              <!-- Release Date -->
              <div class="w-28 text-center text-sm text-foreground-muted">
                {{ formatDate(album.release_date) }}
              </div>

              <!-- Track Count -->
              <div class="w-16 text-center text-sm text-foreground-muted">
                {{ album.nb_tracks || '-' }}
              </div>

              <!-- Download Button — the app's canonical GET ↓ acquisition
                   control, in the source colorway (chartreuse = Deezer,
                   cyan = Channel Q / Qobuz). -->
              <button
                @click.prevent="downloadAlbum(album)"
                class="px-2.5 py-1 font-mono text-[10px] font-bold tracking-[0.12em] border transition-colors whitespace-nowrap"
                :class="(album as any).source === 'qobuz'
                  ? 'border-qobuz-500/70 text-qobuz-400 hover:bg-qobuz-500 hover:text-background-main'
                  : 'border-primary-600/70 text-primary-500 hover:bg-primary-500 hover:text-background-main'"
                :title="t('artistView.downloadAlbum')"
              >GET&nbsp;↓</button>
            </router-link>
          </div>

          <!-- Empty State -->
          <div
            v-if="filteredAlbums.length === 0"
            class="py-12 text-center text-foreground-muted"
          >
            <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
            <p>{{ t('artistView.noReleases', { type: activeFilter === 'all' ? t('artistView.releases') : activeFilter === 'featured' ? t('artistView.featuredAppearances') : activeFilter + 's' }) }}</p>
          </div>
        </div>

        <!-- Album Count and Actions -->
        <div class="mt-4 flex items-center justify-between">
          <p class="text-sm text-foreground-muted">
            Showing {{ filteredAlbums.length }} of {{ albums.length }} releases
            <span v-if="isLoadingDetails" class="text-primary-400">
              {{ t('artistView.loadingDetailsShort') }}
            </span>
          </p>
          <!-- Download all filtered albums button -->
          <button
            v-if="filteredAlbums.length > 0"
            @click="downloadFilteredAlbums"
            class="btn btn-ghost text-sm flex items-center gap-2"
            :disabled="isDownloadingAll"
          >
            <svg v-if="!isDownloadingAll" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <div v-else class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full"></div>
            {{ t('artistView.downloadFiltered', { count: activeFilter === 'all' ? t('artistView.all') : filteredAlbums.length, type: activeFilter === 'all' ? t('artistView.releases') : getTypeLabel(activeFilter) + 's' }) }}
          </button>
        </div>
      </section>
    </template>

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
