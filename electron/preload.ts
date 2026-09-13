import { contextBridge, ipcRenderer } from 'electron'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Dialogs
  selectFolder: (defaultPath?: string) =>
    ipcRenderer.invoke('dialog:selectFolder', defaultPath),

  // Shell
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  deletePath: (path: string) => ipcRenderer.invoke('shell:deletePath', path),

  // Clipboard
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),

  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getRuntimeInfo: () => ipcRenderer.invoke('app:getRuntimeInfo'),
  getServerPort: () => ipcRenderer.invoke('server:getPort'),

  // Window state events
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => {
    ipcRenderer.on('window:maximizeChange', (_, isMaximized) => callback(isMaximized))
  },

  // Auth events
  onAuthExpired: (callback: (data: { reason: string }) => void) => {
    ipcRenderer.on('auth:expired', (_, data) => callback(data))
  },
  onQobuzAuthExpired: (callback: (data: { reason: string }) => void) => {
    ipcRenderer.on('qobuz-auth:expired', (_, data) => callback(data))
  },

  // Session health updates (keep-alive monitoring)
  onSessionHealth: (callback: (data: {
    isHealthy: boolean
    sessionAge: number | null
    lastActivity: string | null
    consecutiveFailures: number
    expiresIn: number | null
  }) => void) => {
    ipcRenderer.on('session:health', (_, data) => callback(data))
  },

  // Safe storage for sensitive data
  safeStorage: {
    isAvailable: () => ipcRenderer.invoke('safeStorage:isAvailable'),
    encrypt: (plaintext: string) => ipcRenderer.invoke('safeStorage:encrypt', plaintext),
    decrypt: (encryptedBase64: string, isEncrypted: boolean) =>
      ipcRenderer.invoke('safeStorage:decrypt', encryptedBase64, isEncrypted)
  },

  // Deezer browser-based login
  deezerLogin: {
    openLoginWindow: () => ipcRenderer.invoke('deezer:openLoginWindow'),
    closeLoginWindow: () => ipcRenderer.invoke('deezer:closeLoginWindow')
  },

  qobuzLogin: {
    openLoginWindow: () => ipcRenderer.invoke('qobuz:openLoginWindow')
  },

  // Playlist sync events
  playlistSync: {
    onSyncStart: (callback: (data: { playlistId: string }) => void) => {
      ipcRenderer.on('sync:start', (_, data) => callback(data))
    },
    onSyncProgress: (callback: (data: { playlistId: string; current: number; total: number; phase: string }) => void) => {
      ipcRenderer.on('sync:progress', (_, data) => callback(data))
    },
    onSyncComplete: (callback: (data: any) => void) => {
      ipcRenderer.on('sync:complete', (_, data) => callback(data))
    },
    onSyncError: (callback: (data: { playlistId: string; error: string }) => void) => {
      ipcRenderer.on('sync:error', (_, data) => callback(data))
    }
  },

  // Artist sync events — separate IPC channels from playlistSync so the
  // renderer can route them to a dedicated store without inspecting payload.
  artistSync: {
    onSyncStart: (callback: (data: { artistId: string }) => void) => {
      ipcRenderer.on('artistSync:start', (_, data) => callback(data))
    },
    onSyncProgress: (callback: (data: { artistId: string; current: number; total: number; phase: string; albumTitle?: string }) => void) => {
      ipcRenderer.on('artistSync:progress', (_, data) => callback(data))
    },
    onSyncComplete: (callback: (data: any) => void) => {
      ipcRenderer.on('artistSync:complete', (_, data) => callback(data))
    },
    onSyncError: (callback: (data: { artistId: string; error: string }) => void) => {
      ipcRenderer.on('artistSync:error', (_, data) => callback(data))
    }
  },

  // Persistent storage (stored in userData, not localStorage)
  // This fixes session persistence issues with file:// protocol
  storage: {
    saveCredentials: (credentials: { arl?: string; spotifyClientId?: string; spotifyClientSecret?: string; spotifyUsername?: string; qobuzUserId?: string; qobuzToken?: string; qobuzAppId?: string; qobuzAppSecret?: string }) =>
      ipcRenderer.invoke('storage:saveCredentials', credentials),
    loadCredentials: () => ipcRenderer.invoke('storage:loadCredentials'),
    loadDownloadsState: () => ipcRenderer.invoke('storage:loadDownloadsState'),
    saveDownloadsState: (state: { downloads: unknown[]; downloadHistory: unknown[] }) =>
      ipcRenderer.invoke('storage:saveDownloadsState', state),
    saveSettings: (settings: object) => ipcRenderer.invoke('storage:saveSettings', settings),
    loadSettings: () => ipcRenderer.invoke('storage:loadSettings'),
    saveProfiles: (data: object) => ipcRenderer.invoke('storage:saveProfiles', data),
    loadProfiles: () => ipcRenderer.invoke('storage:loadProfiles')
  }
})

// Type definitions for the exposed API
interface SafeStorageResult {
  encrypted: boolean
  data: string
}

interface StorageCredentials {
  arl?: string
  spotifyClientId?: string
  spotifyClientSecret?: string
}

interface StorageResult {
  success: boolean
  error?: string
}

interface CredentialsLoadResult {
  success: boolean
  credentials: StorageCredentials
}

interface SettingsLoadResult {
  success: boolean
  settings: object | null
}

declare global {
  interface Window {
    electronAPI: {
      minimize: () => Promise<void>
      maximize: () => Promise<void>
      close: () => Promise<void>
      isMaximized: () => Promise<boolean>
      selectFolder: (defaultPath?: string) => Promise<string | null>
      openPath: (path: string) => Promise<void>
      openExternal: (url: string) => Promise<void>
      deletePath: (path: string) => Promise<void>
      clipboardWriteText: (text: string) => Promise<boolean>
      getVersion: () => Promise<string>
      getRuntimeInfo: () => Promise<{ electron: string; chromium: string; node: string; v8: string; os: string }>
      getServerPort: () => Promise<number>
      onMaximizeChange: (callback: (isMaximized: boolean) => void) => void
      onAuthExpired: (callback: (data: { reason: string }) => void) => void
      onQobuzAuthExpired: (callback: (data: { reason: string }) => void) => void
      onSessionHealth: (callback: (data: {
        isHealthy: boolean
        sessionAge: number | null
        lastActivity: string | null
        consecutiveFailures: number
        expiresIn: number | null
      }) => void) => void
      safeStorage: {
        isAvailable: () => Promise<boolean>
        encrypt: (plaintext: string) => Promise<SafeStorageResult>
        decrypt: (encryptedBase64: string, isEncrypted: boolean) => Promise<string>
      }
      deezerLogin: {
        openLoginWindow: () => Promise<{ success: boolean; arl?: string; error?: string }>
        closeLoginWindow: () => Promise<void>
      }
      playlistSync: {
        onSyncStart: (callback: (data: { playlistId: string }) => void) => void
        onSyncProgress: (callback: (data: { playlistId: string; current: number; total: number; phase: string }) => void) => void
        onSyncComplete: (callback: (data: any) => void) => void
        onSyncError: (callback: (data: { playlistId: string; error: string }) => void) => void
      }
      artistSync: {
        onSyncStart: (callback: (data: { artistId: string }) => void) => void
        onSyncProgress: (callback: (data: { artistId: string; current: number; total: number; phase: string; albumTitle?: string }) => void) => void
        onSyncComplete: (callback: (data: any) => void) => void
        onSyncError: (callback: (data: { artistId: string; error: string }) => void) => void
      }
      storage: {
        saveCredentials: (credentials: StorageCredentials) => Promise<StorageResult>
        loadCredentials: () => Promise<CredentialsLoadResult>
        loadDownloadsState: () => Promise<{ downloads: unknown[]; downloadHistory: unknown[] } | null>
        saveDownloadsState: (state: { downloads: unknown[]; downloadHistory: unknown[] }) => Promise<StorageResult>
        saveSettings: (settings: object) => Promise<StorageResult>
        loadSettings: () => Promise<SettingsLoadResult>
        saveProfiles: (data: object) => Promise<StorageResult>
        loadProfiles: () => Promise<{ success: boolean; data: any }>
      }
    }
  }
}
