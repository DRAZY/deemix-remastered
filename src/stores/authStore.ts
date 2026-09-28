import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import i18n from '../i18n'
import { useSettingsStore } from './settingsStore'

export interface DeezerUser {
  id: number
  name: string
  email?: string
  picture?: string
  country?: string
  canStream: boolean
  canDownload: boolean
  subscription?: {
    type: string
    expires?: string
  }
}

export interface CaptchaChallenge {
  required: boolean
  siteKey: string
  captchaUrl?: string
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<DeezerUser | null>(null)
  const isAuthenticated = ref(false)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const serverPort = ref(6595)

  // CAPTCHA state
  const captchaRequired = ref(false)
  const captchaSiteKey = ref<string | null>(null)
  const captchaUrl = ref<string | null>(null)

  // Auth expiration state
  const authExpired = ref(false)
  const authExpiredReason = ref<string | null>(null)

  const isLoggedIn = computed(() => isAuthenticated.value && user.value !== null)
  const isPremium = computed(() =>
    user.value?.subscription?.type &&
    !['Free', 'free'].includes(user.value.subscription.type)
  )

  async function init() {
    console.log('[AuthStore] Initializing...')

    // Get server port from electron
    if (window.electronAPI) {
      serverPort.value = await window.electronAPI.getServerPort()
      console.log('[AuthStore] Server port:', serverPort.value)

      // Set up auth-expired listener
      setupAuthExpiredListener()
    }

    // Check if we have a saved ARL (from secure storage in settingsStore)
    const settingsStore = useSettingsStore()

    // Migration: check for old plaintext ARL and migrate it
    const oldArl = localStorage.getItem('deezer_arl')
    if (oldArl) {
      console.log('[AuthStore] Migrating plaintext ARL to secure storage')
      await settingsStore.setArl(oldArl)
      localStorage.removeItem('deezer_arl')
    }

    const savedArl = settingsStore.settings.arl
    console.log('[AuthStore] Saved ARL exists:', !!savedArl, 'length:', savedArl?.length || 0)

    if (savedArl) {
      console.log('[AuthStore] Auto-logging in with saved ARL...')
      await login(savedArl, true)
    } else {
      console.log('[AuthStore] No saved ARL, checking auth status...')
      // Check current auth status
      await checkAuthStatus()
    }
  }

  /**
   * Set up listener for auth-expired events from the backend
   */
  function setupAuthExpiredListener() {
    if (window.electronAPI?.onAuthExpired) {
      window.electronAPI.onAuthExpired((data) => {
        console.log('[AuthStore] Auth expired event received:', data.reason)
        handleAuthExpired(data.reason)
      })
    }
  }

  /**
   * Handle authentication expiration
   * This is called when the backend detects that the ARL token has expired
   */
  async function handleAuthExpired(reason: string) {
    console.log('[AuthStore] Handling auth expiration:', reason)

    // Set the expiration state
    authExpired.value = true
    authExpiredReason.value = reason

    // Clear authenticated state
    isAuthenticated.value = false
    user.value = null

    // Clear stored ARL
    const settingsStore = useSettingsStore()
    await settingsStore.setArl('')

    // Set a user-friendly error message
    error.value = i18n.global.t('login.sessionExpired')
  }

  /**
   * Clear the auth expired state (e.g., after user acknowledges or re-logs in)
   */
  function clearAuthExpired() {
    authExpired.value = false
    authExpiredReason.value = null
    error.value = null
  }

  async function checkAuthStatus() {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout

      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/auth/status`, {
        signal: controller.signal
      })
      clearTimeout(timeoutId)
      const data = await response.json()

      if (data.authenticated && data.user) {
        isAuthenticated.value = true
        user.value = data.user
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        console.warn('Auth status check timed out')
      } else {
        console.error('Failed to check auth status:', e)
      }
    }
  }

  async function login(arl: string, silent = false): Promise<boolean> {
    if (!arl || arl.length < 100) {
      error.value = i18n.global.t('login.invalidArl')
      return false
    }

    isLoading.value = true
    error.value = null

    try {
      console.log('[AuthStore] Attempting login to server at port:', serverPort.value)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000) // 15 second timeout for login

      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arl }),
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      const text = await response.text()

      let data
      try {
        data = JSON.parse(text)
      } catch (parseError) {
        console.error('[AuthStore] Failed to parse response')
        throw new Error('Server returned invalid response. Make sure the app is running correctly.')
      }

      if (!response.ok) {
        throw new Error(data.error || 'Login failed')
      }

      if (data.success && data.user) {
        isAuthenticated.value = true
        user.value = data.user

        // Clear any auth expired state
        authExpired.value = false
        authExpiredReason.value = null

        // Save ARL securely for auto-login (use returned ARL if available)
        const settingsStore = useSettingsStore()
        const arlToSave = data.arl || arl
        console.log('[AuthStore] Login successful, saving ARL (length:', arlToSave?.length, ')')
        await settingsStore.setArl(arlToSave)

        return true
      }

      throw new Error('Login failed')
    } catch (e: any) {
      console.error('[AuthStore] Login error:', e)
      if (!silent) {
        if (e.name === 'AbortError') {
          error.value = i18n.global.t('login.connectionTimeout')
        } else {
          error.value = e.message || i18n.global.t('login.loginFailed')
        }
      }
      isAuthenticated.value = false
      user.value = null
      const settingsStore = useSettingsStore()
      await settingsStore.setArl('')
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function loginWithEmail(email: string, password: string): Promise<boolean | 'captcha'> {
    if (!email || !password) {
      error.value = i18n.global.t('login.emailPasswordRequired')
      return false
    }

    isLoading.value = true
    error.value = null
    captchaRequired.value = false

    try {
      console.log('[AuthStore] Attempting email login to server at port:', serverPort.value)

      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/auth/login-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })

      const text = await response.text()

      let data
      try {
        data = JSON.parse(text)
      } catch (parseError) {
        console.error('[AuthStore] Failed to parse response')
        throw new Error('Server returned invalid response. Make sure the app is running correctly.')
      }

      // Check if CAPTCHA is required
      if (data.captchaRequired) {
        console.log('[AuthStore] CAPTCHA required for login')
        captchaRequired.value = true
        captchaSiteKey.value = data.siteKey
        captchaUrl.value = data.captchaUrl
        return 'captcha'
      }

      if (!response.ok) {
        throw new Error(data.error || 'Login failed')
      }

      if (data.success && data.user) {
        isAuthenticated.value = true
        user.value = data.user
        captchaRequired.value = false

        // Save ARL securely for auto-login
        if (data.arl) {
          const settingsStore = useSettingsStore()
          await settingsStore.setArl(data.arl)
        }

        return true
      }

      throw new Error('Login failed')
    } catch (e: any) {
      console.error('[AuthStore] Email login error:', e)
      error.value = e.message || i18n.global.t('login.loginFailed')
      isAuthenticated.value = false
      user.value = null
      const settingsStore = useSettingsStore()
      await settingsStore.setArl('')
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function loginWithCaptcha(captchaResponse: string): Promise<boolean> {
    if (!captchaResponse) {
      error.value = i18n.global.t('login.captchaRequired')
      return false
    }

    isLoading.value = true
    error.value = null

    try {
      console.log('[AuthStore] Completing login with CAPTCHA')

      const response = await fetch(`http://127.0.0.1:${serverPort.value}/api/auth/login-captcha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captchaResponse })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'CAPTCHA verification failed')
      }

      if (data.success && data.user) {
        isAuthenticated.value = true
        user.value = data.user
        captchaRequired.value = false
        captchaSiteKey.value = null
        captchaUrl.value = null

        // Save ARL securely for auto-login
        if (data.arl) {
          const settingsStore = useSettingsStore()
          await settingsStore.setArl(data.arl)
        }

        return true
      }

      throw new Error('Login failed after CAPTCHA')
    } catch (e: any) {
      console.error('[AuthStore] CAPTCHA login error:', e)
      error.value = e.message || i18n.global.t('login.captchaFailed')
      return false
    } finally {
      isLoading.value = false
    }
  }

  function clearCaptcha() {
    captchaRequired.value = false
    captchaSiteKey.value = null
    captchaUrl.value = null

    // Also clear on server
    fetch(`http://127.0.0.1:${serverPort.value}/api/auth/captcha-clear`, {
      method: 'POST'
    }).catch(() => {})
  }

  async function logout() {
    try {
      await fetch(`http://127.0.0.1:${serverPort.value}/api/auth/logout`, {
        method: 'POST'
      })
    } catch (e) {
      console.error('Logout error:', e)
    }

    isAuthenticated.value = false
    user.value = null
    error.value = null

    // Clear ARL from secure storage
    const settingsStore = useSettingsStore()
    await settingsStore.setArl('')
  }

  function clearError() {
    error.value = null
  }

  return {
    user,
    isAuthenticated,
    isLoggedIn,
    isPremium,
    isLoading,
    error,
    serverPort,
    // CAPTCHA state
    captchaRequired,
    captchaSiteKey,
    captchaUrl,
    // Auth expiration state
    authExpired,
    authExpiredReason,
    // Methods
    init,
    login,
    loginWithEmail,
    loginWithCaptcha,
    logout,
    checkAuthStatus,
    clearError,
    clearCaptcha,
    clearAuthExpired
  }
})
