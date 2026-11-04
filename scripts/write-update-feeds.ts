#!/usr/bin/env bun
/**
 * Write the update feeds the in-app updater reads, from the installers in release/. Run after all the platform
 * builds, before uploading.
 *
 *   bun scripts/write-update-feeds.ts
 *
 * electron-builder's own feeds cannot be uploaded: each `electron-builder` run overwrites latest-mac.yml and
 * latest.yml, so the second architecture wipes the first, and they name files with a dash where GitHub's upload
 * turns the space in our file names into a dot, so the updater would 404. Hashing the finished files here also
 * means the feed describes exactly what gets uploaded. Stops if any expected file is missing.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const version: string = JSON.parse(readFileSync('package.json', 'utf8')).version
const dir = 'release'
const name = `Deemix Remastered`

const feeds: Record<string, string[]> = {
  // The updater picks by architecture: arm64 Macs take the arm64 zip, Intel Macs the universal one.
  'latest-mac.yml': [`${name}-${version}-universal-mac.zip`, `${name}-${version}-arm64-mac.zip`],
  // Windows arm64 and x64 pick their installer by the architecture in its name.
  'latest.yml': [`${name}-Setup-${version}-x64.exe`, `${name}-Setup-${version}-arm64.exe`],
  'latest-linux.yml': [`${name}-${version}.AppImage`],
  'latest-linux-arm64.yml': [`${name}-${version}-arm64.AppImage`]
}

const releaseDate = new Date().toISOString()
for (const [feed, files] of Object.entries(feeds)) {
  const entries = files.map((file) => {
    const path = join(dir, file)
    const sha512 = createHash('sha512').update(readFileSync(path)).digest('base64')
    return { url: file.replace(/ /g, '.'), sha512, size: statSync(path).size }
  })
  const lines = [`version: ${version}`, 'files:']
  for (const e of entries) lines.push(`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`)
  lines.push(`path: ${entries[0].url}`, `sha512: ${entries[0].sha512}`, `releaseDate: '${releaseDate}'`, '')
  writeFileSync(join(dir, feed), lines.join('\n'))
  console.log(`wrote ${feed}: ${entries.map((e) => e.url).join(', ')}`)
}
