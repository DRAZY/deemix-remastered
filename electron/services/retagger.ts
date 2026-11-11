// Retagger — rewrite metadata-only on existing local files using the PUBLIC Deezer API.
//
// Design (see MEMORY/WORK/deemix-v1.9.0-retag/ISA.md):
//  - Identity: read each file's ISRC via music-metadata (MP3 + FLAC), then look the
//    track up on the public API (no ARL): GET /track/isrc:{isrc} -> GET /album/{id}.
//  - MP3: normalize existing common metadata, overlay selected fields, then
//    rebuild ID3v2.4. Supported custom text and synchronized lyrics are carried
//    over explicitly; unknown native frames are not guaranteed to survive.
//    FLAC overlays selected Vorbis comments and preserves PICTURE/audio blocks.
//  - Only NON-EMPTY resolved values overwrite; an empty lookup never deletes an
//    existing tag. Files with no ISRC are reported, never guessed.

import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import { qobuzAuth } from './qobuzAuth'
import { deezerAuth } from './deezerAuth'

import { downloadTagPatch } from './mp3-tags'

const str = (v: any) => (v === null || v === undefined ? '' : String(v))

export type AudioFormat = 'mp3' | 'flac'
export type MatchStatus = 'matched' | 'no-isrc' | 'unsupported' | 'unreadable'

export interface ScannedFile {
  path: string
  name: string
  format: AudioFormat | null
  isrc: string | null
  album: string        // existing ALBUM tag — anchors album-aware resolution
  albumArtist: string  // existing album-artist/artist tag
  status: MatchStatus
}

// The retaggable fields (subset of the app's tag settings that the public API
// can actually source). Mirrors the keys used in metadataSettings.tags.
export interface RetagFields {
  title?: boolean
  artist?: boolean
  album?: boolean
  albumArtist?: boolean
  trackNumber?: boolean
  trackTotal?: boolean
  discNumber?: boolean
  isrc?: boolean
  year?: boolean
  date?: boolean
  bpm?: boolean
  genre?: boolean
  trackLength?: boolean
  explicitLyrics?: boolean
  albumBarcode?: boolean // UPC
  albumLabel?: boolean
  copyright?: boolean    // TCOP / COPYRIGHT. Needs a Deezer login — see resolveCopyright.
  releaseType?: boolean  // RELEASETYPE (album/single/EP/compilation) — #82 retag backfill
  replayGain?: boolean   // REPLAYGAIN_TRACK_GAIN from Deezer's per-track gain. Default OFF.
}

// Normalized metadata resolved from the public Deezer endpoints (or supplied
// directly by the download flow, which already holds authoritative track/album
// data — see applyMergeFromMeta).
export interface ResolvedMeta {
  title: string
  artist: string
  album: string
  albumArtist: string
  trackNumber: string
  trackTotal: string
  discNumber: string
  isrc: string
  upc: string
  label: string
  copyright: string  // '' when unobtainable — the public API does not carry it (#139)
  year: string
  date: string
  bpm: string
  genre: string      // joined with "; " — split into multiple Vorbis GENRE comments for FLAC
  duration: string   // seconds (track length); written as TLEN ms (MP3) / LENGTH s (FLAC)
  explicit: boolean
  recordType: string // Deezer record_type (album/single/ep/compile) → RELEASETYPE tag (#82)
  gain: string       // Deezer per-track gain value (e.g. "-6.3") → REPLAYGAIN_TRACK_GAIN. '' when absent.
  source?: 'deezer' | 'qobuz'  // which catalog resolved this metadata (#108)
}

export interface TagChange {
  field: string
  from: string | null
  to: string
}

export interface RetagResult {
  path: string
  status: 'updated' | 'skipped' | 'failed' | 'preview'
  changes: TagChange[]
  // Which catalog sourced the new tags — 'qobuz' when the Deezer lookup missed
  // and the Qobuz fallback matched (#108). Disclosed in the Retag UI.
  source?: 'deezer' | 'qobuz'
  // Selected fields Deezer had no value for (e.g. an album with no genre).
  // Lets the UI say "not available on Deezer" instead of silently skipping.
  unavailable?: string[]
  // Selected fields that already matched Deezer (shown as "✓ already correct").
  unchanged?: string[]
  reason?: string
  error?: string
}

// --- HTTP helper (public Deezer API, no auth) -----------------------------

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve({}) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Deezer API request timed out')))
    req.on('error', reject)
  })
}

// --- Identity (read ISRC) -------------------------------------------------

function formatOf(filePath: string): AudioFormat | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp3') return 'mp3'
  if (ext === '.flac') return 'flac'
  return null
}

/** Read the identity tags we need for matching (ISRC + existing album/artist). */
export async function readTags(filePath: string): Promise<{ isrc: string | null; album: string; albumArtist: string }> {
  try {
    // music-metadata is ESM-only; dynamic import keeps us compatible with the
    // CommonJS main process (same pattern as `await import('https')`).
    const mm: any = await import('music-metadata')
    const meta = await mm.parseFile(filePath, { duration: false, skipCovers: true })
    const c = meta?.common || {}
    let isrc: string | null = null
    if (Array.isArray(c.isrc) && c.isrc.length > 0) isrc = String(c.isrc[0]).trim() || null
    else if (typeof c.isrc === 'string' && c.isrc.trim()) isrc = c.isrc.trim()
    return { isrc, album: str(c.album), albumArtist: str(c.albumartist || c.artist) }
  } catch {
    return { isrc: null, album: '', albumArtist: '' }
  }
}

/** Read just the file's ISRC. */
export async function readIsrc(filePath: string): Promise<string | null> {
  return (await readTags(filePath)).isrc
}

// --- Resolve (public API lookup) ------------------------------------------

// Cache full album objects by id — an album folder resolves the same album 20+
// times, so this collapses it to one fetch.
const albumByIdCache = new Map<string, Promise<any>>()
function getAlbum(albumId: string | number): Promise<any> {
  const key = String(albumId)
  let p = albumByIdCache.get(key)
  if (!p) {
    p = getJson(`https://api.deezer.com/album/${key}`).then(a => (a && !a.error ? a : {})).catch(() => ({}))
    albumByIdCache.set(key, p)
    p.finally(() => setTimeout(() => albumByIdCache.delete(key), 120000))
  }
  return p
}

/**
 * Join every credited artist from a public-API track. The `contributors` array
 * carries all artists (Main + Featured) — e.g. "Loyal" → Chris Brown, Lil Wayne,
 * Tyga — whereas `track.artist.name` is only the main artist. Dedupe by name and
 * keep source order; fall back to the main artist when contributors are absent.
 */
function joinContributors(track: any): string {
  if (Array.isArray(track?.contributors) && track.contributors.length > 0) {
    const seen = new Set<string>()
    const names = track.contributors
      .map((c: any) => str(c?.name).trim())
      .filter((n: string) => {
        if (!n) return false
        const k = n.toLowerCase()
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
    if (names.length > 0) return names.join(', ')
  }
  return str(track?.artist?.name)
}

/** Normalize a public-API track + album object into our tag shape. */
function buildMeta(track: any, album: any): ResolvedMeta {
  const releaseDate: string = album.release_date || track.release_date || ''
  // Album genres live on the public album endpoint; "All" (id 0) is noise.
  const genreNames: string[] = Array.isArray(album.genres?.data)
    ? album.genres.data.map((g: any) => str(g?.name)).filter((n: string) => n && n.toLowerCase() !== 'all')
    : []
  return {
    title: str(track.title),
    artist: joinContributors(track),
    album: str(album.title || track.album?.title),
    albumArtist: str(album.artist?.name || track.artist?.name),
    trackNumber: str(track.track_position),
    trackTotal: str(album.nb_tracks),
    discNumber: str(track.disk_number),
    isrc: str(track.isrc),
    upc: typeof album.upc === 'string' ? album.upc : '',
    label: typeof album.label === 'string' ? album.label : '',
    // Deferred: the public endpoints this resolver uses carry no copyright at
    // all. resolveCopyright fills it in from the gateway when a session exists.
    copyright: '',
    year: releaseDate ? releaseDate.split('-')[0] : '',
    date: releaseDate,
    bpm: track.bpm ? str(track.bpm) : '',
    genre: genreNames.join('; '),
    duration: track.duration ? str(track.duration) : '',
    explicit: track.explicit_lyrics === true,
    recordType: typeof album.record_type === 'string' ? album.record_type : '',
    gain: (track.gain === null || track.gain === undefined) ? '' : String(track.gain),
    source: 'deezer'
  }
}

/**
 * ReplayGain track-gain string from Deezer's per-track gain value.
 * Formula matches original deemix exactly: -(GAIN + 18.4), 2 decimals + " dB".
 * Returns '' when the gain is missing/unparseable so we never write a junk tag.
 * Metadata only — a ReplayGain-aware player reads this to normalize playback
 * loudness; it never alters the audio. Shared by the download writer and the
 * retag/refresh writers so the value can't diverge between paths.
 */
export function replayGainString(gainRaw: string | number | null | undefined): string {
  if (gainRaw === null || gainRaw === undefined || gainRaw === '') return ''
  const g = parseFloat(String(gainRaw))
  if (isNaN(g)) return ''
  return `${(-(g + 18.4)).toFixed(2)} dB`
}

/**
 * Map Deezer's record_type to the MusicBrainz RELEASETYPE value Navidrome/Picard
 * expect. Returns '' for unknown/missing so we never write a junk tag (#82).
 * Mirrors Downloader.mapReleaseType. NOTE: Deezer mislabels many EPs, so EP
 * detection here is best-effort — same source-data caveat as the download path.
 */
function mapReleaseType(recordType: string): string {
  switch ((recordType || '').toLowerCase()) {
    case 'album': return 'Album'
    case 'single': return 'Single'
    case 'ep': return 'EP'
    case 'compile': return 'Compilation'
    default: return ''
  }
}

/** Look up a track by ISRC on the public API and normalize track + album metadata. */
/**
 * Copyright for a Deezer track, from the private gateway (#139).
 *
 * The public endpoints this file resolves from carry no copyright field at all,
 * so it can only come from deezer.pageTrack, which needs a logged-in session.
 * Retagging otherwise works logged out, so this stays best-effort: no session,
 * no lookup, and the field is reported as unavailable rather than failing the
 * retag or forcing a login for the other twenty fields.
 */
async function resolveCopyright(trackId: string | number | undefined): Promise<string> {
  if (!trackId || !deezerAuth.isLoggedIn()) return ''
  try {
    const page = await deezerAuth.getTrackPage(trackId)
    return typeof page?.DATA?.COPYRIGHT === 'string' ? page.DATA.COPYRIGHT : ''
  } catch {
    return ''
  }
}

export async function resolveByIsrc(isrc: string): Promise<ResolvedMeta | null> {
  const track = await getJson(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`)
  if (!track || track.error || !track.id) return null
  const album = track.album?.id ? await getAlbum(track.album.id) : {}
  const meta = buildMeta(track, album)
  meta.copyright = await resolveCopyright(track.id)
  return meta
}

/** Resolve by an explicit Deezer track id (the authoritative album track), with album. */
export async function resolveTrackById(trackId: string | number): Promise<ResolvedMeta | null> {
  const track = await getJson(`https://api.deezer.com/track/${trackId}`)
  if (!track || track.error || !track.id) return null
  const album = track.album?.id ? await getAlbum(track.album.id) : {}
  const meta = buildMeta(track, album)
  meta.copyright = await resolveCopyright(track.id)
  return meta
}

// --- Qobuz fallback resolver (#108) ---------------------------------------
// Qobuz's api.json has no first-class ISRC endpoint, but catalog/search DOES
// index ISRCs (verified live: real library ISRCs return the exact track as the
// first hit). Search, then require the candidate's isrc field to EQUAL the
// file's before accepting — never an unverified match. Requires a connected
// Qobuz session; the caller treats null as "no match".

const qobuzAlbumCache = new Map<string, Promise<any>>()
function getQobuzAlbumCached(albumId: string): Promise<any> {
  let p = qobuzAlbumCache.get(albumId)
  if (!p) {
    p = qobuzAuth.getAlbum(albumId).catch(() => null)
    qobuzAlbumCache.set(albumId, p)
    p.finally(() => setTimeout(() => qobuzAlbumCache.delete(albumId), 120000))
  }
  return p
}

/** Normalize a Qobuz search-hit track + album/get container into ResolvedMeta. */
function buildMetaQobuz(track: any, album: any): ResolvedMeta {
  const a = album || {}
  const releaseDate: string = str(a.release_date_original || track.release_date_original || '')
  const version = str(track.version).trim()
  const baseTitle = str(track.title)
  return {
    // Qobuz keeps edition qualifiers in `version` — fold it in unless the title
    // already carries it (mirrors how the download tagger composes titles).
    title: version && !baseTitle.toLowerCase().includes(version.toLowerCase())
      ? `${baseTitle} ${version}` : baseTitle,
    artist: str(track.performer?.name || a.artist?.name),
    album: str(a.title || track.album?.title),
    albumArtist: str(a.artist?.name || track.performer?.name),
    trackNumber: str(track.track_number),
    trackTotal: str(a.tracks_count),
    discNumber: str(track.media_number),
    isrc: str(track.isrc),
    upc: typeof a.upc === 'string' ? a.upc : '',
    label: str(a.label?.name),
    // Qobuz carries copyright on the track object itself, unlike Deezer's
    // public endpoints, so this path needs no extra request.
    copyright: str((t as any)?.copyright),
    year: releaseDate ? releaseDate.split('-')[0] : '',
    date: releaseDate,
    bpm: '', // not exposed by Qobuz's catalog
    genre: str(a.genre?.name),
    duration: track.duration ? str(track.duration) : '',
    explicit: track.parental_warning === true,
    recordType: '', // Qobuz has no Deezer-style record_type — never write a guess
    gain: '', // Qobuz exposes no per-track gain
    source: 'qobuz'
  }
}

/** ISRC lookup on Qobuz (search-then-verify). Null when disconnected or no exact match. */
export async function resolveByIsrcQobuz(isrc: string): Promise<ResolvedMeta | null> {
  if (!qobuzAuth.isLoggedIn()) return null
  try {
    const res = await qobuzAuth.search(isrc, 5)
    const items: any[] = res?.tracks?.items || []
    const hit = items.find(t => str(t?.isrc).toUpperCase() === isrc.toUpperCase())
    if (!hit) return null
    const albumId = hit.album?.id ? String(hit.album.id) : null
    const album = albumId ? await getQobuzAlbumCached(albumId) : null
    return buildMetaQobuz(hit, album || hit.album || {})
  } catch {
    return null // fallback resolver never fails the file — Deezer's miss already reported
  }
}

// --- Field plan (which tags to overlay, with their new values) ------------

interface PlannedField {
  field: string // human label
  value: string // non-empty new value
}

/**
 * Build the list of fields to overlay, honoring user selection.
 * A selected field whose Deezer value is empty goes to `unavailable` (so the UI
 * can say "not available on Deezer" instead of silently doing nothing).
 */
function planFields(meta: ResolvedMeta, fields: RetagFields): { plan: PlannedField[]; unavailable: string[] } {
  const plan: PlannedField[] = []
  const unavailable: string[] = []
  const add = (on: boolean | undefined, field: string, value: string) => {
    if (!on) return
    if (value) plan.push({ field, value })
    else unavailable.push(field)
  }
  add(fields.title, 'title', meta.title)
  add(fields.artist, 'artist', meta.artist)
  add(fields.album, 'album', meta.album)
  add(fields.albumArtist, 'albumArtist', meta.albumArtist)
  add(fields.trackNumber, 'trackNumber', meta.trackNumber)
  add(fields.trackTotal, 'trackTotal', meta.trackTotal)
  add(fields.discNumber, 'discNumber', meta.discNumber)
  add(fields.isrc, 'isrc', meta.isrc)
  add(fields.year, 'year', meta.year)
  add(fields.date, 'date', meta.date)
  add(fields.bpm, 'bpm', meta.bpm)
  add(fields.genre, 'genre', meta.genre)
  add(fields.trackLength, 'trackLength', meta.duration)
  // explicit is a boolean we always represent as 1/0 when enabled — always available.
  if (fields.explicitLyrics) plan.push({ field: 'explicitLyrics', value: meta.explicit ? '1' : '0' })
  add(fields.albumBarcode, 'albumBarcode', meta.upc)
  add(fields.albumLabel, 'albumLabel', meta.label)
  add(fields.copyright, 'copyright', meta.copyright)
  add(fields.releaseType, 'releaseType', mapReleaseType(meta.recordType))
  add(fields.replayGain, 'replayGain', replayGainString(meta.gain))
  return { plan, unavailable }
}

// --- MP3 merge writer (read-all -> mutate targeted -> write-all) ----------

export async function applyMp3(filePath: string, plan: PlannedField[], dryRun: boolean): Promise<{ changes: TagChange[]; unchanged: string[] }> {
  const { parseFile } = await import('music-metadata')
  const { updateFile } = await import('music-metadata')
  const metadata = await parseFile(filePath)
  const common = metadata.common
  const pair = (value: { no: number | null; of: number | null }) =>
    value.no == null && value.of == null ? undefined : `${value.no ?? ''}${value.of == null ? '' : `/${value.of}`}`
  const existing: any = {
    ...common, performerInfo: common.albumartist, trackNumber: pair(common.track),
    partOfSet: pair(common.disk), ISRC: common.isrc?.[0], publisher: common.label?.[0],
    length: metadata.format.duration == null ? undefined : String(Math.round(metadata.format.duration * 1000)),
    userDefinedText: []
  }
  const preservedNative: Record<string, any> = {}
  for (const [group, entries] of Object.entries(metadata.native)) {
    if (!group.startsWith('ID3v2')) continue
    for (const tag of entries) {
      if (tag.id.startsWith('TXXX:')) {
        existing.userDefinedText.push({ description: tag.id.slice(5), value: tag.value })
        const previous = preservedNative[tag.id]
        preservedNative[tag.id] = previous === undefined ? tag.value : [...(Array.isArray(previous) ? previous : [previous]), tag.value]
      } else if (tag.id === 'SYLT') {
        preservedNative.SYLT = [...(preservedNative.SYLT || []), tag.value]
      }
    }
  }
  const changes: TagChange[] = []
  const unchanged: string[] = []
  const record = (field: string, from: any, to: string) => {
    const fromStr = from === null || from === undefined ? null : String(from)
    if (fromStr === to) { unchanged.push(field); return }
    changes.push({ field, from: fromStr, to })
  }
  // Only selected fields override the normalized common metadata.
  const tags: any = {}
  const udt: Array<{ description: string; value: string }> = Array.isArray(existing.userDefinedText)
    ? existing.userDefinedText.map((e: any) => ({ ...e }))
    : []

  for (const { field, value } of plan) {
    switch (field) {
      case 'title': record(field, existing.title, value); tags.title = value; break
      case 'artist': record(field, existing.artist, value); tags.artist = value; break
      case 'album': record(field, existing.album, value); tags.album = value; break
      case 'albumArtist': record(field, existing.performerInfo, value); tags.performerInfo = value; break
      case 'trackNumber': {
        const combined = existing.trackNumber && String(existing.trackNumber).includes('/')
          ? String(existing.trackNumber).split('/')[1] ? `${value}/${String(existing.trackNumber).split('/')[1]}` : value
          : value
        record(field, existing.trackNumber, combined); tags.trackNumber = combined; break
      }
      case 'trackTotal': {
        const cur = (tags.trackNumber ?? existing.trackNumber) ? String(tags.trackNumber ?? existing.trackNumber).split('/')[0] : ''
        const combined = cur ? `${cur}/${value}` : `/${value}`
        record('trackTotal', existing.trackNumber, combined); tags.trackNumber = combined; break
      }
      case 'discNumber': record(field, existing.partOfSet, value); tags.partOfSet = value; break
      case 'isrc': record(field, existing.ISRC, value); tags.ISRC = value; break
      case 'year': record(field, existing.year, value); tags.year = value; break
      case 'date': record(field, existing.date, value); tags.date = value; break
      case 'bpm': record(field, existing.bpm, value); tags.bpm = value; break
      case 'genre': record(field, existing.genre, value); tags.genre = value; break
      case 'trackLength': {
        // TLEN frame is milliseconds; the resolved value is seconds (matches download writer).
        const ms = (parseInt(value, 10) * 1000).toString()
        record('trackLength', existing.length, ms); tags.length = ms; break
      }
      case 'albumLabel': record(field, existing.publisher, value); tags.publisher = value; break
      case 'copyright': record(field, existing.copyright, value); tags.copyright = value; break
      case 'albumBarcode': {
        const prev = udt.find((e) => e.description === 'BARCODE')
        record('albumBarcode', prev?.value ?? null, value)
        if (prev) prev.value = value
        else udt.push({ description: 'BARCODE', value })
        tags.userDefinedText = udt
        break
      }
      case 'explicitLyrics': {
        // iTunes advisory TXXX frame (matches download writer's ITUNESADVISORY).
        const prev = udt.find((e) => e.description === 'ITUNESADVISORY')
        record('explicitLyrics', prev?.value ?? null, value)
        if (prev) prev.value = value
        else udt.push({ description: 'ITUNESADVISORY', value })
        tags.userDefinedText = udt
        break
      }
      case 'releaseType': {
        // Two TXXX frames so it matches both Navidrome aliases — "releasetype"
        // and "txxx:musicbrainz album type" (matches the download writer, #82).
        const prevRt = udt.find((e) => e.description === 'RELEASETYPE')
        record('releaseType', prevRt?.value ?? null, value)
        if (prevRt) prevRt.value = value
        else udt.push({ description: 'RELEASETYPE', value })
        const prevMb = udt.find((e) => e.description === 'MusicBrainz Album Type')
        if (prevMb) prevMb.value = value
        else udt.push({ description: 'MusicBrainz Album Type', value })
        tags.userDefinedText = udt
        break
      }
      case 'replayGain': {
        // REPLAYGAIN_TRACK_GAIN TXXX frame — the de-facto ReplayGain key that
        // foobar2000/VLC/etc read to normalize playback loudness. Metadata
        // only; audio bytes are untouched. Merge like BARCODE.
        const prev = udt.find((e) => e.description === 'REPLAYGAIN_TRACK_GAIN')
        record('replayGain', prev?.value ?? null, value)
        if (prev) prev.value = value
        else udt.push({ description: 'REPLAYGAIN_TRACK_GAIN', value })
        tags.userDefinedText = udt
        break
      }
    }
  }

  if (!dryRun && changes.length > 0) {
    const overlay = downloadTagPatch(tags)
    const merged = { ...common, native: { ...preservedNative, ...overlay.native } }
    // Avoid common artist aliases competing with the selected native TPE1/TPE2.
    if (tags.artist !== undefined) { delete merged.artist; delete merged.artists }
    if (tags.performerInfo !== undefined) { delete merged.albumartist; delete merged.albumartists }
    await updateFile(filePath, merged, { replaceId3: true })
  }
  return { changes, unchanged }
}

// --- FLAC merge writer (overlay Vorbis comments, preserve PICTURE + audio) -

interface FlacBlock { type: number; isLast: boolean; data: Buffer }

const FLAC_FIELD_TO_KEY: Record<string, string> = {
  title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', albumArtist: 'ALBUMARTIST',
  trackNumber: 'TRACKNUMBER', trackTotal: 'TRACKTOTAL', discNumber: 'DISCNUMBER',
  isrc: 'ISRC', year: 'YEAR', date: 'DATE', bpm: 'BPM', genre: 'GENRE',
  trackLength: 'LENGTH', explicitLyrics: 'EXPLICIT',
  albumBarcode: 'BARCODE', albumLabel: 'LABEL', replayGain: 'REPLAYGAIN_TRACK_GAIN',
  copyright: 'COPYRIGHT'
}

function applyFlac(filePath: string, plan: PlannedField[], dryRun: boolean): { changes: TagChange[]; unchanged: string[] } {
  const flacData = fs.readFileSync(filePath)
  if (flacData.toString('utf8', 0, 4) !== 'fLaC') throw new Error('Not a valid FLAC file')

  // Parse metadata blocks (mirror of downloader.ts block parser).
  const blocks: FlacBlock[] = []
  let offset = 4
  while (offset < flacData.length) {
    const headerByte = flacData.readUInt8(offset)
    const isLast = (headerByte & 0x80) !== 0
    const type = headerByte & 0x7f
    const length = flacData.readUIntBE(offset + 1, 3)
    if (type === 127) break
    blocks.push({ type, isLast, data: flacData.slice(offset + 4, offset + 4 + length) })
    offset += 4 + length
    if (isLast) break
  }
  const audioDataOffset = offset
  const audioData = flacData.slice(audioDataOffset)

  // Parse the existing VORBIS_COMMENT (type 4) into vendor + comment strings.
  let vendor = 'Deemix Remastered'
  let comments: string[] = []
  const vc = blocks.find((b) => b.type === 4)
  if (vc) {
    let p = 0
    const vlen = vc.data.readUInt32LE(p); p += 4
    vendor = vc.data.toString('utf8', p, p + vlen); p += vlen
    const count = vc.data.readUInt32LE(p); p += 4
    for (let i = 0; i < count; i++) {
      const clen = vc.data.readUInt32LE(p); p += 4
      comments.push(vc.data.toString('utf8', p, p + clen)); p += clen
    }
  }

  // Overlay only the planned keys; capture before/after for the change report.
  const changes: TagChange[] = []
  const unchanged: string[] = []
  for (const { field, value } of plan) {
    if (field === 'releaseType') {
      // Two Vorbis keys so it matches both Navidrome aliases (releasetype +
      // musicbrainz_albumtype), mirroring the download writer (#82).
      const rtMatch = (c: string) => c.toUpperCase().startsWith('RELEASETYPE=')
      const prev = comments.find(rtMatch)
      const prevVal = prev ? prev.slice('RELEASETYPE='.length) : null
      if (prevVal === value) { unchanged.push(field); continue }
      changes.push({ field, from: prevVal, to: value })
      comments = comments.filter((c) => !rtMatch(c) && !c.toUpperCase().startsWith('MUSICBRAINZ_ALBUMTYPE='))
      comments.push(`RELEASETYPE=${value}`)
      comments.push(`MUSICBRAINZ_ALBUMTYPE=${value}`)
      continue
    }
    const key = FLAC_FIELD_TO_KEY[field]
    if (!key) continue
    const matches = (c: string) => c.toUpperCase().startsWith(key + '=')
    if (field === 'genre') {
      // FLAC natively supports multiple GENRE comments; the resolved value is
      // "; "-joined, so split it back out (matches the download writer).
      const prev = comments.filter(matches).map((c) => c.slice(key.length + 1)).join('; ') || null
      if (prev === value) { unchanged.push(field); continue }
      changes.push({ field, from: prev, to: value })
      comments = comments.filter((c) => !matches(c))
      for (const g of value.split('; ')) comments.push(`${key}=${g}`)
      continue
    }
    const prevEntry = comments.find(matches)
    const prev = prevEntry ? prevEntry.slice(key.length + 1) : null
    if (prev === value) { unchanged.push(field); continue }
    changes.push({ field, from: prev, to: value })
    comments = comments.filter((c) => !matches(c))
    comments.push(`${key}=${value}`)
  }

  if (dryRun || changes.length === 0) return { changes, unchanged }

  // Re-serialize: keep every block in original order, swapping only the
  // VORBIS_COMMENT payload (preserves PICTURE/SEEKTABLE/CUESHEET/etc).
  const newVc = serializeVorbis(vendor, comments)
  const outBlocks: { type: number; data: Buffer }[] = []
  let replaced = false
  for (const b of blocks) {
    if (b.type === 1) continue // drop PADDING (cosmetic; audio bytes unaffected)
    if (b.type === 4) { outBlocks.push({ type: 4, data: newVc }); replaced = true }
    else outBlocks.push({ type: b.type, data: b.data })
  }
  if (!replaced) {
    // No existing comment block — insert right after STREAMINFO (index 0).
    const insertAt = outBlocks.length > 0 && outBlocks[0].type === 0 ? 1 : 0
    outBlocks.splice(insertAt, 0, { type: 4, data: newVc })
  }

  const chunks: Buffer[] = [Buffer.from('fLaC')]
  outBlocks.forEach((b, i) => {
    const isLast = i === outBlocks.length - 1
    const header = Buffer.alloc(4)
    header.writeUInt8((isLast ? 0x80 : 0x00) | b.type, 0)
    header.writeUIntBE(b.data.length, 1, 3)
    chunks.push(header, b.data)
  })
  chunks.push(audioData)
  fs.writeFileSync(filePath, Buffer.concat(chunks))
  return { changes, unchanged }
}

function serializeVorbis(vendor: string, comments: string[]): Buffer {
  const vendorBytes = Buffer.from(vendor, 'utf8')
  const commentBuffers = comments.map((c) => Buffer.from(c, 'utf8'))
  let size = 4 + vendorBytes.length + 4
  for (const cb of commentBuffers) size += 4 + cb.length
  const buf = Buffer.alloc(size)
  let p = 0
  buf.writeUInt32LE(vendorBytes.length, p); p += 4
  vendorBytes.copy(buf, p); p += vendorBytes.length
  buf.writeUInt32LE(commentBuffers.length, p); p += 4
  for (const cb of commentBuffers) {
    buf.writeUInt32LE(cb.length, p); p += 4
    cb.copy(buf, p); p += cb.length
  }
  return buf
}

// --- Orchestration --------------------------------------------------------

/**
 * Merge-write tags onto an existing file from already-resolved metadata.
 * The download flow calls this directly with authoritative track/album data
 * (exact IDs — no ISRC reverse-lookup ambiguity); the standalone retag calls it
 * after resolving by ISRC.
 */
export async function applyMergeFromMeta(filePath: string, meta: ResolvedMeta, fields: RetagFields, dryRun: boolean): Promise<RetagResult> {
  const fmt = formatOf(filePath)
  if (!fmt) return { path: filePath, status: 'skipped', changes: [], reason: 'unsupported format' }

  const { plan, unavailable } = planFields(meta, fields)
  if (plan.length === 0) {
    return {
      path: filePath, status: 'skipped', changes: [], unavailable,
      reason: unavailable.length ? 'selected tags not available on Deezer' : 'no tags selected'
    }
  }

  try {
    const { changes, unchanged } = fmt === 'flac' ? applyFlac(filePath, plan, dryRun) : await applyMp3(filePath, plan, dryRun)
    if (changes.length === 0) return { path: filePath, status: 'skipped', changes: [], unchanged, unavailable, reason: 'tags already up to date', source: meta.source }
    return { path: filePath, status: dryRun ? 'preview' : 'updated', changes, unchanged, unavailable, source: meta.source }
  } catch (e: any) {
    return { path: filePath, status: 'failed', changes: [], unavailable, error: e?.message || String(e) }
  }
}

/** Retag (or preview) a single file by reverse ISRC lookup, then merge-write. */
export async function retagFile(filePath: string, fields: RetagFields, dryRun: boolean): Promise<RetagResult> {
  const fmt = formatOf(filePath)
  if (!fmt) return { path: filePath, status: 'skipped', changes: [], reason: 'unsupported format' }

  let isrc: string | null
  try { isrc = await readIsrc(filePath) } catch { return { path: filePath, status: 'failed', changes: [], error: 'could not read file tags' } }
  if (!isrc) return { path: filePath, status: 'skipped', changes: [], reason: 'no ISRC in file' }

  let meta: ResolvedMeta | null
  try { meta = await resolveByIsrc(isrc) } catch (e: any) { return { path: filePath, status: 'failed', changes: [], error: `lookup failed: ${e?.message || e}` } }
  // Deezer miss -> Qobuz fallback (#108); connected sessions only, exact-ISRC verified.
  if (!meta) meta = await resolveByIsrcQobuz(isrc)
  if (!meta) {
    const tried = qobuzAuth.isLoggedIn() ? 'Deezer or Qobuz' : 'Deezer'
    return { path: filePath, status: 'failed', changes: [], error: `no ${tried} match for ISRC ${isrc}` }
  }

  return applyMergeFromMeta(filePath, meta, fields, dryRun)
}

/** Recursively scan a folder for .mp3/.flac files and read ISRC + album tags. */
export async function scanFolder(folder: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && formatOf(full)) out.push({ path: full, name: e.name, format: formatOf(full), isrc: null, album: '', albumArtist: '', status: 'no-isrc' })
    }
  }
  walk(folder)
  const concurrency = 8
  for (let i = 0; i < out.length; i += concurrency) {
    const batch = out.slice(i, i + concurrency)
    await Promise.all(batch.map(async (f) => {
      try {
        const t = await readTags(f.path)
        f.isrc = t.isrc; f.album = t.album; f.albumArtist = t.albumArtist
        f.status = f.isrc ? 'matched' : 'no-isrc'
      } catch {
        f.status = 'unreadable'
      }
    }))
  }
  return out
}

// --- Album-aware folder resolution ----------------------------------------

interface FolderAlbumContext {
  // file ISRC -> the authoritative album track's Deezer id (for resolveTrackById)
  isrcToTrackId: Map<string, number>
}
const folderAlbumCache = new Map<string, Promise<FolderAlbumContext>>()

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Determine the ONE Deezer album an album-folder belongs to, and map each file's
 * ISRC to that album's track ids. This defeats the ISRC→single ambiguity: tracks
 * pre-released as singles resolve (via /track/isrc) to the single, but they ARE
 * present in the real album's tracklist at their correct positions.
 */
async function resolveFolderAlbum(folder: string): Promise<FolderAlbumContext> {
  let p = folderAlbumCache.get(folder)
  if (p) return p
  p = (async (): Promise<FolderAlbumContext> => {
    const empty: FolderAlbumContext = { isrcToTrackId: new Map() }
    const files = await scanFolder(folder) // one scan per folder (cache miss only)
    const matched = files.filter(f => f.isrc)
    if (matched.length === 0) return empty

    // Dominant existing ALBUM tag = the album we're trying to match.
    const counts = new Map<string, number>()
    for (const f of matched) if (f.album) counts.set(norm(f.album), (counts.get(norm(f.album)) || 0) + 1)
    let targetAlbum = ''
    let best = 0
    for (const [a, c] of counts) if (c > best) { best = c; targetAlbum = a }
    if (!targetAlbum) return empty

    // Find the real album id: the first track whose ISRC resolves to an album
    // whose title matches the dominant ALBUM tag (album-exclusive tracks do this;
    // single-released tracks won't, so we keep probing up to a cap).
    let albumId: number | null = null
    for (const f of matched.slice(0, 12)) {
      try {
        const track = await getJson(`https://api.deezer.com/track/isrc:${encodeURIComponent(f.isrc!)}`)
        if (track?.album?.id && norm(str(track.album.title)) === targetAlbum) { albumId = track.album.id; break }
      } catch { /* keep probing */ }
    }
    if (!albumId) return empty

    // Fetch the album's full tracklist → isrc -> track id map.
    const isrcToTrackId = new Map<string, number>()
    try {
      let url: string | null = `https://api.deezer.com/album/${albumId}/tracks?limit=100`
      while (url) {
        const page: any = await getJson(url)
        for (const t of page?.data || []) if (t.isrc && t.id) isrcToTrackId.set(String(t.isrc).trim(), t.id)
        url = page?.next || null
      }
    } catch { /* partial map still useful */ }
    return { isrcToTrackId }
  })()
  folderAlbumCache.set(folder, p)
  p.finally(() => setTimeout(() => folderAlbumCache.delete(folder), 120000))
  return p
}

/**
 * Album-aware retag: resolve the file against the folder's authoritative album
 * (correct track position/total/UPC for every track), falling back to per-file
 * ISRC lookup when the file isn't part of that album or no album was determined.
 */
export async function retagFileInFolder(filePath: string, folder: string, fields: RetagFields, dryRun: boolean): Promise<RetagResult> {
  const fmt = formatOf(filePath)
  if (!fmt) return { path: filePath, status: 'skipped', changes: [], reason: 'unsupported format' }

  let tags: { isrc: string | null }
  try { tags = await readTags(filePath) } catch { return { path: filePath, status: 'failed', changes: [], error: 'could not read file tags' } }
  if (!tags.isrc) return { path: filePath, status: 'skipped', changes: [], reason: 'no ISRC in file' }

  let meta: ResolvedMeta | null = null
  try {
    const ctx = await resolveFolderAlbum(folder)
    const albumTrackId = ctx.isrcToTrackId.get(tags.isrc)
    meta = albumTrackId ? await resolveTrackById(albumTrackId) : await resolveByIsrc(tags.isrc)
  } catch (e: any) {
    return { path: filePath, status: 'failed', changes: [], error: `lookup failed: ${e?.message || e}` }
  }
  // Deezer miss -> Qobuz fallback (#108); connected sessions only, exact-ISRC verified.
  if (!meta) meta = await resolveByIsrcQobuz(tags.isrc)
  if (!meta) {
    const tried = qobuzAuth.isLoggedIn() ? 'Deezer or Qobuz' : 'Deezer'
    return { path: filePath, status: 'failed', changes: [], error: `no ${tried} match for ISRC ${tags.isrc}` }
  }

  return applyMergeFromMeta(filePath, meta, fields, dryRun)
}
