import { ref, onMounted } from 'vue'

const isOnline = ref(navigator.onLine)
const wasOffline = ref(false) // Track if we were recently offline

// Shared state - listeners only added once
let listenersAdded = false
let wasOfflineTimeout: ReturnType<typeof setTimeout> | null = null

function handleOnline() {
  isOnline.value = true
  // If we were offline, flag it so we can show "back online" message
  if (wasOffline.value) {
    // Clear any existing timeout to prevent memory leaks
    if (wasOfflineTimeout) {
      clearTimeout(wasOfflineTimeout)
    }
    wasOfflineTimeout = setTimeout(() => {
      wasOffline.value = false
      wasOfflineTimeout = null
    }, 3000) // Clear the flag after 3 seconds
  }
}

function handleOffline() {
  isOnline.value = false
  wasOffline.value = true
}

export function useNetworkStatus() {
  onMounted(() => {
    if (!listenersAdded) {
      window.addEventListener('online', handleOnline)
      window.addEventListener('offline', handleOffline)
      listenersAdded = true
    }
    // Update initial state
    isOnline.value = navigator.onLine
  })

  return {
    isOnline,
    wasOffline
  }
}
