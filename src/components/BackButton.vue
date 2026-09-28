<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router'
import { onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

// Determine if we should show the back button (not on home page)
const shouldShow = computed(() => route.path !== '/')

function goBack() {
  // Check if there's history to go back to, otherwise go home
  if (window.history.length > 2) {
    router.back()
  } else {
    router.push('/')
  }
}

// Keyboard shortcut: Escape or Backspace (when not in input) goes back
function handleKeydown(e: KeyboardEvent) {
  // Don't trigger if user is typing in an input
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return
  }

  if (e.key === 'Escape' || (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey)) {
    e.preventDefault()
    goBack()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <button
    v-if="shouldShow"
    @click="goBack"
    class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-foreground-muted hover:text-foreground hover:bg-white/5 transition-all mb-2 group"
    :title="t('common.goBackEsc')"
  >
    <svg
      class="w-5 h-5 transition-transform group-hover:-translate-x-1"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
    </svg>
    <span class="text-sm font-medium">{{ t('common.back') }}</span>
    <kbd class="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono bg-white/10 rounded text-foreground-muted ml-1">
      Esc
    </kbd>
  </button>
</template>
