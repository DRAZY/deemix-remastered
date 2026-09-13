<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { deezerAPI } from '../services/deezerAPI'
import { useSearchHistory } from '../composables/useSearchHistory'
import { useDownloadStore } from '../stores/downloadStore'
import { textContainsHostUrl } from '../utils/urlHost'
import { qobuzRecordType } from '../utils/qobuzMap'
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

/** Collapse newlines so remote-supplied text cannot forge extra log lines. */
const logSafe = (v: unknown): string => String(v ?? '').replace(/[\r\n]+/g, ' ')

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
const searchSource = ref<'deezer' | 'qobuz'>('deezer')
const qobuzConnected = ref(false)
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

    // Download selected albums — paced, with a second-pass retry for releases
    // that trip Deezer's rate limit, so a large selection doesn't burst past the
    // limit and silently drop albums (issue #84).
    const selectedAlbumObjs = [...selectedAlbums.value]
      .map(albumId => results.value.albums.find(a => a.id === albumId))
      .filter((a): a is NonNullable<typeof a> => !!a)
    const pendingAlbums: typeof selectedAlbumObjs = []
    const failedAlbums: typeof selectedAlbumObjs = []
    for (const album of selectedAlbumObjs) {
      // Qobuz-sourced albums skip the Deezer track fetch (their id isn't a
      // Deezer id) — addAlbumDownload routes them to the Qobuz pipeline, which
      // fetches the tracklist server-side. Same routing as AlbumCard.
      if ((album as any).source === 'qobuz') {
        try {
          await downloadStore.addAlbumDownload(album, [])
        } catch (e) {
          console.warn(`[Search] Selected Qobuz album ${album.id} failed:`, e)
          failedAlbums.push(album)
        }
        continue
      }
      try {
        const tracks = await deezerAPI.getAlbumTracks(album.id)
        await downloadStore.addAlbumDownload(album, tracks)
      } catch (e) {
        console.warn(`[Search] Selected album ${album.id} failed (will retry):`, e)
        pendingAlbums.push(album)
      }
      await deezerAPI.pace()
    }
    if (pendingAlbums.length > 0) {
      await deezerAPI.cooldown()
      for (const album of pendingAlbums) {
        try {
          const tracks = await deezerAPI.getAlbumTracks(album.id)
          await downloadStore.addAlbumDownload(album, tracks)
        } catch {
          failedAlbums.push(album)
        }
        await deezerAPI.pace()
      }
    }

    const addedCount = trackCount + albumCount - failedAlbums.length
    toastStore.success(t('notifications.addedItemsToQueue', { count: addedCount }, addedCount))
    if (failedAlbums.length > 0) {
      toastStore.warning(t('notifications.rateLimitedAlbums', { count: failedAlbums.length }, failedAlbums.length))
    }

    // Clear selection and exit selection mode
    clearSelection()
    isSelectionMode.value = false
  } catch (error) {
    console.error('Failed to download selected:', error)
    toastStore.error(t('notifications.addSomeFailed'))
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

// Whether the Qobuz account is connected (gates the Qobuz source toggle).
async function checkQobuzConnected() {
  try {
    const port = window.electronAPI ? await window.electronAPI.getServerPort() : serverPort.value
    const r = await fetch(`http://127.0.0.1:${port}/api/qobuz/status`)
    const d = await r.json()
    qobuzConnected.value = !!d.connected
  } catch { qobuzConnected.value = false }
}

// Switch search source; if there's a query, re-run the search immediately.
// Persisted so the choice survives navigation (sticky source).
function setSearchSource(src: 'deezer' | 'qobuz') {
  if (searchSource.value === src) return
  searchSource.value = src
  localStorage.setItem('searchSource', src)
  if (searchQuery.value.trim()) performSearch()
}

onMounted(async () => {
  if (window.electronAPI) {
    serverPort.value = await window.electronAPI.getServerPort()
  }
  await checkQobuzConnected()
  // Source selection: an explicit ?source=qobuz (e.g. the Channel Q search bar)
  // wins; otherwise restore the last-used source so leaving and returning to
  // search doesn't silently flip you back to Deezer. Qobuz only sticks while
  // the account is actually connected.
  const requestedSource = route.query.source === 'qobuz' ? 'qobuz' : localStorage.getItem('searchSource')
  if (requestedSource === 'qobuz' && qobuzConnected.value) {
    searchSource.value = 'qobuz'
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

// Monotonic search sequence — every new search bumps it, and every async
// result-write checks it still owns the latest sequence before touching state.
// Without this, a slow earlier response (e.g. a Qobuz search racing a quick
// source-switch back to Deezer) landed LAST and overwrote the fresh results.
let searchSeq = 0

function resetPagination() {
  pagination.value = {
    tracks: { index: 0, hasMore: true, loading: false, total: 0 },
    albums: { index: 0, hasMore: true, loading: false, total: 0 },
    artists: { index: 0, hasMore: true, loading: false, total: 0 },
    playlists: { index: 0, hasMore: true, loading: false, total: 0 }
  }
  results.value = { tracks: [], albums: [], artists: [], playlists: [] }
}

// Map Qobuz catalog objects into the Deezer-shaped objects the cards render,
// tagged with source:'qobuz' + qobuzId so downloadStore routes them correctly.
function mapQobuzTrack(t: any) {
  return {
    id: t.id, title: t.title, duration: t.duration,
    // Qobuz artist id rides along so the artist name links to the Qobuz artist page.
    artist: { id: t.performer?.id ?? t.album?.artist?.id, name: t.performer?.name || t.album?.artist?.name || '' },
    album: { id: t.album?.id, title: t.album?.title, cover_small: t.album?.image?.small, cover_medium: t.album?.image?.large, cover_big: t.album?.image?.large },
    explicit_lyrics: !!t.parental_warning,
    source: 'qobuz', qobuzId: t.id,
  }
}
function mapQobuzAlbum(a: any) {
  return {
    id: a.id, title: a.title, nb_tracks: a.tracks_count, record_type: qobuzRecordType(a),
    qobuzQuality: (a.maximum_bit_depth && a.maximum_sampling_rate)
      ? { hires: !!a.hires, bitDepth: a.maximum_bit_depth, samplingRate: a.maximum_sampling_rate }
      : undefined,
    artist: { id: a.artist?.id, name: a.artist?.name || '' },
    cover_small: a.image?.small, cover_medium: a.image?.large, cover_big: a.image?.large,
    source: 'qobuz', qobuzId: a.id, qobuzData: { title: a.title, artist: a.artist, image: a.image, tracks_count: a.tracks_count },
  }
}
function mapQobuzArtist(a: any) {
  return {
    id: a.id, name: a.name,
    picture_small: a.image?.small || a.picture,
    picture_medium: a.image?.medium || a.image?.small || a.picture,
    picture_big: a.image?.large || a.image?.medium || a.picture,
    nb_album: a.albums_count,
    source: 'qobuz', qobuzId: a.id,
  }
}
function mapQobuzPlaylist(p: any) {
  const cover = p.images300?.[0] || p.images150?.[0] || p.images?.[0] || p.image_rectangle?.[0]
  return {
    id: p.id, title: p.name, nb_tracks: p.tracks_count,
    picture_medium: cover, picture_small: cover,
    user: { name: p.owner?.name || '' },
    source: 'qobuz', qobuzId: p.id,
  }
}

async function performQobuzSearch(seq: number) {
  const port = window.electronAPI ? await window.electronAPI.getServerPort() : serverPort.value
  serverPort.value = port
  const resp = await fetch(`http://127.0.0.1:${port}/api/qobuz/search?q=${encodeURIComponent(searchQuery.value)}&limit=${RESULTS_PER_PAGE}`)
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}))
    throw new Error(e.error === 'Qobuz not connected' ? 'Connect your Qobuz account in Settings first.' : (e.error || 'Qobuz search failed'))
  }
  const d = await resp.json()
  if (seq !== searchSeq) return // a newer search superseded this one
  results.value = {
    tracks: (d.tracks?.items || []).map(mapQobuzTrack),
    albums: (d.albums?.items || []).map(mapQobuzAlbum),
    artists: (d.artists?.items || []).map(mapQobuzArtist),
    playlists: (d.playlists?.items || []).map(mapQobuzPlaylist),
  }
  // Enable "load more" when more results exist than the first page returned.
  const pg = (loaded: number, total: number) => ({ index: loaded, hasMore: loaded < total && loaded > 0, loading: false, total })
  pagination.value = {
    tracks: pg(results.value.tracks.length, d.tracks?.total || results.value.tracks.length),
    albums: pg(results.value.albums.length, d.albums?.total || results.value.albums.length),
    artists: pg(results.value.artists.length, d.artists?.total || results.value.artists.length),
    playlists: pg(results.value.playlists.length, d.playlists?.total || results.value.playlists.length),
  }
}

async function performSearch() {
  if (!searchQuery.value.trim()) return

  // Detect Deezer/Spotify/Qobuz links and redirect to Link Analyzer
  const query = searchQuery.value.trim()
  if (textContainsHostUrl(query, ['deezer.com', 'deezer.page.link', 'spotify.com', 'spotify.link', 'qobuz.com']) || query.startsWith('spotify:')) {
    router.push({ path: '/analyzer', query: { url: query } })
    return
  }

  const seq = ++searchSeq

  // Qobuz source → search Qobuz's catalog instead of Deezer.
  if (searchSource.value === 'qobuz') {
    isLoading.value = true
    hasError.value = false
    showHistory.value = false
    resetPagination()
    addToHistory(searchQuery.value)
    router.replace({ query: { q: searchQuery.value, type: activeTab.value } })
    try {
      await performQobuzSearch(seq)
    } catch (e: any) {
      if (seq === searchSeq) {
        hasError.value = true
        toastStore.error(e.message || 'Qobuz search failed')
      }
    } finally {
      if (seq === searchSeq) isLoading.value = false
    }
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
      if (seq !== searchSeq) return // a newer search superseded this one

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
      if (seq !== searchSeq) return // a newer search superseded this one

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
    if (seq === searchSeq) hasError.value = true
  } finally {
    if (seq === searchSeq) isLoading.value = false
  }
}

async function loadMore(type: 'track' | 'album' | 'artist' | 'playlist') {
  const seq = searchSeq // owned by the search whose results we're extending
  const typeKey = type === 'track' ? 'tracks' :
                  type === 'album' ? 'albums' :
                  type === 'artist' ? 'artists' : 'playlists'

  if (!pagination.value[typeKey].hasMore || pagination.value[typeKey].loading) return

  pagination.value[typeKey].loading = true

  // Qobuz: fetch the next page at this type's current offset and append.
  if (searchSource.value === 'qobuz') {
    try {
      const offset = results.value[typeKey].length
      const port = window.electronAPI ? await window.electronAPI.getServerPort() : serverPort.value
      const resp = await fetch(`http://127.0.0.1:${port}/api/qobuz/search?q=${encodeURIComponent(searchQuery.value)}&limit=${RESULTS_PER_PAGE}&offset=${offset}`)
      const d = await resp.json()
      if (seq !== searchSeq) return // a newer search reset the result set
      const mapper = type === 'track' ? mapQobuzTrack : type === 'album' ? mapQobuzAlbum : type === 'artist' ? mapQobuzArtist : mapQobuzPlaylist
      const bucket = type === 'track' ? d.tracks : type === 'album' ? d.albums : type === 'artist' ? d.artists : d.playlists
      const items = (bucket?.items || []).map(mapper)
      results.value[typeKey] = [...results.value[typeKey], ...items]
      const total = bucket?.total ?? pagination.value[typeKey].total
      pagination.value[typeKey] = { index: results.value[typeKey].length, hasMore: results.value[typeKey].length < total && items.length > 0, loading: false, total }
    } catch (error) {
      console.error(`Failed to load more Qobuz ${type}s:`, error)
      pagination.value[typeKey].loading = false
    }
    return
  }

  try {
    const result = await deezerAPI.searchWithPagination(
      searchQuery.value,
      type,
      RESULTS_PER_PAGE,
      pagination.value[typeKey].index
    )
    if (seq !== searchSeq) return // a newer search reset the result set

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
    toastStore.error(t('sidebar.loginRequired'))
    return
  }

  isBulkDownloading.value = true
  bulkAborted.value = false
  toastStore.info(t('notifications.processingLinks', { count: links.length }))
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
        // Download full discography — fetch artist info + all albums.
        // The list-build fires one /album/{id}/tracks per release; pacing each
        // request and retrying quota-failed releases in a second pass keeps a
        // large discography from bursting past Deezer's rate limit and silently
        // dropping releases from the queue (issue #84).
        const artistInfo = await deezerAPI.getArtist(id)
        const albums = await deezerAPI.getArtistAlbums(id)
        if (albums.length > 0) {
          let albumsQueued = 0

          const tryQueue = async (album: typeof albums[number]): Promise<boolean> => {
            // Inject artist info — /artist/{id}/albums doesn't include it
            if (!album.artist && artistInfo) {
              album.artist = { id: artistInfo.id, name: artistInfo.name }
            }
            const tracks = await deezerAPI.getAlbumTracks(album.id)
            if (tracks?.length > 0) {
              await downloadStore.addAlbumDownload(album, tracks)
              return true
            }
            return false
          }

          // First pass — paced.
          const pending: typeof albums = []
          for (const album of albums) {
            if (bulkAborted.value) break
            try {
              if (await tryQueue(album)) albumsQueued++
              else pending.push(album)
            } catch (e: any) {
              console.warn(`[Search] Album ${album.id} "${album.title}" failed (will retry):`, e.message || e)
              pending.push(album)
            }
            await deezerAPI.pace()
          }

          // Second pass — after Deezer's quota window resets, retry the stragglers.
          const stillFailed: typeof albums = []
          if (pending.length > 0 && !bulkAborted.value) {
            await deezerAPI.cooldown()
            for (const album of pending) {
              if (bulkAborted.value) break
              try {
                if (await tryQueue(album)) albumsQueued++
                else stillFailed.push(album)
              } catch {
                stillFailed.push(album)
              }
              await deezerAPI.pace()
            }
          }

          if (albumsQueued > 0) queued++
          else failed++
          if (stillFailed.length > 0) {
            console.warn(`[Search] Artist ${artistInfo?.name}: ${albumsQueued} queued, ${stillFailed.length} could not be loaded`)
            toastStore.warning(t('notifications.rateLimitedArtistReleases', { count: stillFailed.length, artist: artistInfo?.name || t('notifications.thisArtist') }, stillFailed.length))
          }
        } else {
          failed++
        }
      }
    } catch (err) {
      // Pasted-link values passed as arguments, not interpolated (CodeQL #18).
      console.error('[Search] Bulk download failed for link:', logSafe(link.type), logSafe(link.id), err)
      failed++
    }
    // Pace between pasted links so a big batch doesn't burst Deezer's API (#84).
    await deezerAPI.pace()
  }

  isBulkDownloading.value = false

  if (queued > 0) {
    toastStore.success(t('notifications.queuedFromLinks', { queued, links: links.length }, queued) + (failed > 0 ? ' ' + t('notifications.queuedFromLinksFailed', { failed }) : ''))
  } else {
    toastStore.error(t('notifications.noneQueued'))
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

    <!-- Idle-state hero -->
    <div v-if="!searchQuery && !isLoading && !hasResults()" class="pt-2">
      <div class="font-mono text-[10px] tracking-[0.3em] text-primary-500 mb-2">// ACQUISITION CONSOLE</div>
      <h1 class="font-display uppercase text-[44px] leading-[0.98] tracking-[-0.01em] text-foreground">
        Pull the signal <span class="ghost-text">down.</span>
      </h1>
    </div>

    <!-- Search Header -->
    <div class="sticky top-0 z-10 bg-background-main pt-2 pb-4">
      <form @submit.prevent="handleSearch" class="mb-4">
          <div class="relative">
            <!-- Channel Q mode: while the source is Qobuz the whole command bar
                 shifts to the fixed brand cyan so the active service is
                 unmistakable at any scroll position. -->
            <div
              class="flex items-stretch h-14 border bg-background-secondary/70 transition-colors"
              :class="searchSource === 'qobuz'
                ? 'border-qobuz-500/40 focus-within:border-qobuz-500/70'
                : 'border-white/[0.08] focus-within:border-primary-500/50'"
            >
              <span
                class="flex items-center px-3.5 font-mono text-[11px] font-bold tracking-[0.1em] text-background-main select-none"
                :class="searchSource === 'qobuz' ? 'bg-qobuz-500' : 'bg-primary-500'"
              >{{ searchSource === 'qobuz' ? 'QUERY::QOBUZ' : 'QUERY' }}</span>
              <input
                v-model="searchQuery"
                type="text"
                :placeholder="t('search.placeholder')"
                class="flex-1 min-w-0 bg-transparent border-none outline-none font-mono text-[14px] px-4 text-foreground placeholder:text-foreground-muted"
                :class="searchSource === 'qobuz' ? 'caret-qobuz-500' : 'caret-primary-500'"
                @paste="handlePaste"
                @focus="handleSearchFocus"
                @blur="handleSearchBlur"
                @contextmenu="openSearchInputMenu"
              />
            </div>
            <!-- Source selector: search Deezer or Qobuz's catalog -->
            <div class="mt-2 flex items-center gap-2">
              <span class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted">Source</span>
              <button
                type="button"
                @click="setSearchSource('deezer')"
                class="font-mono text-[10px] tracking-[0.12em] uppercase px-2.5 py-1 border transition-colors"
                :class="searchSource === 'deezer' ? 'border-primary-500/60 text-primary-400 bg-primary-500/10' : 'border-white/[0.1] text-foreground-muted hover:text-foreground'"
              >Deezer</button>
              <button
                type="button"
                @click="qobuzConnected ? setSearchSource('qobuz') : null"
                :disabled="!qobuzConnected"
                :title="qobuzConnected ? '' : 'Connect your Qobuz account in Settings'"
                class="font-mono text-[10px] tracking-[0.12em] uppercase px-2.5 py-1 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                :class="searchSource === 'qobuz' ? 'border-qobuz-500/60 text-qobuz-400 bg-qobuz-500/10' : 'border-white/[0.1] text-foreground-muted hover:text-foreground'"
              >Qobuz <span class="text-[8px] align-top">HI-RES</span></button>
            </div>
            <div class="mt-2 font-mono text-[10px] tracking-[0.06em] uppercase text-foreground-muted">{{ t('search.searchHint') }}</div>
            <div class="mt-1 font-mono text-[10px] tracking-[0.04em] text-foreground-muted">{{ t('search.searchHintPaste') }}</div>

          <!-- Search History Dropdown -->
          <div
            v-if="showHistory && searchHistory.length > 0"
            class="absolute top-full left-0 right-0 mt-1 bg-background-secondary shadow-xl border border-white/10 overflow-hidden z-20"
          >
            <div class="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <span class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted">{{ t('search.recentSearches') }}</span>
              <button
                type="button"
                @click.stop="clearHistory"
                class="font-mono text-[9.5px] tracking-[0.12em] uppercase text-foreground-muted hover:text-red-400 transition-colors"
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
                class="w-full px-3 py-2 text-left hover:bg-primary-500/[0.06] flex items-center gap-3 group border-b border-white/[0.04] last:border-b-0"
              >
                <svg class="w-4 h-4 text-foreground-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span class="flex-1 truncate font-mono text-[12.5px]">{{ query }}</span>
                <button
                  type="button"
                  @click.stop="removeFromHistory(query)"
                  class="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 transition-all"
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
            class="px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] border transition-colors flex items-center gap-2"
            :class="activeTab === tab.id
              ? 'text-primary-500 border-primary-500/60 bg-primary-500/10'
              : 'text-foreground-muted border-white/[0.08] hover:text-foreground hover:border-white/20'"
          >
            {{ tab.label }}
            <span
              v-if="tab.id !== 'all' && resultCounts[tab.id + 's' as keyof typeof resultCounts] > 0"
              class="text-[9.5px]"
              :class="activeTab === tab.id ? 'text-primary-500/80' : 'text-foreground-muted'"
            >
              {{ resultCounts[tab.id + 's' as keyof typeof resultCounts].toLocaleString() }}
            </span>
          </button>
        </div>

        <!-- Selection Mode Toggle -->
        <button
          v-if="results.tracks.length > 0 || results.albums.length > 0"
          @click="toggleSelectionMode"
          class="px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] border transition-colors flex items-center gap-2"
          :class="isSelectionMode
            ? 'text-primary-500 border-primary-500/60 bg-primary-500/10'
            : 'text-foreground-muted border-white/[0.08] hover:text-foreground hover:border-white/20'"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          {{ isSelectionMode ? t('search.cancelSelection') : t('search.select') }}
        </button>
      </div>

      <!-- Selection Toolbar -->
      <div
        v-if="isSelectionMode"
        class="flex items-center justify-between border border-white/[0.08] bg-background-secondary/70 px-4 py-2 mt-3"
      >
        <div class="flex items-center gap-4">
          <span class="font-mono text-[10.5px] tracking-[0.08em] uppercase text-foreground-muted">
            {{ selectedCount }} {{ t('search.selected') }}
          </span>
          <button
            v-if="results.tracks.length > 0 && (activeTab === 'all' || activeTab === 'track')"
            @click="selectAllTracks"
            class="font-mono text-[10.5px] tracking-[0.08em] uppercase text-primary-400 hover:text-primary-300"
          >
            {{ t('search.selectAllTracks') }}
          </button>
          <button
            v-if="results.albums.length > 0 && (activeTab === 'all' || activeTab === 'album')"
            @click="selectAllAlbums"
            class="font-mono text-[10.5px] tracking-[0.08em] uppercase text-primary-400 hover:text-primary-300"
          >
            {{ t('search.selectAllAlbums') }}
          </button>
          <button
            v-if="selectedCount > 0"
            @click="clearSelection"
            class="font-mono text-[10.5px] tracking-[0.08em] uppercase text-foreground-muted hover:text-foreground"
          >
            {{ t('search.clearSelection') }}
          </button>
        </div>
        <button
          v-if="selectedCount > 0"
          @click="downloadSelected"
          :disabled="isDownloadingSelected"
          class="btn btn-primary font-mono text-[11px] tracking-[0.1em] uppercase flex items-center gap-2"
        >
          <svg v-if="!isDownloadingSelected" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <div v-else class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
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
        <div class="flex items-center gap-3 mb-3">
          <h2 class="font-display text-[14px] uppercase tracking-[0.06em]">{{ t('search.tracks') }}<span v-if="searchSource === 'qobuz'" class="ml-2 font-mono text-[9px] px-1.5 py-0.5 border border-qobuz-500/40 text-qobuz-400 tracking-[0.12em] align-middle">QOBUZ</span></h2>
          <span v-if="pagination.tracks.total" class="font-mono text-[10px] text-foreground-muted">
            {{ results.tracks.length.toLocaleString() }} / {{ pagination.tracks.total.toLocaleString() }}
          </span>
          <div class="flex-1 h-px bg-white/[0.06]"></div>
        </div>
        <div class="border-t border-white/[0.06]">
          <div
            v-for="track in results.tracks"
            :key="track.id"
            class="flex items-center gap-2"
            :class="{ 'bg-primary-500/10': isSelectionMode && selectedTracks.has(track.id) }"
          >
            <!-- Selection checkbox -->
            <button
              v-if="isSelectionMode"
              @click="toggleTrackSelection(track.id)"
              class="flex-shrink-0 w-5 h-5 border flex items-center justify-center transition-all ml-2"
              :class="selectedTracks.has(track.id)
                ? 'bg-primary-500 border-primary-500 text-background-main'
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
            class="px-8 py-2 font-mono text-[10.5px] tracking-[0.12em] uppercase border border-white/[0.1] text-foreground-muted hover:text-primary-500 hover:border-primary-500/50 transition-colors disabled:opacity-50"
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
        <div class="flex items-center gap-3 mb-3">
          <h2 class="font-display text-[14px] uppercase tracking-[0.06em]">{{ t('search.albums') }}<span v-if="searchSource === 'qobuz'" class="ml-2 font-mono text-[9px] px-1.5 py-0.5 border border-qobuz-500/40 text-qobuz-400 tracking-[0.12em] align-middle">QOBUZ</span></h2>
          <span v-if="pagination.albums.total" class="font-mono text-[10px] text-foreground-muted">
            {{ results.albums.length.toLocaleString() }} / {{ pagination.albums.total.toLocaleString() }}
          </span>
          <div class="flex-1 h-px bg-white/[0.06]"></div>
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
            class="px-8 py-2 font-mono text-[10.5px] tracking-[0.12em] uppercase border border-white/[0.1] text-foreground-muted hover:text-primary-500 hover:border-primary-500/50 transition-colors disabled:opacity-50"
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
        <div class="flex items-center gap-3 mb-3">
          <h2 class="font-display text-[14px] uppercase tracking-[0.06em]">{{ t('search.artists') }}</h2>
          <span v-if="pagination.artists.total" class="font-mono text-[10px] text-foreground-muted">
            {{ results.artists.length.toLocaleString() }} / {{ pagination.artists.total.toLocaleString() }}
          </span>
          <div class="flex-1 h-px bg-white/[0.06]"></div>
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
            class="px-8 py-2 font-mono text-[10.5px] tracking-[0.12em] uppercase border border-white/[0.1] text-foreground-muted hover:text-primary-500 hover:border-primary-500/50 transition-colors disabled:opacity-50"
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
        <div class="flex items-center gap-3 mb-3">
          <h2 class="font-display text-[14px] uppercase tracking-[0.06em]">{{ t('search.playlists') }}</h2>
          <span v-if="pagination.playlists.total" class="font-mono text-[10px] text-foreground-muted">
            {{ results.playlists.length.toLocaleString() }} / {{ pagination.playlists.total.toLocaleString() }}
          </span>
          <div class="flex-1 h-px bg-white/[0.06]"></div>
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
              nb_tracks: playlist.nb_tracks,
              source: (playlist as any).source,
              qobuzId: (playlist as any).qobuzId,
              qobuzType: 'playlist'
            }"
            type="playlist"
          />
        </div>
        <!-- Load More Button -->
        <div v-if="pagination.playlists.hasMore" class="mt-4 text-center">
          <button
            @click="loadMore('playlist')"
            :disabled="pagination.playlists.loading"
            class="px-8 py-2 font-mono text-[10.5px] tracking-[0.12em] uppercase border border-white/[0.1] text-foreground-muted hover:text-primary-500 hover:border-primary-500/50 transition-colors disabled:opacity-50"
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

<style scoped>
/* Outlined ghost word in the hero headline (mockup h1.big .ghost) */
.ghost-text {
  color: transparent;
  -webkit-text-stroke: 1px rgb(255 255 255 / 0.18);
}
</style>
