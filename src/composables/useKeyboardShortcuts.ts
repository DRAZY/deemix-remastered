import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import i18n from '../i18n'

interface ShortcutHandler {
  key: string
  ctrl?: boolean
  meta?: boolean  // Cmd on Mac
  shift?: boolean
  alt?: boolean
  handler: () => void
  description: string
}

// Shared state for the keyboard shortcuts help modal
const showShortcutsHelp = ref(false)

export function useKeyboardShortcuts() {
  const router = useRouter()
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0

  // Define shortcuts
  const shortcuts: ShortcutHandler[] = [
    {
      key: 'k',
      ctrl: true,
      meta: true,
      handler: () => focusSearch(),
      get description() { return i18n.global.t('shortcuts.focusSearch') }
    },
    {
      key: 'f',
      ctrl: true,
      meta: true,
      handler: () => focusSearch(),
      get description() { return i18n.global.t('shortcuts.focusSearchAlt') }
    },
    {
      key: 'd',
      ctrl: true,
      meta: true,
      handler: () => router.push('/downloads'),
      get description() { return i18n.global.t('shortcuts.goToDownloads') }
    },
    {
      key: ',',
      ctrl: true,
      meta: true,
      handler: () => router.push('/settings'),
      get description() { return i18n.global.t('shortcuts.openSettings') }
    },
    {
      key: 'h',
      ctrl: true,
      meta: true,
      handler: () => router.push('/'),
      get description() { return i18n.global.t('shortcuts.goToHome') }
    },
    {
      key: '/',
      ctrl: true,
      meta: true,
      handler: () => { showShortcutsHelp.value = true },
      get description() { return i18n.global.t('shortcuts.showShortcuts') }
    },
    {
      key: '?',
      ctrl: true,
      meta: true,
      shift: true,
      handler: () => { showShortcutsHelp.value = true },
      get description() { return i18n.global.t('shortcuts.showShortcuts') }
    },
    {
      key: 'Escape',
      handler: () => closeModals(),
      get description() { return i18n.global.t('shortcuts.closeModals') }
    }
  ]

  function focusSearch() {
    // Try to find and focus the search input
    const searchInput = document.querySelector('input[type="search"], input[placeholder*="Search"]') as HTMLInputElement
    if (searchInput) {
      searchInput.focus()
      searchInput.select()
    } else {
      // If no search input on current page, navigate to search
      router.push('/search')
    }
  }

  function closeModals() {
    // Emit a custom event that modals can listen to
    const event = new CustomEvent('keyboard:escape')
    document.dispatchEvent(event)

    // Also try to find and click any visible close buttons
    const closeButtons = document.querySelectorAll('[data-close-modal], .modal-close, [aria-label="Close"]')
    closeButtons.forEach(btn => {
      const el = btn as HTMLElement
      if (el.offsetParent !== null) { // Check if visible
        el.click()
      }
    })
  }

  function handleKeyDown(event: KeyboardEvent) {
    // Don't trigger shortcuts when typing in inputs (except Escape)
    const target = event.target as HTMLElement
    const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

    if (isInputField && event.key !== 'Escape') {
      return
    }

    for (const shortcut of shortcuts) {
      const modifierMatch = isMac
        ? (shortcut.meta && event.metaKey) || (shortcut.ctrl && event.ctrlKey)
        : (shortcut.ctrl && event.ctrlKey)

      const needsModifier = shortcut.ctrl || shortcut.meta
      const hasModifier = event.ctrlKey || event.metaKey

      // If shortcut needs modifier, check it matches
      // If shortcut doesn't need modifier, make sure no modifier is pressed
      if (needsModifier && !modifierMatch) continue
      if (!needsModifier && hasModifier) continue

      // Check shift/alt if specified
      if (shortcut.shift && !event.shiftKey) continue
      if (shortcut.alt && !event.altKey) continue

      // Check key match (case-insensitive)
      if (event.key.toLowerCase() === shortcut.key.toLowerCase()) {
        event.preventDefault()
        shortcut.handler()
        return
      }
    }
  }

  // Lifecycle hooks
  onMounted(() => {
    document.addEventListener('keydown', handleKeyDown)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', handleKeyDown)
  })

  return {
    shortcuts,
    isMac,
    showShortcutsHelp
  }
}
