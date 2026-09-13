<script setup lang="ts">
import { useToastStore } from '../stores/toastStore'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const toastStore = useToastStore()

const iconColor: Record<string, string> = {
  success: 'text-[#22c55e]',
  error: 'text-[#ef4444]',
  info: 'text-primary-500',
  warning: 'text-[#ffb454]'
}

const bgColor: Record<string, string> = {
  success: 'bg-background-secondary border-l-2 border-l-[#22c55e]',
  error: 'bg-background-secondary border-l-2 border-l-[#ef4444]',
  info: 'bg-background-secondary border-l-2 border-l-primary-500',
  warning: 'bg-background-secondary border-l-2 border-l-[#ffb454]'
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toastStore.toasts"
          :key="toast.id"
          class="flex items-start gap-3 px-4 py-3 border border-white/[0.08] shadow-lg"
          :class="bgColor[toast.type]"
        >
          <!-- Icon -->
          <div :class="iconColor[toast.type]" class="flex-shrink-0 mt-0.5">
            <!-- Success icon -->
            <svg v-if="toast.type === 'success'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <!-- Error icon -->
            <svg v-else-if="toast.type === 'error'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <!-- Warning icon -->
            <svg v-else-if="toast.type === 'warning'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <!-- Info icon -->
            <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>

          <!-- Message -->
          <p class="text-sm text-foreground flex-1">{{ toast.message }}</p>

          <!-- Close button -->
          <button
            @click="toastStore.remove(toast.id)"
            class="flex-shrink-0 text-foreground-muted hover:text-foreground transition-colors"
            :aria-label="t('accessibility.closeNotification')"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(100%);
}

.toast-move {
  transition: transform 0.3s ease;
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: opacity 0.3s ease;
  }
  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
  .toast-move {
    transition: none;
  }
}
</style>
