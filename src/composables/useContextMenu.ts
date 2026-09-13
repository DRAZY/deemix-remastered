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

  async function copyToClipboard(text: string, label?: string) {
    try {
      await navigator.clipboard.writeText(text)
      toastStore.success(label ? `${label} copied` : 'Copied to clipboard')
    } catch (err) {
      // Fallback for older browsers or when clipboard API fails
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand('copy')
        toastStore.success(label ? `${label} copied` : 'Copied to clipboard')
      } catch {
        toastStore.error(i18n.global.t('notifications.copyFailed'))
      }
      document.body.removeChild(textarea)
    }
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
