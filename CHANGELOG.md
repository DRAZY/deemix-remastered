# Changelog

All notable changes to **Deemix Remastered** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.6] — 2026-05-01

### Fixed

- **Region-shifted releases now download** ([#57](https://github.com/DRAZY/deemix-remastered/issues/57)). For users on Premium accounts whose region timezone makes a release available earlier than their physical location (e.g., a New Zealand–registered account on a Bulgarian IP, where NZ-only early releases would load in the analyzer but fail to download), the download path now falls back to the legacy CDN URL when Deezer's modern Media API rejects the stream request. The legacy URL is signature-based rather than IP-geo–enforced, matching the behavior of the original Python deemix. Auth-related errors (401, expired session) still surface correctly — only non-auth Media API failures trigger the fallback.

## [1.5.5] — 2026-04-30

### Fixed

- **Link Analyzer no longer hangs on slow or missing Deezer responses** ([#57](https://github.com/DRAZY/deemix-remastered/issues/57)). The public Deezer API call had no request timeout, so an unresponsive endpoint left the analyzer spinning forever with no error. All public REST calls now enforce a 15-second timeout and surface a clear "Deezer API request timed out" message.

### Added

- **Authenticated gateway fallback for region-restricted content in the Link Analyzer.** When Deezer's public REST returns "no data" for a track or album (often happens for region-locked releases — e.g., a New Zealand–only single viewed by a New Zealand–authenticated user), the analyzer now retries via the authenticated gateway using the user's account region. Responses are normalized so the existing UI renders them unchanged.
- **Clearer Link Analyzer error messages.** Deezer error code 800 ("no data") now reads "This content isn't available in your region" when signed in, or prompts to sign in when signed out. Error code 4 reads "Invalid Deezer URL or content ID."

## [1.5.4] — 2026-04-29

### Added

- **Playlist Sync now generates an M3U file** ([#59](https://github.com/DRAZY/deemix-remastered/issues/59)). Each sync run produces a timestamped `.m3u8` snapshot (`{playlist name} - YYYY-MM-DD_HH-MM-SS.m3u8`) so users can see exactly what tracks were synced and when. Mirrors the behavior of normal playlist downloads. Honors the `Create Playlist File` setting.
- **New M3U filename template tokens** — the `m3uNameTemplate` setting now also supports `%time%` (`HH-MM-SS`) and `%datetime%` (`YYYY-MM-DD_HH-MM-SS`) in addition to the existing `%playlist%`, `%date%`, and `%year%` tokens.

## [1.5.3] — 2026-04-28

### Fixed

- **Large playlists and albums no longer truncate at 500 tracks** ([#58](https://github.com/DRAZY/deemix-remastered/issues/58)). The download path was making a single non-paginated request to Deezer's `/playlist/{id}/tracks?limit=500` and `/album/{id}/tracks?limit=500` endpoints, silently dropping anything past the first page. A 1100-track playlist would queue only 500 tracks. Both download handlers now paginate (100-track batches, follow `next`, 10,000 safety ceiling), matching the existing pattern in the browse path.
- **Playlist Sync add/remove toast no longer throws.** `SyncView` was calling a non-existent `toastStore.addToast(...)` method; replaced with the correct `success(...)` / `error(...)` calls.
- **Artist page discography loading no longer errors.** `ArtistView` was reading `downloadStore.serverPort.value`, but Pinia auto-unwraps refs in components so `.value` on a number was a runtime error.
- **Profile actions no longer throw their toasts.** `ProfileSelector` had 8 `addToast` calls with the same wrong-method-name bug; all replaced with the correct store methods.

### Changed

- Internal: typecheck cleanup pass — resolved 61 pre-existing TypeScript errors so `vue-tsc --noEmit` passes clean. Added a GitHub Actions workflow that runs typecheck on every push and PR to `main`.
- Internal: housekeeping — added `LICENSE` (GPL-3.0), `SECURITY.md`, `CHANGELOG.md`, issue templates, architecture diagram, and troubleshooting guide. Refreshed README screenshots. Removed unused `deezer-js` dependency and confirmed dead code in several views.

## [1.5.2] — 2026-04-26

### Changed

- **Refreshed app icon.** Replaced the prior purple-gradient circular icon with a vibrant paper-cut layered squircle design (cobalt blue background, stacked lime-and-mint paper-cut "D", coral equalizer bars, and download arrow). Updated installer/dock/taskbar icons, the in-app sidebar logo, and the About page logo.
- **Linux `.deb` builds now succeed on macOS hosts automatically** via a `scripts/build-tools/ar` shim that redirects to GNU `ar` (since macOS ships BSD `ar` which produces malformed Debian archives). The npm build scripts wire it in automatically.

> Icon-only release. No functional or behavioral changes from v1.5.1.

## [1.5.1] — 2026-04-26

### Added

- **New Releases Page.** Dedicated page showing all 100 of Deezer's latest album releases, accessible via the **See all** link on the Home page's New Releases section.
- **Unified Export/Import Configuration.** Bundles settings *and* profiles into a single export/import flow — replaces the prior settings-only export.

### Changed

- Moved Export/Import Settings buttons into the Profiles section for a cleaner Settings layout, with a visual separator between profile and settings buttons.
- Removed the redundant separate Import Profile button now that Import Configuration covers both.

### Fixed

- Export/Import Configuration round-trips correctly (profiles + settings are restored intact).
- Download statistics now normalize format names so MP3/MP3_320/FLAC roll up correctly.
- Bulk favorites download handles missing or invalid playlist data gracefully instead of failing the whole batch.
- Allowed GitHub API in CSP so the in-app update checker works.

## [1.5.0] — 2026-04-09

### Added

- **Download Statistics Dashboard.** View total downloads, total tracks, top artists, format breakdown, and weekly activity directly on the Downloads page.
- **Duplicate Album Detection.** Warns when an album already exists on disk before downloading.
- **Download Next.** Move pending items to the front of the download queue with one click.
- **Playlist Cover Artwork.** Playlist covers are saved as `cover.jpg` in the playlist folder, or as `{playlist name}.jpg` in the root download directory when no playlist folder is created. Covers are now saved for Deezer, Spotify, and Playlist Sync downloads.
- **Public/Private Badge** for Spotify playlists in the Link Analyzer.

### Changed

- Default concurrent downloads bumped from 3 to 5 for better out-of-box performance.
- Updated to Vue 3.5.32 and electron-builder 26.8.1.
- All HTTP calls in the downloader now have connection and stall timeouts to prevent hanging downloads.
- Compilation/sampler album tracks are now grouped under the album-level artist folder instead of being split across many per-track folders.

### Fixed

- Resolved tracks (FALLBACK / ISRC matches) now keep their original album track number instead of inheriting the alternative version's number.
- Retried failed tracks stay grouped under the parent album/playlist with preserved track counts, instead of becoming orphaned individual downloads.
- Delete Files now removes the entire playlist folder, not just a subfolder.
- M3U generation has an activity-based fallback that triggers after 30s of inactivity, plus a safety timeout for bulk playlist downloads, and only emits the `#PLAYLIST:` tag when the filename template matches.
- Share links pasted into Search now redirect to the Link Analyzer instead of running a literal-text search.
- Album track count is preserved across retries so progress reporting stays accurate.
- Failed album/playlist downloads now show the count of tracks that *did* complete instead of just reporting failure.
- Cancel-all properly stops in-flight bulk paste downloads and resets the queue.
- Playlist Sync now waits for downloads to complete and tracks them properly, only marking successful tracks as known. Force Full Sync is available via right-click on the sync button.
- Compilation albums use album-level explicit status for folder naming rather than per-track status.
- Album titles now wrap to 2 lines with a 3-line clamp at smaller font sizes for better card visibility.
- Better error messaging for inaccessible Spotify personalized playlists and failed Spotify conversions.

### Security

- Fixed all 8 outstanding npm dependency vulnerabilities.
- Expanded path-traversal blocked patterns; Spotify Client ID is masked in logs and error output.

## Earlier Releases

For releases before v1.5.0, see the [GitHub Releases page](https://github.com/DRAZY/deemix-remastered/releases). Highlights:

- **v1.4.0** (2026-03-29) — Auto-update checker, download progress in title bar, global paste, download history, settings export/import, playlist diff, retry-only-failed-tracks for partial playlists.
- **v1.3.0** — Spotify integration (playlist conversion via ISRC matching), playlist sync engine.
- **v1.2.0** — Security hardening (SSRF protection, sandboxed login window, error sanitization, ARL cookie domain hardening).
- **v1.1.x** — Multi-language support (22 languages), additional color themes.
- **v1.0.0** — Initial release.

[1.5.6]: https://github.com/DRAZY/deemix-remastered/releases/tag/v1.5.6
[1.5.5]: https://github.com/DRAZY/deemix-remastered/releases/tag/v1.5.5
[1.5.4]: https://github.com/DRAZY/deemix-remastered/releases/tag/v1.5.4
[1.5.3]: https://github.com/DRAZY/deemix-remastered/releases/tag/v1.5.3
[1.5.2]: https://github.com/DRAZY/deemix-remastered/releases/tag/v1.5.2
[1.5.1]: https://github.com/DRAZY/deemix-remastered/releases/tag/v1.5.1
[1.5.0]: https://github.com/DRAZY/deemix-remastered/releases/tag/v1.5.0
