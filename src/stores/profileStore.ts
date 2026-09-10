import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useSettingsStore, defaultSettings, deepMerge, type Settings } from './settingsStore'

// Profile settings exclude credentials, appearance, and personal preferences
type ProfileSettingsKeys =
  | 'downloadPath' | 'quality' | 'maxConcurrentDownloads' | 'downloadPacing'
  | 'overwriteFiles' | 'bitrateFallback' | 'isrcFallback'
  | 'createErrorLog'
  | 'createPlaylistFile' | 'createAlbumPlaylistFile' | 'clearQueueOnClose'
  | 'createPlaylistFolder' | 'createArtistFolder' | 'createAlbumFolder'
  | 'createCDFolder' | 'createPlaylistStructure' | 'createSinglesStructure'
  | 'createShortReleaseFolder'
  | 'playlistFolderTemplate' | 'albumFolderTemplate' | 'artistFolderTemplate'
  | 'trackNameTemplate' | 'albumTrackTemplate' | 'playlistTrackTemplate'
  | 'saveArtwork' | 'embedArtwork' | 'saveLyrics' | 'syncedLyrics' | 'preferSyncedLyrics'
  | 'tags' | 'albumCovers'
  | 'savePlaylistAsCompilation' | 'useNullSeparator' | 'saveID3v1'
  | 'saveOnlyMainArtist' | 'keepVariousArtists' | 'removeAlbumVersion'
  | 'removeArtistCombinations' | 'artistSeparator' | 'dateFormatFlac'
  | 'featuredArtistsHandling' | 'titleCasing' | 'artistCasing'

export type ProfileSettings = Pick<Settings, ProfileSettingsKeys>

export interface SettingsProfile {
  id: string
  name: string
  description: string
  isBuiltIn: boolean
  createdAt: string
  updatedAt: string
  settings: ProfileSettings
}

const PROFILE_SETTINGS_KEYS: ProfileSettingsKeys[] = [
  'downloadPath', 'quality', 'maxConcurrentDownloads', 'downloadPacing',
  'overwriteFiles', 'bitrateFallback', 'isrcFallback',
  'createErrorLog',
  'createPlaylistFile', 'createAlbumPlaylistFile', 'clearQueueOnClose',
  'createPlaylistFolder', 'createArtistFolder', 'createAlbumFolder',
  'createCDFolder', 'createPlaylistStructure', 'createSinglesStructure',
  'createShortReleaseFolder',
  'playlistFolderTemplate', 'albumFolderTemplate', 'artistFolderTemplate',
  'trackNameTemplate', 'albumTrackTemplate', 'playlistTrackTemplate',
  'saveArtwork', 'embedArtwork', 'saveLyrics', 'syncedLyrics', 'preferSyncedLyrics',
  'tags', 'albumCovers',
  'savePlaylistAsCompilation', 'useNullSeparator', 'saveID3v1',
  'saveOnlyMainArtist', 'keepVariousArtists', 'removeAlbumVersion',
  'removeArtistCombinations', 'artistSeparator', 'dateFormatFlac',
  'featuredArtistsHandling', 'titleCasing', 'artistCasing'
]

function extractProfileSettings(settings: Settings): ProfileSettings {
  const result: any = {}
  for (const key of PROFILE_SETTINGS_KEYS) {
    result[key] = JSON.parse(JSON.stringify(settings[key]))
  }
  return result as ProfileSettings
}

function generateId(): string {
  return `profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// Built-in presets
const BUILT_IN_PROFILES: SettingsProfile[] = [
  {
    id: 'builtin_audiophile',
    name: 'Audiophile',
    description: 'FLAC lossless, all metadata tags, high-res artwork, synced lyrics',
    isBuiltIn: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    settings: {
      ...extractProfileSettings(defaultSettings),
      quality: 'flac',
      saveArtwork: true,
      embedArtwork: true,
      saveLyrics: true,
      syncedLyrics: true,
      createArtistFolder: true,
      createAlbumFolder: true,
      createCDFolder: true,
      saveID3v1: true,
      tags: {
        title: true, artist: true, album: true, cover: true,
        trackNumber: true, trackTotal: true, discNumber: true, discTotal: true,
        albumArtist: true, genre: true, year: true, date: true,
        explicitLyrics: true, isrc: true, trackLength: true, albumBarcode: true,
        bpm: true, replayGain: false, albumLabel: true,
        unsyncLyrics: true, syncLyrics: true, copyright: true,
        composer: true, involvedPeople: true, sourceId: true, releaseType: true
      },
      albumCovers: {
        saveCovers: true,
        coverNameTemplate: 'cover',
        saveArtistImage: true,
        localArtworkSize: 1400,
        embeddedArtworkSize: 1200,
        localArtworkFormat: 'png',
        saveEmbeddedArtworkAsPNG: true,
        coverDescriptionUTF8: true,
        jpegImageQuality: 100
      }
    }
  },
  {
    id: 'builtin_quick',
    name: 'Quick Download',
    description: 'MP3 128kbps, minimal tags, small artwork, fastest downloads',
    isBuiltIn: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    settings: {
      ...extractProfileSettings(defaultSettings),
      quality: '128',
      saveArtwork: false,
      embedArtwork: true,
      saveLyrics: false,
      syncedLyrics: false,
      createArtistFolder: false,
      createAlbumFolder: false,
      createCDFolder: false,
      saveID3v1: false,
      tags: {
        title: true, artist: true, album: true, cover: true,
        trackNumber: true, trackTotal: false, discNumber: false, discTotal: false,
        albumArtist: false, genre: false, year: false, date: false,
        explicitLyrics: false, isrc: false, trackLength: false, albumBarcode: false,
        bpm: false, replayGain: false, albumLabel: false,
        unsyncLyrics: false, syncLyrics: false, copyright: false,
        composer: false, involvedPeople: false, sourceId: false, releaseType: false
      },
      albumCovers: {
        saveCovers: false,
        coverNameTemplate: 'cover',
        saveArtistImage: false,
        localArtworkSize: 500,
        embeddedArtworkSize: 500,
        localArtworkFormat: 'jpeg',
        saveEmbeddedArtworkAsPNG: false,
        coverDescriptionUTF8: false,
        jpegImageQuality: 80
      }
    }
  },
  {
    id: 'builtin_balanced',
    name: 'Balanced',
    description: 'MP3 320kbps, standard metadata, good quality artwork',
    isBuiltIn: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    settings: extractProfileSettings(defaultSettings)
  }
]

export const useProfileStore = defineStore('profiles', () => {
  const profiles = ref<SettingsProfile[]>([...BUILT_IN_PROFILES])
  const activeProfileId = ref<string | null>(null)
  const isLoaded = ref(false)

  const activeProfile = computed(() =>
    activeProfileId.value ? profiles.value.find(p => p.id === activeProfileId.value) ?? null : null
  )

  const customProfiles = computed(() =>
    profiles.value.filter(p => !p.isBuiltIn)
  )

  const builtInProfiles = computed(() =>
    profiles.value.filter(p => p.isBuiltIn)
  )

  const isModified = computed(() => {
    if (!activeProfileId.value) return false
    const profile = activeProfile.value
    if (!profile) return false
    const settingsStore = useSettingsStore()
    const currentProfileSettings = extractProfileSettings(settingsStore.settings)
    return JSON.stringify(currentProfileSettings) !== JSON.stringify(profile.settings)
  })

  async function loadProfiles() {
    if (window.electronAPI?.storage) {
      try {
        const result = await (window.electronAPI.storage as any).loadProfiles()
        if (result.success && result.data) {
          const saved = result.data
          // Merge saved custom profiles with built-in ones
          const customSaved = (saved.profiles || []).filter((p: SettingsProfile) => !p.isBuiltIn)
          profiles.value = [...BUILT_IN_PROFILES, ...customSaved]
          activeProfileId.value = saved.activeProfileId || null
        }
      } catch (e) {
        console.error('[Profiles] Failed to load:', e)
      }
    }
    isLoaded.value = true
  }

  async function saveProfiles() {
    if (!isLoaded.value) return
    // JSON round-trip strips Vue reactive proxies — required for IPC structured clone
    const data = JSON.parse(JSON.stringify({
      profiles: profiles.value.filter(p => !p.isBuiltIn),
      activeProfileId: activeProfileId.value
    }))
    if (window.electronAPI?.storage) {
      try {
        await (window.electronAPI.storage as any).saveProfiles(data)
        console.log('[Profiles] Saved', data.profiles.length, 'custom profiles')
      } catch (e) {
        console.error('[Profiles] Failed to save:', e)
      }
    }
  }

  function applyProfile(id: string) {
    const profile = profiles.value.find(p => p.id === id)
    if (!profile) return

    const settingsStore = useSettingsStore()
    const merged = deepMerge(settingsStore.settings, profile.settings as Partial<Settings>)
    // Preserve credentials and personal prefs
    merged.arl = settingsStore.settings.arl
    merged.spotifyClientId = settingsStore.settings.spotifyClientId
    merged.spotifyClientSecret = settingsStore.settings.spotifyClientSecret
    merged.spotifyUsername = settingsStore.settings.spotifyUsername
    merged.theme = settingsStore.settings.theme
    merged.colorTheme = settingsStore.settings.colorTheme
    merged.language = settingsStore.settings.language
    merged.appearance = settingsStore.settings.appearance
    merged.previewVolume = settingsStore.settings.previewVolume
    merged.checkForUpdates = settingsStore.settings.checkForUpdates

    settingsStore.settings = merged
    activeProfileId.value = id
    settingsStore.saveSettings()
    saveProfiles()
  }

  function saveCurrentAsProfile(name: string, description: string = '') {
    const settingsStore = useSettingsStore()
    const profile: SettingsProfile = {
      id: generateId(),
      name,
      description,
      isBuiltIn: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: extractProfileSettings(settingsStore.settings)
    }
    profiles.value.push(profile)
    activeProfileId.value = profile.id
    saveProfiles()
    return profile
  }

  function deleteProfile(id: string) {
    const profile = profiles.value.find(p => p.id === id)
    if (!profile || profile.isBuiltIn) return
    profiles.value = profiles.value.filter(p => p.id !== id)
    if (activeProfileId.value === id) {
      activeProfileId.value = null
    }
    saveProfiles()
  }

  function duplicateProfile(id: string) {
    const source = profiles.value.find(p => p.id === id)
    if (!source) return null
    const profile: SettingsProfile = {
      id: generateId(),
      name: `${source.name} (Copy)`,
      description: source.description,
      isBuiltIn: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: JSON.parse(JSON.stringify(source.settings))
    }
    profiles.value.push(profile)
    saveProfiles()
    return profile
  }

  function renameProfile(id: string, name: string, description?: string) {
    const profile = profiles.value.find(p => p.id === id)
    if (!profile || profile.isBuiltIn) return
    profile.name = name
    if (description !== undefined) profile.description = description
    profile.updatedAt = new Date().toISOString()
    saveProfiles()
  }

  function exportProfile(id: string): string | null {
    const profile = profiles.value.find(p => p.id === id)
    if (!profile) return null
    const exportData = {
      type: 'deemix-profile',
      version: 1,
      profile: {
        name: profile.name,
        description: profile.description,
        settings: profile.settings
      }
    }
    return JSON.stringify(exportData, null, 2)
  }

  function importProfile(jsonString: string): SettingsProfile | null {
    try {
      const data = JSON.parse(jsonString)
      if (data.type !== 'deemix-profile' || !data.profile?.settings) {
        console.error('[Profiles] Invalid profile format')
        return null
      }
      const imported = data.profile
      const profile: SettingsProfile = {
        id: generateId(),
        name: imported.name || 'Imported Profile',
        description: imported.description || '',
        isBuiltIn: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        settings: deepMerge(extractProfileSettings(defaultSettings), imported.settings)
      }
      profiles.value.push(profile)
      saveProfiles()
      return profile
    } catch (e) {
      console.error('[Profiles] Failed to import:', e)
      return null
    }
  }

  // Restore profiles from a backup, deduplicating by name. Custom-name match
  // overwrites in place (preserves id + createdAt; bumps updatedAt). Built-in
  // name match falls back to a "(Restored)" suffix so the immutable preset is
  // not clobbered. saveProfiles is called once after the full pass.
  function applyBackupProfiles(incoming: SettingsProfile[]): { created: number; overwritten: number; renamed: number } {
    const result = { created: 0, overwritten: 0, renamed: 0 }
    if (!Array.isArray(incoming)) return result

    const now = new Date().toISOString()
    const builtInNames = new Set(BUILT_IN_PROFILES.map(p => p.name))

    for (const p of incoming) {
      if (!p || typeof p.name !== 'string' || !p.settings) continue

      const mergedSettings = deepMerge(extractProfileSettings(defaultSettings), p.settings as Partial<ProfileSettings>)
      const existing = profiles.value.find(local => !local.isBuiltIn && local.name === p.name)

      if (existing) {
        existing.settings = mergedSettings
        existing.description = typeof p.description === 'string' ? p.description : existing.description
        existing.updatedAt = now
        result.overwritten++
        continue
      }

      if (builtInNames.has(p.name)) {
        profiles.value.push({
          id: generateId(),
          name: `${p.name} (Restored)`,
          description: typeof p.description === 'string' ? p.description : '',
          isBuiltIn: false,
          createdAt: now,
          updatedAt: now,
          settings: mergedSettings
        })
        result.renamed++
        continue
      }

      profiles.value.push({
        id: generateId(),
        name: p.name,
        description: typeof p.description === 'string' ? p.description : '',
        isBuiltIn: false,
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : now,
        updatedAt: now,
        settings: mergedSettings
      })
      result.created++
    }

    saveProfiles()
    return result
  }

  function resetToProfile() {
    if (activeProfileId.value) {
      applyProfile(activeProfileId.value)
    }
  }

  return {
    profiles,
    activeProfileId,
    activeProfile,
    customProfiles,
    builtInProfiles,
    isModified,
    isLoaded,
    loadProfiles,
    applyProfile,
    saveCurrentAsProfile,
    deleteProfile,
    duplicateProfile,
    renameProfile,
    exportProfile,
    importProfile,
    applyBackupProfiles,
    resetToProfile
  }
})
