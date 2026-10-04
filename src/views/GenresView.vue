<script setup lang="ts">
// Genre Browse — dual-service.
// QOBUZ (primary): the primary genres, each with a feed-tabbed, continuously
// paginated catalog grid — the "browse the whole genre" surface (#106
// follow-up). Subgenre chips were tried and removed: Qobuz's feeds barely
// change when scoped to a subgenre, so the extra chip row wasn't earning its
// space (the parent_id API support remains server-side if ever wanted).
// DEEZER: editorial picks + charts; Top Tracks / Top Albums page toward
// Deezer's hard 100-per-chart cap (/editorial/{id}/releases is dead upstream).
// The per-genre artists endpoint is broken upstream and deliberately excluded.
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import AlbumCard from '../components/AlbumCard.vue'
import TrackCard from '../components/TrackCard.vue'
import ErrorState from '../components/ErrorState.vue'
import { qobuzRecordType } from '../utils/qobuzMap'
import type { Track, Album } from '../types'

const { t } = useI18n()

type Genre = { id: number; name: string }
type Source = 'qobuz' | 'deezer'

// Qobuz is the primary service — default there; choice is sticky.
const source = ref<Source>((localStorage.getItem('genresSource') as Source) || 'qobuz')
function setSource(s: Source) {
  if (source.value === s) return
  source.value = s
  localStorage.setItem('genresSource', s)
  hasError.value = false
  if (s === 'qobuz' ? !qGenres.value.length : !genres.value.length) {
    loadGenres()
  }
}

const isLoading = ref(false)
const hasError = ref(false)
const errorMessage = ref('')

async function serverPort(): Promise<number> {
  return window.electronAPI ? await window.electronAPI.getServerPort() : 6595
}

// ==================== QOBUZ ====================

const QOBUZ_FEEDS = [
  { type: 'new-releases-full', labelKey: 'qobuz.newReleases' },
  { type: 'most-streamed', labelKey: 'qobuz.mostStreamed' },
  { type: 'press-awards', labelKey: 'qobuz.pressAwards' },
  { type: 'editor-picks', labelKey: 'qobuz.editorPicks' },
] as const

const qGenres = ref<Genre[]>([])
const qActiveGenre = ref<Genre | null>(null)
const qActiveFeed = ref<string>('new-releases-full')
const qItems = ref<Album[]>([])
const qTotal = ref(0)
const qLoadingMore = ref(false)

function mapQobuzAlbum(a: any): Album {
  return {
    id: a.id, title: a.title, nb_tracks: a.tracks_count, record_type: qobuzRecordType(a),
    qobuzQuality: (a.maximum_bit_depth && a.maximum_sampling_rate)
      ? { hires: !!a.hires, bitDepth: a.maximum_bit_depth, samplingRate: a.maximum_sampling_rate }
      : undefined,
    artist: { id: a.artist?.id, name: a.artist?.name || '' },
    cover_small: a.image?.small, cover_medium: a.image?.large, cover_big: a.image?.large,
    release_date: a.release_date_original || a.released_at,
    source: 'qobuz', qobuzId: a.id,
    qobuzData: { title: a.title, artist: a.artist, image: a.image, tracks_count: a.tracks_count },
  } as any
}

async function loadQobuzGenres() {
  const r = await fetch(`http://127.0.0.1:${await serverPort()}/api/qobuz/genres`)
  if (!r.ok) {
    const e = await r.json().catch(() => ({}))
    throw new Error(e.error === 'Qobuz not connected' ? 'Connect your Qobuz account in Settings to browse genres.' : (e.error || `genres: ${r.status}`))
  }
  qGenres.value = (await r.json()).genres || []
  if (qGenres.value.length > 0) await selectQobuzGenre(qGenres.value[0])
}

async function selectQobuzGenre(g: Genre) {
  qActiveGenre.value = g
  await resetQobuzGrid()
}

async function selectQobuzFeed(type: string) {
  if (qActiveFeed.value === type) return
  qActiveFeed.value = type
  await resetQobuzGrid()
}

async function resetQobuzGrid() {
  qItems.value = []
  qTotal.value = 0
  await loadQobuzPage(true)
}

async function loadQobuzPage(initial = false) {
  if (qLoadingMore.value || !qActiveGenre.value) return
  qLoadingMore.value = true
  if (initial) { isLoading.value = true; hasError.value = false }
  try {
    const r = await fetch(
      `http://127.0.0.1:${await serverPort()}/api/qobuz/featured?type=${qActiveFeed.value}&genre=${qActiveGenre.value.id}&offset=${qItems.value.length}&limit=100`
    )
    if (!r.ok) throw new Error(`feed: ${r.status}`)
    const d = await r.json()
    const existing = new Set(qItems.value.map(a => String(a.id)))
    qItems.value = [...qItems.value, ...(d.items || []).map(mapQobuzAlbum).filter((a: Album) => !existing.has(String(a.id)))]
    qTotal.value = d.total ?? qItems.value.length
  } catch (e: any) {
    console.error('Failed to load Qobuz genre feed:', e)
    if (qItems.value.length === 0) { hasError.value = true; errorMessage.value = e?.message || '' }
  } finally {
    qLoadingMore.value = false
    if (initial) isLoading.value = false
  }
}

// ==================== DEEZER ====================

const genres = ref<Genre[]>([])
const activeGenre = ref<number | null>(null)
const picks = ref<Album[]>([])
const chartTracks = ref<Track[]>([])
const chartAlbums = ref<Album[]>([])
// Deezer's only paginated per-genre surface is /chart/{id}/{kind}, hard-capped
// at 100 by Deezer — the chart sections page toward that cap. null total =
// unknown until the first paged fetch; exhausted when a page adds nothing new.
const dzChart = ref<Record<'tracks' | 'albums', { total: number | null; loading: boolean; exhausted: boolean }>>({
  tracks: { total: null, loading: false, exhausted: false },
  albums: { total: null, loading: false, exhausted: false },
})

async function loadDeezerGenres() {
  const r = await fetch(`http://127.0.0.1:${await serverPort()}/api/deezer/genres`)
  if (!r.ok) throw new Error(`genres: ${r.status}`)
  genres.value = (await r.json()).genres || []
  if (genres.value.length > 0) await selectGenre(genres.value[0].id)
}

async function selectGenre(id: number) {
  if (activeGenre.value === id && picks.value.length) return
  activeGenre.value = id
  isLoading.value = true
  hasError.value = false
  dzChart.value = {
    tracks: { total: null, loading: false, exhausted: false },
    albums: { total: null, loading: false, exhausted: false },
  }
  try {
    const r = await fetch(`http://127.0.0.1:${await serverPort()}/api/deezer/genre-browse?id=${id}`)
    if (!r.ok) throw new Error(`genre-browse: ${r.status}`)
    const d = await r.json()
    picks.value = d.picks || []
    chartTracks.value = d.chartTracks || []
    chartAlbums.value = d.chartAlbums || []
    if (!picks.value.length && !chartTracks.value.length && !chartAlbums.value.length) {
      hasError.value = true
    }
  } catch (e) {
    console.error('Failed to load genre browse:', e)
    hasError.value = true
  } finally {
    isLoading.value = false
  }
}

function dzCanLoadMore(kind: 'tracks' | 'albums'): boolean {
  const state = dzChart.value[kind]
  const length = kind === 'tracks' ? chartTracks.value.length : chartAlbums.value.length
  if (state.exhausted || length === 0) return false
  return state.total === null || length < state.total
}

async function loadDeezerChartPage(kind: 'tracks' | 'albums') {
  const state = dzChart.value[kind]
  if (activeGenre.value == null || state.loading) return
  state.loading = true
  try {
    const list = kind === 'tracks' ? chartTracks : chartAlbums
    const r = await fetch(
      `http://127.0.0.1:${await serverPort()}/api/deezer/genre-chart?id=${activeGenre.value}&kind=${kind}&index=${list.value.length}&limit=50`
    )
    if (r.ok) {
      const d = await r.json()
      const existing = new Set(list.value.map((x: any) => String(x.id)))
      const fresh = (d.items || []).filter((x: any) => !existing.has(String(x.id)))
      if (fresh.length === 0) state.exhausted = true
      list.value = [...list.value, ...fresh] as any
      state.total = d.total ?? list.value.length
    }
  } catch (e) {
    console.error('Failed to load genre chart page:', e)
  } finally {
    state.loading = false
  }
}

// ==================== shared ====================

function loadGenres() {
  isLoading.value = true
  hasError.value = false
  errorMessage.value = ''
  const loader = source.value === 'qobuz' ? loadQobuzGenres() : loadDeezerGenres()
  loader
    .catch((e: any) => {
      console.error('Failed to load genres:', e)
      hasError.value = true
      errorMessage.value = e?.message || ''
    })
    .finally(() => { isLoading.value = false })
}

function retry() {
  if (source.value === 'qobuz') {
    qGenres.value.length && qActiveGenre.value ? resetQobuzGrid() : loadGenres()
  } else {
    activeGenre.value !== null ? selectGenre(activeGenre.value) : loadGenres()
  }
}

onMounted(loadGenres)
</script>

<template>
  <div class="space-y-8">
    <!-- Hero -->
    <div class="relative overflow-hidden border border-white/[0.08] bg-background-secondary/60 p-8">
      <div class="relative z-10">
        <div class="font-mono text-[10px] tracking-[0.3em] mb-2" :class="source === 'qobuz' ? 'text-qobuz-500' : 'text-primary-500'">
          // {{ source === 'qobuz' ? 'CHANNEL Q' : 'SIGNAL DECK' }}
        </div>
        <h1 class="font-display uppercase text-[36px] leading-[1] tracking-[-0.01em] mb-2">{{ t('genres.title') }}</h1>
        <p class="font-mono text-[11px] tracking-[0.06em] uppercase text-foreground-muted">
          {{ source === 'qobuz' ? t('genres.heroQobuz') : t('genres.heroDeezer') }}
        </p>
      </div>
      <div class="absolute -right-6 -bottom-16 font-display text-[220px] leading-none text-white/[0.03] select-none pointer-events-none" aria-hidden="true">▮</div>
    </div>

    <!-- Source toggle (Qobuz primary) -->
    <div class="flex gap-2">
      <button
        @click="setSource('qobuz')"
        class="font-mono text-[10px] tracking-[0.14em] uppercase px-3 py-1.5 border transition-colors"
        :class="source === 'qobuz' ? 'border-qobuz-500/60 text-qobuz-400 bg-qobuz-500/10' : 'border-white/[0.1] text-foreground-muted hover:text-foreground'"
      >Qobuz <span class="text-[8px] align-top">HI-RES</span></button>
      <button
        @click="setSource('deezer')"
        class="font-mono text-[10px] tracking-[0.14em] uppercase px-3 py-1.5 border transition-colors"
        :class="source === 'deezer' ? 'border-primary-500/60 text-primary-400 bg-primary-500/10' : 'border-white/[0.1] text-foreground-muted hover:text-foreground'"
      >Deezer</button>
    </div>

    <!-- ==================== QOBUZ MODE ==================== -->
    <template v-if="source === 'qobuz'">
      <!-- Top-level genre chips -->
      <div v-if="qGenres.length > 0" class="flex flex-wrap gap-2">
        <button
          v-for="g in qGenres"
          :key="g.id"
          @click="selectQobuzGenre(g)"
          class="flex-shrink-0 font-mono text-[10px] tracking-[0.12em] uppercase px-2.5 py-1 border transition-colors whitespace-nowrap"
          :class="qActiveGenre?.id === g.id ? 'border-qobuz-500/60 text-qobuz-400 bg-qobuz-500/10' : 'border-white/[0.1] text-foreground-muted hover:text-foreground'"
        >{{ g.name }}</button>
      </div>

      <!-- Feed tabs + counter -->
      <div v-if="qActiveGenre" class="flex items-center gap-3 flex-wrap">
        <div class="flex gap-1">
          <button
            v-for="f in QOBUZ_FEEDS"
            :key="f.type"
            @click="selectQobuzFeed(f.type)"
            class="font-mono text-[10px] tracking-[0.1em] uppercase px-2.5 py-1 border-b-2 transition-colors"
            :class="qActiveFeed === f.type ? 'border-qobuz-500 text-qobuz-400' : 'border-transparent text-foreground-muted hover:text-foreground'"
          >{{ t(f.labelKey) }}</button>
        </div>
        <div class="flex-1"></div>
        <span v-if="qTotal" class="font-mono text-[10px] text-foreground-muted">{{ qItems.length }} / {{ qTotal }}</span>
      </div>

      <!-- Loading (initial) -->
      <div v-if="isLoading" class="flex items-center justify-center py-20">
        <div class="animate-spin w-8 h-8 border-2 border-qobuz-500 border-t-transparent rounded-full"></div>
      </div>

      <ErrorState
        v-else-if="hasError"
        :title="t('errors.loadingFailed')"
        :message="errorMessage || t('errors.tryAgainLater')"
        @retry="retry"
      />

      <template v-else>
        <!-- The full catalog grid — pages until the genre is exhausted -->
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          <AlbumCard v-for="item in qItems" :key="item.id" :album="item" />
        </div>

        <div v-if="qLoadingMore" class="flex items-center justify-center py-10">
          <div class="animate-spin w-8 h-8 border-2 border-qobuz-500 border-t-transparent rounded-full"></div>
        </div>

        <div v-else-if="qItems.length < qTotal" class="text-center pb-8">
          <button
            @click="loadQobuzPage()"
            class="font-mono text-[10px] tracking-[0.16em] uppercase px-5 py-2 border border-qobuz-500/50 text-qobuz-400 hover:bg-qobuz-500 hover:text-background-main transition-colors"
          >{{ t('qobuz.more') }} ({{ qItems.length }}/{{ qTotal }})</button>
        </div>
      </template>
    </template>

    <!-- ==================== DEEZER MODE ==================== -->
    <template v-else>
      <!-- Genre chips (chartreuse — Deezer colorway) -->
      <div v-if="genres.length > 0" class="flex flex-wrap gap-2">
        <button
          v-for="g in genres"
          :key="g.id"
          @click="selectGenre(g.id)"
          class="flex-shrink-0 font-mono text-[10px] tracking-[0.12em] uppercase px-2.5 py-1 border transition-colors whitespace-nowrap"
          :class="activeGenre === g.id ? 'border-primary-500/60 text-primary-400 bg-primary-500/10' : 'border-white/[0.1] text-foreground-muted hover:text-foreground'"
        >{{ g.name }}</button>
      </div>

      <!-- Loading -->
      <div v-if="isLoading" class="flex items-center justify-center py-20">
        <div class="animate-spin w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full"></div>
      </div>

      <!-- Error -->
      <ErrorState
        v-else-if="hasError"
        :title="t('errors.loadingFailed')"
        :message="t('errors.tryAgainLater')"
        @retry="retry"
      />

      <template v-else>
        <!-- Editorial picks -->
        <section v-if="picks.length > 0">
          <h2 class="font-display text-[15px] uppercase tracking-[0.06em] mb-4">{{ t('genres.freshPicks') }}</h2>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <AlbumCard v-for="album in picks" :key="album.id" :album="album" />
          </div>
        </section>

        <!-- Genre chart tracks — pages toward Deezer's 100 cap -->
        <section v-if="chartTracks.length > 0">
          <div class="flex items-center gap-3 mb-4">
            <h2 class="font-display text-[15px] uppercase tracking-[0.06em]">{{ t('genres.topTracks') }}</h2>
            <span v-if="dzChart.tracks.total" class="font-mono text-[10px] text-foreground-muted">{{ chartTracks.length }} / {{ dzChart.tracks.total }}</span>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
            <TrackCard v-for="track in chartTracks" :key="track.id" :track="track" />
          </div>
          <div v-if="dzChart.tracks.loading" class="flex items-center justify-center py-8">
            <div class="animate-spin w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full"></div>
          </div>
          <div v-else-if="dzCanLoadMore('tracks')" class="text-center pt-4">
            <button
              @click="loadDeezerChartPage('tracks')"
              class="font-mono text-[10px] tracking-[0.16em] uppercase px-5 py-2 border border-primary-500/50 text-primary-400 hover:bg-primary-500 hover:text-background-main transition-colors"
            >{{ t('genres.moreTracks') }}</button>
          </div>
        </section>

        <!-- Genre chart albums — pages toward Deezer's 100 cap -->
        <section v-if="chartAlbums.length > 0">
          <div class="flex items-center gap-3 mb-4">
            <h2 class="font-display text-[15px] uppercase tracking-[0.06em]">{{ t('genres.topAlbums') }}</h2>
            <span v-if="dzChart.albums.total" class="font-mono text-[10px] text-foreground-muted">{{ chartAlbums.length }} / {{ dzChart.albums.total }}</span>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <AlbumCard v-for="album in chartAlbums" :key="album.id" :album="album" />
          </div>
          <div v-if="dzChart.albums.loading" class="flex items-center justify-center py-8">
            <div class="animate-spin w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full"></div>
          </div>
          <div v-else-if="dzCanLoadMore('albums')" class="text-center pt-4 pb-8">
            <button
              @click="loadDeezerChartPage('albums')"
              class="font-mono text-[10px] tracking-[0.16em] uppercase px-5 py-2 border border-primary-500/50 text-primary-400 hover:bg-primary-500 hover:text-background-main transition-colors"
            >{{ t('genres.moreAlbums') }}</button>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
