/**
 * electron-builder `afterAllArtifactBuild` hook.
 *
 * electron-builder notarizes and staples the .app, but not the disk image around it. Submit the
 * (Developer-ID-signed) dmg to Apple's notary service and staple the ticket, so Gatekeeper accepts it offline on
 * first open. Uses the notarytool keychain profile in APPLE_KEYCHAIN_PROFILE (no password in any file). Without
 * that variable the build stays local-only: nothing is notarized.
 */
const { basename } = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = async function afterAllArtifactBuild(result) {
  for (const file of result.artifactPaths) {
    if (!file.endsWith('.dmg')) continue
    const profile = process.env.APPLE_KEYCHAIN_PROFILE
    if (!profile) {
      console.warn(`  • skipped dmg notarization: APPLE_KEYCHAIN_PROFILE is not set (${basename(file)})`)
      continue
    }
    console.log(`  • notarizing ${basename(file)} (keychain profile ${profile})`)
    execFileSync('xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait'], { stdio: 'inherit' })
    // notarytool exits 0 even when Apple answers "Invalid"; stapling fails in that case, which fails the build.
    execFileSync('xcrun', ['stapler', 'staple', file], { stdio: 'inherit' })
    execFileSync('xcrun', ['stapler', 'validate', file], { stdio: 'inherit' })
  }
  return []
}
