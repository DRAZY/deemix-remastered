// Shared album-context builder — single source of truth for the album-level
// metadata that drives consistent folder structure (incl. CD subfolders for
// multi-disc albums), folder/file naming templates, and tags.
//
// Used by BOTH the manual album-page download (server.handleDownloadAlbum /
// fetchAlbumContext, #94) and artist sync (artistSync, #95) so a synced track
// lands in the SAME folder — and carries the same tags — as a manual album
// download. Divergence here is exactly what caused #95 (sync ignored CD folders
// because it never built this context).
export interface AlbumContext {
  albumId: number | string
  albumTitle: string
  albumArtist: string
  artistPicture?: string
  totalDiscs?: number
  totalTracks?: number
  explicitLyrics?: boolean
  isCompilation?: boolean
  recordType?: string
  upc?: string
  label?: string
  // Deezer cover hash of the REQUESTED album (public `md5_image`, the same value
  // as the private API's ALB_PICTURE). Lets a substituted track keep this
  // album's artwork even if the rights-locked original came back without one.
  coverMd5?: string
}

// Build the context from a public-API album object (`/album/{id}`) plus its
// tracklist (`/album/{id}/tracks`). `tracksData` drives disc count + explicit
// status; both callers already fetch the tracklist, so no extra request here.
export function buildAlbumContext(
  albumId: number | string,
  albumInfo: any,
  tracksData: any[]
): AlbumContext {
  // Total discs — drives CD folder creation for multi-disc albums.
  const totalDiscs = Math.max(...tracksData.map((t: any) => t.disk_number || 1), 1)
  // Total tracks — feeds the Track Total tag / %tracktotal% (#107). Prefer the
  // authoritative album count; fall back to the tracklist length.
  const totalTracks = Number(albumInfo.nb_tracks) || tracksData.length || undefined
  // Explicit status from actual track data. Album-level explicit_content_lyrics
  // is unreliable (code 4 = "partial"); flag the album explicit if ANY track is
  // code 1.
  const hasExplicitTracks = tracksData.some((t: any) => t.explicit_content_lyrics === 1)
  // For compilations (record_type "compile"), Deezer sets the album artist to
  // "Various Artists" — this keeps all tracks in the same folder.
  return {
    albumId,
    albumTitle: albumInfo.title || 'Unknown Album',
    albumArtist: albumInfo.artist?.name || 'Unknown Artist',
    artistPicture: albumInfo.artist?.picture_xl || albumInfo.artist?.picture_big || albumInfo.artist?.picture_medium || undefined,
    totalDiscs,
    totalTracks,
    explicitLyrics: hasExplicitTracks,
    isCompilation: albumInfo.record_type === 'compile',
    // Full record_type (album/single/ep/compile) for the RELEASETYPE tag (#82)
    recordType: typeof albumInfo.record_type === 'string' ? albumInfo.record_type : '',
    // v1.8.1: surface UPC so %barcode% / %upc% folder + filename templates have a
    // value (trackInfo.ALB_UPC is undefined on private-API track fetches).
    upc: typeof albumInfo.upc === 'string' ? albumInfo.upc : '',
    // v1.8.2: surface label for the same reason.
    label: typeof albumInfo.label === 'string' ? albumInfo.label : '',
    coverMd5: typeof albumInfo.md5_image === 'string' && albumInfo.md5_image ? albumInfo.md5_image : undefined
  }
}

// ---------------------------------------------------------------------------
// Substitution: keep the album looking like the album that was asked for.
//
// When a rights-locked track is replaced by an alternate version, the downloader
// swaps in the alternate's whole track record. That is right for everything that
// describes the AUDIO (id, title, version, ISRC, duration, gain, lyrics, artists)
// and wrong for everything that describes the RELEASE, because the file is going
// into the requested album's folder under the requested album's title.
//
// Until 2.6.3 only title/artist/UPC/label were held by AlbumContext, so cover art
// and release dates leaked in from wherever the alternate lived. On Mötley Crüe's
// "Shout At The Devil (40th Anniversary)" that produced three different covers in
// one album (the anniversary art, the standard album's, and The Dirt Soundtrack's)
// and a folder cover.jpg from the wrong release.
//
// Rule: in an album download, release-level fields come from the requested
// album. Track-level fields stay the alternate's, so the file never claims to be
// a recording it is not; the "Alternate version" badge carries the disclosure.
// Outside an album download (single track, playlist) nothing is pinned: there the
// alternate's own release is the coherent thing to describe.

// Identity of the release. Always taken from the requested track, even when
// empty: another release's barcode or label on this album is worse than none.
const RELEASE_IDENTITY_FIELDS = ['ALB_ID', 'ALB_TITLE', 'ALB_ART_NAME', 'ALB_UPC', 'LABEL_NAME'] as const
// Release descriptors a player groups or sorts by. Taken from the requested
// track when it has them; otherwise the alternate's value is kept and reported,
// since a missing date splits an album as surely as a wrong one.
const RELEASE_DESCRIPTOR_FIELDS = [
  'ALB_PICTURE', 'PHYSICAL_RELEASE_DATE', 'DIGITAL_RELEASE_DATE', 'ORIGINAL_RELEASE_DATE',
  'COPYRIGHT', 'GENRE_ID', 'ALB_GENRE_ID'
] as const

const hasValue = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== '0'

/**
 * Re-apply the requested album's release-level fields onto a substituted track.
 * Returns a COPY: track records come out of deezerAuth's cache, and pinning the
 * cached object would mislabel the alternate if it is later downloaded on its own
 * release. `leaked` lists descriptor fields that had to stay the alternate's
 * because the requested track carried no value.
 */
export function pinReleaseFields(
  resolved: any,
  requested: any,
  ctx: AlbumContext | undefined
): { info: any; leaked: string[] } {
  const leaked: string[] = []
  if (!resolved) return { info: resolved, leaked }
  resolved = { ...resolved }
  if (!ctx || !requested) return { info: resolved, leaked }

  for (const f of RELEASE_IDENTITY_FIELDS) resolved[f] = requested[f]
  if (hasValue(ctx.albumId)) resolved.ALB_ID = ctx.albumId
  if (hasValue(ctx.albumTitle)) resolved.ALB_TITLE = ctx.albumTitle

  for (const f of RELEASE_DESCRIPTOR_FIELDS) {
    if (hasValue(requested[f])) resolved[f] = requested[f]
    else if (hasValue(resolved[f])) leaked.push(f)
  }
  // The album-level cover hash is the most reliable source: it does not depend
  // on what the rights-locked track record happened to include.
  if (hasValue(ctx.coverMd5)) {
    resolved.ALB_PICTURE = ctx.coverMd5
    const i = leaked.indexOf('ALB_PICTURE'); if (i >= 0) leaked.splice(i, 1)
  }
  return { info: resolved, leaked }
}
