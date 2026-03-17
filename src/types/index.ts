export interface Track {
  id: number | string
  title: string
  title_short?: string
  artist: Artist
  album?: Album
  duration: number
  preview?: string
  link?: string
  cover?: string
  explicit_lyrics?: boolean
  rank?: number
  readable?: boolean
  contributors?: Array<{
    id?: number
    name?: string
    role?: string
  }>
}

export interface Album {
  id: number | string
  title: string
  cover?: string
  cover_small?: string
  cover_medium?: string
  cover_big?: string
  cover_xl?: string
  artist?: Artist
  tracks?: { data: Track[] }
  nb_tracks?: number
  duration?: number
  release_date?: string
  record_type?: string
  explicit_lyrics?: boolean
  link?: string
}

export interface Artist {
  id: number | string
  name: string
  picture?: string
  picture_small?: string
  picture_medium?: string
  picture_big?: string
  picture_xl?: string
  nb_album?: number
  nb_fan?: number
  link?: string
}

export interface Playlist {
  id: number | string
  title: string
  description?: string
  picture?: string
  picture_small?: string
  picture_medium?: string
  picture_big?: string
  picture_xl?: string
  creator?: {
    id: number
    name: string
  }
  nb_tracks?: number
  duration?: number
  public?: boolean
  link?: string
  tracks?: { data: Track[] }
}

export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'error' | 'paused'

// Detailed error information for better diagnostics
export interface ErrorDetails {
  message: string                    // Human-readable error message
  code?: string                      // Error code (e.g., 'TRACK_UNAVAILABLE', 'GEO_RESTRICTED')
  httpStatus?: number               // HTTP status code if applicable
  serverResponse?: string           // Raw server response for debugging
  timestamp?: string                // When the error occurred
  trackId?: string | number         // Associated track ID
  suggestion?: string               // Suggestion for user action
}

export interface FailedTrack {
  id: string
  trackId?: string | number  // Deezer track ID for lookup
  title: string
  artist?: string
  albumTitle?: string
  error?: string
  errorDetails?: ErrorDetails       // Enhanced error information
}

export interface DownloadItem {
  id: string
  track?: Track
  album?: Album
  playlist?: Playlist
  title: string
  artist?: string
  cover?: string
  progress: number
  status: DownloadStatus
  type: 'track' | 'album' | 'playlist'
  path?: string
  error?: string
  errorDetails?: ErrorDetails       // Enhanced error information
  addedAt: string
  quality?: '128' | '320' | 'flac'  // Quality at time of download (requested)
  actualFormat?: string             // Actual downloaded format (may differ due to fallback)
  // For album/playlist downloads
  totalTracks?: number
  completedTracks?: number
  failedTracks?: FailedTrack[]
  trackIds?: string[]  // Server-side download IDs for individual tracks
  // Batch download context (for retry of converted Spotify playlists)
  batchConfig?: {
    trackIds: number[]
    playlistName: string
    cover?: string
  }
  // Speed tracking
  speed?: number        // Bytes per second (if server provides it)
  bytesDownloaded?: number
  totalBytes?: number
}

export interface SearchResults {
  tracks: Track[]
  albums: Album[]
  artists: Artist[]
  playlists: Playlist[]
}

export interface DeezerAPIResponse<T> {
  data: T[]
  total?: number
  prev?: string
  next?: string
}
