/**
 * Browser polyfill when running Deemix Remastered as a self-hosted Web / Docker server
 * (outside Electron). Active only when `window.electronAPI` is not injected by Electron preload:
 *   1. Rewrites legacy `http://127.0.0.1:<port>/...`, `http://localhost:<port>/...` and
 *      `https://api.deezer.com/...` `fetch()` URLs to same-origin endpoints so zero Vue stores/views break,
 *   2. Provides a full `window.electronAPI` implementation backed by `/api/web-storage/*` and `/api/events` (SSE).
 */
export function installWebPolyfill(): void {
  if (typeof window === 'undefined' || (window as any).electronAPI) {
    return
  }

  const origFetch = window.fetch.bind(window)

  function rewriteUrl(raw: string): string {
    if (raw.startsWith('http://127.0.0.1:') || raw.startsWith('http://localhost:')) {
      const idx = raw.indexOf('/', 8)
      return idx >= 0 ? raw.slice(idx) : '/'
    }
    if (raw.startsWith('https://api.deezer.com/')) {
      return '/api/deezer-public/' + raw.slice('https://api.deezer.com/'.length)
    }
    return raw
  }

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') {
      return origFetch(rewriteUrl(input), { credentials: 'same-origin', ...init })
    }
    if (input instanceof URL) {
      return origFetch(rewriteUrl(input.toString()), { credentials: 'same-origin', ...init })
    }
    return origFetch(input, init)
  }) as typeof window.fetch

  // SSE event bus for real-time sync & auth health notifications
  const listeners = new Map<string, Set<(payload: any) => void>>()
  const onChannel = (channel: string, cb: (payload: any) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(cb)
  }

  try {
    const es = new EventSource('/api/events', { withCredentials: true })
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        const set = listeners.get(msg.channel)
        if (set) set.forEach((fn) => fn(msg.data))
      } catch {
        // Ignore malformed SSE frames
      }
    }
  } catch {
    // EventSource unavailable
  }

  let cachedRuntime: any = null
  async function getRuntime() {
    if (!cachedRuntime) {
      try {
        const r = await origFetch('/api/web-storage/runtime', { credentials: 'same-origin' })
        cachedRuntime = await r.json()
      } catch {
        cachedRuntime = {
          version: '2.6.6',
          defaultDownloadPath: '/downloads',
          runtime: { electron: 'docker-web', chromium: 'browser', node: '', v8: '', os: 'linux' }
        }
      }
    }
    return cachedRuntime
  }

  async function postJson(url: string, body: unknown) {
    const r = await origFetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {})
    })
    return r.json()
  }

  async function getJson(url: string) {
    const r = await origFetch(url, { credentials: 'same-origin' })
    return r.json()
  }

  ;(window as any).electronAPI = {
    minimize: async () => {},
    maximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    selectFolder: async (defaultPath?: string) => {
      const rt = await getRuntime()
      const suggested = defaultPath || rt.defaultDownloadPath || '/downloads'
      const entered = window.prompt('Server folder path (inside container):', suggested)
      return entered ? entered.trim() : null
    },
    openPath: async (_p: string) => {},
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    deletePath: async (_p: string) => {},
    clipboardWriteText: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    },
    getVersion: async () => (await getRuntime()).version,
    getRuntimeInfo: async () => (await getRuntime()).runtime,
    getServerPort: async () => Number(window.location.port || (window.location.protocol === 'https:' ? 443 : 80)),
    updates: {
      getStatus: async () => ({ state: 'idle', schedule: 'never' }),
      check: async () => ({ state: 'idle' }),
      install: async () => {},
      deferRestart: async () => {},
      setSchedule: async () => {},
      onStatus: () => {}
    },
    onMaximizeChange: () => {},
    onAuthExpired: (cb: any) => onChannel('auth:expired', cb),
    onQobuzAuthExpired: (cb: any) => onChannel('qobuz-auth:expired', cb),
    onSessionHealth: (cb: any) => onChannel('session:health', cb),
    safeStorage: {
      isAvailable: async () => false,
      encrypt: async (plaintext: string) => ({ encrypted: false, data: btoa(plaintext) }),
      decrypt: async (data: string, _isEncrypted: boolean) => {
        try { return atob(data) } catch { return data }
      }
    },
    deezerLogin: {
      openLoginWindow: async () => ({
        success: false,
        error: 'In Docker/Web mode, please sign in using your ARL token or email/password.'
      }),
      closeLoginWindow: async () => {}
    },
    qobuzLogin: {
      openLoginWindow: async () => ({
        success: false,
        error: 'In Docker/Web mode, please paste your Qobuz user auth token directly.'
      })
    },
    playlistSync: {
      onSyncStart: (cb: any) => onChannel('sync:start', cb),
      onSyncProgress: (cb: any) => onChannel('sync:progress', cb),
      onSyncComplete: (cb: any) => onChannel('sync:complete', cb),
      onSyncError: (cb: any) => onChannel('sync:error', cb)
    },
    artistSync: {
      onSyncStart: (cb: any) => onChannel('artistSync:start', cb),
      onSyncProgress: (cb: any) => onChannel('artistSync:progress', cb),
      onSyncComplete: (cb: any) => onChannel('artistSync:complete', cb),
      onSyncError: (cb: any) => onChannel('artistSync:error', cb)
    },
    storage: {
      saveCredentials: (creds: any) => postJson('/api/web-storage/credentials', creds),
      loadCredentials: () => getJson('/api/web-storage/credentials'),
      loadDownloadsState: () => getJson('/api/web-storage/downloads'),
      saveDownloadsState: (state: any) => postJson('/api/web-storage/downloads', state),
      saveSettings: async (settings: any) => {
        const rt = await getRuntime()
        if (settings && !settings.downloadPath) {
          settings.downloadPath = rt.defaultDownloadPath || '/downloads'
        }
        return postJson('/api/web-storage/settings', settings)
      },
      loadSettings: async () => {
        const res = await getJson('/api/web-storage/settings')
        const rt = await getRuntime()
        if (res?.settings && !res.settings.downloadPath) {
          res.settings.downloadPath = rt.defaultDownloadPath || '/downloads'
        } else if (!res?.settings) {
          return { success: true, settings: { downloadPath: rt.defaultDownloadPath || '/downloads' } }
        }
        return res
      },
      saveProfiles: (data: any) => postJson('/api/web-storage/profiles', data),
      loadProfiles: () => getJson('/api/web-storage/profiles')
    }
  }
}
