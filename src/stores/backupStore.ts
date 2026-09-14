// Backup & Restore store — issue #72.
//
// Centralises the assembly + parse + apply logic for the unified deemix-backup
// file. Each segment is opt-in/opt-out on both export and restore so users
// can do partial restores (e.g., "just my favourites, keep current settings").
//
// File shape — versioned, with each segment either populated or null so the
// restore-side preview can show what's actually present:
//
//   {
//     type: 'deemix-backup',
//     version: 1,
//     exportedAt: '2026-05-22T...',
//     appVersion: '1.7.6',
//     segments: { settings, profiles, syncedPlaylists, syncedArtists,
//                 favourites, credentials }
//   }
//
// Legacy `deemix-configuration` files still parse via a fallback branch in
// parseBackup so existing exports keep working.

import { defineStore } from 'pinia'
import { readFavorites, writeFavorites } from '../utils/favoritesStorage'
import { ref } from 'vue'
import { useSettingsStore, type Settings } from './settingsStore'
import { useProfileStore, type SettingsProfile } from './profileStore'
import type { SyncedPlaylist } from './syncStore'
import type { SyncedArtist } from './artistSyncStore'

export type SegmentKey =
  | 'settings'
  | 'profiles'
  | 'syncedPlaylists'
  | 'syncedArtists'
  | 'favourites'
  | 'credentials'

export interface SelectedSegments {
  settings: boolean
  profiles: boolean
  syncedPlaylists: boolean
  syncedArtists: boolean
  favourites: boolean
  credentials: boolean
  // v1.8.0 — when profiles=true AND profileIds is a non-null array, only the
  // listed profile ids are exported/restored. null or undefined = include all
  // (preserves v1.7.9 behavior; v1.7.9 backup files have no field here).
  profileIds?: string[] | null
}

// Qobuz is deliberately ABSENT from this bundle: the Qobuz session token lives
// only in OS secure storage and is never written to backup files, even with the
// Credentials segment opted in. After restoring on a new machine, reconnect
// Qobuz in Settings.
export interface CredentialBundle {
  arl?: string
  spotifyClientId?: string
  spotifyClientSecret?: string
  spotifyUsername?: string
}

export interface BackupSegments {
  settings: Settings | null
  profiles: SettingsProfile[] | null
  syncedPlaylists: SyncedPlaylist[] | null
  syncedArtists: SyncedArtist[] | null
  favourites: any[] | null
  credentials: CredentialBundle | null
}

export interface BackupFile {
  type: 'deemix-backup'
  version: 1
  exportedAt: string
  appVersion: string
  segments: BackupSegments
}

export interface SegmentCounts {
  settings: number  // 1 if present, 0 if null
  profiles: number
  syncedPlaylists: number
  syncedArtists: number
  favourites: number
  credentials: number
}

export interface ApplyResult {
  settings: 'ok' | 'skipped' | 'error'
  profiles: 'ok' | 'skipped' | 'error'
  syncedPlaylists: 'ok' | 'skipped' | 'error'
  syncedArtists: 'ok' | 'skipped' | 'error'
  favourites: 'ok' | 'skipped' | 'error'
  credentials: 'ok' | 'skipped' | 'error'
  errors: Partial<Record<SegmentKey, string>>
}

// Fallback only — buildBackup asks the main process for the real version so
// backup files stamp correctly without a hardcoded constant going stale.
const BACKUP_APP_VERSION = '2.1.0'

export const useBackupStore = defineStore('backup', () => {
  const isBusy = ref(false)
  const lastBackupAt = ref<string | null>(localStorage.getItem('deemix.lastBackupAt'))

  // Build a backup file containing only the selected segments. Segments not
  // selected are stored as `null` so the restore-side preview can still tell
  // what's missing from the file.
  async function buildBackup(selected: SelectedSegments): Promise<BackupFile> {
    isBusy.value = true
    try {
      const settingsStore = useSettingsStore()
      const profileStore = useProfileStore()
      const serverPort = await getServerPort()

      const segments: BackupSegments = {
        settings: null,
        profiles: null,
        syncedPlaylists: null,
        syncedArtists: null,
        favourites: null,
        credentials: null
      }

      if (selected.settings) {
        // Strip credentials from the settings blob — Deezer/Spotify live in
        // their own opt-in segment; the Qobuz session is NEVER written to a
        // backup file (secure storage only — reconnect after restore).
        const s = {
          ...settingsStore.settings,
          arl: '', spotifyClientId: '', spotifyClientSecret: '', spotifyUsername: '',
          qobuzToken: '', qobuzUserId: ''
        }
        segments.settings = s as Settings
      }

      if (selected.profiles) {
        // Only export user-created profiles (built-ins are recreated by the
        // app on next launch anyway, and including them just adds noise).
        // v1.8.0: optionally filter to a subset by id (per-profile picker).
        const allCustom = profileStore.profiles.filter(p => !p.isBuiltIn)
        if (Array.isArray(selected.profileIds)) {
          const idSet = new Set(selected.profileIds)
          segments.profiles = allCustom.filter(p => idSet.has(p.id))
        } else {
          segments.profiles = allCustom
        }
      }

      if (selected.syncedPlaylists) {
        const r = await fetch(`http://127.0.0.1:${serverPort}/api/sync/playlists`)
        if (r.ok) {
          const data = await r.json()
          segments.syncedPlaylists = Array.isArray(data.playlists) ? data.playlists : []
        } else {
          segments.syncedPlaylists = []
        }
      }

      if (selected.syncedArtists) {
        const r = await fetch(`http://127.0.0.1:${serverPort}/api/sync/artists`)
        if (r.ok) {
          const data = await r.json()
          segments.syncedArtists = Array.isArray(data.artists) ? data.artists : []
        } else {
          segments.syncedArtists = []
        }
      }

      if (selected.favourites) {
        try {
          segments.favourites = (await readFavorites()) ?? []
        } catch {
          segments.favourites = []
        }
      }

      if (selected.credentials) {
        // Pull credentials from the live settings store rather than localStorage
        // so secure-storage-decrypted ARL is the value we actually use today.
        const s = settingsStore.settings
        segments.credentials = {
          arl: s.arl || '',
          spotifyClientId: s.spotifyClientId || '',
          spotifyClientSecret: s.spotifyClientSecret || '',
          spotifyUsername: s.spotifyUsername || ''
        }
      }

      let appVersion = BACKUP_APP_VERSION
      if (window.electronAPI?.getVersion) {
        try { appVersion = await window.electronAPI.getVersion() } catch { /* keep fallback */ }
      }
      const file: BackupFile = {
        type: 'deemix-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        appVersion,
        segments
      }

      // Stash a hint so a future "you haven't backed up in N days" banner has
      // a hook (reserved per ISA decision; banner itself is out of scope for v1.7.6).
      lastBackupAt.value = file.exportedAt
      try { localStorage.setItem('deemix.lastBackupAt', file.exportedAt) } catch { /* ignore */ }

      return file
    } finally {
      isBusy.value = false
    }
  }

  // Validate + parse a backup file string. Falls back to the legacy
  // deemix-configuration format so old exports still load (#72 keeps
  // backward compatibility with v1.7.5 export files).
  function parseBackup(text: string): { ok: true; file: BackupFile; counts: SegmentCounts } | { ok: false; error: string } {
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, error: 'File is not valid JSON.' }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'File is not a recognised backup.' }
    }

    // New format
    if (parsed.type === 'deemix-backup' && parsed.segments && typeof parsed.segments === 'object') {
      const segments = parsed.segments
      const file: BackupFile = {
        type: 'deemix-backup',
        version: parsed.version === 1 ? 1 : 1,
        exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : 'unknown',
        segments: {
          settings: segments.settings ?? null,
          profiles: Array.isArray(segments.profiles) ? segments.profiles : null,
          syncedPlaylists: Array.isArray(segments.syncedPlaylists) ? segments.syncedPlaylists : null,
          syncedArtists: Array.isArray(segments.syncedArtists) ? segments.syncedArtists : null,
          favourites: Array.isArray(segments.favourites) ? segments.favourites : null,
          credentials: segments.credentials && typeof segments.credentials === 'object' ? segments.credentials : null
        }
      }
      return { ok: true, file, counts: countSegments(file) }
    }

    // Legacy deemix-configuration fallback (v1.7.5 and earlier export format).
    // Maps onto the new shape so the rest of the pipeline doesn't care.
    if (parsed.type === 'deemix-configuration' && parsed.settings) {
      const file: BackupFile = {
        type: 'deemix-backup',
        version: 1,
        exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
        appVersion: 'legacy (deemix-configuration)',
        segments: {
          settings: parsed.settings,
          profiles: Array.isArray(parsed.profiles) ? parsed.profiles : null,
          syncedPlaylists: null,
          syncedArtists: null,
          favourites: null,
          credentials: null
        }
      }
      return { ok: true, file, counts: countSegments(file) }
    }

    return { ok: false, error: 'File is not a recognised backup or configuration export.' }
  }

  function countSegments(file: BackupFile): SegmentCounts {
    return {
      settings: file.segments.settings ? 1 : 0,
      profiles: file.segments.profiles?.length ?? 0,
      syncedPlaylists: file.segments.syncedPlaylists?.length ?? 0,
      syncedArtists: file.segments.syncedArtists?.length ?? 0,
      favourites: file.segments.favourites?.length ?? 0,
      credentials: file.segments.credentials ? 1 : 0
    }
  }

  // Apply a parsed backup, restoring only the selected segments. Each segment
  // applies independently; one failure does not block the others. Returns a
  // per-segment status report for the toast.
  async function applyBackup(file: BackupFile, selected: SelectedSegments): Promise<ApplyResult> {
    isBusy.value = true
    const result: ApplyResult = {
      settings: 'skipped',
      profiles: 'skipped',
      syncedPlaylists: 'skipped',
      syncedArtists: 'skipped',
      favourites: 'skipped',
      credentials: 'skipped',
      errors: {}
    }
    try {
      const settingsStore = useSettingsStore()
      const profileStore = useProfileStore()
      const serverPort = await getServerPort()

      if (selected.settings && file.segments.settings) {
        try {
          // Reuse the legacy importer's credential-preservation semantics: import
          // settings WITHOUT touching credential fields. The Credentials segment
          // handles credentials separately so the two checkboxes don't fight.
          const incoming = { ...file.segments.settings } as any
          delete incoming.arl
          delete incoming.spotifyClientId
          delete incoming.spotifyClientSecret
          delete incoming.spotifyUsername
          // A foreign/legacy file must never blank or inject the live Qobuz
          // session (importSettings also guards this — defense in depth).
          delete incoming.qobuzToken
          delete incoming.qobuzUserId
          const ok = settingsStore.importSettings(JSON.stringify(incoming))
          result.settings = ok ? 'ok' : 'error'
          if (!ok) result.errors.settings = 'Settings format not recognised'
        } catch (e: any) {
          result.settings = 'error'
          result.errors.settings = e?.message || 'Settings restore failed'
        }
      }

      if (selected.profiles && file.segments.profiles) {
        try {
          // v1.8.0: if the user picked a subset in the Restore preview, narrow
          // the incoming array to just those ids before deduping. Matched on
          // file-side id since that's what the picker checkboxes bind to.
          let incoming = file.segments.profiles
          if (Array.isArray(selected.profileIds)) {
            const idSet = new Set(selected.profileIds)
            incoming = incoming.filter(p => idSet.has(p.id))
          }
          // Dedup by name: custom-name match overwrites in place, built-in
          // name match falls back to a "(Restored)" suffix. saveProfiles fires
          // once at the end of the pass (not per-iteration).
          profileStore.applyBackupProfiles(incoming)
          result.profiles = 'ok'
        } catch (e: any) {
          result.profiles = 'error'
          result.errors.profiles = e?.message || 'Profiles restore failed'
        }
      }

      if (selected.syncedPlaylists && file.segments.syncedPlaylists) {
        try {
          const r = await fetch(`http://127.0.0.1:${serverPort}/api/sync/playlists/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlists: file.segments.syncedPlaylists })
          })
          if (r.ok) {
            result.syncedPlaylists = 'ok'
          } else {
            result.syncedPlaylists = 'error'
            const err = await r.json().catch(() => ({}))
            result.errors.syncedPlaylists = err.error || `Server returned ${r.status}`
          }
        } catch (e: any) {
          result.syncedPlaylists = 'error'
          result.errors.syncedPlaylists = e?.message || 'Playlist sync restore failed'
        }
      }

      if (selected.syncedArtists && file.segments.syncedArtists) {
        try {
          const r = await fetch(`http://127.0.0.1:${serverPort}/api/sync/artists/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ artists: file.segments.syncedArtists })
          })
          if (r.ok) {
            result.syncedArtists = 'ok'
          } else {
            result.syncedArtists = 'error'
            const err = await r.json().catch(() => ({}))
            result.errors.syncedArtists = err.error || `Server returned ${r.status}`
          }
        } catch (e: any) {
          result.syncedArtists = 'error'
          result.errors.syncedArtists = e?.message || 'Artist sync restore failed'
        }
      }

      if (selected.favourites && file.segments.favourites) {
        try {
          await writeFavorites(file.segments.favourites)
          result.favourites = 'ok'
        } catch (e: any) {
          result.favourites = 'error'
          result.errors.favourites = e?.message || 'Favourites restore failed'
        }
      }

      if (selected.credentials && file.segments.credentials) {
        try {
          const c = file.segments.credentials
          // Push into the live settings store so the existing watcher saves
          // each field through its own secure-storage path.
          if (typeof c.arl === 'string') settingsStore.settings.arl = c.arl
          if (typeof c.spotifyClientId === 'string') settingsStore.settings.spotifyClientId = c.spotifyClientId
          if (typeof c.spotifyClientSecret === 'string') settingsStore.settings.spotifyClientSecret = c.spotifyClientSecret
          if (typeof c.spotifyUsername === 'string') settingsStore.settings.spotifyUsername = c.spotifyUsername
          result.credentials = 'ok'
        } catch (e: any) {
          result.credentials = 'error'
          result.errors.credentials = e?.message || 'Credentials restore failed'
        }
      }

      return result
    } finally {
      isBusy.value = false
    }
  }

  // Helper — same port-discovery pattern as syncStore/artistSyncStore.
  async function getServerPort(): Promise<number> {
    if (window.electronAPI?.getServerPort) {
      try { return await window.electronAPI.getServerPort() } catch { /* fall through */ }
    }
    return 6595
  }

  return {
    isBusy,
    lastBackupAt,
    buildBackup,
    parseBackup,
    applyBackup
  }
})
