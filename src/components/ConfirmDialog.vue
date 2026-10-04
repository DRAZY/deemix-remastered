<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  show: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  confirmStyle?: 'danger' | 'warning' | 'primary'
}>(), {
  confirmStyle: 'danger'
})

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const isVisible = ref(false)

watch(() => props.show, (newVal) => {
  isVisible.value = newVal
}, { immediate: true })

function handleConfirm() {
  emit('confirm')
}

function handleCancel() {
  emit('cancel')
}

function handleBackdropClick(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    handleCancel()
  }
}

const confirmButtonClasses = {
  danger: 'border border-red-500/40 text-red-400 hover:bg-red-500 hover:text-white focus:ring-red-500',
  warning: 'border border-[#ffb454]/40 text-[#ffb454] hover:bg-[#ffb454] hover:text-background-main focus:ring-[#ffb454]',
  primary: 'bg-primary-500 text-background-main hover:bg-primary-600 focus:ring-primary-500'
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="isVisible"
        class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        @click="handleBackdropClick"
      >
        <Transition name="scale">
          <div
            v-if="isVisible"
            class="bg-background-secondary border border-white/10 shadow-2xl max-w-md w-full overflow-hidden"
            role="alertdialog"
            aria-modal="true"
            :aria-labelledby="'dialog-title'"
            :aria-describedby="'dialog-description'"
          >
            <!-- Header -->
            <div class="px-6 pt-6 pb-4">
              <div class="flex items-start gap-4">
                <!-- Warning Icon -->
                <div
                  class="flex-shrink-0 w-10 h-10 flex items-center justify-center"
                  :class="{
                    'bg-red-500/20': confirmStyle === 'danger',
                    'bg-yellow-500/20': confirmStyle === 'warning',
                    'bg-primary-500/20': confirmStyle === 'primary'
                  }"
                >
                  <svg
                    class="w-5 h-5"
                    :class="{
                      'text-red-400': confirmStyle === 'danger',
                      'text-yellow-400': confirmStyle === 'warning',
                      'text-primary-400': confirmStyle === 'primary'
                    }"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      v-if="confirmStyle === 'danger'"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                    <path
                      v-else-if="confirmStyle === 'warning'"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                    <path
                      v-else
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>

                <div class="flex-1">
                  <h3 id="dialog-title" class="font-display text-[13px] uppercase tracking-[0.08em] text-foreground">
                    {{ title }}
                  </h3>
                  <p id="dialog-description" class="mt-2 text-sm text-foreground-muted leading-relaxed">
                    {{ message }}
                  </p>
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="px-6 py-4 bg-background-tertiary border-t border-white/[0.06] flex justify-end gap-3">
              <button
                @click="handleCancel"
                class="px-4 py-2 font-mono text-[11px] tracking-[0.1em] uppercase border border-white/[0.1] text-foreground-muted hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-background-secondary"
              >
                {{ cancelText ?? t('common.cancel') }}
              </button>
              <button
                @click="handleConfirm"
                class="px-4 py-2 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors focus:outline-none focus:ring-1 focus:ring-offset-2 focus:ring-offset-background-secondary"
                :class="confirmButtonClasses[confirmStyle]"
              >
                {{ confirmText ?? t('common.confirm') }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}

.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .fade-leave-active,
  .scale-enter-active,
  .scale-leave-active {
    transition: none;
  }
  .scale-enter-from,
  .scale-leave-to {
    transform: none;
  }
}
</style>
