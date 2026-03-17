import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useSettingsStore, defaultSettings, deepMerge, type Settings } from './settingsStore'

// Profile settings exclude credentials, appearance, and personal preferences
type ProfileSettingsKeys =
  | 'downloadPath' | 'quality' | 'maxConcurrentDownloads'
  | 'overwriteFiles' | 'bitrateFallback' | 'searchFallback' | 'isrcFallback'
  | 'createErrorLog' | 'createSearchLog' | 'gambleCDNs' | 'createLrcFiles'
  | 'createPlaylistFile' | 'clearQueueOnClose'
  | 'createPlaylistFolder' | 'createArtistFolder' | 'createAlbumFolder'
  | 'createCDFolder' | 'createPlaylistStructure' | 'createSinglesStructure'
  | 'playlistFolderTemplate' | 'albumFolderTemplate' | 'artistFolderTemplate'
  | 'trackNameTemplate' | 'albumTrackTemplate' | 'playlistTrackTemplate'
  | 'saveArtwork' | 'embedArtwork' | 'artworkSize' | 'saveLyrics' | 'syncedLyrics'
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
  'downloadPath', 'quality', 'maxConcurrentDownloads',
  'overwriteFiles', 'bitrateFallback', 'searchFallback', 'isrcFallback',
  'createErrorLog', 'createSearchLog', 'gambleCDNs', 'createLrcFiles',
  'createPlaylistFile', 'clearQueueOnClose',
  'createPlaylistFolder', 'createArtistFolder', 'createAlbumFolder',
  'createCDFolder', 'createPlaylistStructure', 'createSinglesStructure',
  'playlistFolderTemplate', 'albumFolderTemplate', 'artistFolderTemplate',
  'trackNameTemplate', 'albumTrackTemplate', 'playlistTrackTemplate',
  'saveArtwork', 'embedArtwork', 'artworkSize', 'saveLyrics', 'syncedLyrics',
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
      artworkSize: 1400,
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
        bpm: true, replayGain: true, albumLabel: true,
        unsyncLyrics: true, syncLyrics: true, copyright: true,
        composer: true, involvedPeople: true, sourceId: true
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
      artworkSize: 500,
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
        composer: false, involvedPeople: false, sourceId: false
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
    const data = {
      profiles: profiles.value.filter(p => !p.isBuiltIn),
      activeProfileId: activeProfileId.value
    }
    if (window.electronAPI?.storage) {
      try {
        await (window.electronAPI.storage as any).saveProfiles(data)
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
    merged.spotifyFallbackSearch = settingsStore.settings.spotifyFallbackSearch
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
    resetToProfile
  }
})
