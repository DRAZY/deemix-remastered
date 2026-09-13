#!/usr/bin/env bun
// Localization gate: every locale carries every English key, and no user-facing
// English is typed straight into components, stores or composables.
// Usage: bun scripts/i18n-check.ts   (exit 1 on any finding)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const localeDir = join(root, 'src/i18n/locales')
const flat = (o: any, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object') ? flat(v, p + k + '.') : [p + k])
const en = new Set(flat(JSON.parse(readFileSync(join(localeDir, 'en.json'), 'utf8'))))
let failures = 0

for (const f of readdirSync(localeDir).filter(f => f.endsWith('.json') && f !== 'en.json')) {
  const keys = new Set(flat(JSON.parse(readFileSync(join(localeDir, f), 'utf8'))))
  const missing = [...en].filter(k => !keys.has(k)); const extra = [...keys].filter(k => !en.has(k))
  if (missing.length || extra.length) { failures++; console.log(`${f}: missing ${missing.length}, extra ${extra.length}${missing.length ? ' e.g. ' + missing.slice(0, 3).join(', ') : ''}`) }
}

// Hard-coded English scan. Branded labels are exempt by design.
const BRAND = /Transfer Rack|AGGREGATE RATE|Pull the signal|SIGNAL DECK|ACQUISITION CONSOLE|CHANNEL Q|Q:LINK|LINK ESTABLISHED|LINK DOWN/
const english = /[A-Za-z]{3,}(?:\s+[A-Za-z'.,:!?&-]+){1,}/
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(join(dir, d.name)) : /\.(vue|ts)$/.test(d.name) ? [join(dir, d.name)] : [])
for (const file of [...walk(join(root, 'src/views')), ...walk(join(root, 'src/components')), ...walk(join(root, 'src/stores')), ...walk(join(root, 'src/composables')), join(root, 'src/App.vue')]) {
  const s = readFileSync(file, 'utf8'); const rel = file.slice(root.length)
  const hits: string[] = []
  const tplStart = s.indexOf('<template>'); const tplEnd = s.lastIndexOf('</template>')
  if (tplStart >= 0) {
    const tpl = s.slice(tplStart, tplEnd).replace(/<!--[\s\S]*?-->/g, '')
    for (const m of tpl.matchAll(/>\s*([^<{}]*?[A-Za-z]{3,}[^<{}]*?)\s*</g)) {
      const t = m[1].replace(/\s+/g, ' ').trim()
      if (english.test(t) && !/["=@:]|^\/\/|^\d/.test(t) && !BRAND.test(t)) hits.push(`text: ${t.slice(0, 60)}`)
    }
    for (const m of tpl.matchAll(/\s(placeholder|title|aria-label)="([^"{]*[A-Za-z]{3,}[^"{]*)"/g)) if (english.test(m[2])) hits.push(`${m[1]}: ${m[2].slice(0, 60)}`)
  }
  for (const m of s.matchAll(/toast(?:Store)?\.(?:success|error|info|warning)\(\s*([`'"])(.*?)\1/g)) hits.push(`toast: ${m[2].slice(0, 60)}`)
  if (hits.length) { failures++; console.log(`${rel}:`); for (const h of hits) console.log(`   ${h}`) }
}
console.log(failures ? `i18n-check: ${failures} finding(s)` : 'i18n-check: ok')
process.exit(failures ? 1 : 0)
