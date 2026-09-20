# Security Triage — CodeQL Alert Log

Running record of every CodeQL alert in the repo's Security tab: what it was,
what we did, and why. Future scans that re-flag a dismissed pattern should be
checked against this log before any code churn.

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
