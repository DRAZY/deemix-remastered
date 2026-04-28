// Renderer-side type declarations for the API exposed by electron/preload.ts
// via contextBridge.exposeInMainWorld. Mirrored here because preload.ts is
// compiled under tsconfig.node.json and its global augmentation does not
// reach the renderer's tsconfig.json scope.

interface ElectronSafeStorageResult {
  encrypted: boolean
  data: string
}

interface ElectronStorageCredentials {
  arl?: string
  spotifyClientId?: string
  spotifyClientSecret?: string
  spotifyUsername?: string
}

interface ElectronStorageResult {
  success: boolean
  error?: string
}

interface ElectronCredentialsLoadResult {
  success: boolean
  credentials: ElectronStorageCredentials
}

interface ElectronSettingsLoadResult {
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
      getVersion: () => Promise<string>
      getRuntimeInfo: () => Promise<{ electron: string; chromium: string; node: string; v8: string; os: string }>
      getServerPort: () => Promise<number>
      onMaximizeChange: (callback: (isMaximized: boolean) => void) => void
      onAuthExpired: (callback: (data: { reason: string }) => void) => void
      onSessionHealth: (callback: (data: {
        isHealthy: boolean
        sessionAge: number | null
        lastActivity: string | null
        consecutiveFailures: number
        expiresIn: number | null
      }) => void) => void
      safeStorage: {
        isAvailable: () => Promise<boolean>
        encrypt: (plaintext: string) => Promise<ElectronSafeStorageResult>
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
      storage: {
        saveCredentials: (credentials: ElectronStorageCredentials) => Promise<ElectronStorageResult>
        loadCredentials: () => Promise<ElectronCredentialsLoadResult>
        saveSettings: (settings: object) => Promise<ElectronStorageResult>
        loadSettings: () => Promise<ElectronSettingsLoadResult>
        saveProfiles: (data: object) => Promise<ElectronStorageResult>
        loadProfiles: () => Promise<{ success: boolean; data: any }>
      }
    }
  }
}

export {}
