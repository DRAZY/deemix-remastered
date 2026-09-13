import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Track } from '../types'
import { useSettingsStore } from './settingsStore'

export const usePlayerStore = defineStore('player', () => {
  const currentTrack = ref<Track | null>(null)
  const isPlaying = ref(false)
  const audio = ref<HTMLAudioElement | null>(null)

  const currentTrackId = computed(() => currentTrack.value?.id || null)

  // Qobuz preview clips match Deezer's 30-second samples.
  const QOBUZ_PREVIEW_SECONDS = 30

  async function play(track: Track) {
    const settingsStore = useSettingsStore()

    // If clicking the same track, toggle playback
    if (currentTrack.value?.id === track.id) {
      if (isPlaying.value) {
        stop()
      } else if (audio.value) {
        audio.value.volume = settingsStore.settings.previewVolume / 100
        audio.value.play()
        isPlaying.value = true
      }
      return
    }

    // Stop any existing playback
    stop()

    // Qobuz tracks carry no static preview URL — resolve a signed stream URL
    // from the local server on demand (playback is capped to preview length).
    // Resolved fresh on EVERY play and never cached onto the track: the URLs
    // are short-lived signed links, and a replay through a stale one dies with
    // a silent media error.
    let previewUrl = track.preview
    if ((track as any).source === 'qobuz') {
      previewUrl = undefined
      try {
        const port = window.electronAPI ? await window.electronAPI.getServerPort() : 6595
        const qobuzId = (track as any).qobuzId ?? track.id
        const r = await fetch(`http://127.0.0.1:${port}/api/qobuz/preview?id=${qobuzId}`)
        if (r.ok) {
          const d = await r.json()
          if (d.url) previewUrl = d.url
        }
      } catch { /* no preview available — play() falls through silently */ }
    } else if (previewUrl === undefined) {
      // Deezer list endpoints (favourites import in particular) return slim
      // track objects with no preview field, so rows built from them never
      // had a clip to play (#153). Resolve the full track once on demand and
      // cache the result on the row: Deezer preview links are stable CDN
      // URLs, unlike the signed Qobuz ones above. An empty string from the
      // API means Deezer has no clip for this track; caching that hides the
      // button instead of leaving a control that does nothing.
      try {
        const port = window.electronAPI ? await window.electronAPI.getServerPort() : 6595
        const r = await fetch(`http://127.0.0.1:${port}/api/track?id=${track.id}`)
        if (r.ok) {
          const d = await r.json()
          track.preview = typeof d.preview === 'string' ? d.preview : ''
          previewUrl = track.preview || undefined
        }
      } catch { /* leave preview unresolved; the button stays and retries next click */ }
    }

    // Start new track if it has a preview
    if (previewUrl) {
      currentTrack.value = track
      audio.value = new Audio(previewUrl)

      // Apply preview volume setting
      audio.value.volume = settingsStore.settings.previewVolume / 100

      audio.value.addEventListener('ended', () => {
        isPlaying.value = false
        currentTrack.value = null
      })

      audio.value.addEventListener('error', () => {
        isPlaying.value = false
        currentTrack.value = null
      })

      // Qobuz streams are full-length files, not curated clips — so playing
      // from 0:00 samples the intro (often a quiet fade-in), unlike Deezer's
      // editor-picked mid-song excerpts. Seek to a representative point (~25%
      // in, capped at 60s) before playing, then cap the window at 30s. Short
      // tracks (<45s) just play from the top. The CDN supports range requests,
      // so the seek costs one ranged fetch, not a full download.
      if ((track as any).source === 'qobuz') {
        let previewStart = 0
        const audioEl = audio.value
        audioEl.addEventListener('loadedmetadata', () => {
          const d = audioEl.duration
          if (isFinite(d) && d > 45) {
            previewStart = Math.min(d * 0.25, 60)
            audioEl.currentTime = previewStart
          }
        })
        audioEl.addEventListener('timeupdate', () => {
          if (audio.value && audio.value.currentTime >= previewStart + QOBUZ_PREVIEW_SECONDS) {
            stop()
          }
        })
      }

      audio.value.play()
      isPlaying.value = true
    }
  }

  function stop() {
    if (audio.value) {
      audio.value.pause()
      audio.value.currentTime = 0
      audio.value = null
    }
    isPlaying.value = false
    currentTrack.value = null
  }

  function isTrackPlaying(trackId: number | string): boolean {
    return isPlaying.value && currentTrack.value?.id === trackId
  }

  return {
    currentTrack,
    isPlaying,
    currentTrackId,
    play,
    stop,
    isTrackPlaying
  }
})
