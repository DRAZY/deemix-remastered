<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useDownloadStore } from '../stores/downloadStore'
import { useAuthStore } from '../stores/authStore'
import BackButton from '../components/BackButton.vue'
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu } from '../composables/useContextMenu'

const router = useRouter()
const downloadStore = useDownloadStore()
const authStore = useAuthStore()

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

// Get the actual server port on mount
onMounted(async () => {
  if (window.electronAPI) {
    serverPort.value = await window.electronAPI.getServerPort()
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

// Check if URL is a Spotify link
function isSpotifyUrl(url: string): boolean {
  return url.includes('open.spotify.com') ||
         url.includes('link.spotify.com') ||
         url.startsWith('spotify:')
}

// Check if URL is a Deezer link
function isDeezerUrl(url: string): boolean {
  return url.includes('deezer.com') || url.includes('deezer.page.link')
}

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
  const url = linkInput.value.trim()
  if (!url) {
    error.value = 'Please enter a Deezer or Spotify link'
    return
  }

  isAnalyzing.value = true
  error.value = ''
  result.value = null
  spotifyResult.value = null
  conversionResult.value = null
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
    } else if (isDeezerUrl(url)) {
      await analyzeDeezerLink(url)
    } else {
      error.value = 'Please enter a valid Deezer or Spotify link'
    }
  } catch (err: any) {
    console.error('[LinkAnalyzer] Error:', err)
    error.value = `Failed to connect to server (port ${serverPort.value}). ${err.message || ''}`
  } finally {
    isAnalyzing.value = false
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

  try {
    const apiUrl = `http://localhost:${serverPort.value}/api/spotify/convert`
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: spotifyResult.value.type,
        id: spotifyResult.value.id
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
    isConverting.value = false
  }
}

async function downloadConvertedTracks() {
  if (!conversionResult.value?.matched) return

  // Collect all Deezer track IDs from the conversion results
  const trackIds: number[] = []
  for (const match of conversionResult.value.matched) {
    const dz = match.deezer || match.deezerTrack
    if (dz && dz.id) {
      trackIds.push(dz.id)
    }
  }

  if (trackIds.length === 0) return

  const sourcePlaylistName = spotifyResult.value?.data?.name || 'Spotify Playlist'
  const coverUrl = spotifyResult.value?.data?.images?.[0]?.url
    || spotifyResult.value?.data?.album?.images?.[0]?.url
    || ''

  // Single batch request — the server queues all tracks and returns one set of IDs.
  // The download store tracks them as a single playlist item with unified progress.
  await downloadStore.addBatchDownload({
    trackIds,
    playlistName: sourcePlaylistName,
    title: sourcePlaylistName,
    cover: coverUrl,
    totalTracks: trackIds.length
  })
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
  if (isDeezerUrl(text) || isSpotifyUrl(text)) {
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
        left: { label: 'ID', value: String(result.value.id) },
        right: { label: 'Type', value: 'Track' }
      })
      pairs.push({
        left: { label: 'Title', value: data.title || '-' },
        right: { label: 'Artist', value: data.artist?.name || '-' }
      })
      pairs.push({
        left: { label: 'Album', value: data.album?.title || '-' },
        right: { label: 'Duration', value: formatDuration(data.duration) }
      })
      pairs.push({
        left: { label: 'ISRC', value: result.value.isrc || '-' },
        right: { label: 'Release Date', value: formatDate(data.release_date) }
      })
      pairs.push({
        left: { label: 'BPM', value: result.value.bpm ? String(result.value.bpm) : '-' },
        right: { label: 'Track Number', value: `${data.track_position || '-'} / ${data.disk_number || 1}` }
      })
      pairs.push({
        left: { label: 'Explicit', value: data.explicit_lyrics ? 'Yes' : 'No' },
        right: { label: 'Readable', value: result.value.readable ? 'Yes' : 'No' }
      })
      pairs.push({
        left: { label: 'Available', value: result.value.available ? 'Yes' : 'No' }
      })
      break

    case 'album':
      pairs.push({
        left: { label: 'ID', value: String(result.value.id) },
        right: { label: 'Type', value: 'Album' }
      })
      pairs.push({
        left: { label: 'Title', value: data.title || '-' },
        right: { label: 'Artist', value: data.artist?.name || '-' }
      })
      pairs.push({
        left: { label: 'Release Date', value: formatDate(data.release_date) },
        right: { label: 'Track Count', value: formatNumber(result.value.trackCount) }
      })
      pairs.push({
        left: { label: 'Duration', value: formatDuration(data.duration) },
        right: { label: 'UPC/Barcode', value: result.value.upc || '-' }
      })
      pairs.push({
        left: { label: 'Label', value: result.value.label || '-' },
        right: { label: 'Genres', value: result.value.genres?.join(', ') || '-' }
      })
      pairs.push({
        left: { label: 'Record Type', value: data.record_type || '-' },
        right: { label: 'Explicit', value: data.explicit_lyrics ? 'Yes' : 'No' }
      })
      break

    case 'artist':
      pairs.push({
        left: { label: 'ID', value: String(result.value.id) },
        right: { label: 'Type', value: 'Artist' }
      })
      pairs.push({
        left: { label: 'Name', value: data.name || '-' },
        right: { label: 'Fan Count', value: formatNumber(result.value.fanCount) }
      })
      pairs.push({
        left: { label: 'Album Count', value: formatNumber(result.value.albumCount) }
      })
      break

    case 'playlist':
      pairs.push({
        left: { label: 'ID', value: String(result.value.id) },
        right: { label: 'Type', value: 'Playlist' }
      })
      pairs.push({
        left: { label: 'Title', value: data.title || '-' },
        right: { label: 'Creator', value: result.value.creator || '-' }
      })
      pairs.push({
        left: { label: 'Track Count', value: formatNumber(result.value.trackCount) },
        right: { label: 'Duration', value: formatDuration(result.value.totalDuration) }
      })
      pairs.push({
        left: { label: 'Public', value: result.value.isPublic ? 'Yes' : 'No' },
        right: { label: 'Fans', value: formatNumber(data.fans) }
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
        label: 'Paste',
        icon: 'paste',
        action: async () => {
          const text = await pasteFromClipboard()
          if (text) {
            linkInput.value = text
          }
        }
      },
      {
        label: 'Copy',
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

// Copy link function
function copyLink() {
  if (linkInput.value) {
    copyToClipboard(linkInput.value, 'Link')
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Back Button -->
    <BackButton />

    <!-- Header -->
    <div class="mb-6">
      <h1 class="text-2xl font-bold mb-2">Link Analyzer</h1>
      <p class="text-foreground-muted">
        Paste a Deezer or Spotify link to analyze its metadata and download options
      </p>
    </div>

    <!-- Input Section -->
    <div class="card">
      <form @submit.prevent="analyzeLink" class="flex gap-3">
        <div class="relative flex-1">
          <input
            v-model="linkInput"
            type="text"
            placeholder="Paste a Deezer or Spotify link (track, album, artist, or playlist)..."
            class="input pl-12 pr-12"
            @paste="handlePaste"
            @contextmenu="openInputMenu"
          />
          <svg
            class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </div>
        <!-- Paste Button -->
        <button
          type="button"
          @click="pasteLink"
          class="btn btn-secondary flex items-center gap-2"
          title="Paste from clipboard"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span class="hidden sm:inline">Paste</span>
        </button>
        <button
          type="submit"
          :disabled="isAnalyzing || !linkInput.trim()"
          class="btn bg-green-600 hover:bg-green-700 text-white px-6 flex items-center gap-2"
        >
          <svg v-if="isAnalyzing" class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          <span>{{ isAnalyzing ? 'Analyzing...' : 'Analyze' }}</span>
        </button>
      </form>
    </div>

    <!-- Error State -->
    <div v-if="error" class="card border border-red-500/50 bg-red-500/10">
      <div class="flex items-center gap-3 text-red-400">
        <svg class="w-6 h-6 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p>{{ error }}</p>
      </div>
    </div>

    <!-- Results Section -->
    <div v-if="result" class="card">
      <!-- Cover and Basic Info -->
      <div class="flex gap-6 mb-6">
        <!-- Cover Image -->
        <div class="w-48 h-48 flex-shrink-0 rounded-lg overflow-hidden bg-background-tertiary">
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
                class="inline-block px-2 py-0.5 text-xs font-medium rounded mb-2"
                :class="{
                  'bg-primary-500/20 text-primary-400': result.type === 'track',
                  'bg-blue-500/20 text-blue-400': result.type === 'album',
                  'bg-green-500/20 text-green-400': result.type === 'artist',
                  'bg-orange-500/20 text-orange-400': result.type === 'playlist'
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
              class="btn flex items-center gap-2"
              :class="(!authStore.isLoggedIn || (result.type === 'track' && !result.available))
                ? 'bg-zinc-600 text-zinc-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-700 text-white'"
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
              class="btn btn-secondary flex items-center gap-2"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {{ result.type === 'track' ? 'View Album' : 'View Details' }}
            </button>
          </div>

          <!-- Download Notice -->
          <p v-if="!authStore.isLoggedIn && result.type !== 'artist'" class="text-sm text-foreground-muted mt-2">
            Login required to download
          </p>
          <p v-else-if="result.type === 'track' && !result.available" class="text-sm text-red-400 mt-2">
            This track is not available for download
          </p>
        </div>
      </div>

      <!-- Metadata Table - 2 Column Layout -->
      <div class="border-t border-zinc-700 pt-6">
        <h3 class="text-lg font-semibold mb-4">Metadata</h3>
        <table class="w-full">
          <tbody>
            <tr
              v-for="(pair, index) in metadataRows"
              :key="index"
              class="border-b border-zinc-800"
            >
              <!-- Left column -->
              <td class="py-2 pr-4 text-foreground-muted w-28">{{ pair.left.label }}</td>
              <td
                class="py-2 font-medium w-1/3 cursor-context-menu hover:text-primary-400 transition-colors"
                @contextmenu="openMetadataMenu($event, pair.left.label, pair.left.value)"
              >{{ pair.left.value }}</td>
              <!-- Right column -->
              <td v-if="pair.right" class="py-2 pr-4 text-foreground-muted w-28 pl-8">{{ pair.right.label }}</td>
              <td
                v-if="pair.right"
                class="py-2 font-medium cursor-context-menu hover:text-primary-400 transition-colors"
                @contextmenu="openMetadataMenu($event, pair.right.label, pair.right.value)"
              >{{ pair.right.value }}</td>
              <td v-else colspan="2"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Availability Status (for tracks) -->
      <div v-if="result.type === 'track'" class="border-t border-zinc-700 pt-6 mt-6">
        <h3 class="text-lg font-semibold mb-4">Availability</h3>
        <div class="flex gap-6">
          <div class="flex items-center gap-2">
            <div
              class="w-6 h-6 rounded-full flex items-center justify-center"
              :class="result.readable ? 'bg-green-500/20' : 'bg-red-500/20'"
            >
              <svg v-if="result.readable" class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <span :class="result.readable ? 'text-green-400' : 'text-red-400'">
              {{ result.readable ? 'Streamable' : 'Not Streamable' }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <div
              class="w-6 h-6 rounded-full flex items-center justify-center"
              :class="result.available ? 'bg-green-500/20' : 'bg-red-500/20'"
            >
              <svg v-if="result.available" class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <span :class="result.available ? 'text-green-400' : 'text-red-400'">
              {{ result.available ? 'Downloadable' : 'Not Downloadable' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Countries (for tracks, when authenticated) -->
      <div v-if="result.type === 'track' && result.countries && result.countries.length > 0" class="border-t border-zinc-700 pt-6 mt-6">
        <h3 class="text-lg font-semibold mb-4">Countries</h3>
        <div class="space-y-1 max-h-64 overflow-y-auto">
          <div
            v-for="code in result.countries"
            :key="code"
            class="text-sm"
          >
            {{ getCountryInfo(code).flag }} - [{{ code }}] {{ getCountryInfo(code).name }}
          </div>
        </div>
      </div>

      <!-- Login notice for countries -->
      <div v-else-if="result.type === 'track' && !authStore.isLoggedIn" class="border-t border-zinc-700 pt-6 mt-6">
        <h3 class="text-lg font-semibold mb-2 text-foreground-muted">Countries</h3>
        <p class="text-sm text-foreground-muted">Login to view country availability</p>
      </div>
    </div>

    <!-- Spotify Results Section -->
    <div v-if="spotifyResult" class="card">
      <!-- Cover and Basic Info -->
      <div class="flex gap-6 mb-6">
        <!-- Cover Image -->
        <div class="w-48 h-48 flex-shrink-0 rounded-lg overflow-hidden bg-background-tertiary">
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
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded mb-2 bg-[#1DB954]/20 text-[#1DB954]">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                </svg>
                SPOTIFY {{ spotifyResult.type?.toUpperCase() }}
              </span>
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

          <!-- Action Buttons -->
          <div class="flex gap-3 mt-4">
            <button
              v-if="!conversionResult"
              @click="convertSpotifyToDeezer"
              :disabled="isConverting || !authStore.isLoggedIn"
              class="btn flex items-center gap-2"
              :class="(isConverting || !authStore.isLoggedIn)
                ? 'bg-zinc-600 text-zinc-400 cursor-not-allowed'
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
              {{ isConverting ? 'Converting...' : 'Convert to Deezer' }}
            </button>

            <button
              v-if="conversionResult?.matched?.length"
              @click="downloadConvertedTracks"
              :disabled="!authStore.isLoggedIn"
              class="btn bg-green-600 hover:bg-green-700 text-white flex items-center gap-2"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download {{ conversionResult.matched.length }} Tracks
            </button>
          </div>

          <p v-if="!authStore.isLoggedIn" class="text-sm text-foreground-muted mt-2">
            Login required to convert and download
          </p>
        </div>
      </div>

      <!-- Conversion Results -->
      <div v-if="conversionResult" class="border-t border-zinc-700 pt-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold">Conversion Results</h3>
          <span class="text-sm px-3 py-1 rounded-full" :class="conversionResult.matchRate >= 80 ? 'bg-green-500/20 text-green-400' : conversionResult.matchRate >= 50 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-red-500/20 text-red-400'">
            {{ conversionResult.matchRate }}% matched
          </span>
        </div>

        <!-- Matched Tracks -->
        <div v-if="conversionResult.matched?.length" class="space-y-2 mb-4">
          <p class="text-sm text-foreground-muted">Matched ({{ conversionResult.matched.length }})</p>
          <div class="max-h-48 overflow-y-auto space-y-1">
            <div
              v-for="match in conversionResult.matched"
              :key="match.spotify?.id || match.spotifyTrack?.id"
              class="flex items-center gap-3 p-2 rounded bg-background-main"
            >
              <svg class="w-4 h-4 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <span class="truncate">{{ match.spotify?.name || match.spotifyTrack?.name }}</span>
              <span class="text-xs text-foreground-muted ml-auto">{{ match.matchType === 'isrc' ? 'ISRC' : 'Search' }}</span>
            </div>
          </div>
        </div>

        <!-- Unmatched Tracks -->
        <div v-if="conversionResult.unmatched?.length" class="space-y-2">
          <p class="text-sm text-foreground-muted">Unmatched ({{ conversionResult.unmatched.length }})</p>
          <div class="max-h-32 overflow-y-auto space-y-1">
            <div
              v-for="track in conversionResult.unmatched"
              :key="track.id"
              class="flex items-center gap-3 p-2 rounded bg-background-main"
            >
              <svg class="w-4 h-4 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <span class="truncate text-foreground-muted">{{ track.name }} - {{ track.artists?.[0]?.name }}</span>
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
      <p class="text-foreground-muted text-lg mb-2">Paste a Deezer or Spotify link to get started</p>
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
