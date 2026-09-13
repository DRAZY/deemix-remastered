import { ref } from 'vue'
import { useToastStore } from '../stores/toastStore'
import i18n from '../i18n'

export interface ContextMenuState {
  show: boolean
  x: number
  y: number
}

export function useContextMenu() {
  const toastStore = useToastStore()

  const menuState = ref<ContextMenuState>({
    show: false,
    x: 0,
    y: 0
  })

  function openMenu(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    menuState.value = {
      show: true,
      x: e.clientX,
      y: e.clientY
    }
  }

  function closeMenu() {
    menuState.value.show = false
  }

  // Every copy action in the app funnels through here. Order of preference:
  // the native Electron clipboard (no focus or permission constraints), then
  // the browser clipboard API, then the legacy execCommand path. Success is
  // only reported when a write actually succeeded: the old version toasted
  // "copied" after execCommand regardless of its result, so a failed write
  // left the previous link on the clipboard while the UI claimed otherwise
  // (alex5908, discussion #105).
  async function copyToClipboard(text: string, label?: string) {
    const ok = await writeClipboard(text)
    if (ok) {
      toastStore.success(label ? i18n.global.t('notifications.copiedLabel', { label }) : i18n.global.t('notifications.copiedToClipboard'))
    } else {
      toastStore.error(i18n.global.t('notifications.copyFailed'))
    }
  }

  async function writeClipboard(text: string): Promise<boolean> {
    const native = (window as any).electronAPI?.clipboardWriteText
    if (typeof native === 'function') {
      try {
        if (await native(text) === true) return true
      } catch { /* fall through to the browser API */ }
    }
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through to execCommand */ }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    document.body.removeChild(textarea)
    return ok
  }

  async function pasteFromClipboard(): Promise<string | null> {
    try {
      const text = await navigator.clipboard.readText()
      return text
    } catch (err) {
      toastStore.error(i18n.global.t('notifications.pasteFailed'))
      return null
    }
  }

  return {
    menuState,
    openMenu,
    closeMenu,
    copyToClipboard,
    pasteFromClipboard
  }
}
