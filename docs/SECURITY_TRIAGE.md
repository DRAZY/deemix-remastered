# Security Triage — CodeQL Alert Log

Running record of every CodeQL alert in the repo's Security tab: what it was,
what we did, and why. Future scans that re-flag a dismissed pattern should be
checked against this log before any code churn.

## 2026-09-20, three CodeQL alerts opened by the 2.6.3 push

Dependabot, secret scanning and repository advisories were all clear. Code scanning
raised three medium alerts, all on lines 2.6.3 touched.

| # | Rule | Severity | Location | Disposition |
|---|------|----------|----------|-------------|
| 172 | js/log-injection | medium | `electron/services/deezerAuth.ts` `getLyrics` catch | **Hardened on `rc/2.6.4`, expected to close on merge.** The value already went through `logSafe`, so this was the same false positive as #140 to #168. It still exposed two real weaknesses. `logSafe` existed as seven copied one-liners, and it stripped CR and LF only, so terminal escape codes (ESC, `0x1b`) passed straight into the log, where they can recolour, hide or rewrite lines for anyone reading it in a terminal. There is now one `electron/services/logSafe.ts`. It escapes every C0 control through `JSON.stringify`, blanks DEL, the C1 range and U+2028/U+2029, and restores quotes and backslashes so Windows paths still read naturally. `JSON.stringify` is a sanitiser the query recognises (the neighbouring line that logs `JSON.stringify(response.error)` was never flagged), so this should also end the dismiss-on-every-release cycle for this rule. **Not yet confirmed by CodeQL**: that needs the branch analysed, on a PR or after merge. |
| 173 | js/http-to-file-access | medium | `electron/services/downloader.ts` `writeFileAtomic`, staging write | **Dismissed (false positive).** Same helper as #108, which was dismissed on the same grounds. Writing downloaded bytes to disk is what a downloader does. 2.6.3 rewrote the helper for the Windows rename fix (#159), which moved the lines and reopened the finding. Re-verified rather than assumed: every caller builds its target from the user's own download folder plus a name that went through `sanitizeFilename`, which removes `..`, path separators and all control characters, or from the user's cover-name template. |
| 174 | js/http-to-file-access | medium | `electron/services/downloader.ts` `writeFileAtomic`, direct-write fallback | **Dismissed (false positive).** The second write 2.6.3 added for when Windows keeps the rename locked. Same target path and same bytes as #173. |

Considered and left out: checking image magic bytes before writing a cover. It would
stop a non-image response body being saved as `cover.jpg`, but it is new behaviour on
the most exercised path in the app, and the standing instruction for security work
here is that remediation must not change what works. Worth its own tested change.

### Build-toolchain audit (added 2026-09-27, `rc/2.6.4`)

`bun audit` on the 2.6.4 candidate reported 27 findings (23 high, 3 moderate,
1 low), every one in build-time tooling: electron-builder's chain (`fast-uri`,
`@xmldom/xmldom`, `js-yaml`, `brace-expansion` at three majors) and the
Tailwind/PostCSS chain (`postcss-selector-parser`, `nanoid`). None ship: the
package only carries `dist/`, `dist-electron/`, `public/` and `package.json`,
and the 2.6.3 asar contains none of these modules. GitHub's Dependabot showed
nothing, presumably because it scopes to runtime dependencies.

Fixed by re-resolving only those entries in `bun.lock` to the newest versions
the parents already declare (all caret ranges, so no override change and no
risk to electron-builder's declared-range collector). `package.json` untouched.
Eleven lock lines changed; `bun install --frozen-lockfile` accepts it, `bun
audit` is clean, typecheck and vite build pass, and `electron-builder --dir`
packs. A full `bun update` was tried first and rejected: it moved 102 packages
including Electron and Vue, far beyond a security fix.

### Standing posture (added 2026-09-20)

- Anything from outside the app that reaches a log line goes through `logSafe`
  from `electron/services/logSafe.ts`. Do not re-declare a local copy.
- A path component that came from a remote name goes through `sanitizeFilename`
  before it reaches any write. That is the basis for every
  js/http-to-file-access dismissal in this file, so it has to stay true.

## 2026-09-13, private advisory GHSA-3v8g-hjrg-cr33 (Electron RunAsNode fuse)

| Report | Severity | Location | Disposition |
|--------|----------|----------|-------------|
| `ELECTRON_RUN_AS_NODE` fuse left at Electron's default, so the shipped binary can be launched as a bare Node interpreter under the app's code-signing identity. | Reported medium, assessed low | electron-builder config (`package.json` `build`) | **Fixed in 2.6.3, advisory closed without publication.** Verified against the 2.6.2 arm64 build: `ELECTRON_RUN_AS_NODE=1` did yield a Node 24 shell. Impact is narrow because the macOS build is ad-hoc signed (no durable identity for TCC to bind to) and `require('electron')` returns a path string in that mode, so safeStorage is not reachable. The reporter's template still holds as a hardening gap, so `electronFuses` now turns off `runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments`, and turns on `onlyLoadAppFromAsar` and `enableEmbeddedAsarIntegrityValidation`. Confirmed with `electron-fuses read` on a fresh package and by launching it: the reproduction no longer runs, the app starts, serves its API, and `ElectronAsarIntegrity` is present in `Info.plist`. |

### Standing posture (added 2026-09-13)

- The fuse block in `package.json` ships in every build. Do not add
  `child_process.fork` to the main process; `RunAsNode` is off and it will not
  work. Use `utilityProcess` instead.

## 2026-07-19 — branch `security/codeql-hardening`

| # | Rule | Severity | Location | Disposition |
|---|------|----------|----------|-------------|
| 21 | js/clear-text-storage-of-sensitive-data | error/high | `src/stores/settingsStore.ts` | **Fixed.** The legacy Spotify localStorage fallback wrote the client secret in plaintext when safeStorage was unavailable. The secret is now persisted only through safeStorage encryption; without safeStorage it stays in-memory for the session (re-entry required next launch). The startup migration path still reads and deletes any pre-existing legacy key. |
| 20 | js/tainted-format-string | warning/high | `electron/server.ts` (artist sync) | **Fixed.** Request-supplied id moved out of the format string into a console argument. |
| 19 | js/tainted-format-string | warning/high | `electron/server.ts` (playlist sync) | **Fixed.** Same pattern. |
| 18 | js/tainted-format-string | warning/high | `src/views/SearchView.vue` (bulk link download) | **Fixed.** Pasted-link type/id moved into console arguments. |
| 16 | js/stack-trace-exposure | warning/medium | `electron/server.ts` `sendJSON` | **Hardened → dismissed (won't fix).** `sendJSON` now scrubs `stack` fields (and collapses raw `Error` objects to message-only) from every error-status payload — a chokepoint guarantee covering all current and future handlers. The rule still flags exception-derived *messages*, which are intentional UX; server binds to 127.0.0.1 only. |
| 15 | js/request-forgery | error/critical | `electron/server.ts` (Deezer API proxy) | **Mitigated + hardened → dismissed (false positive).** Endpoint is resolved against `https://api.deezer.com` and the full origin is pinned: protocol must be `https:`, hostname must equal `api.deezer.com`, port must be default. CodeQL cannot recognize the custom sanitizer; dismissed with this justification. |
| 14 | js/request-forgery | error/critical | `electron/server.ts` (redirect resolver) | **Mitigated + hardened → dismissed (false positive).** `isRedirectSafe()` runs on the initial URL and every redirect hop: http/https only, default ports only (added this pass), private/link-local/localhost ranges blocked, and a host allowlist (`.deezer.com`, `.spotify.com`, `.dzcdn.net`, exact `deezer.page.link`) with correct suffix-vs-exact matching. Dismissed with this justification. |
| 23 | js/weak-cryptographic-algorithm | warning/high | `electron/services/qobuzAuth.ts` (request signing) | **Dismissed (won't fix).** MD5 is mandated by Qobuz's API contract — their gateway validates `md5(object+method+params+timestamp+secret)`. It authenticates requests to their service and protects no data of ours; any other algorithm is rejected by Qobuz. Documented at the call site. |

### Standing posture

- The local HTTP server binds to `127.0.0.1` only.
- Service credentials (Deezer ARL, Spotify client secret, Qobuz token) are
  stored via OS safeStorage / userData files, never in cleartext web storage,
  never in settings exports or backups.
- Any new outbound-fetch endpoint must pin its origin (scheme + host + port)
  or route through `isRedirectSafe()`.

### Outcome (2026-07-19, post-merge of PR #111)

- Auto-closed as fixed by main's scan: **#18, #19, #20, #21**
- Dismissed with justification: **#14, #15** (false positive — custom sanitizers),
  **#16** (won't fix — messages intentional, stacks scrubbed), **#23** (won't fix —
  protocol-mandated MD5)
- Open alerts remaining: **0**
