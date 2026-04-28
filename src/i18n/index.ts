import { createI18n } from 'vue-i18n'
import en from './locales/en.json'

// Supported locales with metadata
export const SUPPORTED_LOCALES = [
  { code: 'en', name: 'English', flag: '🇬🇧', nativeName: 'English' },
  { code: 'ar', name: 'Arabic', flag: '🇸🇦', nativeName: 'العربية', rtl: true },
  { code: 'de', name: 'German', flag: '🇩🇪', nativeName: 'Deutsch' },
  { code: 'el', name: 'Greek', flag: '🇬🇷', nativeName: 'Ελληνικά' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸', nativeName: 'Español' },
  { code: 'fil', name: 'Filipino', flag: '🇵🇭', nativeName: 'Filipino' },
  { code: 'fr', name: 'French', flag: '🇫🇷', nativeName: 'Français' },
  { code: 'hr', name: 'Croatian', flag: '🇭🇷', nativeName: 'Hrvatski' },
  { code: 'id', name: 'Indonesian', flag: '🇮🇩', nativeName: 'Bahasa Indonesia' },
  { code: 'it', name: 'Italian', flag: '🇮🇹', nativeName: 'Italiano' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷', nativeName: '한국어' },
  { code: 'pl', name: 'Polish', flag: '🇵🇱', nativeName: 'Polski' },
  { code: 'pt-br', name: 'Portuguese (Brazil)', flag: '🇧🇷', nativeName: 'Português (Brasil)' },
  { code: 'pt-pt', name: 'Portuguese', flag: '🇵🇹', nativeName: 'Português' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺', nativeName: 'Русский' },
  { code: 'sr', name: 'Serbian', flag: '🇷🇸', nativeName: 'Српски' },
  { code: 'th', name: 'Thai', flag: '🇹🇭', nativeName: 'ไทย' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷', nativeName: 'Türkçe' },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳', nativeName: 'Tiếng Việt' },
  { code: 'zh-cn', name: 'Chinese (Simplified)', flag: '🇨🇳', nativeName: '简体中文' },
  { code: 'zh-tw', name: 'Chinese (Traditional)', flag: '🇹🇼', nativeName: '繁體中文' }
] as const

export type LocaleCode = typeof SUPPORTED_LOCALES[number]['code']

// Create i18n instance with English as default
const i18n = createI18n({
  legacy: false, // Use Composition API
  locale: 'en',
  fallbackLocale: 'en',
  messages: {
    en
  }
})

// Cache for loaded locales
const loadedLocales: Set<string> = new Set(['en'])

// Dynamically load a locale
export async function loadLocale(locale: string): Promise<void> {
  // Already loaded
  if (loadedLocales.has(locale)) {
    return
  }

  // Check if locale is supported
  const isSupported = SUPPORTED_LOCALES.some(l => l.code === locale)
  if (!isSupported) {
    console.warn(`[i18n] Locale "${locale}" is not supported, falling back to English`)
    return
  }

  try {
    // Dynamic import of locale file
    const messages = await import(`./locales/${locale}.json`)
    i18n.global.setLocaleMessage(locale, messages.default)
    loadedLocales.add(locale)
    console.log(`[i18n] Loaded locale: ${locale}`)
  } catch (error) {
    console.error(`[i18n] Failed to load locale "${locale}":`, error)
  }
}

// Set the active locale
export async function setLocale(locale: string): Promise<void> {
  await loadLocale(locale)
  ;(i18n.global.locale as any).value = locale

  // Update html lang attribute (but do NOT change direction - keep LTR for all languages)
  // The original deemix-gui does not flip the UI for RTL languages
  document.documentElement.setAttribute('lang', locale)
}

// Get current locale
export function getCurrentLocale(): string {
  return i18n.global.locale.value
}

// Get locale info by code
export function getLocaleInfo(code: string) {
  return SUPPORTED_LOCALES.find(l => l.code === code)
}

export default i18n
