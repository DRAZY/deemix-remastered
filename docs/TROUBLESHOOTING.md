# Troubleshooting

Common problems and how to fix them. If your issue isn't listed here, search [open and closed issues](https://github.com/DRAZY/deemix-remastered/issues?q=is%3Aissue) — it's likely been seen before.

---

## Installation

### Windows blocks the installer (SmartScreen or Smart App Control)

The Windows builds are not code signed, so every new release starts with no reputation on Microsoft's side. What you see depends on which protection is active:

- **SmartScreen** ("Windows protected your PC"): click **More info**, then **Run anyway**. The warning is about the missing certificate, not about anything found in the file.
- **Smart App Control** (Windows 11, on by default on some new installs): there is no "run anyway". It blocks unsigned files with no reputation outright, and it can only be turned off, permanently until Windows is reinstalled, under Windows Security > App & browser control. A release that worked for you last month and is blocked this month is the same situation: the new file has a new hash and no reputation yet.

Signing the builds is the real fix and is being looked at.

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

### "Quota limit exceeded" when downloading a large discography

Deezer's public API enforces a per-IP rate limit. When the app builds the download queue for a big artist discography it fetches each release's metadata, and on large discographies that burst can briefly trip Deezer's limit. These messages are **transient** — the app paces requests and retries with backoff, so they usually recover on their own.

**Fix:** Update to v1.10.10+ (paced list-building, jittered retry, and a second-pass retry so releases aren't silently dropped). If on an older version, grab the discography in smaller batches or just re-run it — already-downloaded tracks are skipped. This is independent of the "Max concurrent downloads" setting (the limit is hit while building the list, not while downloading).

### The `RELEASETYPE` tag isn't written on downloads

`RELEASETYPE` (Album / Single / EP / Compilation, for Navidrome separation) is written on download starting in v1.10.12, but a settings-sync bug in v1.10.12–v1.10.13 caused it to be dropped on the download path (it only appeared if you retagged afterward).

**Fix:** Update to **v1.10.14+**, where it's written on download as intended (on by default; toggle under Settings → Metadata tags). To add it to music downloaded earlier, run **Retag Library** over the folder. Note: the type comes from Deezer, which is reliable for albums/singles/compilations but often mislabels EPs, so EP detection is best-effort.

---

## Qobuz Integration

**"Connect your Qobuz account in Settings first" even though Settings shows connected**
Update to v2.1.1+ — earlier builds could misread an app-level signing problem as a dead session and lock into a false "expired" state that reconnecting never cleared. If it ever recurs on 2.1.1+, fully quit the app (not just the window) and relaunch, then reconnect once.

**Downloads fail with "not available at the requested quality"**
Not every track exists at every tier on every plan. With **Bitrate Fallback off**, tracks unavailable at your requested quality error by design instead of silently downgrading. Turn Bitrate Fallback on (Settings → Downloads) to accept the best available tier — such tracks get a "Lower bitrate" badge so nothing is silent.

**An album came down with some tracks from a different release ("Alternate version" badge)**
Labels sometimes lock individual tracks of a release on Deezer, most often on deluxe and anniversary editions, so those tracks cannot be streamed or downloaded by anyone. When that happens the app downloads the alternate version Deezer points to, or failing that a version matched by ISRC on another release. The alternate is not always the same recording. It can be a different master, and the badge's track list marks each one **Same recording** or **Different recording**. Nothing is circumvented here: the original is tried first, and the alternate is an official release that Deezer's own catalog points to for the locked track. From 2.6.3 an alternate inside an album download keeps that album's cover, release date, barcode and label, so the album looks like one release in your player, while the track title and ISRC stay those of the recording you received. Albums downloaded before 2.6.3 can show mixed cover art for this reason, and downloading them again with overwrite on fixes it. If you want the exact track or nothing, turn off **Alternate version fallback** (Settings → Downloads). Locked tracks then fail with a message saying so, and the fix for a coherent album is usually to download the standard edition instead.

**A playlist only downloaded 50 tracks**
Fixed in v2.1.1 — Qobuz pages track listings 50 at a time and earlier builds only fetched the first page. Re-run the playlist after updating; already-downloaded tracks are skipped.

**"This purchased release can only be downloaded from your Qobuz account page"**
Some purchased content (e.g. mixed-version albums) is only released by Qobuz through their own site (qobuz.com → My purchases), not the player API the app uses. That's a Qobuz-side restriction.

**Free account connects but can't download**
Qobuz requires a paid plan for downloads — that's enforced on their side.

## Spotify Integration

### "Spotify credentials not configured"

The app needs your own Spotify Developer API credentials to convert Spotify playlists to Deezer.

**Fix:**
1. Go to https://developer.spotify.com/dashboard and create an app.
2. Copy the Client ID and Client Secret.
3. In the app: Settings → Spotify → paste both → click **Test Connection**.

Note that since 9 March 2026 the Spotify account you create that app under must have Spotify Premium. See "Spotify says a premium subscription is required" below.

### A playlist fails to sync with "Spotify no longer lets other apps read its own playlists"

You are trying to sync one of Spotify's own playlists. These are the ones Spotify makes rather than a person: the editorial lists like "All Out 60s", "Today's Top Hits" and "RapCaviar", and the auto-generated ones like "Discover Weekly" and "Release Radar". Spotify stopped letting other apps read them, so the request comes back as if the playlist does not exist.

Nothing is wrong with your credentials, and this is not affected by whether you have Premium. Verified on 2026-08-11: "All Out 60s", "Today's Top Hits", "RapCaviar" and "Discover Weekly" all return HTTP 404, while every playlist made by a person returns normally.

You can tell them apart from the link. Spotify's own playlists have an ID beginning `37i9dQZ`:

```
https://open.spotify.com/playlist/37i9dQZF1DXaKIA8E7WcJj   <- Spotify's, cannot be synced
https://open.spotify.com/playlist/4P8LYbKIDMDeXHKOXPGaXI   <- someone's, syncs fine
```

**Fix:** open the playlist in Spotify, select all the tracks, add them to a new playlist of your own, and sync that one instead. A copy you own is readable.

### Spotify says a premium subscription is required

The full message is "Active premium subscription required for the owner of the app".

In [February 2026](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security) Spotify changed the rules for developer apps. From 9 March 2026, the account that created the app must have Spotify Premium. This is about the **owner of the developer app only**. It does not matter whether the playlist's creator has Premium, and the people whose playlists you read do not need it.

Confusingly, entering your credentials can still appear to work, because Spotify still issues the access token. Only the actual requests are refused. Deemix Remastered 2.5.5 and later perform a real read when you click **Test Connection**, so this shows up straight away rather than the first time a sync runs.

**Fix:** put Spotify Premium on the account that owns the developer app, or create the app under an account that already has it. Spotify notes it can take a few hours after the subscription changes before requests are allowed.

### Spotify returns the playlist name but none of the songs

The message says Spotify sent the playlist details but not the songs in it.

The same [February 2026](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security) change restricts *what* a developer app receives, not just whether it works. A playlist's contents are only returned for the account that authorised the request. Deemix Remastered signs in with a Client ID and Secret and no personal Spotify login, so there is no such account and the songs are withheld for every playlist, including ones you created yourself. Copying tracks into a playlist of your own does not help, for the same reason.

This only affects Client IDs created recently. Credentials registered before February are still served the songs, which is why most setups are unaffected.

**Why there is no "sign in with Spotify" button.** Adding a personal login would create the authorising account Spotify wants, and it was considered. It was not built, for two reasons. February also removed public playlist browsing from the supported endpoints, so signing in would likely restore your own playlists without restoring the ability to open a link someone sent you, which is the main reason people use this. And it would mean maintaining a second authentication path against an API that has narrowed twice in eighteen months. Spotify support here is a convenience for converting links; Deezer and Qobuz are what the app is for.

**Fix:** in the Spotify Developer Dashboard, request extended access for your app so it leaves Development Mode. That is Spotify's own route out of these restrictions and it is the only one available today.

### Spotify playlist conversion finds wrong tracks

Spotify-to-Deezer matching uses ISRC codes (the standardized track identifier) first, then falls back to title+artist search. ISRC matching is exact; the search fallback is best-effort and can mismatch on covers, live versions, or remixes.

**Fix:**
- Check the Link Analyzer's match list: a row matched by ISRC is the same recording, a row matched by search is a best guess.
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

Known limitation (issue #57). The "New Releases" page is backed by Deezer's public **editorial** endpoint (`/editorial/0/releases`) — a *curated* selection, not a complete feed of everything released, and it appears to serve a single global feed regardless of `Accept-Language` or country query parameters. So a brand-new release can be genuinely absent from the feed even on release day if Deezer didn't include it in their editorial picks. The page also fetches live each time you open it (there's no cached list or refresh interval to clear), so re-opening or waiting won't surface a release the endpoint isn't returning.

**Workaround:** Use **Search** by artist or album name, or visit the artist's page directly (full discographies come from `/artist/{id}/albums`, the complete chronological list — so a release missing from New Releases will still show there).

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
