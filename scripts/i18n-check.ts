#!/usr/bin/env bun
// Localization gate: every locale carries every English key, and no user-facing
// English is typed straight into components, stores, composables or utilities.
// Usage: bun scripts/i18n-check.ts   (exit 1 on any finding)
//
// What the scan covers (the 2.6.5 rewrite, after #160 showed the old scanner
// only read direct template text and toast calls):
//   - template text nodes, including text mixed with {{ interpolation }}
//   - static placeholder/title/aria-label/alt/label attributes
//   - string literals inside bound attributes (:title="x ? 'Resume' : 'Pause'")
//   - string literals anywhere in <script> or .ts: ref('...'), x.value = '...',
//     description: '...', return '...', error strings, template literals
// Exempt by design: branded labels and instrument-panel readouts (ALL CAPS),
// service and format names, key names, %template% variables, and any line
// carrying an `// i18n-exempt` comment. Internal Error() messages, console
// output, comparisons and enum values are not user copy and are skipped.
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

// Branded labels stay English on purpose (see CLAUDE.md § Localization).
const BRAND = /^(Transfer Rack|AGGREGATE RATE|Pull the signal|down\.|SIGNAL DECK|ACQUISITION CONSOLE|CHANNEL Q|Q:LINK(ED)?|LINK ESTABLISHED|LINK DOWN|Deemix Remastered|Deemix|deemix)$/i
// Names and tokens that are never translated: services, formats, keys, runtimes, theme names.
const NAMES = new Set(['Deezer', 'Qobuz', 'Spotify', 'Tidal', 'FLAC', 'MP3', 'AAC', 'OGG', 'ISRC', 'UPC', 'ARL', 'URL', 'API', 'ID', 'OK', 'N/A', 'Hi-Res', 'HiRes', 'Electron', 'Chromium', 'Node', 'GitHub', 'Windows', 'macOS', 'Linux', 'Vue', 'JSON', 'CSV', 'M3U', 'ReplayGain', 'Esc', 'Ctrl', 'Cmd', 'Alt', 'Shift', 'Enter', 'Tab', 'Space', 'Backspace', 'Escape', 'Meta', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert', 'EP', 'Signal', 'Violet', 'Rose', 'Ocean', 'Sunset', 'Mint', 'Dracula', 'Nord'])

const twoWords = (t: string) => t.split(/\s+/).filter(w => (w.match(/[A-Za-z]/g) ?? []).length >= 2).length >= 2
// Things that look like code rather than copy: paths, keys, css classes, urls, template vars.
const codey = /[\\_=<>{}\[\]|;$#@^~`]|\S\/|\/\S|^\.|\.[a-zA-Z]+\.|^[a-z]+[A-Z]|^\d|^(?=.*[-:\d])[a-z0-9:\/\[\]().%-]+(\s[a-z0-9:\/\[\]().%-]+)+$|https?:|^\s*$|^[a-z]+:[a-z]|%[a-z]+%/
const looksLikeUi = (raw: string, inScript = false) => {
  const t = raw.replace(/\{\{[\s\S]*?\}\}/g, ' ').replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t || codey.test(t) || BRAND.test(t)) return false
  if (!/[a-z]/.test(t)) return false // ALL CAPS instrument readouts (LIVE, STORED, RECV ...)
  const words = t.split(/\s+/).filter(w => /[A-Za-z]/.test(w))
  if (words.length === 0 || words.every(w => NAMES.has(w.replace(/[.,:!?()]/g, '')))) return false
  if (words.length === 1) {
    const w = t.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')
    return inScript ? /^[A-Z][a-z]{2,}$/.test(w) : /^[A-Z][a-z]{2,}$|^[a-z]{3,}$/.test(w)
  }
  return twoWords(t)
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(join(dir, d.name)) : /\.(vue|ts)$/.test(d.name) && !/\.d\.ts$|\.test\.ts$|\.spec\.ts$/.test(d.name) ? [join(dir, d.name)] : [])
const files = walk(join(root, 'src')).filter(f => !/\/src\/(i18n|types)\//.test(f))
const lineOf = (s: string, idx: number) => s.slice(0, idx).split('\n').length
const blankLine = (l: string) => ' '.repeat(l.length)
// Comparison and membership operands are enum values, not copy: x === 'album', ['a','b'].includes(x).
// Blanked in place so offsets and line numbers hold.
const dropOperands = (src: string) => src
  .replace(/[!=]==?\s*(['"`])(?:(?!\1).)*\1/g, m => ' '.repeat(m.length))
  .replace(/(['"`])(?:(?!\1).)*\1\s*[!=]==?/g, m => ' '.repeat(m.length))
  .replace(/\[(?:\s*(['"`])(?:(?!\1).)*\1\s*,?)+\s*\]\s*\.includes\(/g, m => ' '.repeat(m.length))
  .replace(/\.includes\(\s*(['"`])(?:(?!\1).)*\1\s*\)/g, m => ' '.repeat(m.length))
  .replace(/\[\s*(['"`])(?:(?!\1).)*\1\s*\]/g, m => ' '.repeat(m.length))
// A line the author has marked exempt, or one that is not user copy.
const SKIP_LINE = /i18n-exempt|console\.|new Error\(|^\s*import |\bt\(['"]|i18n\.global\.t\(|\bemit\(|defineEmits|defineProps|new RegExp|\.matches\(|querySelector|addEventListener|removeEventListener|localStorage|sessionStorage|\bclass(?:Name)?[:=]|\bicon[:=]|\bsrc[:=]|\bhref[:=]/

for (const file of files) {
  const s = readFileSync(file, 'utf8'); const rel = file.slice(root.length)
  const hits: string[] = []
  const add = (kind: string, idx: number, text: string) => hits.push(`${lineOf(s, idx)} ${kind}: ${text.replace(/\s+/g, ' ').trim().slice(0, 70)}`)
  const exemptLines = new Set(s.split('\n').map((l, i) => /i18n-exempt/.test(l) ? i + 1 : 0).filter(Boolean))
  const addUnlessExempt = (kind: string, idx: number, text: string) => { if (!exemptLines.has(lineOf(s, idx))) add(kind, idx, text) }

  const tplStart = s.indexOf('<template>'); const tplEnd = s.lastIndexOf('</template>')
  if (tplStart >= 0) {
    let tpl = s.slice(tplStart, tplEnd)
    // Blank HTML comments (length preserved so line numbers hold) until none remain,
    // so an overlapping form cannot leave a "<!--" behind (CodeQL js/incomplete-multi-character-sanitization).
    for (let prev = ''; prev !== tpl;) { prev = tpl; tpl = tpl.replace(/<!--[\s\S]*?-->/g, m => ' '.repeat(m.length)) }
    for (const m of tpl.matchAll(/>([^<]*)</g)) if (/[A-Za-z]{3,}/.test(m[1]) && looksLikeUi(m[1])) addUnlessExempt('text', tplStart + m.index! + 1, m[1])
    for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      const expr = dropOperands(m[1]).replace(/\bt\(\s*(['"`])(?:(?!\1).)*\1/g, '')
      for (const lit of expr.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) { const v = lit[1] ?? lit[2]; if (looksLikeUi(v)) addUnlessExempt('mustache', tplStart + m.index!, v) }
    }
    for (const m of tpl.matchAll(/\s(placeholder|title|aria-label|alt|label)="([^"]*)"/g)) if (looksLikeUi(m[2])) addUnlessExempt(m[1], tplStart + m.index!, m[2])
    for (const m of tpl.matchAll(/\s(?::|v-bind:)(placeholder|title|aria-label|alt|label|tooltip)="([^"]*)"|\sv-tooltip="([^"]*)"/g)) {
      const expr = dropOperands(m[2] ?? m[3])
      for (const lit of expr.matchAll(/'([^']*)'|`([^`]*)`/g)) { const v = lit[1] ?? lit[2]; if (looksLikeUi(v)) addUnlessExempt(':' + (m[1] ?? 'v-tooltip'), tplStart + m.index!, v) }
    }
  }
  const scripts: Array<[number, string]> = []
  if (file.endsWith('.vue')) { for (const m of s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) scripts.push([m.index! + m[0].indexOf('>') + 1, m[1]]) }
  else scripts.push([0, s])
  for (const [off, body0] of scripts) {
    let body = body0.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length)).replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    body = body.split('\n').map(l => SKIP_LINE.test(l) ? blankLine(l) : l).join('\n')
    body = dropOperands(body)
    for (const m of body.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const v = m[1] ?? m[2] ?? m[3]
      if (/[A-Za-z]{3,}/.test(v) && looksLikeUi(v, true)) addUnlessExempt('script', off + m.index!, v)
    }
  }
  if (hits.length) { failures++; console.log(`${rel}:`); for (const h of hits) console.log(`   ${h}`) }
}
console.log(failures ? `i18n-check: ${failures} finding(s)` : 'i18n-check: ok')
process.exit(failures ? 1 : 0)
