<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfileStore } from '../stores/profileStore'
import { useToastStore } from '../stores/toastStore'

const { t } = useI18n()
const profileStore = useProfileStore()
const toastStore = useToastStore()

const showSaveDialog = ref(false)
const newProfileName = ref('')
const newProfileDescription = ref('')
const editingProfileId = ref<string | null>(null)
const editName = ref('')
const editDescription = ref('')

function applyProfile(id: string) {
  profileStore.applyProfile(id)
  toastStore.addToast(t('settings.profiles.applied'), 'success')
}

function saveCurrentProfile() {
  if (!newProfileName.value.trim()) return
  profileStore.saveCurrentAsProfile(newProfileName.value.trim(), newProfileDescription.value.trim())
  toastStore.addToast(t('settings.profiles.saved'), 'success')
  newProfileName.value = ''
  newProfileDescription.value = ''
  showSaveDialog.value = false
}

function startEdit(id: string) {
  const profile = profileStore.profiles.find(p => p.id === id)
  if (!profile || profile.isBuiltIn) return
  editingProfileId.value = id
  editName.value = profile.name
  editDescription.value = profile.description
}

function saveEdit() {
  if (!editingProfileId.value || !editName.value.trim()) return
  profileStore.renameProfile(editingProfileId.value, editName.value.trim(), editDescription.value.trim())
  editingProfileId.value = null
}

function cancelEdit() {
  editingProfileId.value = null
}

function deleteProfile(id: string) {
  profileStore.deleteProfile(id)
  toastStore.addToast(t('settings.profiles.deleted'), 'success')
}

function duplicateProfile(id: string) {
  profileStore.duplicateProfile(id)
  toastStore.addToast(t('settings.profiles.duplicated'), 'success')
}

function exportProfile(id: string) {
  const json = profileStore.exportProfile(id)
  if (!json) return
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const profile = profileStore.profiles.find(p => p.id === id)
  a.href = url
  a.download = `deemix-profile-${profile?.name?.toLowerCase().replace(/\s+/g, '-') || 'export'}.json`
  a.click()
  URL.revokeObjectURL(url)
  toastStore.addToast(t('settings.profiles.exported'), 'success')
}

async function importProfile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    const text = await file.text()
    const result = profileStore.importProfile(text)
    if (result) {
      toastStore.addToast(t('settings.profiles.imported', { name: result.name }), 'success')
    } else {
      toastStore.addToast(t('settings.profiles.importFailed'), 'error')
    }
  }
  input.click()
}
</script>

<template>
  <div class="space-y-4">
    <!-- Active Profile Indicator -->
    <div v-if="profileStore.activeProfile" class="flex items-center gap-2 text-sm text-foreground-muted">
      <svg class="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
      </svg>
      <span>{{ t('settings.profiles.activeProfile') }}: <strong class="text-foreground">{{ profileStore.activeProfile.name }}</strong></span>
      <span v-if="profileStore.isModified" class="text-yellow-400 text-xs ml-1">({{ t('settings.profiles.modified') }})</span>
      <button
        v-if="profileStore.isModified"
        @click="profileStore.resetToProfile()"
        class="text-xs text-primary-400 hover:text-primary-300 ml-2"
      >
        {{ t('settings.profiles.resetToProfile') }}
      </button>
    </div>

    <!-- Built-in Preset Buttons -->
    <div>
      <label class="block text-sm font-medium mb-3">{{ t('settings.profiles.presets') }}</label>
      <div class="grid grid-cols-3 gap-3">
        <button
          v-for="profile in profileStore.builtInProfiles"
          :key="profile.id"
          @click="applyProfile(profile.id)"
          class="flex flex-col items-center gap-1 px-4 py-3 rounded-lg transition-all duration-200 border-2"
          :class="profileStore.activeProfileId === profile.id
            ? 'border-primary-500 bg-primary-500/10 text-primary-400'
            : 'border-transparent bg-background-main hover:bg-background-tertiary text-foreground-muted'"
        >
          <svg v-if="profile.id === 'builtin_audiophile'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
          </svg>
          <svg v-else-if="profile.id === 'builtin_quick'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
          </svg>
          <span class="font-medium text-sm">{{ profile.name }}</span>
          <span class="text-xs text-foreground-muted text-center leading-tight">{{ profile.description }}</span>
        </button>
      </div>
    </div>

    <!-- Custom Profiles -->
    <div v-if="profileStore.customProfiles.length > 0">
      <label class="block text-sm font-medium mb-3">{{ t('settings.profiles.customProfiles') }}</label>
      <div class="space-y-2">
        <div
          v-for="profile in profileStore.customProfiles"
          :key="profile.id"
          class="flex items-center gap-3 px-4 py-3 rounded-lg bg-background-main border-2 transition-all duration-200"
          :class="profileStore.activeProfileId === profile.id
            ? 'border-primary-500/50'
            : 'border-transparent'"
        >
          <!-- Editing mode -->
          <template v-if="editingProfileId === profile.id">
            <div class="flex-1 space-y-2">
              <input
                v-model="editName"
                class="w-full px-2 py-1 bg-background-tertiary rounded text-sm"
                @keyup.enter="saveEdit"
                @keyup.escape="cancelEdit"
              />
              <input
                v-model="editDescription"
                class="w-full px-2 py-1 bg-background-tertiary rounded text-xs text-foreground-muted"
                :placeholder="t('settings.profiles.descriptionPlaceholder')"
                @keyup.enter="saveEdit"
                @keyup.escape="cancelEdit"
              />
            </div>
            <button @click="saveEdit" class="text-green-400 hover:text-green-300 p-1">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
            </button>
            <button @click="cancelEdit" class="text-red-400 hover:text-red-300 p-1">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </template>

          <!-- Display mode -->
          <template v-else>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-sm truncate">{{ profile.name }}</div>
              <div v-if="profile.description" class="text-xs text-foreground-muted truncate">{{ profile.description }}</div>
            </div>
            <button
              @click="applyProfile(profile.id)"
              class="px-3 py-1 text-xs font-medium rounded bg-primary-500/20 text-primary-400 hover:bg-primary-500/30 transition-colors"
            >
              {{ t('settings.profiles.apply') }}
            </button>
            <button @click="startEdit(profile.id)" class="text-foreground-muted hover:text-foreground p-1" :title="t('settings.profiles.rename')">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
            <button @click="duplicateProfile(profile.id)" class="text-foreground-muted hover:text-foreground p-1" :title="t('settings.profiles.duplicate')">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            </button>
            <button @click="exportProfile(profile.id)" class="text-foreground-muted hover:text-foreground p-1" :title="t('settings.profiles.export')">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            </button>
            <button @click="deleteProfile(profile.id)" class="text-red-400/60 hover:text-red-400 p-1" :title="t('settings.profiles.delete')">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- Action Buttons -->
    <div class="flex gap-2 pt-2">
      <button
        @click="showSaveDialog = !showSaveDialog"
        class="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-primary-500/20 text-primary-400 hover:bg-primary-500/30 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
        {{ t('settings.profiles.saveAsCurrent') }}
      </button>
      <button
        @click="importProfile"
        class="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-background-main text-foreground-muted hover:text-foreground hover:bg-background-tertiary transition-colors"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
        {{ t('settings.profiles.import') }}
      </button>
    </div>

    <!-- Save Profile Form -->
    <div v-if="showSaveDialog" class="p-4 rounded-lg bg-background-main border border-zinc-700 space-y-3">
      <input
        v-model="newProfileName"
        class="w-full px-3 py-2 bg-background-tertiary rounded-lg text-sm"
        :placeholder="t('settings.profiles.namePlaceholder')"
        @keyup.enter="saveCurrentProfile"
      />
      <input
        v-model="newProfileDescription"
        class="w-full px-3 py-2 bg-background-tertiary rounded-lg text-xs text-foreground-muted"
        :placeholder="t('settings.profiles.descriptionPlaceholder')"
        @keyup.enter="saveCurrentProfile"
      />
      <div class="flex gap-2">
        <button
          @click="saveCurrentProfile"
          :disabled="!newProfileName.trim()"
          class="px-4 py-2 text-sm font-medium rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ t('common.save') }}
        </button>
        <button
          @click="showSaveDialog = false"
          class="px-4 py-2 text-sm rounded-lg text-foreground-muted hover:text-foreground transition-colors"
        >
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
  </div>
</template>
