/**
 * Public web addresses for things the app can download, rebuilt from the id
 * and the service that owns it. Used by the Copy Link context-menu entries
 * (#150): a playlist, album or track in the rack or on its own page can be
 * copied back out as the URL you would paste into a browser or Link Analyzer.
 */
export type LinkKind = 'track' | 'album' | 'playlist'

export function publicLink(
  kind: LinkKind,
  id: string | number | null | undefined,
  source?: string | null
): string | null {
  if (id == null || id === '') return null
  const s = String(id)
  if (source === 'qobuz') return `https://open.qobuz.com/${kind}/${s}`
  // Deezer ids are numeric. A non-numeric id with no source flag is a Qobuz
  // id that lost its marker somewhere; better no link than a wrong one.
  if (!/^\d+$/.test(s)) return null
  return `https://www.deezer.com/${kind}/${s}`
}

/** Link for a Downloads-rack row, whichever of track/album/playlist it carries. */
export function publicLinkForItem(item: {
  type?: string
  source?: string
  track?: any
  album?: any
  playlist?: any
}): string | null {
  if (item.type === 'track' && item.track) {
    return publicLink('track', item.track.qobuzId ?? item.track.id, item.source ?? item.track.source)
  }
  if (item.type === 'album' && item.album) {
    const a = item.album
    // Qobuz "albums" in the rack can really be Qobuz playlists (qobuzType).
    const kind: LinkKind = a.qobuzType === 'playlist' ? 'playlist' : 'album'
    return publicLink(kind, a.qobuzId ?? a.id, item.source ?? a.source)
  }
  if (item.type === 'playlist' && item.playlist) {
    const p = item.playlist
    return publicLink('playlist', p.qobuzId ?? p.id, item.source ?? p.source)
  }
  return null
}
