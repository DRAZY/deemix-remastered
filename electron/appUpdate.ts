import { app, autoUpdater as nativeUpdater, BrowserWindow, powerMonitor, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'
import { installMode, isDeveloperIdSigned, newer, parkedExePath, portableAsset, verifyDigest, type InstallMode, type ManualReason, type ReleaseAsset } from './updatePlan'

/**
 * App updates, from GitHub Releases. A check 15 s after launch, then on the schedule the user picked in Settings,
 * again when the machine wakes past the interval, and a manual one from Settings. Results go to the renderer as
 * `update:status`; the renderer owns the Update now / Update later / Skip this version dialog. Nothing is
 * downloaded until the user says so.
 *
 * Installing (see updatePlan.installMode): "Update now" downloads with progress, then restarts into the new version.
 * If downloads are running it waits and offers "Restart now" instead, so an update never cuts one off.
 * Anything that cannot update in place (ad-hoc Mac builds, .deb, AUR, a read-only portable folder) or whose
 * in-place install failed opens the release page.
 */

export type UpdateSchedule = 'hour' | 'sixHours' | 'day' | 'launch' | 'never'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  current: string
  latest?: string
  notes?: string
  progress?: number
  error?: string
  /** Set when "Update now" means opening the release page, and why. */
  manualReason?: ManualReason | 'failed'
  /** Downloads are running, so a restart now would interrupt them. */
  busy?: boolean
}

const REPO = 'DRAZY/deemix-remastered'
const RELEASE_URL = `https://github.com/${REPO}/releases/latest`
const SCHEDULE_MS: Record<UpdateSchedule, number> = {
  hour: 60 * 60_000,
  sixHours: 6 * 60 * 60_000,
  day: 24 * 60 * 60_000,
  launch: 0,
  never: 0
}

let status: UpdateStatus = { state: 'idle', current: app.getVersion() }
let schedule: UpdateSchedule = 'launch'
let timer: NodeJS.Timeout | undefined
let launchChecked = false
let resumeHooked = false
let listenersReady = false
let lastCheckAt = 0
/** Assets of the newest release seen by the last check (the portable self-update downloads from these). */
let latestAssets: ReleaseAsset[] = []
let latestUrl = RELEASE_URL
/** Set by "Update now": restart on our own once the download is ready (unless downloads are running). */
let restartWhenReady = false
/** An in-place install failed this session: fall back to the release page until the next launch. */
let inPlaceFailed = false
let isBusy: () => boolean = () => false
let modePromise: Promise<InstallMode> | undefined
let pendingRestart: (() => void) | undefined

const portableExe = process.platform === 'win32' ? process.env.PORTABLE_EXECUTABLE_FILE : undefined

/** main.ts tells us whether downloads are running, so a finished update never cuts one off. */
export function setUpdateBusyCheck(fn: () => boolean): void {
  isBusy = fn
}

function dirWritable(dir: string): boolean {
  const probe = join(dir, `.deemix-write-test-${process.pid}`)
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

async function macDeveloperIdSigned(): Promise<boolean> {
  // process.execPath = <bundle>.app/Contents/MacOS/Deemix Remastered
  const bundle = resolve(process.execPath, '..', '..', '..')
  try {
    const { stdout, stderr } = await promisify(execFile)('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 15000 })
    return isDeveloperIdSigned(`${stdout}\n${stderr}`)
  } catch (e) {
    console.warn('[Update] codesign check failed:', (e as Error).message)
    return false
  }
}

/** How this build installs updates; computed once (the codesign check takes a moment). */
function updateInstallMode(): Promise<InstallMode> {
  return (modePromise ??= (async () => {
    const mode = installMode({
      platform: process.platform,
      packaged: app.isPackaged,
      portableExe,
      developerIdSigned: process.platform === 'darwin' && app.isPackaged ? await macDeveloperIdSigned() : undefined,
      portableDirWritable: portableExe ? dirWritable(dirname(portableExe)) : undefined,
      appImage: process.env.APPIMAGE
    })
    console.log(`[Update] install mode: ${mode.kind}${mode.kind === 'manual' ? ` (${mode.reason})` : ''}`)
    return mode
  })())
}

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next, current: app.getVersion() }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', status)
  }
}

export function updateStatus(): UpdateStatus {
  return status
}

/** Ask GitHub for the latest release. */
export async function checkForUpdate(manual = false): Promise<UpdateStatus> {
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return status
  lastCheckAt = Date.now()
  set({ state: 'checking', error: undefined })
  try {
    const mode = await updateInstallMode()
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `DeemixRemastered/${app.getVersion()}` },
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    const rel = (await res.json()) as { tag_name: string; html_url?: string; body?: string; assets?: ReleaseAsset[] }
    const latest = rel.tag_name.replace(/^v/, '')
    latestAssets = rel.assets ?? []
    latestUrl = rel.html_url?.startsWith(`https://github.com/${REPO}/`) ? rel.html_url : RELEASE_URL
    if (newer(latest, app.getVersion())) {
      console.log(`[Update] check (${manual ? 'manual' : 'scheduled'}): ${latest} available, running ${app.getVersion()}`)
      set({
        state: 'available',
        latest,
        notes: rel.body?.slice(0, 4000),
        manualReason: inPlaceFailed ? 'failed' : mode.kind === 'manual' ? mode.reason : undefined
      })
    } else {
      console.log(`[Update] check (${manual ? 'manual' : 'scheduled'}): up to date`)
      set({ state: 'none', latest, notes: undefined, manualReason: undefined })
    }
  } catch (e) {
    console.warn('[Update] check failed:', (e as Error).message)
    set({ state: 'error', error: (e as Error).message })
  }
  return status
}

/** "Update now": download and restart into the new version, or open the release page for a manual install. */
export async function installUpdate(): Promise<void> {
  if (status.state === 'ready') return restartNow()
  if (status.state !== 'available') return
  const mode = await updateInstallMode()
  if (inPlaceFailed || mode.kind === 'manual') {
    await shell.openExternal(latestUrl)
    return
  }
  restartWhenReady = true
  set({ state: 'downloading', progress: 0, error: undefined })
  try {
    if (mode.kind === 'portable') await downloadPortable()
    else await downloadWithUpdater()
  } catch (e) {
    failInPlace(e as Error)
  }
}

/** "Restart later" after the download: stay running; the update waits in the ready state. */
export function deferRestart(): void {
  restartWhenReady = false
}

/** An in-place install went wrong: say so, keep the app running, and offer the release page instead. */
function failInPlace(err: Error): void {
  inPlaceFailed = true
  restartWhenReady = false
  console.error('[Update] in-place install failed:', err.message)
  set({ state: 'available', progress: undefined, manualReason: 'failed', error: err.message })
}

function downloaded(version: string): void {
  console.log(`[Update] ${version} ready to install`)
  const busy = isBusy()
  set({ state: 'ready', latest: version, progress: 100, busy })
  if (restartWhenReady && !busy) restartNow()
}

function restartNow(): void {
  if (status.state !== 'ready') return
  console.log(`[Update] restarting into ${status.latest}`)
  if (pendingRestart) return pendingRestart()
  // Windows installer: silent install, then start the new version. macOS: Squirrel.Mac swaps and relaunches.
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}

// ---- electron-updater (Windows installer, macOS Developer ID, Linux AppImage) ----

function wireUpdater(): void {
  if (listenersReady) return
  listenersReady = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // The release ships no blockmaps; always fetch the whole file.
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.logger = console
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', progress: Math.min(99, Math.round(p.percent)) }))
  if (process.platform === 'darwin') {
    // electron-updater reports the zip as downloaded before Squirrel.Mac has taken it and checked its code
    // signature against this app; ready means Squirrel accepted it, so a mismatch surfaces before any restart.
    let version = ''
    autoUpdater.on('update-downloaded', (info) => {
      version = info.version
      console.log(`[Update] ${info.version} zip downloaded; handing it to Squirrel.Mac`)
    })
    nativeUpdater.on('update-downloaded', () => downloaded(version || status.latest || ''))
  } else {
    autoUpdater.on('update-downloaded', (info) => downloaded(info.version))
  }
  autoUpdater.on('error', (err) => {
    if (status.state === 'downloading' || status.state === 'ready') failInPlace(err)
    else console.warn('[Update] updater error:', err.message)
  })
}

async function downloadWithUpdater(): Promise<void> {
  wireUpdater()
  const r = await autoUpdater.checkForUpdates()
  if (!r?.updateInfo || !newer(r.updateInfo.version, app.getVersion())) throw new Error('the release has no update feed for this platform')
  await autoUpdater.downloadUpdate()
  // 'update-downloaded' follows; Squirrel.Mac has verified the signature by the time quitAndInstall runs.
}

// ---- Windows portable self-update ----

async function downloadPortable(): Promise<void> {
  const exe = portableExe as string
  const asset = portableAsset(latestAssets, process.arch)
  if (!asset) throw new Error('the release has no portable build for this machine')
  const staging = join(dirname(exe), `.${asset.name}.download`)
  rmSync(staging, { force: true })
  console.log(`[Update] portable: downloading ${asset.name}`)
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': `DeemixRemastered/${app.getVersion()}` }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download ${res.status} for ${asset.name}`)
  const total = Number(res.headers.get('content-length')) || asset.size || 0
  const hash = createHash('sha256')
  const out = createWriteStream(staging)
  let got = 0
  let lastPct = -1
  try {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      got += value.length
      const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0
      if (pct !== lastPct) set({ state: 'downloading', progress: (lastPct = pct) })
    }
    await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())))
    const sha = verifyDigest(hash.digest('hex'), asset.name, asset.digest)
    console.log(`[Update] portable: ${asset.name} verified, sha256 ${sha}`)
  } catch (e) {
    out.destroy()
    rmSync(staging, { force: true })
    throw e
  }
  pendingRestart = () => swapPortableAndRelaunch(exe, staging)
  downloaded(status.latest ?? '')
}

function swapPortableAndRelaunch(exe: string, staging: string): void {
  const parked = parkedExePath(exe)
  try {
    rmSync(parked, { force: true })
    renameSync(exe, parked) // Windows lets a running exe be renamed, not overwritten
    try {
      renameSync(staging, exe)
    } catch (e) {
      renameSync(parked, exe) // put the working exe back
      throw e
    }
  } catch (e) {
    pendingRestart = undefined
    rmSync(staging, { force: true })
    failInPlace(e as Error)
    return
  }
  console.log(`[Update] portable: ${exe} replaced; relaunching`)
  app.relaunch({ execPath: exe })
  app.quit()
}

/** Portable build: delete the exe parked by the last self-update. */
export function cleanupPortableUpdate(): void {
  if (!portableExe) return
  const parked = parkedExePath(portableExe)
  const attempt = (left: number) => {
    if (!existsSync(parked)) return
    try {
      rmSync(parked, { force: true })
    } catch {
      // the old launcher can hold its file for a few seconds after the relaunch
      if (left > 0) setTimeout(() => attempt(left - 1), 10_000)
    }
  }
  attempt(6)
}

/**
 * The renderer calls this once settings have loaded, and again when the setting changes. The launch check runs
 * 15 s after the first call (unless the setting is "never"), then the chosen interval takes over.
 */
export function scheduleUpdateChecks(every: UpdateSchedule): void {
  schedule = every in SCHEDULE_MS ? every : 'launch'
  if (timer) clearInterval(timer)
  timer = undefined
  const interval = SCHEDULE_MS[schedule]
  if (!launchChecked && schedule !== 'never') {
    launchChecked = true
    setTimeout(() => void checkForUpdate(false), 15_000)
  }
  if (interval > 0) timer = setInterval(() => void checkForUpdate(false), interval)
  if (!resumeHooked) {
    resumeHooked = true
    // A laptop asleep for the night should not wait another full interval after it wakes.
    powerMonitor.on('resume', () => {
      const ms = SCHEDULE_MS[schedule]
      if (ms > 0 && Date.now() - lastCheckAt > ms) void checkForUpdate(false)
    })
  }
}
