/**
 * Pure decisions behind app updates (no Electron imports, so tests/updatePlan.test.ts can run them).
 */

/** Apple Team ID the Developer ID builds are signed with. */
export const TEAM_ID = 'W966GFT83K'

/**
 * How an update gets onto this machine.
 * - installer: Windows NSIS build; electron-updater runs the installer silently, then relaunches.
 * - mac: Developer-ID-signed Mac build; electron-updater + Squirrel.Mac swap the bundle and relaunch.
 * - appimage: Linux AppImage; electron-updater replaces the AppImage and relaunches.
 * - portable: Windows portable exe in a writable folder; the app downloads, verifies and swaps the exe itself.
 * - manual: open the release page; `reason` says why, so the UI can explain it.
 */
export type InstallMode =
  | { kind: 'installer' | 'mac' | 'appimage' | 'portable' }
  | { kind: 'manual'; reason: ManualReason }
export type ManualReason = 'unsigned' | 'readonly' | 'dev' | 'unsupported'

export interface InstallEnv {
  platform: NodeJS.Platform
  packaged: boolean
  /** Windows portable: the exe the user started (PORTABLE_EXECUTABLE_FILE), else undefined. */
  portableExe?: string
  /** macOS: is the running bundle signed with our Developer ID? */
  developerIdSigned?: boolean
  /** Windows portable: can the app write next to its exe? */
  portableDirWritable?: boolean
  /** Linux: the AppImage being run (APPIMAGE), else undefined for .deb, AUR and source installs. */
  appImage?: string
}

export function installMode(env: InstallEnv): InstallMode {
  if (!env.packaged) return { kind: 'manual', reason: 'dev' }
  if (env.platform === 'win32') {
    if (!env.portableExe) return { kind: 'installer' }
    return env.portableDirWritable ? { kind: 'portable' } : { kind: 'manual', reason: 'readonly' }
  }
  if (env.platform === 'darwin') {
    // Squirrel.Mac installs an update only when it satisfies the running app's designated requirement. An ad-hoc
    // build's requirement is its own cdhash, which no other build can match, so ad-hoc builds update by hand once.
    return env.developerIdSigned ? { kind: 'mac' } : { kind: 'manual', reason: 'unsigned' }
  }
  if (env.platform === 'linux' && env.appImage) return { kind: 'appimage' }
  return { kind: 'manual', reason: 'unsupported' }
}

/**
 * Read `codesign -dv --verbose=2 <app>` output (codesign prints it on stderr): true only for a real Developer ID
 * Application signature from our team, never for ad-hoc or another team's certificate.
 */
export function isDeveloperIdSigned(codesignDisplay: string, teamId = TEAM_ID): boolean {
  if (/^Signature=adhoc$/m.test(codesignDisplay)) return false
  const team = codesignDisplay.match(/^TeamIdentifier=(\S+)$/m)?.[1]
  const leaf = codesignDisplay.match(/^Authority=(.+)$/m)?.[1] ?? ''
  return team === teamId && leaf.startsWith('Developer ID Application:') && leaf.endsWith(`(${teamId})`)
}

/** "2.6.6" > "2.6.5" by numeric parts; pre-release suffixes are ignored. */
export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((n) => Number(n) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  /** "sha256:<hex>", recorded by GitHub when the asset was uploaded. */
  digest?: string | null
  size?: number
}

/** Releases are published from github.com/DRAZY/deemix-remastered only; anything else is refused before download. */
export const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/DRAZY/deemix-remastered/releases/download/'

/** The portable exe for this architecture in a release (GitHub turns the space in its name into a dot). */
export function portableAsset(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  const pattern = new RegExp(`^Deemix\\.Remastered-Portable-[\\w.-]+-${arch}\\.exe$`)
  const exe = assets.find((a) => pattern.test(a.name))
  return exe && exe.browser_download_url.startsWith(RELEASE_DOWNLOAD_PREFIX) ? exe : null
}

/** Accept a downloaded exe only when its SHA-256 matches the digest GitHub recorded; with no digest, nothing installs. */
export function verifyDigest(actualSha256: string, fileName: string, apiDigest: string | null | undefined): string {
  const actual = actualSha256.toLowerCase()
  const expected = apiDigest?.startsWith('sha256:') ? apiDigest.slice(7).toLowerCase() : null
  if (!expected) throw new Error(`the release publishes no checksum for ${fileName}; update not installed`)
  if (expected !== actual) throw new Error(`${fileName} does not match the digest GitHub recorded; update not installed`)
  return actual
}

/** Where the portable exe being replaced is parked until the next start deletes it. */
export function parkedExePath(exe: string): string {
  return `${exe}.old`
}
