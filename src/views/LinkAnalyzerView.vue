<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useDownloadStore } from '../stores/downloadStore'
import { useAuthStore } from '../stores/authStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useToastStore } from '../stores/toastStore'
import BackButton from '../components/BackButton.vue'
import { isDeezerUrl, isSpotifyUrl, isQobuzUrl } from '../utils/urlHost'
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu } from '../composables/useContextMenu'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const downloadStore = useDownloadStore()
const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const toastStore = useToastStore()

const linkInput = ref('')
const isAnalyzing = ref(false)
const error = ref('')
const result = ref<any>(null)
const serverPort = ref(6595)

// Spotify-specific state
const isSpotifyLink = ref(false)
const spotifyResult = ref<any>(null)
const isConverting = ref(false)
const conversionResult = ref<any>(null)
const conversionProgress = ref({ current: 0, total: 0 })
// 2.4: which service the Link Analyzer resolves a Spotify link against.
// 'both' runs the cross-service availability matrix.
const targetService = ref<'deezer' | 'qobuz' | 'both'>('deezer')
// In 'both' mode, the default service to download from when a track is on both.
const bothPreference = ref<'deezer' | 'qobuz'>('qobuz')
// Per-track service overrides in 'both' mode, keyed by Spotify track id.
const trackOverrides = ref<Record<string, 'deezer' | 'qobuz'>>({})

const deezerConnected = computed(() => authStore.isLoggedIn)
const qobuzConnected = computed(() => settingsStore.isQobuzLinked)

// Resolve which service a both-mode track downloads from: a valid per-track
// override wins; otherwise the global preference, falling back to the other
// service when the preferred one doesn't have it. null = on neither service.
function resolvedServiceFor(m: any): 'deezer' | 'qobuz' | null {
  const hasD = !!m.deezer, hasQ = !!m.qobuz
  const override = trackOverrides.value[m.spotify?.id]
  if (override === 'deezer' && hasD) return 'deezer'
  if (override === 'qobuz' && hasQ) return 'qobuz'
  if (bothPreference.value === 'qobuz') return hasQ ? 'qobuz' : (hasD ? 'deezer' : null)
  return hasD ? 'deezer' : (hasQ ? 'qobuz' : null)
}

// Click a lit cell to force that track to that service (no-op if unavailable).
function chooseService(m: any, service: 'deezer' | 'qobuz') {
  if (service === 'deezer' && !m.deezer) return
  if (service === 'qobuz' && !m.qobuz) return
  trackOverrides.value = { ...trackOverrides.value, [m.spotify.id]: service }
}

// Download tally for the both-mode button: how many resolve to each service.
const bothCounts = computed(() => {
  const matched = conversionResult.value?.matched || []
  let deezer = 0, qobuz = 0
  for (const m of matched) {
    const s = resolvedServiceFor(m)
    if (s === 'deezer') deezer++
    else if (s === 'qobuz') qobuz++
  }
  return { deezer, qobuz, total: deezer + qobuz }
})

// Qobuz-specific state (WIP)
const qobuzResult = ref<any>(null)
const qobuzDownloading = ref(false)

// ---- Multi-link batch (#142) ----------------------------------------------
// Paste more than one link and the analyzer works through them one at a time,
// keeping a row per link. The detail view below the list still shows exactly
// one result, driven by the same refs as before: selecting a row restores that
// link's saved state into them, so every existing render block and button keeps
// working unchanged. Spotify links are converted as part of the run so a row is
// download-ready when it turns green.
type BatchKind = 'deezer' | 'spotify' | 'qobuz'
interface BatchSnapshot { result: any; spotifyResult: any; qobuzResult: any; conversionResult: any; isSpotifyLink: boolean }
interface BatchRow {
  url: string
  kind: BatchKind
  status: 'pending' | 'analyzing' | 'ready' | 'failed'
  type?: string
  title?: string
  subtitle?: string
  error?: string
  snapshot?: BatchSnapshot
}
const batch = ref<BatchRow[]>([])
const batchRunning = ref(false)
const batchSelected = ref(-1)
const batchReady = computed(() => batch.value.filter(r => r.status === 'ready').length)
const batchDone = computed(() => batch.value.filter(r => r.status === 'ready' || r.status === 'failed').length)
const batchDownloading = ref(false)

// Pull every supported link out of whatever was typed or pasted, in order,
// without duplicates. Separators are whitespace, commas and semicolons; a
// text input collapses pasted newlines into spaces, so that case is covered.
function extractLinks(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const u = raw.trim().replace(/^<|>$/g, '')
    if (!u || seen.has(u)) continue
    if (isDeezerUrl(u) || isSpotifyUrl(u) || isQobuzUrl(u)) { seen.add(u); out.push(u) }
  }
  return out
}

function kindOf(url: string): BatchKind { return isSpotifyUrl(url) ? 'spotify' : isQobuzUrl(url) ? 'qobuz' : 'deezer' }

function takeSnapshot(): BatchSnapshot {
  return { result: result.value, spotifyResult: spotifyResult.value, qobuzResult: qobuzResult.value, conversionResult: conversionResult.value, isSpotifyLink: isSpotifyLink.value }
}
function restoreSnapshot(sn: BatchSnapshot) {
  result.value = sn.result; spotifyResult.value = sn.spotifyResult; qobuzResult.value = sn.qobuzResult
  conversionResult.value = sn.conversionResult; isSpotifyLink.value = sn.isSpotifyLink; error.value = ''
}

// Summary line for a row, read off whichever result the link produced.
function describeRow(row: BatchRow) {
  if (row.kind === 'spotify' && spotifyResult.value) {
    const d = spotifyResult.value.data || {}
    row.type = spotifyResult.value.type
    row.title = d.name || d.title || row.url
    row.subtitle = d.artists?.[0]?.name || d.owner?.display_name || ''
    const m = conversionResult.value?.matched?.length
    if (typeof m === 'number') row.subtitle = [row.subtitle, `${m} matched`].filter(Boolean).join(' · ')
  } else if (row.kind === 'qobuz' && qobuzResult.value) {
    const q = qobuzResult.value
    row.type = q.type
    row.title = q.data?.title || q.data?.name || row.url
    row.subtitle = q.data?.artist?.name || q.data?.owner?.name || ''
  } else if (result.value) {
    const d = result.value.data || {}
    row.type = result.value.type
    row.title = d.title || d.name || row.url
    row.subtitle = result.value.type === 'playlist' ? (result.value.creator || d.creator?.name || '') : (d.artist?.name || '')
  }
}

// Sequential on purpose: Deezer rate-limits, and this view already has to cope
// with quota errors on a single link. One failure marks its row and the run
// carries on with the next.
async function runBatch(links: string[]) {
  batch.value = links.map(url => ({ url, kind: kindOf(url), status: 'pending' as const }))
  batchSelected.value = -1
  batchRunning.value = true
  try {
    for (let i = 0; i < batch.value.length; i++) {
      const row = batch.value[i]
      row.status = 'analyzing'
      await analyzeOne(row.url)
      if (!error.value && isSpotifyLink.value && spotifyResult.value) {
        await convertSpotifyToDeezer()
      }
      if (error.value) {
        row.status = 'failed'
        row.error = error.value
      } else {
        describeRow(row)
        row.snapshot = takeSnapshot()
        row.status = 'ready'
      }
    }
  } finally {
    batchRunning.value = false
    error.value = ''
    const first = batch.value.findIndex(r => r.status === 'ready')
    if (first >= 0) selectBatchRow(first)
  }
}

function selectBatchRow(i: number) {
  const row = batch.value[i]
  if (!row) return
  batchSelected.value = i
  if (row.snapshot) restoreSnapshot(row.snapshot)
  else { result.value = null; spotifyResult.value = null; qobuzResult.value = null; conversionResult.value = null; error.value = row.error || '' }
}

function clearBatch() {
  batch.value = []
  batchSelected.value = -1
  result.value = null; spotifyResult.value = null; qobuzResult.value = null; conversionResult.value = null; isSpotifyLink.value = false; error.value = ''
}

// Route one row through the same download action its detail view uses.
async function downloadBatchRow(i: number) {
  const row = batch.value[i]
  if (!row?.snapshot || row.status !== 'ready') return
  selectBatchRow(i)
  if (row.kind === 'qobuz') await downloadQobuz()
  else if (row.kind === 'spotify') await downloadConvertedTracks()
  else await handleDownload()
}

async function downloadAllReady() {
  if (batchDownloading.value) return
  batchDownloading.value = true
  let n = 0
  try {
    for (let i = 0; i < batch.value.length; i++) {
      // Artists have no direct download; their detail action navigates to the
      // artist page, which would yank the user off this screen mid-run.
      if (batch.value[i].status !== 'ready' || batch.value[i].type === 'artist') continue
      await downloadBatchRow(i)
      n++
    }
    toastStore.success(t('notifications.queuedLinks', { n, total: batch.value.length }))
  } finally {
    batchDownloading.value = false
  }
}

// Get the actual server port on mount
onMounted(async () => {
  if (window.electronAPI) {
    serverPort.value = await window.electronAPI.getServerPort()
  }
  // Default the target service by what's connected: Both when both services are
  // live (the richest view), otherwise whichever single service is available.
  if (deezerConnected.value && qobuzConnected.value) targetService.value = 'both'
  else if (qobuzConnected.value && !deezerConnected.value) targetService.value = 'qobuz'
  else targetService.value = 'deezer'
  // Auto-analyze if URL passed via query parameter (from Search redirect)
  if (route.query.url) {
    linkInput.value = route.query.url as string
    analyzeLink()
  }
})

// Format duration from seconds to MM:SS or HH:MM:SS
function formatDuration(seconds: number): string {
  if (!seconds) return '-'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

// Format date to readable format
function formatDate(dateStr: string): string {
  if (!dateStr) return '-'
  try {
    const date = new Date(dateStr + 'T00:00:00')
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  } catch {
    return dateStr
  }
}

// Format large numbers with commas
function formatNumber(num: number): string {
  if (!num && num !== 0) return '-'
  return num.toLocaleString()
}

// URL type detection now uses shared hostname matching (src/utils/urlHost.ts)
// instead of substring checks. isDeezerUrl/isSpotifyUrl are imported above.

// Get cover image URL (largest available)
const coverUrl = computed(() => {
  if (!result.value?.data) return ''
  const data = result.value.data
  return data.cover_xl || data.cover_big || data.cover_medium ||
         data.picture_xl || data.picture_big || data.picture_medium ||
         data.album?.cover_xl || data.album?.cover_big || data.album?.cover_medium || ''
})

// Get title based on content type
const title = computed(() => {
  if (!result.value?.data) return ''
  return result.value.data.title || result.value.data.name || ''
})

// Get subtitle (artist name or creator)
const subtitle = computed(() => {
  if (!result.value?.data) return ''
  const data = result.value.data
  if (result.value.type === 'playlist') {
    return result.value.creator || data.creator?.name || 'Unknown Creator'
  }
  return data.artist?.name || ''
})

async function analyzeLink() {
  const raw = linkInput.value.trim()
  if (!raw) {
    error.value = 'Please enter a Deezer, Spotify, or Qobuz link'
    return
  }
  const links = extractLinks(raw)
  // More than one supported link in the box: run them as a batch (#142).
  if (links.length > 1) {
    await runBatch(links)
    return
  }
  if (batch.value.length) clearBatch()
  await analyzeOne(links[0] || raw)
}

async function analyzeOne(url: string) {
  isAnalyzing.value = true
  error.value = ''
  result.value = null
  spotifyResult.value = null
  conversionResult.value = null
  qobuzResult.value = null
  isSpotifyLink.value = false

  try {
    // Ensure we have the correct server port
    if (window.electronAPI) {
      serverPort.value = await window.electronAPI.getServerPort()
    }

    // Check if it's a Spotify URL
    if (isSpotifyUrl(url)) {
      isSpotifyLink.value = true
      await analyzeSpotifyLink(url)
    } else if (isQobuzUrl(url)) {
      await analyzeQobuzLink(url)
    } else if (isDeezerUrl(url)) {
      await analyzeDeezerLink(url)
    } else {
      error.value = 'Please enter a valid Deezer, Spotify, or Qobuz link'
    }
  } catch (err: any) {
    console.error('[LinkAnalyzer] Error:', err)
    error.value = `Failed to connect to server (port ${serverPort.value}). ${err.message || ''}`
  } finally {
    isAnalyzing.value = false
  }
}

async function analyzeQobuzLink(url: string) {
  const resp = await fetch(`http://localhost:${serverPort.value}/api/qobuz/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const data = await resp.json()
  if (!resp.ok) {
    error.value = data.error === 'Qobuz not connected'
      ? 'Connect your Qobuz account in Settings first.'
      : data.error || 'Failed to analyze Qobuz link'
    return
  }
  qobuzResult.value = data
}

// Collect the track ids a Qobuz analyze result implies (single track, or all
// tracks of an album/playlist).
// Route to the source-aware detail view for an analyzed Qobuz link. Tracks
// route to their album (no track detail page exists — same rule as Deezer).
const qobuzDetailRoute = computed(() => {
  const q = qobuzResult.value
  if (!q) return null
  if (q.type === 'track') {
    const albumId = q.data?.album?.id
    return albumId ? { path: `/album/${albumId}`, query: { source: 'qobuz' } } : null
  }
  if (q.type === 'album' || q.type === 'playlist' || q.type === 'artist') {
    return { path: `/${q.type}/${q.id}`, query: { source: 'qobuz' } }
  }
  return null
})

function qobuzTrackIds(q: any): (string | number)[] {
  if (!q) return []
  if (q.type === 'track') return [q.id]
  const items = q.data?.tracks?.items || []
  return items.map((t: any) => t.id).filter(Boolean)
}

async function downloadQobuz() {
  const q = qobuzResult.value
  if (!q) return
  qobuzDownloading.value = true
  try {
    if (q.type === 'album' || q.type === 'playlist') {
      // Grouped: one Transfer Rack row aggregating all tracks (like Deezer albums).
      await downloadStore.addQobuzAlbumDownload(q)
      const n = qobuzTrackIds(q).length
      toastStore.success(t('notifications.queuedQobuzItem', { title: q.data?.title || 'Qobuz ' + q.type, count: n }))
    } else {
      // Single track. A non-OK response must NOT toast success — surface the
      // server's actual error instead.
      const resp = await fetch(`http://localhost:${serverPort.value}/api/qobuz/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: q.id }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({} as any))
        throw new Error(err.error || `server returned HTTP ${resp.status}`)
      }
      toastStore.success(t('notifications.queuedQobuzTrack'))
    }
  } catch (e: any) {
    toastStore.error(t('notifications.qobuzDownloadFailed', { message: e.message }))
  } finally {
    qobuzDownloading.value = false
  }
}

async function analyzeDeezerLink(url: string) {
  const apiUrl = `http://localhost:${serverPort.value}/api/analyze?url=${encodeURIComponent(url)}`
  console.log('[LinkAnalyzer] Fetching Deezer:', apiUrl)

  const response = await fetch(apiUrl)
  const data = await response.json()

  console.log('[LinkAnalyzer] Deezer Response:', response.status, data)

  if (!response.ok) {
    error.value = data.error || 'Failed to analyze link'
    return
  }

  result.value = data
}

async function analyzeSpotifyLink(url: string) {
  const apiUrl = `http://localhost:${serverPort.value}/api/spotify/analyze`
  console.log('[LinkAnalyzer] Fetching Spotify:', apiUrl)

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  })
  const data = await response.json()

  console.log('[LinkAnalyzer] Spotify Response:', response.status, data)

  if (!response.ok) {
    error.value = data.error || 'Failed to analyze Spotify link'
    return
  }

  spotifyResult.value = data
}

async function convertSpotifyToDeezer() {
  if (!spotifyResult.value) return

  isConverting.value = true
  conversionResult.value = null
  conversionProgress.value = { current: 0, total: 0 }
  trackOverrides.value = {}

  // Poll the server's live per-track progress on a side channel so a long match
  // shows real "N / total" movement. Best-effort: the conversion result comes
  // back on the main request regardless of whether these polls succeed.
  const progressToken = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const pollProgress = async () => {
    try {
      const r = await fetch(`http://localhost:${serverPort.value}/api/spotify/convert-progress?token=${progressToken}`)
      if (!r.ok) return
      const p = await r.json()
      if (p && typeof p.total === 'number' && p.total > 0) {
        conversionProgress.value = { current: p.current || 0, total: p.total }
      }
    } catch { /* progress is cosmetic; ignore transient poll failures */ }
  }
  pollTimer = setInterval(pollProgress, 400)

  try {
    const apiUrl = `http://localhost:${serverPort.value}/api/spotify/convert`
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: spotifyResult.value.type,
        id: spotifyResult.value.id,
        targetService: targetService.value,
        progressToken
      })
    })

    const data = await response.json()

    if (!response.ok) {
      error.value = data.error || 'Failed to convert Spotify content'
      return
    }

    conversionResult.value = data
  } catch (err: any) {
    console.error('[LinkAnalyzer] Conversion error:', err)
    error.value = `Conversion failed: ${err.message || ''}`
  } finally {
    if (pollTimer) clearInterval(pollTimer)
    isConverting.value = false
  }
}

async function downloadConvertedTracks() {
  if (!conversionResult.value?.matched) {
    toastStore.error(t('notifications.noConversionResults'))
    return
  }

  const sourcePlaylistName = spotifyResult.value?.data?.name || 'Spotify Playlist'
  const coverUrl = spotifyResult.value?.data?.images?.[0]?.url
    || spotifyResult.value?.data?.album?.images?.[0]?.url
    || ''

  // Both-services matrix: each matched track downloads from its resolved
  // service (override or preference+fallback) as one mixed playlist row.
  if (conversionResult.value.service === 'both') {
    const tracks: { id: number; service: 'deezer' | 'qobuz' }[] = []
    for (const m of conversionResult.value.matched) {
      const svc = resolvedServiceFor(m)
      if (!svc) continue
      const hit = svc === 'qobuz' ? m.qobuz : m.deezer
      if (hit && hit.id) tracks.push({ id: Number(hit.id), service: svc })
    }
    if (tracks.length === 0) {
      toastStore.error(t('notifications.noDownloadableTracks'))
      return
    }
    try {
      await downloadStore.addMixedBatchDownload({
        tracks,
        playlistName: sourcePlaylistName,
        title: sourcePlaylistName,
        cover: coverUrl,
        totalTracks: tracks.length
      })
      toastStore.success(t('notifications.addedTracksToQueue', { count: tracks.length }))
    } catch (err: any) {
      toastStore.error(t('notifications.downloadStartFailed', { message: err.message || t('common.unknownError') }))
    }
    return
  }

  // Which service these matches resolved against (server echoes it; default deezer).
  const service: 'deezer' | 'qobuz' = conversionResult.value.service === 'qobuz' ? 'qobuz' : 'deezer'
  const serviceLabel = service === 'qobuz' ? 'Qobuz' : 'Deezer'

  // Collect matched track IDs. Prefer the neutral `match` field (2.4); fall back
  // to the legacy `deezer`/`deezerTrack` shape for older responses.
  const trackIds: number[] = []
  for (const m of conversionResult.value.matched) {
    const hit = m.match || m.deezer || m.deezerTrack
    if (hit && hit.id) {
      trackIds.push(Number(hit.id))
    }
  }

  if (trackIds.length === 0) {
    toastStore.error(t('notifications.noMatchingTracks', { service: serviceLabel }))
    return
  }

  // Single batch request — the server queues all tracks and returns one set of IDs.
  // The download store tracks them as a single playlist item with unified progress
  // and routes to the matching service's batch endpoint.
  try {
    await downloadStore.addBatchDownload({
      trackIds,
      playlistName: sourcePlaylistName,
      title: sourcePlaylistName,
      cover: coverUrl,
      totalTracks: trackIds.length,
      service
    })
    toastStore.success(t('notifications.addedTracksToQueue', { count: trackIds.length }))
  } catch (err: any) {
    toastStore.error(t('notifications.downloadStartFailed', { message: err.message || t('common.unknownError') }))
  }
}

async function handleDownload() {
  if (!result.value || !authStore.isLoggedIn) return

  const { type, id, data } = result.value

  switch (type) {
    case 'track':
      // Construct a proper Track object for addDownload
      await downloadStore.addDownload({
        id,
        title: data.title,
        artist: data.artist || { id: 0, name: 'Unknown Artist' },
        album: data.album,
        duration: data.duration || 0,
        cover: data.album?.cover_medium || ''
      })
      break
    case 'album':
      // Construct an Album object for addAlbumDownload
      // The server will fetch the actual tracks
      const albumObj = {
        id,
        title: data.title,
        artist: data.artist || { id: 0, name: 'Unknown Artist' },
        cover_medium: data.cover_medium || '',
        cover_big: data.cover_big || '',
        cover_xl: data.cover_xl || '',
        nb_tracks: data.nb_tracks || 0
      }
      // Create placeholder tracks array based on track count
      const albumTracks = Array(data.nb_tracks || 0).fill({ id: 0, title: '', artist: { id: 0, name: '' }, duration: 0 })
      await downloadStore.addAlbumDownload(albumObj, albumTracks)
      break
    case 'playlist':
      // Construct a Playlist object for addPlaylistDownload
      const playlistObj = {
        id,
        title: data.title,
        creator: data.creator || { id: 0, name: 'Unknown' },
        picture_medium: data.picture_medium || '',
        picture_big: data.picture_big || '',
        nb_tracks: data.nb_tracks || 0
      }
      // Create placeholder tracks array based on track count
      const playlistTracks = Array(data.nb_tracks || 0).fill({ id: 0, title: '', artist: { id: 0, name: '' }, duration: 0 })
      await downloadStore.addPlaylistDownload(playlistObj, playlistTracks)
      break
    case 'artist':
      // Navigate to artist page for download options
      router.push(`/artist/${id}`)
      break
  }
}

function navigateToContent() {
  if (!result.value) return
  const { type, id, data } = result.value
  // For tracks, navigate to the album instead (no track detail page exists)
  if (type === 'track' && data?.album?.id) {
    router.push(`/album/${data.album.id}`)
  } else {
    router.push(`/${type}/${id}`)
  }
}

function handlePaste(e: ClipboardEvent) {
  // Auto-analyze on paste if it looks like a Deezer or Spotify URL
  const text = e.clipboardData?.getData('text') || ''
  if (extractLinks(text).length > 0) {
    // Let the paste happen first, then analyze
    setTimeout(() => {
      analyzeLink()
    }, 100)
  }
}

// Country code to name and flag mapping
const countryData: Record<string, { name: string; flag: string }> = {
  AD: { name: 'Andorra', flag: '🇦🇩' },
  AE: { name: 'United Arab Emirates', flag: '🇦🇪' },
  AF: { name: 'Afghanistan', flag: '🇦🇫' },
  AG: { name: 'Antigua and Barbuda', flag: '🇦🇬' },
  AL: { name: 'Albania', flag: '🇦🇱' },
  AM: { name: 'Armenia', flag: '🇦🇲' },
  AO: { name: 'Angola', flag: '🇦🇴' },
  AR: { name: 'Argentina', flag: '🇦🇷' },
  AT: { name: 'Austria', flag: '🇦🇹' },
  AU: { name: 'Australia', flag: '🇦🇺' },
  AZ: { name: 'Azerbaijan', flag: '🇦🇿' },
  BA: { name: 'Bosnia and Herzegovina', flag: '🇧🇦' },
  BB: { name: 'Barbados', flag: '🇧🇧' },
  BD: { name: 'Bangladesh', flag: '🇧🇩' },
  BE: { name: 'Belgium', flag: '🇧🇪' },
  BF: { name: 'Burkina Faso', flag: '🇧🇫' },
  BG: { name: 'Bulgaria', flag: '🇧🇬' },
  BH: { name: 'Bahrain', flag: '🇧🇭' },
  BJ: { name: 'Benin', flag: '🇧🇯' },
  BN: { name: 'Brunei', flag: '🇧🇳' },
  BO: { name: 'Bolivia', flag: '🇧🇴' },
  BR: { name: 'Brazil', flag: '🇧🇷' },
  BS: { name: 'Bahamas', flag: '🇧🇸' },
  BW: { name: 'Botswana', flag: '🇧🇼' },
  BY: { name: 'Belarus', flag: '🇧🇾' },
  BZ: { name: 'Belize', flag: '🇧🇿' },
  CA: { name: 'Canada', flag: '🇨🇦' },
  CD: { name: 'DR Congo', flag: '🇨🇩' },
  CH: { name: 'Switzerland', flag: '🇨🇭' },
  CI: { name: 'Ivory Coast', flag: '🇨🇮' },
  CL: { name: 'Chile', flag: '🇨🇱' },
  CM: { name: 'Cameroon', flag: '🇨🇲' },
  CN: { name: 'China', flag: '🇨🇳' },
  CO: { name: 'Colombia', flag: '🇨🇴' },
  CR: { name: 'Costa Rica', flag: '🇨🇷' },
  CV: { name: 'Cape Verde', flag: '🇨🇻' },
  CY: { name: 'Cyprus', flag: '🇨🇾' },
  CZ: { name: 'Czechia', flag: '🇨🇿' },
  DE: { name: 'Germany', flag: '🇩🇪' },
  DJ: { name: 'Djibouti', flag: '🇩🇯' },
  DK: { name: 'Denmark', flag: '🇩🇰' },
  DM: { name: 'Dominica', flag: '🇩🇲' },
  DO: { name: 'Dominican Republic', flag: '🇩🇴' },
  DZ: { name: 'Algeria', flag: '🇩🇿' },
  EC: { name: 'Ecuador', flag: '🇪🇨' },
  EE: { name: 'Estonia', flag: '🇪🇪' },
  EG: { name: 'Egypt', flag: '🇪🇬' },
  ES: { name: 'Spain', flag: '🇪🇸' },
  FI: { name: 'Finland', flag: '🇫🇮' },
  FJ: { name: 'Fiji', flag: '🇫🇯' },
  FR: { name: 'France', flag: '🇫🇷' },
  GA: { name: 'Gabon', flag: '🇬🇦' },
  GB: { name: 'United Kingdom', flag: '🇬🇧' },
  GD: { name: 'Grenada', flag: '🇬🇩' },
  GE: { name: 'Georgia', flag: '🇬🇪' },
  GH: { name: 'Ghana', flag: '🇬🇭' },
  GM: { name: 'Gambia', flag: '🇬🇲' },
  GN: { name: 'Guinea', flag: '🇬🇳' },
  GQ: { name: 'Equatorial Guinea', flag: '🇬🇶' },
  GR: { name: 'Greece', flag: '🇬🇷' },
  GT: { name: 'Guatemala', flag: '🇬🇹' },
  GW: { name: 'Guinea-Bissau', flag: '🇬🇼' },
  HK: { name: 'Hong Kong', flag: '🇭🇰' },
  HN: { name: 'Honduras', flag: '🇭🇳' },
  HR: { name: 'Croatia', flag: '🇭🇷' },
  HT: { name: 'Haiti', flag: '🇭🇹' },
  HU: { name: 'Hungary', flag: '🇭🇺' },
  ID: { name: 'Indonesia', flag: '🇮🇩' },
  IE: { name: 'Ireland', flag: '🇮🇪' },
  IL: { name: 'Israel', flag: '🇮🇱' },
  IN: { name: 'India', flag: '🇮🇳' },
  IQ: { name: 'Iraq', flag: '🇮🇶' },
  IS: { name: 'Iceland', flag: '🇮🇸' },
  IT: { name: 'Italy', flag: '🇮🇹' },
  JM: { name: 'Jamaica', flag: '🇯🇲' },
  JO: { name: 'Jordan', flag: '🇯🇴' },
  JP: { name: 'Japan', flag: '🇯🇵' },
  KE: { name: 'Kenya', flag: '🇰🇪' },
  KG: { name: 'Kyrgyzstan', flag: '🇰🇬' },
  KH: { name: 'Cambodia', flag: '🇰🇭' },
  KM: { name: 'Comoros', flag: '🇰🇲' },
  KR: { name: 'South Korea', flag: '🇰🇷' },
  KW: { name: 'Kuwait', flag: '🇰🇼' },
  KZ: { name: 'Kazakhstan', flag: '🇰🇿' },
  LA: { name: 'Laos', flag: '🇱🇦' },
  LB: { name: 'Lebanon', flag: '🇱🇧' },
  LC: { name: 'Saint Lucia', flag: '🇱🇨' },
  LK: { name: 'Sri Lanka', flag: '🇱🇰' },
  LR: { name: 'Liberia', flag: '🇱🇷' },
  LT: { name: 'Lithuania', flag: '🇱🇹' },
  LU: { name: 'Luxembourg', flag: '🇱🇺' },
  LV: { name: 'Latvia', flag: '🇱🇻' },
  LY: { name: 'Libya', flag: '🇱🇾' },
  MA: { name: 'Morocco', flag: '🇲🇦' },
  MC: { name: 'Monaco', flag: '🇲🇨' },
  MD: { name: 'Moldova', flag: '🇲🇩' },
  ME: { name: 'Montenegro', flag: '🇲🇪' },
  MG: { name: 'Madagascar', flag: '🇲🇬' },
  MK: { name: 'North Macedonia', flag: '🇲🇰' },
  ML: { name: 'Mali', flag: '🇲🇱' },
  MN: { name: 'Mongolia', flag: '🇲🇳' },
  MR: { name: 'Mauritania', flag: '🇲🇷' },
  MT: { name: 'Malta', flag: '🇲🇹' },
  MU: { name: 'Mauritius', flag: '🇲🇺' },
  MW: { name: 'Malawi', flag: '🇲🇼' },
  MX: { name: 'Mexico', flag: '🇲🇽' },
  MY: { name: 'Malaysia', flag: '🇲🇾' },
  MZ: { name: 'Mozambique', flag: '🇲🇿' },
  NA: { name: 'Namibia', flag: '🇳🇦' },
  NE: { name: 'Niger', flag: '🇳🇪' },
  NG: { name: 'Nigeria', flag: '🇳🇬' },
  NI: { name: 'Nicaragua', flag: '🇳🇮' },
  NL: { name: 'Netherlands', flag: '🇳🇱' },
  NO: { name: 'Norway', flag: '🇳🇴' },
  NP: { name: 'Nepal', flag: '🇳🇵' },
  NZ: { name: 'New Zealand', flag: '🇳🇿' },
  OM: { name: 'Oman', flag: '🇴🇲' },
  PA: { name: 'Panama', flag: '🇵🇦' },
  PE: { name: 'Peru', flag: '🇵🇪' },
  PG: { name: 'Papua New Guinea', flag: '🇵🇬' },
  PH: { name: 'Philippines', flag: '🇵🇭' },
  PK: { name: 'Pakistan', flag: '🇵🇰' },
  PL: { name: 'Poland', flag: '🇵🇱' },
  PS: { name: 'Palestine', flag: '🇵🇸' },
  PT: { name: 'Portugal', flag: '🇵🇹' },
  PY: { name: 'Paraguay', flag: '🇵🇾' },
  QA: { name: 'Qatar', flag: '🇶🇦' },
  RO: { name: 'Romania', flag: '🇷🇴' },
  RS: { name: 'Serbia', flag: '🇷🇸' },
  RU: { name: 'Russia', flag: '🇷🇺' },
  RW: { name: 'Rwanda', flag: '🇷🇼' },
  SA: { name: 'Saudi Arabia', flag: '🇸🇦' },
  SC: { name: 'Seychelles', flag: '🇸🇨' },
  SE: { name: 'Sweden', flag: '🇸🇪' },
  SG: { name: 'Singapore', flag: '🇸🇬' },
  SI: { name: 'Slovenia', flag: '🇸🇮' },
  SK: { name: 'Slovakia', flag: '🇸🇰' },
  SL: { name: 'Sierra Leone', flag: '🇸🇱' },
  SN: { name: 'Senegal', flag: '🇸🇳' },
  SV: { name: 'El Salvador', flag: '🇸🇻' },
  TD: { name: 'Chad', flag: '🇹🇩' },
  TG: { name: 'Togo', flag: '🇹🇬' },
  TH: { name: 'Thailand', flag: '🇹🇭' },
  TJ: { name: 'Tajikistan', flag: '🇹🇯' },
  TN: { name: 'Tunisia', flag: '🇹🇳' },
  TR: { name: 'Turkey', flag: '🇹🇷' },
  TT: { name: 'Trinidad and Tobago', flag: '🇹🇹' },
  TW: { name: 'Taiwan', flag: '🇹🇼' },
  TZ: { name: 'Tanzania', flag: '🇹🇿' },
  UA: { name: 'Ukraine', flag: '🇺🇦' },
  UG: { name: 'Uganda', flag: '🇺🇬' },
  US: { name: 'United States', flag: '🇺🇸' },
  UY: { name: 'Uruguay', flag: '🇺🇾' },
  UZ: { name: 'Uzbekistan', flag: '🇺🇿' },
  VE: { name: 'Venezuela', flag: '🇻🇪' },
  VN: { name: 'Vietnam', flag: '🇻🇳' },
  ZA: { name: 'South Africa', flag: '🇿🇦' },
  ZM: { name: 'Zambia', flag: '🇿🇲' },
  ZW: { name: 'Zimbabwe', flag: '🇿🇼' }
}

function getCountryInfo(code: string): { name: string; flag: string } {
  return countryData[code] || { name: code, flag: '🏳️' }
}

// Metadata rows based on content type - paired for 2-column layout
const metadataRows = computed(() => {
  if (!result.value?.data) return []

  const data = result.value.data
  const type = result.value.type
  // Return pairs of [left, right] for 2-column layout
  const pairs: { left: { label: string; value: string }; right?: { label: string; value: string } }[] = []

  switch (type) {
    case 'track':
      // Match original deemix-gui 2-column layout
      pairs.push({
        left: { label: t('analyzer.fields.id'), value: String(result.value.id) },
        right: { label: t('analyzer.fields.type'), value: t('analyzer.types.track') }
      })
      pairs.push({
        left: { label: t('analyzer.fields.title'), value: data.title || '-' },
        right: { label: t('analyzer.fields.artist'), value: data.artist?.name || '-' }
      })
      pairs.push({
        left: { label: t('analyzer.fields.album'), value: data.album?.title || '-' },
        right: { label: t('analyzer.fields.duration'), value: formatDuration(data.duration) }
      })
      pairs.push({
        left: { label: t('analyzer.fields.isrc'), value: result.value.isrc || '-' },
        right: { label: t('analyzer.fields.releaseDate'), value: formatDate(data.release_date) }
      })
      pairs.push({
        left: { label: t('analyzer.fields.bpm'), value: result.value.bpm ? String(result.value.bpm) : '-' },
        right: { label: t('analyzer.fields.trackNumber'), value: `${data.track_position || '-'} / ${data.disk_number || 1}` }
      })
      pairs.push({
        left: { label: t('analyzer.fields.explicit'), value: data.explicit_lyrics ? t('common.yes') : t('common.no') },
        right: { label: t('analyzer.fields.readable'), value: result.value.readable ? t('common.yes') : t('common.no') }
      })
      pairs.push({
        left: { label: t('analyzer.fields.available'), value: result.value.available ? t('common.yes') : t('common.no') }
      })
      break

    case 'album':
      pairs.push({
        left: { label: t('analyzer.fields.id'), value: String(result.value.id) },
        right: { label: t('analyzer.fields.type'), value: t('analyzer.types.album') }
      })
      pairs.push({
        left: { label: t('analyzer.fields.title'), value: data.title || '-' },
        right: { label: t('analyzer.fields.artist'), value: data.artist?.name || '-' }
      })
      pairs.push({
        left: { label: t('analyzer.fields.releaseDate'), value: formatDate(data.release_date) },
        right: { label: t('analyzer.fields.trackCount'), value: formatNumber(result.value.trackCount) }
      })
      pairs.push({
        left: { label: t('analyzer.fields.duration'), value: formatDuration(data.duration) },
        right: { label: t('analyzer.fields.upc'), value: result.value.upc || '-' }
      })
      pairs.push({
        left: { label: t('analyzer.fields.label'), value: result.value.label || '-' },
        right: { label: t('analyzer.fields.genres'), value: result.value.genres?.join(', ') || '-' }
      })
      pairs.push({
        left: { label: t('analyzer.fields.recordType'), value: data.record_type || '-' },
        right: { label: t('analyzer.fields.explicit'), value: data.explicit_lyrics ? t('common.yes') : t('common.no') }
      })
      break

    case 'artist':
      pairs.push({
        left: { label: t('analyzer.fields.id'), value: String(result.value.id) },
        right: { label: t('analyzer.fields.type'), value: t('analyzer.types.artist') }
      })
      pairs.push({
        left: { label: t('analyzer.fields.name'), value: data.name || '-' },
        right: { label: t('analyzer.fields.fanCount'), value: formatNumber(result.value.fanCount) }
      })
      pairs.push({
        left: { label: t('analyzer.fields.albumCount'), value: formatNumber(result.value.albumCount) }
      })
      break

    case 'playlist':
      pairs.push({
        left: { label: t('analyzer.fields.id'), value: String(result.value.id) },
        right: { label: t('analyzer.fields.type'), value: t('analyzer.types.playlist') }
      })
      pairs.push({
        left: { label: t('analyzer.fields.title'), value: data.title || '-' },
        right: { label: t('analyzer.fields.creator'), value: result.value.creator || '-' }
      })
      pairs.push({
        left: { label: t('analyzer.fields.trackCount'), value: formatNumber(result.value.trackCount) },
        right: { label: t('analyzer.fields.duration'), value: formatDuration(result.value.totalDuration) }
      })
      pairs.push({
        left: { label: t('analyzer.fields.public'), value: result.value.isPublic ? t('common.yes') : t('common.no') },
        right: { label: t('analyzer.fields.fans'), value: formatNumber(data.fans) }
      })
      break
  }

  return pairs
})

// Context menu for metadata values
const { menuState, openMenu, closeMenu, copyToClipboard, pasteFromClipboard } = useContextMenu()
const contextMenuValue = ref('')
const contextMenuLabel = ref('')
const contextMenuMode = ref<'copy' | 'input'>('copy')

function openMetadataMenu(e: MouseEvent, label: string, value: string) {
  if (value && value !== '-') {
    contextMenuValue.value = value
    contextMenuLabel.value = label
    contextMenuMode.value = 'copy'
    openMenu(e)
  }
}

function openInputMenu(e: MouseEvent) {
  contextMenuMode.value = 'input'
  openMenu(e)
}

const contextMenuItems = computed(() => {
  if (contextMenuMode.value === 'input') {
    return [
      {
        label: t('common.paste'),
        icon: 'paste',
        action: async () => {
          const text = await pasteFromClipboard()
          if (text) {
            linkInput.value = text
          }
        }
      },
      {
        label: t('common.copy'),
        icon: 'copy',
        action: () => copyToClipboard(linkInput.value, 'Link'),
        disabled: !linkInput.value
      }
    ]
  }
  return [
    {
      label: `Copy ${contextMenuLabel.value}`,
      icon: 'copy',
      action: () => copyToClipboard(contextMenuValue.value, contextMenuLabel.value)
    }
  ]
})

// Paste link function (for paste button)
async function pasteLink() {
  const text = await pasteFromClipboard()
  if (text) {
    linkInput.value = text
  }
}

</script>

<template>
  <div class="space-y-6">
    <!-- Back Button -->
    <BackButton />

    <!-- Header -->
    <div class="mb-6">
      <h1 class="font-display uppercase text-[22px] tracking-[0.02em] mb-2">{{ t('analyzer.title') }}</h1>
      <p class="text-foreground-muted">
        {{ t('analyzer.subtitle') }}
      </p>
    </div>

    <!-- Input Section — LINK command bar -->
    <div>
      <form @submit.prevent="analyzeLink">
        <div class="flex items-stretch h-14 border border-white/[0.08] bg-background-secondary/70 focus-within:border-primary-500/50 transition-colors">
          <span class="flex items-center px-3.5 font-mono text-[11px] font-bold tracking-[0.1em] bg-primary-500 text-background-main select-none">LINK</span>
          <input
            v-model="linkInput"
            type="text"
            :placeholder="t('analyzer.placeholder')"
            class="flex-1 min-w-0 bg-transparent border-none outline-none font-mono text-[13px] px-4 text-foreground placeholder:text-foreground-muted caret-primary-500"
            @paste="handlePaste"
            @contextmenu="openInputMenu"
          />
          <!-- Paste Button -->
          <button
            type="button"
            @click="pasteLink"
            class="flex items-center gap-1.5 px-3.5 border-l border-white/[0.08] font-mono text-[10.5px] uppercase tracking-[0.12em] text-foreground-muted hover:text-primary-500 transition-colors"
            :title="t('common.pasteFromClipboard')"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <span class="hidden sm:inline">Paste</span>
          </button>
          <button
            type="submit"
            :disabled="isAnalyzing || !linkInput.trim()"
            class="flex items-center gap-2 px-5 font-mono text-[11px] uppercase tracking-[0.1em] bg-primary-500 text-background-main hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <svg v-if="isAnalyzing" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <span>{{ isAnalyzing ? t('analyzer.analyzing') : t('analyzer.analyze') }}</span>
          </button>
        </div>
      </form>
    </div>

    <!-- Error State -->
    <div v-if="error" class="border border-red-500/30 bg-red-500/10 px-4 py-3">
      <div class="flex items-center gap-3 text-red-400">
        <svg class="w-6 h-6 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p>{{ error }}</p>
      </div>
    </div>

    <!-- Multi-link batch (#142): one row per pasted link; the detail view below shows the selected row -->
    <div v-if="batch.length" class="bg-background-secondary/60 border border-white/[0.08]">
      <div class="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.08]">
        <span class="font-mono text-[10.5px] uppercase tracking-[0.12em] text-foreground-muted">
          {{ t('analyzer.batchSummary', { links: batch.length, ready: batchReady }) }}<span v-if="batchDone < batch.length"> · {{ t('analyzer.batchAnalyzed', { done: batchDone, total: batch.length }) }}</span><span v-else-if="batch.length - batchReady > 0"> · {{ t('analyzer.batchFailed', { count: batch.length - batchReady }) }}</span>
        </span>
        <svg v-if="batchRunning" class="animate-spin w-3.5 h-3.5 text-primary-500" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <div class="flex-1"></div>
        <button
          type="button"
          :disabled="batchRunning || batchDownloading || batchReady === 0"
          class="px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] bg-primary-500 text-background-main hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          @click="downloadAllReady"
        >
          {{ batchDownloading ? t('analyzer.queuing') : t('analyzer.downloadAllReady', { count: batchReady }) }}
        </button>
        <button
          type="button"
          :disabled="batchRunning"
          class="px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] border border-white/[0.1] text-foreground-muted hover:text-foreground disabled:opacity-50 transition-colors"
          @click="clearBatch"
        >
          Clear
        </button>
      </div>
      <div class="max-h-72 overflow-y-auto divide-y divide-white/[0.06]">
        <div
          v-for="(row, i) in batch"
          :key="row.url"
          class="flex items-center gap-3 px-4 py-2 text-sm cursor-pointer hover:bg-white/[0.03]"
          :class="batchSelected === i ? 'bg-primary-500/10' : ''"
          @click="selectBatchRow(i)"
        >
          <span
            class="w-2 h-2 flex-shrink-0 rounded-full"
            :class="row.status === 'ready' ? 'bg-green-400' : row.status === 'failed' ? 'bg-red-400' : row.status === 'analyzing' ? 'bg-primary-500 animate-pulse' : 'bg-white/20'"
          ></span>
          <span class="flex-shrink-0 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] border border-white/[0.1] text-foreground-muted">{{ row.type || row.kind }}</span>
          <div class="flex-1 min-w-0">
            <div class="truncate" :class="row.status === 'failed' ? 'text-foreground-muted' : ''">{{ row.title || row.url }}</div>
            <div v-if="row.status === 'failed'" class="truncate text-xs text-red-400">{{ row.error }}</div>
            <div v-else-if="row.subtitle" class="truncate text-xs text-foreground-muted">{{ row.subtitle }}</div>
          </div>
          <button
            v-if="row.status === 'ready' && row.type !== 'artist'"
            type="button"
            :disabled="batchDownloading"
            class="flex-shrink-0 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] border border-primary-500/40 text-primary-500 hover:bg-primary-500/10 disabled:opacity-50 transition-colors"
            @click.stop="downloadBatchRow(i)"
          >
            Download
          </button>
        </div>
      </div>
    </div>

    <!-- Results Section -->
    <div v-if="result" class="bg-background-secondary/60 border border-white/[0.08] p-5">
      <!-- Cover and Basic Info -->
      <div class="flex gap-6 mb-6">
        <!-- Cover Image -->
        <div class="w-48 h-48 flex-shrink-0 overflow-hidden bg-background-tertiary border border-white/[0.08]">
          <img
            v-if="coverUrl"
            :src="coverUrl"
            :alt="title"
            class="w-full h-full object-cover"
          />
          <div v-else class="w-full h-full flex items-center justify-center text-foreground-muted">
            <svg class="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <circle cx="12" cy="12" r="10" stroke-width="1.5"/>
              <circle cx="12" cy="12" r="3" stroke-width="1.5"/>
            </svg>
          </div>
        </div>

        <!-- Title and Actions -->
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <span
                class="inline-block px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase border mb-2"
                :class="{
                  'bg-primary-500/10 text-primary-400 border-primary-500/30': result.type === 'track',
                  'bg-blue-500/10 text-blue-400 border-blue-500/30': result.type === 'album',
                  'bg-green-500/10 text-green-400 border-green-500/30': result.type === 'artist',
                  'bg-orange-500/10 text-orange-400 border-orange-500/30': result.type === 'playlist'
                }"
              >
                {{ result.type.toUpperCase() }}
              </span>
              <h2 class="text-2xl font-bold truncate">{{ title }}</h2>
              <p v-if="subtitle" class="text-lg text-foreground-muted truncate">{{ subtitle }}</p>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="flex gap-3 mt-4">
            <button
              v-if="result.type !== 'artist'"
              @click="handleDownload"
              :disabled="!authStore.isLoggedIn || (result.type === 'track' && !result.available)"
              class="btn flex items-center gap-2 font-mono text-[11px] tracking-[0.1em] uppercase"
              :class="(!authStore.isLoggedIn || (result.type === 'track' && !result.available))
                ? 'border border-white/[0.08] text-foreground-muted/50 cursor-not-allowed'
                : 'btn-primary'"
              :title="!authStore.isLoggedIn ? 'Login required to download' : (result.type === 'track' && !result.available) ? 'Track not available for download' : ''"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download
            </button>
            <!-- View Details: For tracks, go to album; for others go to their detail page -->
            <button
              v-if="result.type !== 'track' || result.data?.album?.id"
              @click="navigateToContent"
              class="btn btn-secondary flex items-center gap-2 font-mono text-[11px] tracking-[0.1em] uppercase"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {{ result.type === 'track' ? t('analyzer.viewAlbum') : t('analyzer.viewDetails') }}
            </button>
          </div>

          <!-- Download Notice -->
          <p v-if="!authStore.isLoggedIn && result.type !== 'artist'" class="text-sm text-foreground-muted mt-2">
            {{ t('analyzer.loginRequired') }}
          </p>
          <p v-else-if="result.type === 'track' && !result.available" class="text-sm text-red-400 mt-2">
            {{ t('analyzer.notAvailable') }}
          </p>
        </div>
      </div>

      <!-- Metadata Table - 2 Column Layout -->
      <div class="border-t border-white/[0.08] pt-6">
        <div class="flex items-center gap-3 mb-4">
          <h3 class="font-display text-[14px] uppercase tracking-[0.06em]">Metadata</h3>
          <div class="flex-1 h-px bg-white/[0.06]"></div>
        </div>
        <table class="w-full">
          <tbody>
            <tr
              v-for="(pair, index) in metadataRows"
              :key="index"
              class="border-b border-white/[0.06]"
            >
              <!-- Left column -->
              <td class="py-2 pr-4 font-mono text-[10px] tracking-[0.1em] uppercase text-foreground-muted align-top w-28">{{ pair.left.label }}</td>
              <td
                class="py-2 font-mono text-[12.5px] w-1/3 cursor-context-menu hover:text-primary-400 transition-colors"
                @contextmenu="openMetadataMenu($event, pair.left.label, pair.left.value)"
              >{{ pair.left.value }}</td>
              <!-- Right column -->
              <td v-if="pair.right" class="py-2 pr-4 font-mono text-[10px] tracking-[0.1em] uppercase text-foreground-muted align-top w-28 pl-8">{{ pair.right.label }}</td>
              <td
                v-if="pair.right"
                class="py-2 font-mono text-[12.5px] cursor-context-menu hover:text-primary-400 transition-colors"
                @contextmenu="openMetadataMenu($event, pair.right.label, pair.right.value)"
              >{{ pair.right.value }}</td>
              <td v-else colspan="2"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Availability Status (for tracks) -->
      <div v-if="result.type === 'track'" class="border-t border-white/[0.08] pt-6 mt-6">
        <div class="flex items-center gap-3 mb-4">
          <h3 class="font-display text-[14px] uppercase tracking-[0.06em]">Availability</h3>
          <div class="flex-1 h-px bg-white/[0.06]"></div>
        </div>
        <div class="flex gap-6">
          <div class="flex items-center gap-2">
            <div
              class="w-6 h-6 flex items-center justify-center border"
              :class="result.readable ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'"
            >
              <svg v-if="result.readable" class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <span class="font-mono text-[11px] tracking-[0.08em] uppercase" :class="result.readable ? 'text-green-400' : 'text-red-400'">
              {{ result.readable ? t('analyzer.streamable') : t('analyzer.notStreamable') }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <div
              class="w-6 h-6 flex items-center justify-center border"
              :class="result.available ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'"
            >
              <svg v-if="result.available" class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <span class="font-mono text-[11px] tracking-[0.08em] uppercase" :class="result.available ? 'text-green-400' : 'text-red-400'">
              {{ result.available ? t('analyzer.downloadable') : t('analyzer.notDownloadable') }}
            </span>
          </div>
        </div>
      </div>

      <!-- Countries (for tracks, when authenticated) -->
      <div v-if="result.type === 'track' && result.countries && result.countries.length > 0" class="border-t border-white/[0.08] pt-6 mt-6">
        <div class="flex items-center gap-3 mb-4">
          <h3 class="font-display text-[14px] uppercase tracking-[0.06em]">Countries</h3>
          <div class="flex-1 h-px bg-white/[0.06]"></div>
        </div>
        <div class="space-y-1 max-h-64 overflow-y-auto">
          <div
            v-for="code in result.countries"
            :key="code"
            class="font-mono text-[12px]"
          >
            {{ getCountryInfo(code).flag }} - [{{ code }}] {{ getCountryInfo(code).name }}
          </div>
        </div>
      </div>

      <!-- Login notice for countries -->
      <div v-else-if="result.type === 'track' && !authStore.isLoggedIn" class="border-t border-white/[0.08] pt-6 mt-6">
        <div class="flex items-center gap-3 mb-2">
          <h3 class="font-display text-[14px] uppercase tracking-[0.06em] text-foreground-muted">Countries</h3>
          <div class="flex-1 h-px bg-white/[0.06]"></div>
        </div>
        <p class="text-sm text-foreground-muted">{{ t('analyzer.loginForCountries') }}</p>
      </div>
    </div>

    <!-- Qobuz Results Section (WIP) -->
    <div v-if="qobuzResult" class="bg-background-secondary/60 border border-white/[0.08] p-5">
      <div class="flex items-center gap-4">
        <img
          v-if="qobuzResult.data?.image?.large || qobuzResult.data?.album?.image?.large"
          :src="qobuzResult.data?.image?.large || qobuzResult.data?.album?.image?.large"
          class="w-24 h-24 object-cover border border-white/[0.08]"
          alt="cover"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 mb-1">
            <span class="font-mono text-[10px] tracking-[0.12em] uppercase text-primary-400 border border-primary-500/40 px-1.5 py-0.5">{{ qobuzResult.type }}</span>
            <span class="font-mono text-[10px] tracking-[0.12em] uppercase text-foreground-muted">Qobuz</span>
          </div>
          <h3
            class="text-lg font-semibold truncate"
            :class="{ 'hover:text-qobuz-400 cursor-pointer transition-colors': qobuzDetailRoute }"
            @click="qobuzDetailRoute && router.push(qobuzDetailRoute)"
          >{{ qobuzResult.data?.title }}</h3>
          <p class="text-foreground-muted truncate">
            {{ qobuzResult.data?.performer?.name || qobuzResult.data?.artist?.name }}
          </p>
          <p v-if="qobuzResult.data?.tracks?.total" class="text-sm text-foreground-muted mt-1">{{ qobuzResult.data.tracks.total }} tracks</p>
        </div>
        <button
          @click="downloadQobuz"
          :disabled="qobuzDownloading"
          class="btn btn-primary font-mono text-[11px] uppercase tracking-[0.12em] disabled:opacity-50 flex-shrink-0"
        >
          <span v-if="qobuzDownloading">Queuing…</span>
          <span v-else>Download ↓</span>
        </button>
      </div>
    </div>

    <!-- Spotify Results Section -->
    <div v-if="spotifyResult" class="bg-background-secondary/60 border border-white/[0.08] p-5">
      <!-- Cover and Basic Info -->
      <div class="flex gap-6 mb-6">
        <!-- Cover Image -->
        <div class="w-48 h-48 flex-shrink-0 overflow-hidden bg-background-tertiary border border-white/[0.08]">
          <img
            v-if="spotifyResult.data?.images?.[0]?.url || spotifyResult.data?.album?.images?.[0]?.url"
            :src="spotifyResult.data?.images?.[0]?.url || spotifyResult.data?.album?.images?.[0]?.url"
            :alt="spotifyResult.data?.name"
            class="w-full h-full object-cover"
          />
          <div v-else class="w-full h-full flex items-center justify-center text-foreground-muted">
            <svg class="w-16 h-16 text-[#1DB954]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
            </svg>
          </div>
        </div>

        <!-- Title and Actions -->
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <span class="inline-flex items-center gap-1.5 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase border mb-2 bg-[#1DB954]/10 text-[#1DB954] border-[#1DB954]/30">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                </svg>
                SPOTIFY {{ spotifyResult.type?.toUpperCase() }}
              </span>
              <span v-if="spotifyResult.type === 'playlist' && spotifyResult.data?.public === true" class="px-1.5 py-0.5 bg-green-500/10 text-green-400 border border-green-500/30 font-mono text-[10px] tracking-[0.08em] font-semibold uppercase">Public</span>
              <span v-if="spotifyResult.type === 'playlist' && spotifyResult.data?.public === false" class="px-1.5 py-0.5 bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 font-mono text-[10px] tracking-[0.08em] font-semibold uppercase">Private</span>
              <h2 class="text-2xl font-bold truncate">{{ spotifyResult.data?.name }}</h2>
              <p v-if="spotifyResult.data?.artists?.[0]?.name || spotifyResult.data?.owner?.display_name" class="text-lg text-foreground-muted truncate">
                {{ spotifyResult.data?.artists?.[0]?.name || spotifyResult.data?.owner?.display_name }}
              </p>
            </div>
          </div>

          <!-- Track count info -->
          <p v-if="spotifyResult.trackCount" class="text-foreground-muted mt-2">
            {{ spotifyResult.trackCount }} tracks
          </p>

          <!-- Target service picker (2.4): resolve the Spotify link against
               Deezer (default) or Qobuz. Hidden once a conversion has run. -->
          <div v-if="!conversionResult" class="mt-4">
            <p class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted mb-1.5">{{ t('analyzer.convertTo') }}</p>
            <div class="inline-flex border border-white/[0.08] p-0.5 gap-0.5 bg-background-main">
              <button
                v-for="svc in (['deezer','qobuz','both'] as const)"
                :key="svc"
                @click="targetService = svc"
                class="font-mono text-[10px] tracking-[0.12em] uppercase px-4 py-1.5 transition-colors"
                :class="targetService === svc
                  ? (svc === 'qobuz' ? 'bg-qobuz-500/20 text-qobuz-400'
                     : svc === 'deezer' ? 'bg-deezer-500/20 text-deezer-400'
                     : 'bg-gradient-to-r from-deezer-500/25 to-qobuz-500/25 text-foreground')
                  : 'text-foreground-muted hover:text-foreground-muted'"
              >
                {{ svc }}
              </button>
            </div>
            <p v-if="targetService === 'both' && !(deezerConnected && qobuzConnected)" class="font-mono text-[10px] text-yellow-400/80 mt-1.5">
              {{ t('analyzer.compareNeedsBoth') }}
            </p>
          </div>

          <!-- Action Buttons -->
          <div class="flex gap-3 mt-4">
            <button
              v-if="!conversionResult"
              @click="convertSpotifyToDeezer"
              :disabled="isConverting || !authStore.isLoggedIn"
              class="btn flex items-center gap-2 font-mono text-[11px] tracking-[0.1em] uppercase"
              :class="(isConverting || !authStore.isLoggedIn)
                ? 'border border-white/[0.08] text-foreground-muted/50 cursor-not-allowed'
                : 'bg-[#1DB954] hover:bg-[#1ed760] text-black'"
            >
              <svg v-if="isConverting" class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {{ isConverting ? t('analyzer.converting') : (targetService === 'both' ? t('analyzer.compareBoth') : targetService === 'qobuz' ? t('analyzer.convertToQobuz') : t('analyzer.convertToDeezer')) }}
            </button>

            <button
              v-if="conversionResult?.matched?.length && conversionResult.service === 'both'"
              @click="downloadConvertedTracks"
              :disabled="!authStore.isLoggedIn || bothCounts.total === 0"
              class="btn btn-primary font-mono text-[11px] tracking-[0.1em] uppercase flex items-center gap-2"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download {{ bothCounts.total }} tracks<span class="opacity-60 normal-case">&nbsp;· {{ bothCounts.qobuz }} Qobuz, {{ bothCounts.deezer }} Deezer</span>
            </button>
            <button
              v-else-if="conversionResult?.matched?.length"
              @click="downloadConvertedTracks"
              :disabled="!authStore.isLoggedIn"
              class="btn btn-primary font-mono text-[11px] tracking-[0.1em] uppercase flex items-center gap-2"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download {{ conversionResult.matched.length }} Tracks
            </button>
            <p v-if="conversionResult && !conversionResult.matched?.length" class="text-sm text-yellow-400">
              <template v-if="conversionResult.service === 'both'">{{ t('analyzer.noneFoundBoth') }}</template>
              <template v-else>{{ t('analyzer.noneFoundService', { service: conversionResult.service === 'qobuz' ? 'Qobuz' : 'Deezer' }) }}</template>
            </p>
          </div>

          <!-- Conversion progress (2.4): real per-track counts so a long match
               reads as moving, not hung. -->
          <div v-if="isConverting && conversionProgress.total > 0" class="mt-3 max-w-sm">
            <div class="flex items-center justify-between font-mono text-[9.5px] tracking-[0.15em] uppercase text-foreground-muted mb-1">
              <span>{{ t('analyzer.matchingTracks') }}</span>
              <span>{{ conversionProgress.current }} / {{ conversionProgress.total }}</span>
            </div>
            <div class="h-1 bg-white/[0.08] overflow-hidden">
              <div
                class="h-full transition-all duration-300"
                :class="targetService === 'qobuz' ? 'bg-qobuz-500' : 'bg-[#1DB954]'"
                :style="{ width: Math.round((conversionProgress.current / conversionProgress.total) * 100) + '%' }"
              ></div>
            </div>
          </div>

          <p v-if="!authStore.isLoggedIn" class="text-sm text-foreground-muted mt-2">
            {{ t('analyzer.loginRequiredConvert') }}
          </p>
        </div>
      </div>

      <!-- Conversion Results -->
      <div v-if="conversionResult" class="border-t border-white/[0.08] pt-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-display text-[14px] uppercase tracking-[0.06em]">{{ t('analyzer.conversionResults') }}</h3>
          <span class="font-mono text-[10px] tracking-[0.08em] uppercase px-1.5 py-0.5 border" :class="conversionResult.matchRate >= 80 ? 'bg-green-500/10 text-green-400 border-green-500/30' : conversionResult.matchRate >= 50 ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' : 'bg-red-500/10 text-red-400 border-red-500/30'">
            {{ conversionResult.matchRate }}% matched
          </span>
        </div>

        <!-- Cross-service availability matrix (both mode) -->
        <div v-if="conversionResult.service === 'both' && conversionResult.matched?.length" class="space-y-3 mb-4">
          <!-- summary tally -->
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 p-2.5 bg-background-main border border-white/[0.06] text-[11px] text-foreground-muted">
            <span><span class="inline-block w-2 h-2 rounded-sm bg-green-400 mr-1.5 align-middle"></span><b class="text-foreground">{{ conversionResult.summary?.both || 0 }}</b> on both</span>
            <span><span class="inline-block w-2 h-2 rounded-sm bg-qobuz-500 mr-1.5 align-middle"></span><b class="text-foreground">{{ conversionResult.summary?.qobuzOnly || 0 }}</b> {{ t('analyzer.qobuzOnly') }}</span>
            <span><span class="inline-block w-2 h-2 rounded-sm bg-deezer-500 mr-1.5 align-middle"></span><b class="text-foreground">{{ conversionResult.summary?.deezerOnly || 0 }}</b> {{ t('analyzer.deezerOnly') }}</span>
            <span><span class="inline-block w-2 h-2 rounded-sm bg-white/20 mr-1.5 align-middle"></span><b class="text-foreground">{{ conversionResult.summary?.neither || 0 }}</b> unavailable</span>
          </div>

          <!-- preference control -->
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-foreground-muted">
            <span class="font-mono text-[9.5px] tracking-[0.15em] uppercase">{{ t('analyzer.prefer') }}</span>
            <div class="inline-flex border border-white/[0.08] p-0.5 gap-0.5">
              <button @click="bothPreference = 'qobuz'" class="font-mono text-[10px] tracking-[0.1em] uppercase px-2.5 py-1 transition-colors"
                :class="bothPreference === 'qobuz' ? 'bg-qobuz-500/20 text-qobuz-400' : 'text-foreground-muted hover:text-foreground-muted'">Qobuz</button>
              <button @click="bothPreference = 'deezer'" class="font-mono text-[10px] tracking-[0.1em] uppercase px-2.5 py-1 transition-colors"
                :class="bothPreference === 'deezer' ? 'bg-deezer-500/20 text-deezer-400' : 'text-foreground-muted hover:text-foreground-muted'">Deezer</button>
            </div>
            <span class="opacity-80">{{ t('analyzer.fallbackHint') }}</span>
          </div>

          <!-- matrix header -->
          <div class="grid grid-cols-[1fr_74px_74px] gap-2 px-2.5 font-mono text-[9px] tracking-[0.16em] uppercase text-foreground-muted">
            <span>Track</span><span class="text-center">Deezer</span><span class="text-center">Qobuz</span>
          </div>

          <!-- matrix rows -->
          <div class="max-h-80 overflow-y-auto space-y-1">
            <div
              v-for="m in conversionResult.matched"
              :key="m.spotify?.id"
              class="grid grid-cols-[1fr_74px_74px] gap-2 items-center p-2 bg-background-main border border-white/[0.06]"
            >
              <div class="min-w-0">
                <p class="truncate text-[13px]">{{ m.spotify?.name }}</p>
                <p class="truncate text-[11px] text-foreground-muted">{{ m.spotify?.artist }}</p>
              </div>
              <button
                @click="chooseService(m, 'deezer')"
                :disabled="!m.deezer"
                class="flex flex-col items-center justify-center h-10 border rounded-sm transition-colors"
                :class="m.deezer
                  ? (resolvedServiceFor(m) === 'deezer' ? 'bg-deezer-500/10 border-deezer-500 text-deezer-400 ring-1 ring-deezer-500' : 'bg-deezer-500/[0.04] border-deezer-500/30 text-deezer-400/70 hover:border-deezer-500/60')
                  : 'border-white/[0.06] text-foreground-muted/30 cursor-default'"
              >
                <span class="font-mono text-[11px] font-bold leading-none">{{ m.deezer ? 'D' : '—' }}</span>
                <span v-if="m.deezer" class="text-[8px] uppercase tracking-wide opacity-80 mt-0.5">{{ m.deezer.matchType === 'isrc' ? 'ISRC' : m.deezer.confidence + '%' }}</span>
              </button>
              <button
                @click="chooseService(m, 'qobuz')"
                :disabled="!m.qobuz"
                class="flex flex-col items-center justify-center h-10 border rounded-sm transition-colors"
                :class="m.qobuz
                  ? (resolvedServiceFor(m) === 'qobuz' ? 'bg-qobuz-500/10 border-qobuz-500 text-qobuz-400 ring-1 ring-qobuz-500' : 'bg-qobuz-500/[0.04] border-qobuz-500/30 text-qobuz-400/70 hover:border-qobuz-500/60')
                  : 'border-white/[0.06] text-foreground-muted/30 cursor-default'"
              >
                <span class="font-mono text-[11px] font-bold leading-none">{{ m.qobuz ? 'Q' : '—' }}</span>
                <span v-if="m.qobuz" class="text-[8px] uppercase tracking-wide opacity-80 mt-0.5">{{ m.qobuz.matchType === 'isrc' ? 'ISRC' : m.qobuz.confidence + '%' }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Matched Tracks (single-service) -->
        <div v-else-if="conversionResult.matched?.length" class="space-y-2 mb-4">
          <p class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted">Matched ({{ conversionResult.matched.length }})</p>
          <div class="max-h-48 overflow-y-auto space-y-1">
            <div
              v-for="match in conversionResult.matched"
              :key="match.spotify?.id || match.spotifyTrack?.id"
              class="flex items-center gap-3 p-2 bg-background-main border border-white/[0.06]"
            >
              <svg class="w-4 h-4 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <span class="truncate text-sm">{{ match.spotify?.name || match.spotifyTrack?.name }}</span>
              <span class="font-mono text-[9.5px] tracking-[0.1em] uppercase text-foreground-muted ml-auto flex-shrink-0">{{ match.matchType === 'isrc' ? 'ISRC' : t('analyzer.matchSearch') }}</span>
            </div>
          </div>
        </div>

        <!-- Unmatched Tracks -->
        <div v-if="conversionResult.unmatched?.length" class="space-y-2">
          <p class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted">Unmatched ({{ conversionResult.unmatched.length }})</p>
          <div class="max-h-32 overflow-y-auto space-y-1">
            <div
              v-for="track in conversionResult.unmatched"
              :key="track.id"
              class="flex items-center gap-3 p-2 bg-background-main border border-white/[0.06]"
            >
              <svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <span class="truncate text-sm text-foreground-muted">{{ track.name }}<template v-if="track.artist"> - {{ track.artist }}</template></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div v-else-if="!error && !result" class="text-center py-16">
      <svg class="w-20 h-20 mx-auto text-foreground-muted mb-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
      <p class="text-foreground-muted text-lg mb-2">{{ t('analyzer.getStarted') }}</p>
      <p class="text-foreground-muted text-sm">
        Supported: tracks, albums, artists, and playlists
      </p>
    </div>

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
