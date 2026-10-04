<script setup lang="ts">
import { ref, computed, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToastStore } from '../stores/toastStore'

const { t } = useI18n()
const toastStore = useToastStore()

const serverPort = ref(6595)
const folder = ref<string>('')
const isScanning = ref(false)
const isRunning = ref(false)
const dryRun = ref(false)
const cancelRequested = ref(false)

interface ScannedFile {
  path: string
  name: string
  format: 'mp3' | 'flac' | null
  isrc: string | null
  status: 'matched' | 'no-isrc' | 'unsupported' | 'unreadable'
}
interface TagChange { field: string; from: string | null; to: string }
interface FileResult {
  status: 'updated' | 'skipped' | 'failed' | 'preview' | 'pending'
  changes: TagChange[]
  unavailable?: string[]
  unchanged?: string[]
  reason?: string
  error?: string
  source?: 'deezer' | 'qobuz'  // which catalog sourced the tags (#108) — disclosed as a chip
}

const files = ref<ScannedFile[]>([])
const results = reactive<Record<string, FileResult>>({})
const progress = reactive({ current: 0, total: 0 })

// Fields the public API can source. UPC + Label default ON (the gap users hit);
// the rest are opt-in so we never silently overwrite carefully-tagged data.
const fieldKeys = [
  'albumBarcode', 'albumLabel', 'copyright', 'releaseType', 'replayGain', 'genre', 'isrc', 'year', 'date', 'bpm', 'trackLength',
  'trackNumber', 'trackTotal', 'discNumber', 'explicitLyrics', 'albumArtist', 'album', 'artist', 'title'
] as const
type FieldKey = typeof fieldKeys[number]
const fields = reactive<Record<FieldKey, boolean>>({
  albumBarcode: true, albumLabel: true, copyright: true, releaseType: true, replayGain: false, genre: false, isrc: false, year: false, date: false,
  bpm: false, trackLength: false, trackNumber: false, trackTotal: false, discNumber: false,
  explicitLyrics: false, albumArtist: false, album: false, artist: false, title: false
})

const matchedFiles = computed(() => files.value.filter(f => f.status === 'matched'))
const skippedCount = computed(() => files.value.filter(f => f.status !== 'matched').length)
const anyFieldSelected = computed(() => fieldKeys.some(k => fields[k]))

// Per-file selection — lets users retag a subset of the folder, or just the
// file(s) that errored, instead of re-running the whole list.
const selected = reactive<Record<string, boolean>>({})
const selectedFiles = computed(() => matchedFiles.value.filter(f => selected[f.path]))
const allSelected = computed<boolean>({
  get: () => matchedFiles.value.length > 0 && matchedFiles.value.every(f => selected[f.path]),
  set: (v: boolean) => { matchedFiles.value.forEach(f => { selected[f.path] = v }) }
})
function selectFailedOnly() {
  matchedFiles.value.forEach(f => { selected[f.path] = results[f.path]?.status === 'failed' })
}

const summary = computed(() => {
  let updated = 0, skipped = 0, failed = 0
  for (const r of Object.values(results)) {
    if (r.status === 'updated' || r.status === 'preview') updated++
    else if (r.status === 'skipped') skipped++
    else if (r.status === 'failed') failed++
  }
  return { updated, skipped, failed }
})

onMounted(async () => {
  if (window.electronAPI) serverPort.value = await window.electronAPI.getServerPort()
})

function apiUrl(path: string) { return `http://127.0.0.1:${serverPort.value}${path}` }

async function pickFolder() {
  if (!window.electronAPI?.selectFolder) return
  const picked = await window.electronAPI.selectFolder(folder.value || undefined)
  if (picked) {
    folder.value = picked
    files.value = []
    Object.keys(results).forEach(k => delete results[k])
    Object.keys(selected).forEach(k => delete selected[k])
  }
}

async function scan() {
  if (!folder.value) return
  isScanning.value = true
  files.value = []
  Object.keys(results).forEach(k => delete results[k])
  try {
    const res = await fetch(apiUrl('/api/retag/scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folder.value })
    })
    const data = await res.json()
    if (data.error) { toastStore.error(data.error); return }
    files.value = data.files || []
    // Default to all matched files selected — one click still retags everything.
    Object.keys(selected).forEach(k => delete selected[k])
    matchedFiles.value.forEach(f => { selected[f.path] = true })
    if (matchedFiles.value.length === 0) {
      toastStore.info(t('retag.noIsrcWarning'))
    }
  } catch (e: any) {
    toastStore.error(e?.message || t('common.requestFailed'))
  } finally {
    isScanning.value = false
  }
}

function buildSelectedFields(): Record<string, boolean> {
  const selectedFields: Record<string, boolean> = {}
  fieldKeys.forEach(k => { if (fields[k]) selectedFields[k] = true })
  return selectedFields
}

// Retag one file, writing its result. Shared by the full run, "retry failed",
// and per-file retry — so a transient Deezer timeout on one track doesn't force
// a re-run of the whole list.
async function retagOne(path: string, preview: boolean, selectedFields: Record<string, boolean>) {
  results[path] = { status: 'pending', changes: [] }
  try {
    const res = await fetch(apiUrl('/api/retag/file'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, folder: folder.value, fields: selectedFields, dryRun: preview })
    })
    const data = await res.json()
    results[path] = data.error
      ? { status: 'failed', changes: [], error: data.error }
      : { status: data.status, changes: data.changes || [], unavailable: data.unavailable || [], unchanged: data.unchanged || [], reason: data.reason, error: data.error }
  } catch (e: any) {
    results[path] = { status: 'failed', changes: [], error: e?.message || t('common.requestFailed') }
  }
}

// Sequentially retag a set of files (does NOT clear existing results, so a retry
// leaves the already-succeeded rows alone). The full run clears first; retries don't.
async function runTargets(targets: ScannedFile[], preview: boolean) {
  if (targets.length === 0 || !anyFieldSelected.value) return
  dryRun.value = preview
  isRunning.value = true
  cancelRequested.value = false
  progress.current = 0
  progress.total = targets.length
  const selectedFields = buildSelectedFields()

  for (const f of targets) {
    if (cancelRequested.value) break
    await retagOne(f.path, preview, selectedFields)
    progress.current++
    // Politeness: small gap between public-API calls to avoid hammering Deezer.
    await new Promise(r => setTimeout(r, 250))
  }

  isRunning.value = false
  if (!cancelRequested.value && !preview) {
    toastStore.success(t('retag.summary', summary.value))
  }
}

async function run(preview: boolean) {
  if (selectedFiles.value.length === 0 || !anyFieldSelected.value) return
  await runTargets(selectedFiles.value, preview)
}

// Files that errored (e.g. a Deezer timeout) in the last run.
const failedFiles = computed(() => matchedFiles.value.filter(f => results[f.path]?.status === 'failed'))

// Re-run only the failed files, reusing the last preview/write mode.
async function retryFailed() {
  if (failedFiles.value.length === 0 || isRunning.value) return
  await runTargets([...failedFiles.value], dryRun.value)
}

// Re-run a single file without disturbing the rest (no full progress bar).
async function retryOne(f: ScannedFile) {
  if (isRunning.value || results[f.path]?.status === 'pending' || !anyFieldSelected.value) return
  await retagOne(f.path, dryRun.value, buildSelectedFields())
}

function cancel() { cancelRequested.value = true }

function resultClass(status?: string) {
  if (status === 'updated' || status === 'preview') return 'text-green-400'
  if (status === 'failed') return 'text-red-400'
  if (status === 'skipped') return 'text-foreground-muted'
  return 'text-foreground-muted'
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-4xl mx-auto p-6 space-y-6">
      <!-- Header -->
      <div>
        <h1 class="font-display uppercase text-[22px] tracking-[0.02em]">{{ t('retag.title') }}</h1>
        <p class="text-foreground-muted text-sm mt-1">{{ t('retag.subtitle') }}</p>
        <p class="text-xs text-foreground-muted mt-1">{{ t('retag.freemodeNote') }}</p>
      </div>

      <!-- Folder picker — PATH command bar -->
      <div class="bg-background-secondary/60 border border-white/[0.08] p-5 space-y-3">
        <label class="block font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted">{{ t('retag.folder') }}</label>
        <div class="flex gap-2">
          <div class="flex items-stretch flex-1 min-w-0 border border-white/[0.1] bg-background-main focus-within:border-primary-500/50 transition-colors">
            <span class="flex items-center px-3 font-mono text-[10.5px] font-bold tracking-[0.1em] bg-primary-500 text-background-main select-none">PATH</span>
            <input
              :value="folder"
              readonly
              :placeholder="t('retag.noFolder')"
              class="flex-1 min-w-0 bg-transparent outline-none font-mono text-[13px] px-3 text-foreground placeholder:text-foreground-muted"
            />
          </div>
          <button class="px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.12em] border border-white/[0.08] text-foreground-muted hover:text-primary-500 hover:border-primary-500/50 transition-colors whitespace-nowrap" @click="pickFolder">{{ t('retag.selectFolder') }}</button>
          <button class="btn btn-primary font-mono text-[11px] tracking-[0.1em] uppercase disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap" :disabled="!folder || isScanning" @click="scan">
            {{ isScanning ? t('retag.scanning') : t('retag.scan') }}
          </button>
        </div>
        <p v-if="files.length" class="font-mono text-[10px] tracking-[0.04em] text-foreground-muted">
          {{ t('retag.filesFound', { matched: matchedFiles.length, skipped: skippedCount, total: files.length }) }}
        </p>
      </div>

      <!-- Tag selection -->
      <div v-if="matchedFiles.length" class="bg-background-secondary/60 border border-white/[0.08] p-5 space-y-3">
        <div>
          <h2 class="font-display text-[13px] uppercase tracking-[0.06em]">{{ t('retag.fields') }}</h2>
          <p class="font-mono text-[10px] tracking-[0.04em] text-foreground-muted mt-1">{{ t('retag.fieldsHint') }}</p>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <label
            v-for="key in fieldKeys"
            :key="key"
            class="flex items-center gap-2 text-sm cursor-pointer select-none"
          >
            <input type="checkbox" v-model="fields[key]" class="accent-primary-500" />
            <span>{{ t('settings.tags.' + key) }}</span>
          </label>
        </div>
      </div>

      <!-- Actions -->
      <div v-if="matchedFiles.length" class="flex items-center gap-2">
        <button
          class="btn btn-secondary font-mono text-[10.5px] tracking-[0.1em] uppercase disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="isRunning || !anyFieldSelected || !selectedFiles.length"
          @click="run(true)"
        >
          {{ isRunning && dryRun ? t('retag.previewing') : t('retag.preview') }}
        </button>
        <button
          class="btn btn-primary font-mono text-[10.5px] tracking-[0.1em] uppercase disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="isRunning || !anyFieldSelected || !selectedFiles.length"
          @click="run(false)"
        >
          {{ isRunning && !dryRun ? t('retag.running') : t('retag.run', { count: selectedFiles.length }) }}
        </button>
        <button v-if="isRunning" class="btn btn-ghost font-mono text-[10.5px] tracking-[0.1em] uppercase" @click="cancel">{{ t('retag.cancel') }}</button>
        <button
          v-if="!isRunning && failedFiles.length"
          class="btn btn-ghost font-mono text-[10.5px] tracking-[0.1em] uppercase text-red-400"
          @click="retryFailed"
        >
          {{ t('retag.retryFailed', { count: failedFiles.length }) }}
        </button>
        <div v-if="isRunning" class="font-mono text-[11px] tracking-[0.08em] text-foreground-muted ml-2">
          {{ progress.current }} / {{ progress.total }}
        </div>
      </div>

      <!-- Progress bar -->
      <div v-if="isRunning" class="w-full h-2 bg-background-main border border-white/[0.06] overflow-hidden">
        <div
          class="h-full bg-primary-500 transition-all duration-200"
          :style="{ width: progress.total ? (progress.current / progress.total * 100) + '%' : '0%' }"
        ></div>
      </div>

      <!-- Summary -->
      <div v-if="Object.keys(results).length" class="font-mono text-[11px] tracking-[0.04em]">
        <span class="text-green-400">{{ summary.updated }} {{ dryRun ? t('retag.previewWouldChange') : t('retag.resultUpdated') }}</span>
        · <span class="text-foreground-muted">{{ summary.skipped }} {{ t('retag.resultSkipped') }}</span>
        · <span class="text-red-400">{{ summary.failed }} {{ t('retag.resultFailed') }}</span>
      </div>

      <!-- Per-file results -->
      <div v-if="matchedFiles.length" class="bg-background-secondary/60 border border-white/[0.08] divide-y divide-white/[0.06]">
        <!-- Selection header: pick a subset, or just the failed ones, to retag -->
        <div class="p-3 flex items-center gap-3 font-mono text-[10px] tracking-[0.04em] text-foreground-muted">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" v-model="allSelected" :disabled="isRunning" class="accent-primary-500" />
            <span>{{ t('retag.selectAll') }}</span>
          </label>
          <span>· {{ t('retag.selectedCount', { count: selectedFiles.length }) }}</span>
          <button
            v-if="failedFiles.length && !isRunning"
            class="text-red-400 hover:underline uppercase tracking-[0.08em]"
            @click="selectFailedOnly"
          >
            {{ t('retag.selectFailed', { count: failedFiles.length }) }}
          </button>
        </div>
        <div
          v-for="f in matchedFiles"
          :key="f.path"
          class="p-3 flex items-start justify-between gap-3"
        >
          <input
            type="checkbox"
            v-model="selected[f.path]"
            :disabled="isRunning"
            class="accent-primary-500 mt-1 flex-shrink-0"
          />
          <div class="min-w-0 flex-1">
            <p class="text-sm truncate">{{ f.name }}</p>
            <p class="font-mono text-[11px] text-foreground-muted truncate">
              {{ f.format?.toUpperCase() }} · ISRC {{ f.isrc }}
            </p>
            <div v-if="results[f.path]?.changes?.length" class="mt-1 space-y-0.5">
              <p
                v-for="c in results[f.path].changes"
                :key="c.field"
                class="text-xs text-foreground-muted"
              >
                <span class="text-foreground">{{ t('settings.tags.' + c.field) }}</span>:
                <span class="line-through opacity-60">{{ c.from || '—' }}</span>
                → <span class="text-green-400">{{ c.to }}</span>
              </p>
            </div>
            <p v-else-if="results[f.path]?.error" class="text-xs text-red-400 mt-1">
              {{ results[f.path].error }}
            </p>
            <!-- Tags already matching Deezer — shown so they don't look skipped -->
            <p
              v-if="results[f.path]?.unchanged?.length"
              class="text-xs text-green-400/70 mt-1"
            >
              ✓ {{ t('retag.alreadyCorrect') }}: {{ (results[f.path]?.unchanged || []).map(k => t('settings.tags.' + k)).join(', ') }}
            </p>
            <!-- Fields Deezer has no value for — shown even alongside changes -->
            <p
              v-if="results[f.path]?.unavailable?.length"
              class="text-xs text-amber-400/80 mt-1"
            >
              {{ t('retag.notOnDeezer') }}: {{ (results[f.path]?.unavailable || []).map(k => t('settings.tags.' + k)).join(', ') }}
            </p>
          </div>
          <div v-if="results[f.path]" class="flex items-center gap-2 flex-shrink-0">
            <button
              v-if="results[f.path].status === 'failed' && !isRunning"
              class="font-mono text-[10px] tracking-[0.08em] uppercase text-primary-400 hover:underline"
              @click="retryOne(f)"
            >
              {{ t('retag.retry') }}
            </button>
            <!-- Cross-catalog disclosure (#108): tags sourced from Qobuz's catalog
                 because Deezer had no match for this ISRC -->
            <span
              v-if="results[f.path].source === 'qobuz'"
              v-tooltip="t('retag.viaQobuzTip')"
              class="font-mono text-[9px] px-1 py-px border border-qobuz-500/50 text-qobuz-400 bg-qobuz-500/10 tracking-[0.08em] cursor-help"
            >Q</span>
            <span
              class="font-mono text-[10px] tracking-[0.08em] uppercase font-medium"
              :class="resultClass(results[f.path].status)"
            >
              {{ results[f.path].status === 'pending' ? '…' :
                 results[f.path].status === 'preview' ? t('retag.previewed') :
                 t('retag.result' + results[f.path].status.charAt(0).toUpperCase() + results[f.path].status.slice(1)) }}
            </span>
          </div>
        </div>
      </div>

      <!-- No-ISRC notice -->
      <p v-if="files.length && skippedCount > 0" class="font-mono text-[10px] tracking-[0.04em] text-foreground-muted">
        {{ t('retag.noIsrcWarning') }}
      </p>
    </div>
  </div>
</template>
