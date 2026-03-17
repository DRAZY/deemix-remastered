import { app, BrowserWindow, ipcMain, shell, dialog, Menu, session, safeStorage } from 'electron'
import { join, normalize, resolve } from 'path'
import { rm, stat, readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { DeemixServer } from './server'
import { playlistSync } from './services/playlistSync'
import { spotifyAPI } from './services/spotifyAPI'

// Handle creating/removing shortcuts on Windows when installing/uninstalling
// Squirrel startup is handled by electron-builder

let mainWindow: BrowserWindow | null = null
let server: DeemixServer | null = null

// Simple window state manager
interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1400,
  height: 900
}

function getWindowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function getCredentialsPath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function getProfilesPath(): string {
  return join(app.getPath('userData'), 'profiles.json')
}

async function loadWindowState(): Promise<WindowState> {
  try {
    const data = await readFile(getWindowStatePath(), 'utf-8')
    const state = JSON.parse(data) as WindowState
    // Validate the loaded state
    if (state.width && state.height && state.width > 0 && state.height > 0) {
      return { ...DEFAULT_WINDOW_STATE, ...state }
    }
  } catch {
    // File doesn't exist or is invalid, use defaults
  }
  return DEFAULT_WINDOW_STATE
}

async function saveWindowState(win: BrowserWindow): Promise<void> {
  try {
    const bounds = win.getBounds()
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: win.isMaximized()
    }
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(getWindowStatePath(), JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[Main] Failed to save window state:', err)
  }
}

let windowState: WindowState = DEFAULT_WINDOW_STATE

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

// Set the app name for macOS menu (overrides package.json "name" field)
app.setName('Deemix Remastered')

const DEFAULT_PORT = 6595
const HOST = '127.0.0.1'

// Security: Validate that a path is allowed for file operations
// Allows any valid absolute path except sensitive system directories
function isPathAllowed(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false

  // Check for path traversal patterns
  if (targetPath.includes('..')) return false

  try {
    const normalizedPath = normalize(resolve(targetPath))

    // Check if it's an absolute path
    // Windows: starts with drive letter (e.g., C:\, D:\)
    // Unix: starts with /
    const isWindowsAbsolute = /^[A-Za-z]:[\\\/]/.test(normalizedPath)
    const isUnixAbsolute = normalizedPath.startsWith('/')

    if (!isWindowsAbsolute && !isUnixAbsolute) {
      return false
    }

    // Block sensitive system directories
    const blockedPaths = process.platform === 'win32'
      ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\System']
      : ['/bin', '/sbin', '/usr', '/etc', '/var', '/System', '/Library']

    const isBlocked = blockedPaths.some(blocked => {
      const normalizedBlocked = normalize(resolve(blocked))
      return normalizedPath.toLowerCase().startsWith(normalizedBlocked.toLowerCase())
    })

    return !isBlocked
  } catch {
    return false
  }
}

// Security: Validate URL for external opening
function isUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url)
    // Only allow http and https protocols
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function createWindow() {
  // Platform-specific window options with remembered state
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    backgroundColor: '#121216',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    show: false // Don't show until ready
  }

  // macOS-specific options
  if (isMac) {
    windowOptions.titleBarStyle = 'hidden'
    windowOptions.trafficLightPosition = { x: 15, y: 15 }
  }

  // Set icon based on platform
  if (isWin) {
    windowOptions.icon = join(__dirname, '../public/icon.ico')
  } else {
    windowOptions.icon = join(__dirname, '../public/icon.png')
  }

  mainWindow = new BrowserWindow(windowOptions)

  // Show window when ready to prevent white flash
  // Use timeout fallback in case ready-to-show never fires
  let windowShown = false
  const showWindow = () => {
    if (!windowShown && mainWindow) {
      windowShown = true
      mainWindow.show()
    }
  }

  mainWindow.once('ready-to-show', showWindow)

  // Fallback: show window after 3 seconds regardless
  setTimeout(showWindow, 3000)

  // Handle load failures
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Main] Failed to load:', errorCode, errorDescription)
    showWindow() // Show window even on failure so user can see something
  })

  // Emit maximize change events for the renderer
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximizeChange', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximizeChange', false)
  })

  // Remove menu in production
  if (!isDev) {
    Menu.setApplicationMenu(null)
  }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Security: Set Content Security Policy
  // Using consistent CSP for both dev and production to avoid rendering issues
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-src 'self' https://www.google.com; connect-src 'self' http://127.0.0.1:* http://localhost:* https://api.deezer.com https://*.dzcdn.net https://*.deezer.com https://www.google.com; img-src 'self' data: https://*.dzcdn.net https://*.deezer.com https://*.scdn.co https://*.spotifycdn.com https://www.gstatic.com; media-src 'self' https://*.dzcdn.net https://*.deezer.com"
        ]
      }
    })
  })

  // Security: Prevent navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsedUrl = new URL(url)
    const validOrigins = ['http://localhost:5173', `file://${join(__dirname, '../dist')}`]
    if (!validOrigins.some(origin => url.startsWith(origin)) && parsedUrl.protocol !== 'file:') {
      console.warn('[Security] Blocked navigation to:', url)
      event.preventDefault()
    }
  })

  // Add keyboard shortcut to toggle DevTools (Cmd+Option+I on Mac, Ctrl+Shift+I elsewhere)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.alt && input.key.toLowerCase() === 'i') {
      mainWindow?.webContents.toggleDevTools()
    }
    // Also support F12
    if (input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    // In production, load from the packaged dist folder
    // __dirname is dist-electron, so ../dist/index.html is the correct path
    const indexPath = join(__dirname, '../dist/index.html')
    console.log('[Main] Loading production file:', indexPath)
    mainWindow.loadFile(indexPath).catch((err) => {
      console.error('[Main] Failed to load file:', err)
      // Try alternative path as fallback
      const altPath = join(__dirname, '..', 'dist', 'index.html')
      console.log('[Main] Trying alternative path:', altPath)
      mainWindow?.loadFile(altPath).catch((err2) => {
        console.error('[Main] Alternative path also failed:', err2)
      })
    })
  }

  // Save window state on close
  mainWindow.on('close', () => {
    if (mainWindow) {
      saveWindowState(mainWindow)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Initialize the deemix server
async function initServer() {
  try {
    server = new DeemixServer(HOST, DEFAULT_PORT)
    await server.start()
    console.log(`[Main] Deemix server running on http://${HOST}:${server.getPort()}`)

    // Listen for auth-expired events and forward to renderer
    server.on('auth-expired', (data: { reason: string }) => {
      console.log('[Main] Auth expired, notifying renderer:', data.reason)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:expired', data)
      }
    })

    // Forward session health updates to renderer for keep-alive monitoring
    server.on('session-health', (data: any) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session:health', data)
      }
    })

    // Restore Spotify credentials from saved storage before sync init
    try {
      const credentialsPath = getCredentialsPath()
      const credData = JSON.parse(await readFile(credentialsPath, 'utf-8'))
      const decodeField = (stored: any): string => {
        if (!stored || !stored.data) return ''
        if (stored.encrypted && safeStorage.isEncryptionAvailable()) {
          try { return safeStorage.decryptString(Buffer.from(stored.data, 'base64')) } catch { /* fall through */ }
        }
        if (stored.obfuscated) {
          try { return Buffer.from(stored.data.split('').reverse().join(''), 'base64').toString('utf-8') } catch { /* fall through */ }
        }
        return stored.data || ''
      }
      const spotifyClientId = decodeField(credData.spotifyClientId)
      const spotifyClientSecret = decodeField(credData.spotifyClientSecret)
      if (spotifyClientId && spotifyClientSecret) {
        spotifyAPI.setCredentials(spotifyClientId, spotifyClientSecret)
        console.log('[Main] Spotify credentials restored from storage')
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        console.warn('[Main] Failed to restore Spotify credentials:', e.message)
      }
    }

    // Provide current download settings to the sync engine so synced playlists
    // use the same quality, folder structure, templates, and metadata settings
    playlistSync.setSettingsProvider(() => {
      const s = server!.getSettings()
      return {
        downloadPath: s.downloadPath,
        quality: s.quality,
        bitrateFallback: s.bitrateFallback,
        createArtistFolder: s.createArtistFolder,
        createAlbumFolder: s.createAlbumFolder,
        saveArtwork: s.saveArtwork,
        embedArtwork: s.embedArtwork,
        saveLyrics: s.saveLyrics,
        syncedLyrics: s.syncedLyrics,
        createErrorLog: s.createErrorLog,
        savePlaylistAsCompilation: s.savePlaylistAsCompilation,
        folderSettings: {
          createPlaylistFolder: s.createPlaylistFolder,
          createArtistFolder: s.createArtistFolder,
          createAlbumFolder: s.createAlbumFolder,
          createCDFolder: s.createCDFolder,
          createPlaylistStructure: s.createPlaylistStructure,
          createSinglesStructure: s.createSinglesStructure,
          playlistFolderTemplate: s.playlistFolderTemplate,
          albumFolderTemplate: s.albumFolderTemplate,
          artistFolderTemplate: s.artistFolderTemplate
        },
        trackTemplates: {
          trackNameTemplate: s.trackNameTemplate,
          albumTrackTemplate: s.albumTrackTemplate,
          playlistTrackTemplate: s.playlistTrackTemplate
        },
        metadataSettings: {
          tags: s.tags,
          albumCovers: s.albumCovers,
          useNullSeparator: s.useNullSeparator,
          saveID3v1: s.saveID3v1,
          saveOnlyMainArtist: s.saveOnlyMainArtist,
          artistSeparator: s.artistSeparator,
          dateFormatFlac: s.dateFormatFlac,
          titleCasing: s.titleCasing,
          artistCasing: s.artistCasing,
          removeAlbumVersion: s.removeAlbumVersion,
          featuredArtistsHandling: s.featuredArtistsHandling,
          keepVariousArtists: s.keepVariousArtists,
          removeArtistCombinations: s.removeArtistCombinations
        }
      }
    })

    // Initialize playlist sync engine
    await playlistSync.init()
    console.log('[Main] Playlist sync engine initialized')

    // Forward sync events to renderer
    playlistSync.on('sync:start', (playlistId: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:start', { playlistId })
      }
    })
    playlistSync.on('sync:progress', (playlistId: string, data: any) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:progress', { playlistId, ...data })
      }
    })
    playlistSync.on('sync:complete', (playlistId: string, result: any) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:complete', { playlistId, ...result })
      }
    })
    playlistSync.on('sync:error', (playlistId: string, error: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:error', { playlistId, error })
      }
    })
  } catch (error) {
    console.error('[Main] Failed to start server:', error)
    throw error
  }
}

app.whenReady().then(async () => {
  // Load window state before creating window
  windowState = await loadWindowState()

  try {
    await initServer()
  } catch (error) {
    console.error('[Main] Server initialization failed, continuing without server:', error)
    // Continue anyway - the app might still be usable for some features
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}).catch((error) => {
  console.error('[Main] Fatal error during startup:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    server?.stop()
    app.quit()
  }
})

app.on('before-quit', async () => {
  await playlistSync.shutdown()
  server?.stop()
})

// IPC Handlers
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.handle('window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized()
})

ipcMain.handle('dialog:selectFolder', async (_, defaultPath?: string) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  })
  return result.filePaths[0] || null
})

ipcMain.handle('shell:openPath', async (_, path: string) => {
  // Security: Validate path before opening
  if (!path || typeof path !== 'string') {
    console.warn('[Security] Invalid path provided to openPath')
    return { success: false, error: 'Invalid path' }
  }

  // Check for path traversal attempts
  if (path.includes('..') || !isPathAllowed(path)) {
    console.warn('[Security] Blocked path traversal attempt:', path)
    return { success: false, error: 'Path not allowed' }
  }

  // Verify path exists
  if (!existsSync(path)) {
    return { success: false, error: 'Path does not exist' }
  }

  await shell.openPath(path)
  return { success: true }
})

ipcMain.handle('shell:openExternal', async (_, url: string) => {
  // Security: Validate URL before opening
  if (!url || typeof url !== 'string') {
    console.warn('[Security] Invalid URL provided to openExternal')
    return { success: false, error: 'Invalid URL' }
  }

  if (!isUrlSafe(url)) {
    console.warn('[Security] Blocked unsafe URL:', url)
    return { success: false, error: 'URL not allowed' }
  }

  await shell.openExternal(url)
  return { success: true }
})

ipcMain.handle('shell:deletePath', async (_, path: string) => {
  // Security: Strict validation for delete operations
  if (!path || typeof path !== 'string') {
    console.warn('[Security] Invalid path provided to deletePath')
    return { success: false, error: 'Invalid path' }
  }

  // Check for path traversal attempts
  if (path.includes('..')) {
    console.warn('[Security] Blocked path traversal in delete:', path)
    return { success: false, error: 'Invalid path' }
  }

  // Ensure path is within allowed directories
  if (!isPathAllowed(path)) {
    console.warn('[Security] Delete blocked - path not in allowed directories:', path)
    return { success: false, error: 'Path not allowed for deletion' }
  }

  // Additional check: Don't allow deleting root-level directories
  const normalizedPath = normalize(resolve(path))

  // Block deletion of drive roots (Windows) or filesystem root (Unix)
  const isWindowsDriveRoot = /^[A-Za-z]:[\\\/]?$/.test(normalizedPath)
  const isUnixRoot = normalizedPath === '/'

  // Also block common user directories
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const protectedDirs = home ? [
    normalize(resolve(home)),
    normalize(resolve(join(home, 'Music'))),
    normalize(resolve(join(home, 'Downloads'))),
    normalize(resolve(join(home, 'Desktop'))),
    normalize(resolve(join(home, 'Documents')))
  ] : []

  const isProtectedDir = protectedDirs.includes(normalizedPath)

  if (isWindowsDriveRoot || isUnixRoot || isProtectedDir) {
    console.warn('[Security] Cannot delete protected directory:', path)
    return { success: false, error: 'Cannot delete this directory' }
  }

  try {
    // Verify path exists before attempting delete
    await stat(path)
    await rm(path, { recursive: true, force: true })
    return { success: true }
  } catch (error: any) {
    console.error('[Main] Failed to delete path:', path, error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('app:getVersion', () => {
  return app.getVersion()
})

ipcMain.handle('app:getRuntimeInfo', () => {
  return {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    os: `${process.platform} ${process.arch}`
  }
})

ipcMain.handle('server:getPort', () => {
  // Return the actual port the server is running on
  return server?.getPort() || DEFAULT_PORT
})

// Security: Safe storage for sensitive data (like ARL tokens)
ipcMain.handle('safeStorage:isAvailable', () => {
  return safeStorage.isEncryptionAvailable()
})

ipcMain.handle('safeStorage:encrypt', (_, plaintext: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[Security] Encryption not available, returning plaintext')
    return { encrypted: false, data: plaintext }
  }
  try {
    const encrypted = safeStorage.encryptString(plaintext)
    // Convert Buffer to base64 string for storage
    return { encrypted: true, data: encrypted.toString('base64') }
  } catch (error) {
    console.error('[Security] Encryption failed:', error)
    return { encrypted: false, data: plaintext }
  }
})

ipcMain.handle('safeStorage:decrypt', (_, encryptedBase64: string, isEncrypted: boolean) => {
  if (!isEncrypted || !safeStorage.isEncryptionAvailable()) {
    // Data was stored as plaintext, return as-is
    return encryptedBase64
  }
  try {
    const buffer = Buffer.from(encryptedBase64, 'base64')
    return safeStorage.decryptString(buffer)
  } catch (error) {
    console.error('[Security] Decryption failed:', error)
    // If decryption fails, the data might have been stored as plaintext
    return encryptedBase64
  }
})

// Deezer browser-based login
let loginWindow: BrowserWindow | null = null
let cookieCheckInterval: NodeJS.Timeout | null = null
let cookieChangeHandler: ((event: Electron.Event, cookie: Electron.Cookie, cause: string, removed: boolean) => void) | null = null

ipcMain.handle('deezer:openLoginWindow', async () => {
  if (loginWindow) {
    loginWindow.focus()
    return { success: false, error: 'Login window already open' }
  }

  // Get the session with our partition
  const loginSession = session.fromPartition('persist:deezer-login')

  // Clear any existing cookies first
  await loginSession.clearStorageData({ storages: ['cookies'] })

  return new Promise((resolve) => {
    let resolved = false

    const cleanup = () => {
      if (cookieCheckInterval) {
        clearInterval(cookieCheckInterval)
        cookieCheckInterval = null
      }
      if (cookieChangeHandler) {
        loginSession.cookies.removeListener('changed', cookieChangeHandler)
        cookieChangeHandler = null
      }
    }

    const handleArlFound = (arl: string) => {
      if (resolved) return
      resolved = true
      console.log('[DeezerLogin] ARL cookie captured, length:', arl.length)

      cleanup()

      // Close the login window
      if (loginWindow) {
        loginWindow.close()
        loginWindow = null
      }

      resolve({ success: true, arl })
    }

    // Create a new window for Deezer login with the partition specified
    loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      parent: mainWindow || undefined,
      modal: false, // Non-modal so user can interact freely
      show: false,
      title: 'Login to Deezer',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // Allow full web functionality for login
        partition: 'persist:deezer-login' // Use persistent partition for cookies
      }
    })

    // Load Deezer login page
    loginWindow.loadURL('https://www.deezer.com/login')

    loginWindow.once('ready-to-show', () => {
      loginWindow?.show()
    })

    // Listen for cookie changes - most reliable method
    cookieChangeHandler = (_event, cookie, _cause, removed) => {
      if (removed) return
      if (cookie.name === 'arl' && cookie.domain.includes('deezer') && cookie.value && cookie.value.length > 50) {
        console.log('[DeezerLogin] ARL cookie detected via change event')
        handleArlFound(cookie.value)
      }
    }
    loginSession.cookies.on('changed', cookieChangeHandler)

    // Also poll for ARL - backup method with broader search
    const checkForArl = async () => {
      if (!loginWindow || resolved) return

      try {
        // Search all cookies and find ARL (more reliable than domain filter)
        const allCookies = await loginSession.cookies.get({})
        const arlCookie = allCookies.find(c =>
          c.name === 'arl' &&
          c.domain.includes('deezer') &&
          c.value &&
          c.value.length > 50
        )

        if (arlCookie) {
          console.log('[DeezerLogin] ARL cookie found via polling, domain:', arlCookie.domain)
          handleArlFound(arlCookie.value)
        }
      } catch (error) {
        console.error('[DeezerLogin] Error checking cookies:', error)
      }
    }

    // Check cookies periodically (every 500ms for faster detection)
    cookieCheckInterval = setInterval(checkForArl, 500)

    // Also check on navigation
    loginWindow.webContents.on('did-navigate', (_, url) => {
      console.log('[DeezerLogin] Navigated to:', url)
      // Check after navigation completes
      setTimeout(checkForArl, 300)
    })

    loginWindow.webContents.on('did-finish-load', () => {
      console.log('[DeezerLogin] Page finished loading')
      checkForArl()
    })

    // Handle window close
    loginWindow.on('closed', () => {
      cleanup()
      loginWindow = null
      if (!resolved) {
        resolve({ success: false, error: 'Login window closed' })
      }
    })
  })
})

ipcMain.handle('deezer:closeLoginWindow', () => {
  if (loginWindow) {
    loginWindow.close()
    loginWindow = null
  }
})

// Persistent storage for credentials (stored in userData, not localStorage)
// This fixes session persistence issues with file:// protocol
ipcMain.handle('storage:saveCredentials', async (_, credentials: { arl?: string; spotifyClientId?: string; spotifyClientSecret?: string }) => {
  try {
    const credentialsPath = getCredentialsPath()
    const data: any = {}

    // Load existing credentials first
    try {
      const existing = await readFile(credentialsPath, 'utf-8')
      Object.assign(data, JSON.parse(existing))
    } catch {
      // File doesn't exist yet, start fresh
    }

    // Check if encryption is available
    const encryptionAvailable = safeStorage.isEncryptionAvailable()
    if (!encryptionAvailable) {
      console.warn('[Security] WARNING: Secure storage encryption is NOT available on this system!')
      console.warn('[Security] Credentials will be stored with basic obfuscation only.')
      console.warn('[Security] For better security, ensure your system keychain/keyring is configured.')
    }

    // Helper to store credential with encryption or obfuscation fallback
    const storeCredential = (value: string | undefined, key: string) => {
      if (value === undefined) return
      if (!value) {
        delete (data as any)[key]
        return
      }

      if (encryptionAvailable) {
        const encrypted = safeStorage.encryptString(value)
        ;(data as any)[key] = { data: encrypted.toString('base64'), encrypted: true }
      } else {
        // Fallback: Basic obfuscation (base64 + reverse) - NOT secure, but better than plaintext
        // Users are warned above that encryption is not available
        const obfuscated = Buffer.from(value).toString('base64').split('').reverse().join('')
        ;(data as any)[key] = { data: obfuscated, encrypted: false, obfuscated: true }
      }
    }

    // Store each credential
    storeCredential(credentials.arl, 'arl')
    storeCredential(credentials.spotifyClientId, 'spotifyClientId')
    storeCredential(credentials.spotifyClientSecret, 'spotifyClientSecret')

    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(credentialsPath, JSON.stringify(data, null, 2))
    console.log('[Main] Credentials saved to userData')
    return { success: true }
  } catch (error: any) {
    console.error('[Main] Failed to save credentials:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('storage:loadCredentials', async () => {
  try {
    const credentialsPath = getCredentialsPath()
    const fileData = await readFile(credentialsPath, 'utf-8')
    const data = JSON.parse(fileData)

    // Helper to decode credential based on storage format
    const decodeCredential = (stored: { data: string; encrypted?: boolean; obfuscated?: boolean } | undefined): string | undefined => {
      if (!stored || !stored.data) return undefined

      // Encrypted with safeStorage
      if (stored.encrypted && safeStorage.isEncryptionAvailable()) {
        try {
          const buffer = Buffer.from(stored.data, 'base64')
          return safeStorage.decryptString(buffer)
        } catch {
          // Fall through to other methods
        }
      }

      // Obfuscated (base64 reversed) - fallback when encryption wasn't available
      if (stored.obfuscated) {
        try {
          const deobfuscated = stored.data.split('').reverse().join('')
          return Buffer.from(deobfuscated, 'base64').toString('utf-8')
        } catch {
          // Fall through to plaintext
        }
      }

      // Legacy plaintext storage
      return stored.data
    }

    const result: { arl?: string; spotifyClientId?: string; spotifyClientSecret?: string } = {}
    result.arl = decodeCredential(data.arl)
    result.spotifyClientId = decodeCredential(data.spotifyClientId)
    result.spotifyClientSecret = decodeCredential(data.spotifyClientSecret)

    console.log('[Main] Credentials loaded from userData')
    return { success: true, credentials: result }
  } catch (error: any) {
    // File doesn't exist is normal on first run
    if (error.code !== 'ENOENT') {
      console.error('[Main] Failed to load credentials:', error)
    }
    return { success: true, credentials: {} }
  }
})

// Persistent storage for settings (stored in userData, not localStorage)
ipcMain.handle('storage:saveSettings', async (_, settings: object) => {
  try {
    const settingsPath = getSettingsPath()
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(settingsPath, JSON.stringify(settings, null, 2))
    console.log('[Main] Settings saved to userData')
    return { success: true }
  } catch (error: any) {
    console.error('[Main] Failed to save settings:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('storage:loadSettings', async () => {
  try {
    const settingsPath = getSettingsPath()
    const data = await readFile(settingsPath, 'utf-8')
    console.log('[Main] Settings loaded from userData')
    return { success: true, settings: JSON.parse(data) }
  } catch (error: any) {
    // File doesn't exist is normal on first run
    if (error.code !== 'ENOENT') {
      console.error('[Main] Failed to load settings:', error)
    }
    return { success: true, settings: null }
  }
})

// Persistent storage for settings profiles
ipcMain.handle('storage:saveProfiles', async (_, data: object) => {
  try {
    const profilesPath = getProfilesPath()
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(profilesPath, JSON.stringify(data, null, 2))
    console.log('[Main] Profiles saved to userData')
    return { success: true }
  } catch (error: any) {
    console.error('[Main] Failed to save profiles:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('storage:loadProfiles', async () => {
  try {
    const profilesPath = getProfilesPath()
    const data = await readFile(profilesPath, 'utf-8')
    console.log('[Main] Profiles loaded from userData')
    return { success: true, data: JSON.parse(data) }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('[Main] Failed to load profiles:', error)
    }
    return { success: true, data: null }
  }
})
