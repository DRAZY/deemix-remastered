import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ColorTheme = 'violet' | 'spotify' | 'rose' | 'ocean' | 'sunset' | 'mint' | 'dracula' | 'nord'

export type OverwriteMode = 'no' | 'overwrite' | 'rename'

// Other settings types
export type ArtistSeparator = 'standard' | 'comma' | 'slash' | 'semicolon' | 'ampersand'
export type DateFormat = 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY'
export type FeaturedArtistsHandling = 'nothing' | 'remove' | 'moveToTitle' | 'removeFromTitle'
export type CasingOption = 'unchanged' | 'lowercase' | 'uppercase' | 'titlecase' | 'sentencecase'
export type LocalArtworkFormat = 'jpeg' | 'png' | 'both'

export interface TagSettings {
  title: boolean
  artist: boolean
  album: boolean
  cover: boolean
  trackNumber: boolean
  trackTotal: boolean
  discNumber: boolean
  discTotal: boolean
  albumArtist: boolean
  genre: boolean
  year: boolean
  date: boolean
  explicitLyrics: boolean
  isrc: boolean
  trackLength: boolean
  albumBarcode: boolean
  bpm: boolean
  replayGain: boolean
  albumLabel: boolean
  unsyncLyrics: boolean
  syncLyrics: boolean
  copyright: boolean
  composer: boolean
  involvedPeople: boolean
  sourceId: boolean
}

export interface AppearanceSettings {
  slimDownloadTab: boolean
  slimSidebar: boolean
  showQualityTag: boolean
  showSearchButton: boolean
}

export interface AlbumCoverSettings {
  saveCovers: boolean
  coverNameTemplate: string
  saveArtistImage: boolean
  localArtworkSize: number
  embeddedArtworkSize: number
  localArtworkFormat: LocalArtworkFormat
  saveEmbeddedArtworkAsPNG: boolean
  coverDescriptionUTF8: boolean
  jpegImageQuality: number
}

export interface Settings {
  downloadPath: string
  quality: '128' | '320' | 'flac'
  maxConcurrentDownloads: number
  // Download behavior settings
  overwriteFiles: OverwriteMode
  bitrateFallback: boolean
  searchFallback: boolean
  isrcFallback: boolean
  createErrorLog: boolean
  createSearchLog: boolean
  gambleCDNs: boolean
  createLrcFiles: boolean
  createPlaylistFile: boolean
  clearQueueOnClose: boolean
  // Folder settings
  createPlaylistFolder: boolean
  createArtistFolder: boolean
  createAlbumFolder: boolean
  createCDFolder: boolean
  createPlaylistStructure: boolean
  createSinglesStructure: boolean
  playlistFolderTemplate: string
  albumFolderTemplate: string
  artistFolderTemplate: string
  // Track naming templates
  trackNameTemplate: string
  albumTrackTemplate: string
  playlistTrackTemplate: string
  // File settings
  saveArtwork: boolean
  embedArtwork: boolean
  artworkSize: number
  saveLyrics: boolean
  syncedLyrics: boolean
  // Tag settings
  tags: TagSettings
  // Appearance settings
  appearance: AppearanceSettings
  // Album cover settings
  albumCovers: AlbumCoverSettings
  // Other settings
  checkForUpdates: boolean
  savePlaylistAsCompilation: boolean
  useNullSeparator: boolean
  saveID3v1: boolean
  saveOnlyMainArtist: boolean
  keepVariousArtists: boolean
  removeAlbumVersion: boolean
  removeArtistCombinations: boolean
  artistSeparator: ArtistSeparator
  dateFormatFlac: DateFormat
  featuredArtistsHandling: FeaturedArtistsHandling
  titleCasing: CasingOption
  artistCasing: CasingOption
  previewVolume: number
  // executeAfterDownload removed - security risk (arbitrary command execution)
  theme: 'dark' | 'light' | 'system'
  colorTheme: ColorTheme
  language: string
  arl: string // Deezer ARL token
  // Spotify integration
  spotifyClientId: string
  spotifyClientSecret: string
  spotifyUsername: string
  spotifyFallbackSearch: boolean
}

export const defaultSettings: Settings = {
  downloadPath: '',
  quality: '320',
  maxConcurrentDownloads: 3,
  // Download behavior settings
  overwriteFiles: 'no',
  bitrateFallback: true,
  searchFallback: true,
  isrcFallback: false,
  createErrorLog: true,
  createSearchLog: false,
  gambleCDNs: false,
  createLrcFiles: false,
  createPlaylistFile: false,
  clearQueueOnClose: false,
  // Folder settings
  createPlaylistFolder: true,
  createArtistFolder: false,
  createAlbumFolder: true,
  createCDFolder: true,
  createPlaylistStructure: false,
  createSinglesStructure: false,
  playlistFolderTemplate: '%playlist%',
  albumFolderTemplate: '%artist% - %album%',
  artistFolderTemplate: '%artist%',
  // Track naming templates
  trackNameTemplate: '%artist% - %title%',
  albumTrackTemplate: '%tracknumber% - %title%',
  playlistTrackTemplate: '%position% - %artist% - %title%',
  // File settings
  saveArtwork: true,
  embedArtwork: true,
  artworkSize: 1200,
  saveLyrics: true,
  syncedLyrics: true,
  // Tag settings
  tags: {
    title: true,
    artist: true,
    album: true,
    cover: true,
    trackNumber: true,
    trackTotal: false,
    discNumber: true,
    discTotal: false,
    albumArtist: true,
    genre: true,
    year: true,
    date: true,
    explicitLyrics: false,
    isrc: true,
    trackLength: true,
    albumBarcode: true,
    bpm: true,
    replayGain: false,
    albumLabel: true,
    unsyncLyrics: false,
    syncLyrics: false,
    copyright: false,
    composer: false,
    involvedPeople: false,
    sourceId: false
  },
  // Appearance settings
  appearance: {
    slimDownloadTab: false,
    slimSidebar: false,
    showQualityTag: true,
    showSearchButton: true
  },
  // Album cover settings
  albumCovers: {
    saveCovers: true,
    coverNameTemplate: 'cover',
    saveArtistImage: false,
    localArtworkSize: 1200,
    embeddedArtworkSize: 800,
    localArtworkFormat: 'jpeg',
    saveEmbeddedArtworkAsPNG: false,
    coverDescriptionUTF8: false,
    jpegImageQuality: 90
  },
  // Other settings
  checkForUpdates: true,
  savePlaylistAsCompilation: false,
  useNullSeparator: false,
  saveID3v1: false,
  saveOnlyMainArtist: false,
  keepVariousArtists: true,
  removeAlbumVersion: false,
  removeArtistCombinations: false,
  artistSeparator: 'standard',
  dateFormatFlac: 'YYYY-MM-DD',
  featuredArtistsHandling: 'nothing',
  titleCasing: 'unchanged',
  artistCasing: 'unchanged',
  previewVolume: 80,
  // executeAfterDownload removed - security risk
  theme: 'dark',
  colorTheme: 'violet',
  language: 'en',
  arl: '',
  // Spotify integration
  spotifyClientId: '',
  spotifyClientSecret: '',
  spotifyUsername: '',
  spotifyFallbackSearch: true
}

function applyColorTheme(theme: ColorTheme) {
  document.documentElement.setAttribute('data-theme', theme)
}

function applyThemeMode(theme: 'dark' | 'light' | 'system') {
  let mode: 'dark' | 'light'
  if (theme === 'system') {
    mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } else {
    mode = theme
  }
  document.documentElement.setAttribute('data-mode', mode)
}

// Legacy storage keys (for migration from localStorage)
const LEGACY_ARL_STORAGE_KEY = 'arl_secure'
const LEGACY_SPOTIFY_STORAGE_KEY = 'spotify_secure'
const LEGACY_SETTINGS_KEY = 'settings'

// Deep merge helper to properly merge nested objects (exported for use by profileStore)
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key]) &&
        typeof target[key] === 'object' &&
        target[key] !== null
      ) {
        result[key] = deepMerge(target[key], source[key] as any)
      } else {
        result[key] = source[key] as any
      }
    }
  }
  return result
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({ ...defaultSettings })
  const isLoaded = ref(false)

  async function loadSettings() {
    console.log('[Settings] Loading settings...')
    console.log('[Settings] electronAPI available:', !!window.electronAPI)
    console.log('[Settings] storage API available:', !!window.electronAPI?.storage)

    let loadedSettings: Partial<Settings> | null = null
    let settingsFileExists = false

    // Try to load from Electron's userData storage first (preferred - reliable persistence)
    if (window.electronAPI?.storage) {
      try {
        const result = await window.electronAPI.storage.loadSettings()
        console.log('[Settings] userData result:', result.success, 'hasSettings:', !!result.settings)
        if (result.success && result.settings) {
          loadedSettings = result.settings as Partial<Settings>
          settingsFileExists = true
          console.log('[Settings] Got settings from userData')
        }
      } catch (e) {
        console.error('[Settings] Failed to load from userData:', e)
      }
    }

    // Also check localStorage - use whichever has more data or is newer
    try {
      const localStorageData = localStorage.getItem(LEGACY_SETTINGS_KEY)
      if (localStorageData) {
        const parsed = JSON.parse(localStorageData)
        console.log('[Settings] Found settings in localStorage')

        // If we didn't get userData settings, use localStorage
        if (!loadedSettings) {
          loadedSettings = parsed
          console.log('[Settings] Using localStorage settings')
        }
      }
    } catch (e) {
      console.error('[Settings] Failed to load from localStorage:', e)
    }

    // Apply loaded settings
    if (loadedSettings) {
      settings.value = deepMerge(defaultSettings, loadedSettings)
      settings.value.arl = '' // Don't store ARL in main settings
      settings.value.spotifyClientId = ''
      settings.value.spotifyClientSecret = ''
      settings.value.spotifyUsername = ''
      console.log('[Settings] Applied settings:', {
        downloadPath: settings.value.downloadPath,
        quality: settings.value.quality,
        theme: settings.value.theme,
        colorTheme: settings.value.colorTheme,
        maxConcurrentDownloads: settings.value.maxConcurrentDownloads
      })
    } else {
      console.log('[Settings] No saved settings found, using defaults')
    }

    // Load encrypted credentials separately (from userData or localStorage)
    await loadSecureCredentials()

    // Push Spotify credentials to server so spotifyAPI singleton has them
    if (settings.value.spotifyClientId && settings.value.spotifyClientSecret) {
      try {
        const port = window.electronAPI ? await window.electronAPI.getServerPort() : 6595
        fetch(`http://127.0.0.1:${port}/api/spotify/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: settings.value.spotifyClientId,
            clientSecret: settings.value.spotifyClientSecret
          })
        }).then(() => console.log('[Settings] Spotify credentials pushed to server'))
          .catch(() => {}) // Non-blocking, best-effort
      } catch (e) {
        // Ignore
      }
    }

    // Set default download path
    if (!settings.value.downloadPath) {
      if (window.electronAPI) {
        settings.value.downloadPath = ''
      } else {
        settings.value.downloadPath = '~/Music/Deemix'
      }
    }

    // Apply color theme on load
    applyColorTheme(settings.value.colorTheme)
    applyThemeMode(settings.value.theme)

    isLoaded.value = true
    console.log('[Settings] Settings load complete. ARL loaded:', !!settings.value.arl)

    // CRITICAL: If no settings file existed, create one now with defaults
    // This ensures future saves work and settings persist from the first run
    if (!settingsFileExists) {
      console.log('[Settings] No settings file found, creating initial settings file...')
      await saveSettings()
    }
  }

  async function migrateFromLocalStorage() {
    // Try to load from legacy localStorage
    const saved = localStorage.getItem(LEGACY_SETTINGS_KEY)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        settings.value = deepMerge(defaultSettings, parsed)
        settings.value.arl = ''
        settings.value.spotifyClientId = ''
        settings.value.spotifyClientSecret = ''
        settings.value.spotifyUsername = ''
        console.log('[Settings] Migrated settings from localStorage')

        // Save to userData and clear localStorage
        if (window.electronAPI?.storage) {
          await saveSettings()
          localStorage.removeItem(LEGACY_SETTINGS_KEY)
          console.log('[Settings] Cleared legacy localStorage settings')
        }
      } catch (e) {
        console.error('[Settings] Failed to migrate from localStorage:', e)
      }
    }

    // Also migrate credentials from legacy localStorage
    await migrateLegacyCredentials()
  }

  async function migrateLegacyCredentials() {
    if (!window.electronAPI?.storage) return

    // Migrate ARL
    const legacyArl = localStorage.getItem(LEGACY_ARL_STORAGE_KEY)
    if (legacyArl) {
      try {
        const arlData = JSON.parse(legacyArl)
        let arl = ''
        if (window.electronAPI?.safeStorage && arlData.encrypted) {
          arl = await window.electronAPI.safeStorage.decrypt(arlData.data, arlData.encrypted)
        } else {
          arl = arlData.data
        }
        if (arl) {
          await window.electronAPI.storage.saveCredentials({ arl })
          localStorage.removeItem(LEGACY_ARL_STORAGE_KEY)
          console.log('[Settings] Migrated ARL from localStorage to userData')
        }
      } catch (e) {
        console.error('[Settings] Failed to migrate ARL:', e)
      }
    }

    // Migrate Spotify credentials
    const legacySpotify = localStorage.getItem(LEGACY_SPOTIFY_STORAGE_KEY)
    if (legacySpotify) {
      try {
        const data = JSON.parse(legacySpotify)
        let clientId = ''
        let clientSecret = ''

        if (data.clientId) {
          if (window.electronAPI?.safeStorage && data.clientId.encrypted) {
            clientId = await window.electronAPI.safeStorage.decrypt(data.clientId.data, data.clientId.encrypted)
          } else {
            clientId = data.clientId.data
          }
        }

        if (data.clientSecret) {
          if (window.electronAPI?.safeStorage && data.clientSecret.encrypted) {
            clientSecret = await window.electronAPI.safeStorage.decrypt(data.clientSecret.data, data.clientSecret.encrypted)
          } else {
            clientSecret = data.clientSecret.data
          }
        }

        if (clientId || clientSecret) {
          await window.electronAPI.storage.saveCredentials({
            spotifyClientId: clientId,
            spotifyClientSecret: clientSecret
          })
          localStorage.removeItem(LEGACY_SPOTIFY_STORAGE_KEY)
          console.log('[Settings] Migrated Spotify credentials from localStorage to userData')
        }
      } catch (e) {
        console.error('[Settings] Failed to migrate Spotify credentials:', e)
      }
    }
  }

  async function loadSecureCredentials() {
    console.log('[Settings] Loading credentials...')

    // Try Electron's userData storage first (preferred - reliable persistence)
    if (window.electronAPI?.storage) {
      try {
        const result = await window.electronAPI.storage.loadCredentials()
        console.log('[Settings] loadCredentials result:', result.success, 'hasArl:', !!result.credentials?.arl)
        if (result.success && result.credentials) {
          if (result.credentials.arl) {
            settings.value.arl = result.credentials.arl
            console.log('[Settings] Loaded ARL from userData, length:', result.credentials.arl.length)
          }
          if (result.credentials.spotifyClientId) {
            settings.value.spotifyClientId = result.credentials.spotifyClientId
          }
          if (result.credentials.spotifyClientSecret) {
            settings.value.spotifyClientSecret = result.credentials.spotifyClientSecret
          }
          if (result.credentials.spotifyUsername) {
            settings.value.spotifyUsername = result.credentials.spotifyUsername
          }
          return // Successfully loaded from userData
        }
      } catch (e) {
        console.error('[Settings] Failed to load credentials from userData:', e)
      }
    }

    // Fallback: Try legacy localStorage
    console.log('[Settings] Trying legacy localStorage for credentials...')
    try {
      const legacyArl = localStorage.getItem(LEGACY_ARL_STORAGE_KEY)
      if (legacyArl) {
        const arlData = JSON.parse(legacyArl)
        if (window.electronAPI?.safeStorage && arlData.encrypted) {
          settings.value.arl = await window.electronAPI.safeStorage.decrypt(arlData.data, arlData.encrypted)
        } else {
          settings.value.arl = arlData.data
        }
        console.log('[Settings] Loaded ARL from localStorage fallback')
      }
    } catch (e) {
      console.error('[Settings] Failed to load from localStorage:', e)
    }
  }

  async function saveSecureArl(arl: string) {
    console.log('[Settings] Saving ARL, length:', arl?.length || 0)

    // Try Electron's userData storage first
    if (window.electronAPI?.storage) {
      try {
        const result = await window.electronAPI.storage.saveCredentials({ arl })
        console.log('[Settings] ARL saved to userData, success:', result.success)
        if (result.success) return
      } catch (e) {
        console.error('[Settings] Failed to save ARL to userData:', e)
      }
    }

    // Fallback: Save to localStorage
    console.log('[Settings] Falling back to localStorage for ARL')
    try {
      if (!arl) {
        localStorage.removeItem(LEGACY_ARL_STORAGE_KEY)
        return
      }

      if (window.electronAPI?.safeStorage) {
        const result = await window.electronAPI.safeStorage.encrypt(arl)
        localStorage.setItem(LEGACY_ARL_STORAGE_KEY, JSON.stringify({
          data: result.data,
          encrypted: result.encrypted
        }))
        console.log('[Settings] ARL saved to localStorage with encryption:', result.encrypted)
      } else {
        localStorage.setItem(LEGACY_ARL_STORAGE_KEY, JSON.stringify({
          data: arl,
          encrypted: false
        }))
        console.log('[Settings] ARL saved to localStorage (unencrypted)')
      }
    } catch (e) {
      console.error('[Settings] Failed to save ARL to localStorage:', e)
    }
  }

  async function saveSecureSpotifyCredentials(clientId: string, clientSecret: string, username: string) {
    // Try Electron's userData storage first
    if (window.electronAPI?.storage) {
      try {
        const result = await window.electronAPI.storage.saveCredentials({
          spotifyClientId: clientId,
          spotifyClientSecret: clientSecret,
          spotifyUsername: username
        })
        if (result.success) {
          console.log('[Settings] Spotify credentials saved to userData')
          return
        }
      } catch (e) {
        console.error('[Settings] Failed to save Spotify credentials to userData:', e)
      }
    }

    // Fallback: Save to localStorage
    console.log('[Settings] Falling back to localStorage for Spotify credentials')
    try {
      if (!clientId && !clientSecret) {
        localStorage.removeItem(LEGACY_SPOTIFY_STORAGE_KEY)
        return
      }

      const data: any = {}
      if (window.electronAPI?.safeStorage) {
        if (clientId) {
          const result = await window.electronAPI.safeStorage.encrypt(clientId)
          data.clientId = { data: result.data, encrypted: result.encrypted }
        }
        if (clientSecret) {
          const result = await window.electronAPI.safeStorage.encrypt(clientSecret)
          data.clientSecret = { data: result.data, encrypted: result.encrypted }
        }
      } else {
        if (clientId) data.clientId = { data: clientId, encrypted: false }
        if (clientSecret) data.clientSecret = { data: clientSecret, encrypted: false }
      }
      localStorage.setItem(LEGACY_SPOTIFY_STORAGE_KEY, JSON.stringify(data))
    } catch (e) {
      console.error('[Settings] Failed to save Spotify credentials to localStorage:', e)
    }
  }

  async function setSpotifyCredentials(clientId: string, clientSecret: string, username: string = '') {
    settings.value.spotifyClientId = clientId
    settings.value.spotifyClientSecret = clientSecret
    settings.value.spotifyUsername = username
    await saveSecureSpotifyCredentials(clientId, clientSecret, username)
  }

  function setColorTheme(theme: ColorTheme) {
    settings.value.colorTheme = theme
    applyColorTheme(theme)
    saveSettings()
  }

  function setTheme(theme: 'dark' | 'light' | 'system') {
    settings.value.theme = theme
    applyThemeMode(theme)
    saveSettings()
  }

  // Save settings immediately - no debouncing to ensure persistence
  async function saveSettings() {
    // Don't save during initial load to avoid overwriting with defaults
    if (!isLoaded.value) {
      console.log('[Settings] Skipping save during initial load')
      return
    }

    // Create a plain object copy without sensitive credentials (stored separately for security)
    // Use JSON.parse(JSON.stringify()) to ensure we have a plain object, not a Vue reactive proxy
    // This is necessary because IPC's structured clone algorithm can't clone Vue proxies
    const settingsToSave = JSON.parse(JSON.stringify({
      ...settings.value,
      arl: '',
      spotifyClientId: '',
      spotifyClientSecret: '',
      spotifyUsername: ''
    }))

    console.log('[Settings] Saving settings...', {
      downloadPath: settingsToSave.downloadPath,
      quality: settingsToSave.quality,
      theme: settingsToSave.theme,
      colorTheme: settingsToSave.colorTheme
    })

    // Try Electron's userData storage first
    if (window.electronAPI?.storage) {
      try {
        const result = await window.electronAPI.storage.saveSettings(settingsToSave)
        if (result.success) {
          console.log('[Settings] Settings saved to userData successfully')
          // Also save to localStorage as backup
          try {
            localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(settingsToSave))
          } catch (e) {
            // Ignore localStorage errors if userData worked
          }
          return
        }
        console.warn('[Settings] userData save returned failure, trying localStorage')
      } catch (e) {
        console.error('[Settings] Failed to save to userData:', e)
      }
    }

    // Fallback to localStorage
    try {
      localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(settingsToSave))
      console.log('[Settings] Settings saved to localStorage')
    } catch (e) {
      console.error('[Settings] Failed to save to localStorage:', e)
    }
  }

  async function setArl(arl: string) {
    console.log('[Settings] setArl called, length:', arl?.length || 0)
    settings.value.arl = arl
    await saveSecureArl(arl)
    console.log('[Settings] setArl complete')
  }

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    settings.value[key] = value
    saveSettings()
  }

  function resetSettings() {
    settings.value = { ...defaultSettings }
    saveSettings()
  }

  async function selectDownloadPath() {
    if (window.electronAPI) {
      const path = await window.electronAPI.selectFolder(settings.value.downloadPath)
      if (path) {
        settings.value.downloadPath = path
        saveSettings()
      }
    }
  }

  async function openDownloadPath() {
    if (window.electronAPI && settings.value.downloadPath) {
      await window.electronAPI.openPath(settings.value.downloadPath)
    }
  }

  // Auto-save on changes - saves immediately to ensure persistence
  // Use getter function for more reliable deep watching in Pinia stores
  watch(
    () => JSON.stringify(settings.value),
    (newVal, oldVal) => {
      if (newVal !== oldVal) {
        console.log('[Settings] Watch detected change, triggering save...')
        saveSettings()
      }
    }
  )

  return {
    settings,
    isLoaded,
    loadSettings,
    saveSettings,
    updateSetting,
    resetSettings,
    selectDownloadPath,
    openDownloadPath,
    setColorTheme,
    setTheme,
    setArl,
    setSpotifyCredentials
  }
})
