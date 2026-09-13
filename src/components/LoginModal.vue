<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/authStore'
import Toast from './Toast.vue'

const { t } = useI18n()

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'success'): void
}>()

const authStore = useAuthStore()

// Login method tabs
type LoginMethod = 'email' | 'arl'
const loginMethod = ref<LoginMethod>('email')

// Email/password form
const email = ref('')
const password = ref('')
const showPassword = ref(false)

// ARL form
const arl = ref('')
const showArl = ref(false)

// Browser login state
const isBrowserLoginLoading = ref(false)

// Toast notification
const showToast = ref(false)
const toastMessage = ref('')
const toastType = ref<'success' | 'error' | 'info'>('info')

function showNotification(message: string, type: 'success' | 'error' | 'info') {
  toastMessage.value = message
  toastType.value = type
  showToast.value = true
}

const isEmailValid = computed(() => email.value.includes('@') && password.value.length >= 1)
const isArlValid = computed(() => arl.value.length >= 100)

async function handleLogin() {
  if (loginMethod.value === 'email') {
    if (!isEmailValid.value) return
    const result = await authStore.loginWithEmail(email.value, password.value)

    if (result === 'captcha') {
      // CAPTCHA required - show browser login option
      showNotification(t('login.captchaRequired'), 'info')
      return
    }

    if (result === true) {
      email.value = ''
      password.value = ''
      showNotification(t('login.success'), 'success')
      setTimeout(() => {
        emit('success')
        emit('close')
      }, 1500)
    } else {
      showNotification(authStore.error || t('login.failed'), 'error')
    }
  } else {
    if (!isArlValid.value) return
    const success = await authStore.login(arl.value)
    if (success) {
      arl.value = ''
      showNotification(t('login.success'), 'success')
      setTimeout(() => {
        emit('success')
        emit('close')
      }, 1500)
    } else {
      showNotification(authStore.error || t('login.invalidArl'), 'error')
    }
  }
}

async function handleBrowserLogin() {
  if (!window.electronAPI?.deezerLogin) {
    showNotification('Browser login not available', 'error')
    return
  }

  isBrowserLoginLoading.value = true
  showNotification(t('login.openingBrowser'), 'info')

  try {
    const result = await window.electronAPI.deezerLogin.openLoginWindow()

    if (result.success && result.arl) {
      // Login with the captured ARL
      const loginSuccess = await authStore.login(result.arl)
      if (loginSuccess) {
        authStore.clearCaptcha()
        showNotification(t('login.success'), 'success')
        setTimeout(() => {
          emit('success')
          emit('close')
        }, 1500)
      } else {
        showNotification(authStore.error || t('login.failed'), 'error')
      }
    } else if (result.error) {
      if (result.error !== 'Login window closed') {
        showNotification(result.error, 'error')
      }
    }
  } catch (error: any) {
    showNotification(error.message || 'Browser login failed', 'error')
  } finally {
    isBrowserLoginLoading.value = false
  }
}

function handleBackFromCaptcha() {
  authStore.clearCaptcha()
}

function handleClose() {
  email.value = ''
  password.value = ''
  arl.value = ''
  authStore.clearError()
  authStore.clearCaptcha()
  emit('close')
}

function openArlGuide() {
  window.electronAPI?.openExternal('https://www.google.com/search?q=how+to+get+deezer+arl+cookie')
}

function openDeezerExternal() {
  // Open Deezer login page in external browser as fallback
  window.electronAPI?.openExternal('https://www.deezer.com/login')
}
</script>

<template>
  <!-- Toast Notification -->
  <Toast
    :show="showToast"
    :message="toastMessage"
    :type="toastType"
    @close="showToast = false"
  />

  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="show"
        class="fixed inset-0 z-50 flex items-center justify-center"
      >
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-black/60 backdrop-blur-sm"
          @click="handleClose"
        />

        <!-- Modal -->
        <div class="relative bg-background-secondary border border-white/10 w-full max-w-md p-6 shadow-2xl">
          <!-- Close button -->
          <button
            @click="handleClose"
            class="absolute top-4 right-4 p-2 hover:bg-background-tertiary transition-colors"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <!-- Header -->
          <div class="text-center mb-6">
            <div class="w-14 h-14 mx-auto mb-4 bg-primary-500 flex items-center justify-center">
              <svg v-if="!authStore.captchaRequired" class="w-7 h-7 text-background-main" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <svg v-else class="w-7 h-7 text-background-main" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h2 class="font-display text-[15px] uppercase tracking-[0.08em] text-foreground">{{ authStore.captchaRequired ? t('login.captchaTitle') : t('login.title') }}</h2>
            <p v-if="authStore.captchaRequired" class="text-sm text-foreground-muted mt-2">
              {{ t('login.captchaDescription') }}
            </p>
          </div>

          <!-- CAPTCHA View - Browser Login -->
          <template v-if="authStore.captchaRequired">
            <div class="space-y-4">
              <!-- Browser Login Button -->
              <button
                type="button"
                @click="handleBrowserLogin"
                :disabled="isBrowserLoginLoading"
                class="w-full btn btn-primary font-mono text-[13px] tracking-[0.1em] uppercase py-4 flex items-center justify-center gap-3"
              >
                <svg v-if="isBrowserLoginLoading" class="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <svg v-else class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                </svg>
                {{ isBrowserLoginLoading ? t('login.loggingIn') : t('login.loginWithDeezer') }}
              </button>

              <!-- Error display -->
              <p v-if="authStore.error" class="text-sm text-red-400 text-center">
                {{ authStore.error }}
              </p>

              <!-- Back button -->
              <div class="flex flex-col gap-3 mt-4">
                <button
                  type="button"
                  @click="handleBackFromCaptcha"
                  class="w-full py-2 font-mono text-[11px] tracking-[0.1em] uppercase border border-white/[0.1] text-foreground-muted hover:text-foreground transition-colors flex items-center justify-center gap-2"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
                  </svg>
                  {{ t('login.backToLogin') }}
                </button>

                <button
                  type="button"
                  @click="openDeezerExternal"
                  class="text-sm text-primary-400 hover:text-primary-300 flex items-center justify-center gap-1"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  {{ t('login.openInExternalBrowser') }}
                </button>
              </div>

              <!-- Help text -->
              <div class="p-4 bg-background-tertiary border border-white/[0.06]">
                <div class="flex gap-3">
                  <svg class="w-5 h-5 text-primary-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div class="text-sm text-foreground-muted">
                    <p class="font-medium text-foreground mb-1">{{ t('login.browserLoginHelp') }}</p>
                    <p>{{ t('login.browserLoginHelpText') }}</p>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- Login Method Tabs -->
          <template v-if="!authStore.captchaRequired">
          <div class="flex mb-6 bg-background-tertiary border border-white/[0.06] p-1 gap-1">
            <button
              @click="loginMethod = 'email'"
              class="flex-1 py-2 px-4 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors"
              :class="loginMethod === 'email'
                ? 'bg-primary-500 text-background-main'
                : 'text-foreground-muted hover:text-foreground'"
            >
              {{ t('login.emailPassword') }}
            </button>
            <button
              @click="loginMethod = 'arl'"
              class="flex-1 py-2 px-4 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors"
              :class="loginMethod === 'arl'
                ? 'bg-primary-500 text-background-main'
                : 'text-foreground-muted hover:text-foreground'"
            >
              {{ t('login.arlToken') }}
            </button>
          </div>

          <!-- Form -->
          <form @submit.prevent="handleLogin" class="space-y-4">
            <!-- Email/Password Fields -->
            <template v-if="loginMethod === 'email'">
              <div>
                <label class="block text-sm font-medium mb-2">{{ t('login.email') }}</label>
                <input
                  v-model="email"
                  type="email"
                  placeholder="your@email.com"
                  class="input"
                  :class="{ 'border-red-500': authStore.error }"
                  autocomplete="email"
                />
              </div>

              <div>
                <label class="block text-sm font-medium mb-2">{{ t('login.password') }}</label>
                <div class="relative">
                  <input
                    v-model="password"
                    :type="showPassword ? 'text' : 'password'"
                    :placeholder="t('login.passwordPlaceholder')"
                    class="input pr-10"
                    :class="{ 'border-red-500': authStore.error }"
                    autocomplete="current-password"
                  />
                  <button
                    type="button"
                    @click="showPassword = !showPassword"
                    class="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground"
                  >
                    <svg v-if="showPassword" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                    <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  </button>
                </div>
              </div>
            </template>

            <!-- ARL Token Field -->
            <template v-else>
              <div>
                <label class="block text-sm font-medium mb-2">{{ t('login.arl') }}</label>
                <div class="relative">
                  <input
                    v-model="arl"
                    :type="showArl ? 'text' : 'password'"
                    :placeholder="t('login.arlPlaceholder')"
                    class="input pr-10 font-mono text-sm"
                    :class="{ 'border-red-500': authStore.error }"
                  />
                  <button
                    type="button"
                    @click="showArl = !showArl"
                    class="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground"
                  >
                    <svg v-if="showArl" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                    <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  </button>
                </div>
                <p class="font-mono text-[10px] tracking-[0.08em] text-foreground-muted mt-1">
                  {{ arl.length }} / 192 characters
                </p>
              </div>

              <!-- How to get ARL -->
              <button
                type="button"
                @click="openArlGuide"
                class="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ t('login.howToGetArl') }}
              </button>
            </template>

            <!-- Error -->
            <p v-if="authStore.error" class="text-sm text-red-400">
              {{ authStore.error }}
            </p>

            <!-- Submit -->
            <button
              type="submit"
              :disabled="(loginMethod === 'email' ? !isEmailValid : !isArlValid) || authStore.isLoading"
              class="w-full btn btn-primary font-mono text-[11px] tracking-[0.1em] uppercase py-3 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg
                v-if="authStore.isLoading"
                class="w-5 h-5 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span>{{ authStore.isLoading ? t('login.loggingIn') : t('login.login') }}</span>
            </button>
          </form>

          <!-- Info -->
          <div class="mt-6 p-4 bg-background-tertiary border border-white/[0.06]">
            <div class="flex gap-3">
              <svg class="w-5 h-5 text-primary-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div class="text-sm text-foreground-muted">
                <template v-if="loginMethod === 'email'">
                  <p class="font-medium text-foreground mb-1">{{ t('login.emailPasswordLogin') }}</p>
                  <p>{{ t('login.emailPasswordHelp') }}</p>
                </template>
                <template v-else>
                  <p class="font-medium text-foreground mb-1">{{ t('login.whatIsArl') }}</p>
                  <p>{{ t('login.arlExplainer') }}</p>
                </template>
              </div>
            </div>
          </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-active .bg-background-secondary,
.modal-leave-active .bg-background-secondary {
  transition: transform 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .bg-background-secondary {
  transform: scale(0.95) translateY(10px);
}

.modal-leave-to .bg-background-secondary {
  transform: translateY(10px);
}

@media (prefers-reduced-motion: reduce) {
  .modal-enter-active,
  .modal-leave-active,
  .modal-enter-active .bg-background-secondary,
  .modal-leave-active .bg-background-secondary {
    transition: none;
  }
  .modal-enter-from .bg-background-secondary,
  .modal-leave-to .bg-background-secondary {
    transform: none;
  }
}
</style>
