import { defineStore } from 'pinia'
import { ref } from 'vue'

export type UpdateSchedule = 'hour' | 'sixHours' | 'day' | 'launch' | 'never'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  current: string
  latest?: string
  notes?: string
  progress?: number
  error?: string
  manualReason?: 'unsigned' | 'readonly' | 'dev' | 'unsupported' | 'failed'
  busy?: boolean
}

const SKIPPED_KEY = 'deemix-update-skipped-version'
// "Update later" asks again at the next launch, or after this long if the app stays open.
const LATER_MS = 24 * 60 * 60 * 1000

function readSkipped(): string | null {
  try {
    return localStorage.getItem(SKIPPED_KEY)
  } catch {
    return null
  }
}

export const useUpdateStore = defineStore('update', () => {
  const status = ref<UpdateStatus>({ state: 'idle', current: '' })
  const dialogOpen = ref(false)
  const skippedVersion = ref<string | null>(readSkipped())
  let laterAt = 0
  let started = false

  function apply(next: UpdateStatus) {
    const wasDownloading = status.value.state === 'downloading'
    status.value = next
    // The download the user asked for has an outcome (ready, or a failed install
    // that comes back as 'available' with the reason): always show it.
    if (wasDownloading && (next.state === 'ready' || next.state === 'available')) {
      dialogOpen.value = true
      return
    }
    if (next.state !== 'available') return
    const skipped = next.latest === skippedVersion.value
    const snoozed = Date.now() - laterAt < LATER_MS
    if (!skipped && !snoozed) dialogOpen.value = true
  }

  async function init() {
    if (started || !window.electronAPI?.updates) return
    started = true
    window.electronAPI.updates.onStatus(apply)
    status.value = await window.electronAPI.updates.getStatus()
  }

  function setSchedule(every: UpdateSchedule) {
    window.electronAPI?.updates?.setSchedule(every)
  }

  /** "Check now" in Settings: an answer the user asked for, so a skipped or snoozed version still shows. */
  async function checkNow() {
    const result = await window.electronAPI?.updates?.check()
    if (result?.state === 'available') dialogOpen.value = true
  }

  function updateNow() {
    window.electronAPI?.updates?.install()
    if (status.value.manualReason) dialogOpen.value = false
  }

  function later() {
    laterAt = Date.now()
    dialogOpen.value = false
  }

  function skip() {
    skippedVersion.value = status.value.latest ?? null
    try {
      if (skippedVersion.value) localStorage.setItem(SKIPPED_KEY, skippedVersion.value)
    } catch {
      // the choice then lasts this session only
    }
    dialogOpen.value = false
  }

  function restartLater() {
    window.electronAPI?.updates?.deferRestart()
    dialogOpen.value = false
  }

  return { status, dialogOpen, skippedVersion, init, setSchedule, checkNow, updateNow, later, skip, restartLater }
})
