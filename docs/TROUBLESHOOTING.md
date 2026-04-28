# Troubleshooting

Common problems and how to fix them. If your issue isn't listed here, search [open and closed issues](https://github.com/DRAZY/deemix-remastered/issues?q=is%3Aissue) — it's likely been seen before.

---

## Login & Authentication

### "Invalid ARL token format" or "Invalid or expired ARL token"

The ARL cookie is what authenticates you to Deezer. It expires periodically (typically every few months) and gets invalidated when you change your Deezer password.

**Fix:**
1. Open https://www.deezer.com in your browser and log in.
2. Open DevTools (`F12` on most browsers) → **Application** tab → **Cookies** → `https://www.deezer.com`.
3. Find the `arl` cookie. Copy its **Value** (a long alphanumeric string, ~192 characters).
4. Paste it into the app's login dialog.

If you copied the cookie name instead of the value, or if the value is shorter than ~100 characters, you'll see the "Invalid ARL token format" error.

### "Session expired. Please log in again to download."

Your ARL was valid at startup but Deezer invalidated it during use (often because you logged out somewhere else, or the token aged out).

**Fix:** Sign out of the app (Settings → Account → Logout), then log in again with a fresh ARL.

### "License token required for downloads"

The app authenticated successfully but didn't receive a license token from Deezer's gateway. This usually means your account isn't eligible for that quality tier (e.g. trying to download FLAC on a free account).

**Fix:** Confirm you have a Deezer Premium or HiFi subscription. Free accounts can't download lossless. If you have HiFi and still see this, log out and back in.

---

## Downloads

### Tracks fail with "Download error: getaddrinfo ENOTFOUND"

A specific Deezer CDN host couldn't be resolved or reached. Sometimes a single track in a playlist fails this way while neighboring tracks succeed (see issue #28).

**Fix:**
- Check your internet connection.
- The same track via Link Analyzer (paste the share URL) often works because it routes through a different CDN. Try downloading the track directly instead of as part of the playlist.
- If a corporate VPN or DNS-level ad blocker is active (e.g. Pi-hole), allowlist `*.dzcdn.net`.

### "PreferredBitrateNotFound: FLAC not available"

A specific track isn't available in the quality you requested (FLAC requires a HiFi subscription, and not every track is mastered in lossless).

**Fix:** Either switch quality to MP3 320 in Settings, or enable **Bitrate Fallback** so the app automatically downloads the next-best available quality instead of failing.

### Downloads don't start after canceling a bulk download

Known issue (#39). When everything is canceled mid-bulk, the queue can get into a state where new downloads sit in "pending" indefinitely.

**Fix:** Restart the app. The queue resets cleanly on launch.

### Track downloaded into the wrong album folder (e.g., from a playlist)

When a playlist track has its own album metadata, the app uses that album's folder structure — but if the playlist provides different metadata than the track's standalone album, you can end up with `Artist/Wrong Album/...`.

**Fix:** Right-click the playlist sync button → **Force Full Sync** to redo the playlist with fresh metadata. For one-off downloads, find the track via Search or Link Analyzer (which uses the canonical track metadata) and re-download.

### Various Artists samplers create one folder per artist

Known. If you download a sampler/compilation, individual tracks may end up under each track's individual artist instead of `Various Artists/`.

**Fix:** This is corrected in v1.5.0+ for new downloads via the Compilation Album fix (compilation tracks now use the album-level artist for folder naming). If you're seeing it on an older version, update to v1.5.2.

---

## Spotify Integration

### "Spotify credentials not configured"

The app needs your own Spotify Developer API credentials to convert Spotify playlists to Deezer.

**Fix:**
1. Go to https://developer.spotify.com/dashboard and create a free app.
2. Copy the Client ID and Client Secret.
3. In the app: Settings → Spotify → paste both → click **Test Connection**.

### Spotify playlist conversion finds wrong tracks

Spotify-to-Deezer matching uses ISRC codes (the standardized track identifier) first, then falls back to title+artist search. ISRC matching is exact; the search fallback is best-effort and can mismatch on covers, live versions, or remixes.

**Fix:**
- Enable **ISRC Fallback** in Settings (on by default in v1.5.0+) so converted tracks always include the ISRC for tagging.
- For high-stakes playlists, review the Link Analyzer's match list before downloading and skip any tracks whose confidence score is low.

### "Failed to authenticate with Spotify"

Wrong Client ID or Secret, or the values are swapped.

**Fix:** Re-copy both values from the Spotify Developer Dashboard. The Client Secret is hidden by default — click **View Client Secret** to reveal it. Both values are alphanumeric without spaces.

---

## M3U Playlist Files

### Bulk playlist downloads stop generating M3U files after ~10–45 playlists

Known issue (#37, #43, #45, #49, #50). M3U generation has historically been the most fragile part of bulk operations.

**Fix in v1.5.0+:**
- Activity-based fallback now triggers M3U generation after 30 seconds of download inactivity, recovering stuck playlists.
- A safety timeout for bulk downloads ensures M3U files are written even if some tracks fail.
- The M3U tracker uses unique IDs to prevent duplicate/skipped tracks in `processedCount`.

If you're still hitting this on v1.5.2, it's worth a fresh issue with the playlist URLs that fail.

### `#PLAYLIST:` tag in the M3U file conflicts with Navidrome / other players

By design — some media servers ignore the filename when this tag is present.

**Fix:** Currently the tag matches the filename template. To skip it, use a custom M3U filename template that doesn't trigger the tag emission. (A toggle to disable it entirely is tracked in #46 as a feature request.)

### M3U paths point to the wrong location

If your M3U file references `\Shakira\Nice 2000s\track.flac` but the file is actually at `\Shakira\Laundry Service\track.flac`, the playlist track was resolved to a different album version (FALLBACK or ISRC match) and the M3U recorded the resolved path.

**Fix in v1.5.0+:** Track Number Preservation keeps resolved tracks at their original album position. For downloads from before this fix, delete the affected playlist folder and re-download.

---

## File Organization

### Explicit-tag folders aren't being created (e.g., no `(Explicit)` suffix)

Issue #40, #42. The `%explicit%` variable in folder templates uses album-level metadata, not track-level — so a playlist track from an explicit album can land in a non-explicit folder if the playlist's track metadata doesn't carry the album-level explicit flag.

**Fix in v1.5.0+:** Folder template now fetches album-level explicit status from the public API for playlist tracks. Some specific tracks (notably tracks where Deezer itself doesn't mark the album explicit) may still fall through.

### `%owner%` template variable

Available in v1.5.0+. Use `%owner%` in the **Playlist** folder template (Settings → Folder Structure) to include the playlist creator's name. Useful for differentiating playlists with the same name from different uploaders.

### `%date%` template variable

Available in v1.5.0+. Inserts the download date in the folder name. Combine with the M3U filename template (`%playlist% - %date%`) for date-stamped playlist files.

---

## Where Files Are Stored

### Downloaded music

Wherever you set in **Settings → Downloads → Download Path**. Default is your OS Downloads folder.

### Configuration & download history

The app stores its own data (settings, profiles, download history JSON, encrypted credentials) in the standard Electron `userData` directory:

- **macOS:** `~/Library/Application Support/Deemix Remastered/`
- **Windows:** `%APPDATA%\Deemix Remastered\`
- **Linux:** `~/.config/Deemix Remastered/`

Download history is capped at the last 500 entries. To reset, delete the relevant JSON file inside `userData`.

### Encrypted credentials

The ARL token and Spotify Client Secret are encrypted via Electron's `safeStorage` (OS keychain on macOS/Linux, DPAPI on Windows). They're not portable across machines — exporting your settings (Settings → Profiles → Export Configuration) bundles non-credential settings only.

---

## Region / Geo-restriction

### Some albums don't appear in New Releases despite being available in my region

Known limitation (issue #57). The "New Releases" feed uses Deezer's public editorial endpoint, which appears to serve a single global feed regardless of `Accept-Language` or country query parameters. Tracking this — see the issue for the investigation log.

**Workaround:** Use **Search** by artist or album name, or visit the artist's page directly (full discographies are region-aware via different API paths).

### "Track not available - may be geo-restricted or require Premium subscription"

The track is licensed but not in your region or not at the quality tier your account has.

**Fix:** Try a lower quality (MP3 320 instead of FLAC). If the track is geo-restricted, no client-side fix exists — Deezer enforces region availability at the streaming endpoint.

---

## Auto-Update

### "Failed to check for updates"

The update checker hits GitHub's API. If your Content Security Policy or network blocks `api.github.com`, this fails silently.

**Fix in v1.5.0+:** GitHub API is allowlisted in the app's CSP. If you're still seeing this on v1.5.2, check whether a system-level firewall or DNS filter is blocking GitHub.

---

## Reporting a Bug

Before filing:
1. Update to the latest release (Settings → About → check for updates).
2. Search [existing issues](https://github.com/DRAZY/deemix-remastered/issues?q=is%3Aissue).
3. Reproduce in a clean run (restart the app, retry the action).

If still broken, [open a new bug report](https://github.com/DRAZY/deemix-remastered/issues/new?template=bug_report.yml). The template asks for the version, OS, exact reproduction steps, and any error messages — please fill all fields. Attaching a screenshot or the relevant log excerpt helps a lot.

For security issues, **do not** open a public issue — see [SECURITY.md](../SECURITY.md) for the private disclosure path.
