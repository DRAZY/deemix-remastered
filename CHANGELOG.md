# Changelog

All notable changes to **Deemix Remastered** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries use a compact format, short bullets, one line each. Full per-version detail and release notes live on the [GitHub Releases page](https://github.com/DRAZY/deemix-remastered/releases).

> **Releasing:** add entries under `## [Unreleased]` as you work. At release time, rename that heading to `## [X.Y.Z] - <date>` (the hyphen matters, the About page parser keys on it), add a fresh empty `## [Unreleased]` above it, then run `scripts/release-notes.sh X.Y.Z` to emit that version's notes for `gh release create --notes-file`.

## [Unreleased]

### Added

- **Link Analyzer takes many links at once (#142, requested by @cisko99za).** Paste any number of Deezer, Spotify or Qobuz links into the box, separated by spaces, commas or new lines, and the analyzer works through them one at a time with a row per link. Each row turns green when it is ready or red with the reason when it fails, and one failure does not stop the rest. Spotify links are matched during the run, so a green row is ready to download. Click a row to see its full details below, download a single row, or use Download all ready to queue everything that resolved. A single link behaves exactly as before.

- **Favorites loads each section on its own and can open on the tab you choose (#149, requested by @GravuTrad).** Import from Deezer used to fetch tracks, albums, artists and playlists as one request and show nothing until the largest had finished, so a library with thousands of favourite tracks made every tab wait on the tracks. Each section is now its own request and appears the moment it arrives, with a small spinner on any tab still loading. A section that fails to load is reported and left as it was instead of sinking the whole import. Settings > Appearance has a new "Favorites: open on" choice for which tab the Favorites page opens to.

## [2.6.1] - 2026-09-10

### Summary

- **A fix release: the synced-lyrics toggle from 2.6.0 now works, Settings keeps your panels folded, a higher quality setting can re-download something you already have, and you can copy a Deezer or Qobuz link back out of the app. French is now fully translated.**

### Added

- **Copy Link on downloads and on playlist and album pages (#150, requested by @alex5908).** Right-click any row in the Downloads rack for Copy Link and Copy Title, and the playlist and album pages now have Copy Link at the top of their right-click menu. The link is the public Deezer or Qobuz address, so a playlist that failed can be pasted straight back into Link Analyzer or a browser. Rows that finished before this version show Copy Link greyed out, since they were recorded without the id needed to rebuild it.

- **French is complete (#148, contributed by @GravuTrad).** Every string in the app now has a French translation, replacing the partial one that fell back to English for about a third of the interface. Existing strings were polished too, with proper French quotation marks and apostrophes.

### Fixed

- **The "prefer synced lyrics" toggle from 2.6.0 did nothing (#141, reported by @shark0151).** The setting saved and showed as on, but the app kept writing both the .lrc and the .txt. The checkbox was never sent to the part of the app that writes the files, so it always ran with the option off. It is now sent, and it was tested both ways on a real download: on gives one .lrc, off gives both files. It also now survives switching profiles.
- **Settings remembers which panels you collapsed (reported by @cisko99za in discussion #105).** The collapse state of each Settings section was never saved, so every launch reopened Profiles, Appearance, Languages, Downloads, Accounts, Spotify and Qobuz, and anyone who rotates their Deezer ARL had to fold the same panels again to reach Accounts. The state is now kept between launches.
- **Switching to a higher quality lets you download an item again (#144, requested by @username227).** A track, album or playlist that had already come down as MP3 128 was refused with "was already downloaded" even after you changed the setting to 320 or FLAC. The check now compares the quality it was delivered at with the quality you have selected, and steps aside when yours is higher. Same or lower quality still gets the notice, so nothing is refetched for a downgrade. The quality shown on the transfer row at the moment you start a download is the tier being requested; it updates to the delivered tier once Deezer answers.

## [2.6.0] - 2026-08-23

### Summary

- **Two additions: you can now follow a playlist creator to see everything else they've made, and lyrics no longer have to arrive as two files.**

### Added

- **Click a playlist's creator to browse their other playlists (#135, requested by @alex5908).** On a Deezer playlist, the creator's name under the title is now a link that opens everything else they've shared, so finding one playlist you like leads to the rest of that person's taste. Creators who keep their profile private show as plain text instead of a link, since there's nothing behind it to open. Qobuz playlists list an owner without a profile to link to, so those are unchanged.
- **Retag can now backfill the copyright tag (#139).** Anything downloaded before 2.5.10 has no copyright tag, and Retag couldn't repair it because it reads a different source than downloads do. Point Retag at those folders with Copyright ticked and it fills them in, no re-downloading needed. Requires a Deezer login; without one the field is skipped and everything else still retags.
- **A setting to skip the plain .txt when synced lyrics are available (#141, requested by @shark0151).** The app used to save both the .lrc and the .txt for the same track, which meant two files saying the same thing. Turn this on and only the .lrc is kept, with the .txt still written for tracks that have no synced version. Off by default, so nothing about your existing library changes unless you ask.

## [2.5.10] - 2026-08-23

### Fixed

- **Copyright was missing from every Deezer download (#139, reported by @lukisbaby).** Deezer publishes copyright, but not on the endpoint the app was asking. The call it used for track details doesn't include the field at all, so the tag had nothing to write and silently stayed empty. It now reads the endpoint that does carry it, and only when the copyright tag is switched on, so nobody pays an extra request for a tag they don't use. Applies to both MP3 and FLAC.

## [2.5.9] - 2026-08-21

### Summary

- **MP3 downloads were being saved with no tags at all.** A single malformed lyric timestamp aborted the whole tag write, so the file arrived with no title, artist, album, artwork or anything else. FLAC was never affected.

### Fixed

- **MP3 files downloaded with synced lyrics enabled had no tags whatsoever (#139, reported by @lukisbaby).** The tag library requires a synced-lyric timestamp to be a whole number and refuses anything else. Deezer returns them as text, so the write was rejected outright, and the fallback path was rejected for the same reason, leaving the file with no tag block at all. It looked like individual fields were missing because every field was. Timestamps are now converted before use, and any line that still cannot be read is dropped rather than taking the whole file down with it. Synced lyrics are enabled by default, so this affected most MP3 downloads.

## [2.5.8] - 2026-08-21

### Summary

- **Playlist folders were saving one track's album cover instead of the playlist's own artwork, and a security pass hardened how the app writes files and logs.** Downloading itself is unchanged. Covers now land correctly, and several ways a file could be left half-written are closed.

### Fixed

- **A playlist folder showed a random track's album cover instead of the playlist artwork.** The playlist's own cover has to be fetched over the network before it can be saved, while a finished track already holds its album art in memory. With several tracks downloading at once, a track's cover reached `cover.jpg` first and the playlist's image then found the file already there and gave up. The playlist now claims that filename before it starts fetching. Album downloads are unaffected.
- **Qobuz playlists were labelled as albums in the downloads list.** The badge was fixed to "album" regardless of what had actually been queued. Deezer playlists were always labelled correctly.
- **Album art and tags could be left truncated when several tracks finished at the same moment.** Covers, playlist covers, artist images and tag writes now go to a temporary file and are swapped into place in one step, so a partly written file can never be read or left behind.
- **A track title containing a line break could forge extra rows in `errors.txt`.** Those fields are flattened to a single line before the file is written.

### Changed

- **Remote text has line breaks stripped before it reaches the app's logs**, across the download, authentication and server paths, so a crafted track or playlist name cannot fake log entries.
- **The build workflow pins its Bun setup action to an exact commit** instead of a moving tag, so an upstream change cannot alter what runs in CI.
- **Deezer share links are matched on the actual hostname** rather than by searching for that text anywhere in the address, so a lookalike address is no longer accepted.

## [2.5.7] - 2026-08-15

### Summary

- **Spotify changed the shape of its playlist replies, and downloads stopped working for anyone who registered a developer app recently.** The app now reads both the old and the new format, and explains the one case Spotify will not let it read at all.

### Fixed

- **Spotify links failed with "Cannot read properties of undefined" (discussion #105, reported by @alex5908).** In February 2026 Spotify renamed the fields carrying a playlist's songs. Apps registered before that change are still sent the old names and kept working, which is why this only affected people who created their Spotify credentials recently. The app now accepts either format, so both groups work.
- **A playlist whose songs Spotify withholds now explains itself instead of failing strangely.** The same change means a developer app only receives the contents of playlists owned by the account that authorised it; everything else arrives with the name and artwork but no songs. That is a successful reply as far as Spotify is concerned, so it used to slip past the error handling entirely. It is now recognised and explained.
- **Explanations reached people syncing a playlist but not people downloading one.** The messages written for 2.5.5 were only wired into the sync path, so the same underlying problem produced a clear answer in one place and a raw error in another. Both paths now use them.
- **The suggested workaround no longer sends recent setups down a dead end.** Both messages used to say that copying the tracks into a playlist of your own would fix it. That holds only for Spotify credentials created before February 2026. Newer ones are refused the songs for every playlist including one you just made yourself, so the messages now say which case you are in and point at requesting extended access. Thanks to @alex5908, who tested the old advice and reported that it did not work.

### Changed

- **Long playlists page through Spotify's own paging links** rather than a fixed address, so a future rename of the endpoint cannot break them either.

## [2.5.6] - 2026-08-14

### Fixed

- **A playlist's M3U file was written into the first track's album folder instead of the download root (#138).** With folder creation for playlists switched off, the M3U tracker latched onto whichever album folder appeared first, so the playlist file ended up filed under an unrelated album. Album M3U generation, which shares the same tracker, is unchanged.

## [2.5.5] - 2026-08-11

### Summary

- **When a playlist fails to sync, the app now tells you why.** Two different Spotify problems used to look identical, and neither of them explained itself. Both now say what happened and what to do about it.

### Fixed

- **A failed sync showed a red ERROR label and nothing else (#137).** The reason was being recorded the whole time, it simply was never displayed, so there was no way to tell a Spotify restriction apart from a problem with your own settings. The explanation now appears on the playlist itself.
- **Syncing one of Spotify's own playlists now explains itself.** Spotify no longer lets other apps read the playlists it makes: the editorial ones such as "All Out 60s" and "Today's Top Hits", and the automatic ones such as "Discover Weekly". Spotify reports these as though the playlist does not exist, which previously surfaced as an unexplained failure. The app now recognises them and tells you to copy the tracks into a playlist of your own and sync that instead, which works. Playlists made by people were never affected.
- **The Test Connection button no longer reports success when Spotify will refuse every request.** Since 9 March 2026 Spotify requires the account that created your developer app to hold Spotify Premium. Spotify still hands out an access token in that situation and only refuses the actual requests, so the button was reporting a good connection to people whose every sync was going to fail. It now performs a real read before saying it worked, and explains the subscription requirement if that is what is blocking you. This affects only the owner of the developer app, not the people whose playlists you read.

### Changed

- **The Spotify setup instructions now state both of Spotify's restrictions up front**, in the README and in the troubleshooting guide, so they are visible before you spend time on a setup that cannot work.

## [2.5.4] - 2026-08-09

### Summary

- **Small text throughout the app is easier to read, in every theme.** This is the same problem as the track count in 2.5.2, found everywhere else it occurs. Nothing moves and no colours change character; the greyer text simply stops being quite so faint.

### Fixed

- **The muted grey used for secondary text was too light on cards and panels.** Labels, hints, settings descriptions and similar small text are drawn in a lighter grey so they sit behind the main text. That grey was measured against every one of the app's twenty theme and mode combinations, on all three background shades each of them uses, and it fell below the recognised minimum for readable text in four of them, on the darker card and tile backgrounds in particular. It was slightly too light before anything else was done to it, so the grey itself has been adjusted: a little darker in light mode and in the light Signal theme, a little lighter in Dracula. Every combination now clears the minimum. The other seventeen were already fine and are untouched.
- **Thirty-three places were fading that text further still.** On top of the grey, individual labels were being drawn at partial opacity, some as low as 30%, which took them well below readable. That extra fading has been removed. These elements are still clearly secondary, because they were already set apart by size, spacing, capitals and typeface rather than by the fading. Twelve other faded elements were left exactly as they are on purpose: the drawings on empty pages, and options that are switched off, where the fading is what tells you the option is unavailable.

## [2.5.3] - 2026-08-09

### Fixed

- **Track counts now appear on New Releases, Charts and Genres.** These pages never showed the `TRK` line, while search results and Qobuz pages did. The reason is that the Deezer feeds behind them do not include a track total: the New Releases feed returns thirteen fields per album and a track count is not one of them, and the public chart and editorial feeds leave it out as well. The app was correctly hiding a number it had never been given. It now looks the count up separately for those albums and remembers it, so the first visit to one of those pages takes a couple of seconds longer while the numbers come in and every visit after that is immediate. Nothing was removed in 2.5.2; that release made the existing counts easier to read, which is what made the pages that never had them stand out. Reported by DRAZY.

## [2.5.2] - 2026-08-09

### Fixed

- **The track count on album and playlist cards is readable now.** The small `109 TRK` line under the artist name was being dimmed twice, a muted grey then dropped to 60% opacity, at a 9.5px size. Measured against every one of the ten themes in both dark and light mode, all twenty combinations fell below the WCAG AA minimum for text this size, the worst of them at less than half the required contrast. The extra dimming is gone and the line now sits at the same grey as the artist name above it. It stays clearly distinct because it is already set in the monospace face, smaller, uppercase and widely letter-spaced, so the hierarchy never depended on the fading. This also brings it in line with the identical `TRK` readout in the download panel, which was full strength all along. Reported by alex5908, with a useful observation from cisko99za that the line only appears when the service actually returns a track count, which is why some cards show it and others do not.

## [2.5.1] - 2026-08-09

### Summary

- **A fix-only release for two problems in 2.5.0. Nothing in the app itself changed.** If your 2.5.0 macOS download refused to open, this is the release that fixes it. Windows and Linux users are on identical code to 2.5.0 and have nothing to gain by updating, though nothing to lose either.

### Fixed

- **macOS builds are properly signed again.** The 2.5.0 macOS downloads failed to open, with macOS calling the app damaged and offering only to move it to the Trash. The app was not damaged. Moving to a newer build tool in 2.5.0 silently dropped a step: older versions automatically applied a basic signature when no developer certificate was present, and the newer one stopped doing that and simply skipped signing. That left the bundle carrying the stock signature from an unmodified copy of Electron, which no longer matched its own contents, and macOS refuses to open an app whose signature does not verify. Signing is now requested explicitly rather than left to a default, so the macOS builds carry the same valid signature every release before 2.5.0 did. Windows and Linux downloads were never affected. Reported by DRAZY.
- **Building from source with npm works again (#136).** `npm install` stopped at once with an `EOVERRIDE` error about postcss. The 2.5.0 security pass pinned a minimum version for postcss in two places and the two did not agree, and npm refuses to continue when they disagree. It is a source-build problem only: the released downloads were built and shipped correctly and nobody using them was affected. The pin is now written so the two places cannot drift apart again. Reported by username227.

## [2.5.0] - 2026-08-07

### Summary

- **This is a security release. Nothing in the app itself changed, but everything underneath it did.** No settings move, no features are added or removed, and the app looks and behaves exactly as 2.4.4 did. The version number moved to 2.5.0 rather than 2.4.5 because the entire engine the app runs on was replaced, and if some display oddity does turn up, it will help to know which release it arrived in.
- **Updating is safe and nobody gets left behind.** Existing settings, library, and download history carry over untouched. System requirements are unchanged: macOS Monterey or newer, Windows 10 or newer, and the same Linux versions as before.

### Security

- **The app runs on a current browser engine again.** Deemix Remastered is built on Electron, which bundles the same engine Chrome uses to draw the interface and talk to Deezer, Qobuz, and Spotify. It had been sitting on Electron 39, and Electron only issues security fixes for its three newest versions. 39 fell out of that window and received its last fix on 5 May 2026, so for three months every browser security fix published had been missing from the app. This release moves to Electron 43, which takes the engine from Chromium 142 to Chromium 150, eight versions of accumulated fixes, and the copy of Node inside the app from 22 to 24. This matters more here than it would in an offline tool, because the app loads real web pages: the Deezer sign-in window, the Qobuz player used to sign in, and cover art fetched from their servers.
- **Linux AppImage builds no longer add the folder they are launched from to the library search path.** Every AppImage released up to and including 2.4.4 was built by a version of the packaging tool that left a stray separator at the end of `LD_LIBRARY_PATH`. Linux reads that empty entry as "look in the current directory", so a file placed next to the AppImage could be loaded and run in place of a real system library. Anyone using the `.AppImage` should replace it with this build. The `.deb` packages were never affected, and neither were the Windows or macOS builds.
- **Twenty-two of the thirty-two known issues in the build toolchain are resolved.** These sit in the tools that assemble the installers rather than in the app you run, but they are worth closing regardless. The ten that remain are all the same component on one build-time path, they cannot be reached by anything a user does, and they are documented in `docs/DEPENDENCY_SECURITY_AUDIT.md` along with why forcing a fix would break the packaging instead.

### Changed

- **The interface libraries the app is built on were brought up to date.** Pinia, Vue I18n, Vue Router, and Vite all moved up a major version. None of this is meant to be visible. It is listed because it is the kind of change that can produce an odd rendering or layout glitch, and if you hit one it will help to know the version it arrived in.
- **Installers no longer carry leftover files from previous builds.** The build wrote each release into a folder it never cleared first, so unused fragments from earlier versions had been accumulating and shipping inside the app. The build now starts clean.

## [2.4.4] - 2026-07-31

### Fixed

- **Turning off album playlist files now works (#131).** 2.4.3 added the "Also create one for each album" option but the app never told its own download engine what the checkbox was set to, so the engine stayed on its built-in default of on and kept writing an .m3u8 into every album folder no matter what you chose. The setting is now sent through correctly. Verified by downloading a 14 track album with the option off, which produced no playlist file, and again with it on, which produced one. Reported by SchwanzusLongus.

## [2.4.3] - 2026-07-31

### Added

- **Playlist files for albums are now a separate setting (#131).** "Create playlist file" meant two different things at once: an .m3u8 for playlists, and one for every album as well. The two are not equally useful. A playlist's file is the only record of its ordering and selection, while an album folder and its tags already say the same thing. Downloading a whole discography therefore left one file in every album folder, and Navidrome, MusicBee and similar tools ingest each of those as its own playlist, filling the library with entries that duplicate albums it already shows. A new sub-option, "Also create one for each album", is on by default so nothing changes for anyone already using playlist files, and can be turned off to keep playlist files while stopping the per-album ones. Reported by SchwanzusLongus.
- **Option to skip the folder for one and two track releases (#129).** Pulling a discography used to leave a folder for every single, each holding one file. A new folder option, "Create a folder for releases with 1 or 2 tracks", is on by default and can be turned off to send those tracks straight into the artist folder instead. It keys on how many tracks a release actually has rather than on how the service labels it, so a one-track EP is treated the same as a one-track single, and a five-track EP still gets its folder. Works the same for Deezer and Qobuz, on manual album downloads and on artist sync. Requested by AmiFox.

### Fixed

- **Re-downloading a track at a higher bitrate no longer keeps the lower one.** MP3 128 and MP3 320 produce the same filename, since the naming templates have no bitrate variable. With the overwrite mode set to its default of "no", asking for 320 over a track already on disk at 128 found the file, skipped the download, reported success, and showed MP3 320 on the row with no downgrade warning, while the 128 file stayed where it was. The app now reads the real bitrate out of the file already on disk and only skips when it is the same tier or better, so an upgrade always downloads and a downgrade never overwrites. The same check was added to the duplicate-track skip, which matched on recording identity alone and would keep a 128 file for a download that would have been lossless. FLAC was never affected, because it has its own file extension.
- **Every completed download is now checked against the file it actually produced.** The quality shown on a finished download came from what the service said it was sending, and nothing ever compared that to the bytes on disk. The app now reads the encoding out of the finished file. If the tier disagrees with the label, the label is corrected so the quality chip and the downgrade warning tell the truth; if the file is not even the right kind of audio, the download fails and the file is removed rather than being left with a misleading extension and the wrong tags written into it.
- **A failed decryption chunk can no longer reach the file.** An internal fallback would have copied still-encrypted bytes into the output on a decryption error, producing a file that reported success but held noise. It now stops the download instead. The related buffer guarantee that keeps decryption lossless is asserted at runtime rather than assumed.
- **A private Spotify playlist is no longer blamed on the editorial API change.** Spotify answers 404 both for its own editorial and algorithmic playlists and for a user's private playlist, and the app reported every one of them as the first case, ending with "playlists created by regular users still work" while someone stared at their own playlist failing. The message now branches on the playlist ID: links starting with `37i9` keep the editorial explanation, everything else says the playlist is private or gone, explains that Spotify credentials identify the app rather than the person, and points to the Make public option. Raised by alex5908 on #117.

### Changed

- **The Replay Gain setting now says what the tag does to playback (#130).** It was a bare checkbox, which left people to discover by ear that files can play quieter than expected. It is now labelled "Replay Gain (playback loudness tag)" and explains that the tag holds the service's reference loudness, that players which understand it (foobar2000, VLC, most car and USB head units) use it to level playback, that the audio itself is never modified, and that this is why a file can sound quieter than the same track from a tool that writes no tag. Raised on #130.
- **The Settings description for Spotify now names Qobuz.** It still described the pre-2.4.0 behavior, converting to Deezer only, three lines above a disclaimer that correctly named both services. Updated across all 21 languages.
- **Two folder options now say what they do.** "Create playlist structure" and "Create singles structure" were bare checkboxes whose names described nothing, and the second was actively misleading: it reads as though it governs releases Deezer and Qobuz classify as singles, when it only ever applies to tracks downloaded individually. They are now "Create artist and album folders inside playlists" and "Create artist and album folders for individual tracks". Behavior is unchanged, only the labels. Updated across all 21 languages.

## [2.4.2] - 2026-07-24

### Changed

- **Linux window can be sized narrower (#125).** On Linux the window minimum width is lowered from 1024 to 800, so it can be resized smaller than before, which helps on smaller displays and for placing it side by side manually. macOS and Windows keep the 1024 minimum.

## [2.4.1] - 2026-07-24

### Fixed

- **Linux window frame corrected (#125).** 2.4.0 applied the window frame logic backwards, which left Linux with no title bar and no window controls, and put a duplicate title bar on Windows. Linux now correctly uses a native title bar with working minimize, maximize, and top-snap, and Windows is back to a single custom title bar. macOS unaffected. Reported by username227.

## [2.4.0] - 2026-07-24

### Added

- **Multi-service Link Analyzer (#117).** A Spotify link can be converted to Deezer, Qobuz, or both, with the service picker on the analyzer. Requested by alex5908 and cisko99za.
- **Cross-service availability matrix.** In Both mode, every track shows whether it is on Deezer, Qobuz, or both, and how it matched (ISRC or search). A preferred service with automatic fallback resolves each track, and any track can be overridden by clicking its cell. Tracks on neither service are listed and skipped.
- **Per-track source chips and expandable track lists.** Every album and playlist row expands to its full track list, each track tagged with a D (Deezer) or Q (Qobuz) chip. A mixed-source download carries both chips on the row, and downloads across the app are now uniformly source-tagged.
- **Live conversion progress.** Converting a large playlist shows a progress bar with real per-track match counts instead of a static message.

## [2.3.2] - 2026-07-23

### Changed

- **Clearer, more complete disclaimers.** The in-app About disclaimer now names Deezer, Qobuz, and Spotify, states that the app is for personal use with your own accounts, and asks users to follow local laws, copyright, and each service's terms of service (it previously mentioned only Deezer and Spotify). Short per-service reminders were also added at each connect section in Settings. Localized across all 21 languages.

## [2.3.1] - 2026-07-23

### Fixed

- **Maximized window is remembered across launches.** A window closed while maximized reopened at its normal size, because only the size and position were restored, not the maximized state. It now re-maximizes on launch, and the restore-down size is saved correctly so un-maximizing still lands where expected. Reported by cisko99za.

## [2.3.0] - 2026-07-23

### Added

- **Advanced Qobuz connect (from #105).** Settings, Qobuz gains an optional Advanced section where a token minted by another tool (streamrip, qobuz-dl, and similar) can be paired with that tool's App ID and App Secret (and an optional User ID). Qobuz binds tokens to the app that created them, so a token from elsewhere previously read as "expired"; supplying the matching app credentials lets it connect and downloads sign correctly. The username and password login window and plain token paste are unchanged. Confirmed with alex5908 and cisko99za.
- **Album M3U files (#121, legacy Deemix parity).** With "create playlist file" enabled, album downloads now write an .m3u8 into the album folder alongside the tracks, matching the behavior playlists already had. Reported by username227.

### Security

- **Removed the unused `sharp` dependency (Dependabot #46, high).** `sharp` 0.34.5 carried high-severity inherited libvips CVEs but was never imported anywhere in the app (artwork sizing uses CDN-served sizes, not local resizing). Removing it resolves the alert outright and trims a native dependency from the build.

## [2.2.3] - 2026-07-22

### Changed

- **Album covers now open the album (#105 follow-up).** Clicking an album cover opens its detail page and track list, matching Spotify, Apple Music, and Deezer's own client, instead of downloading the whole album. The one-click whole-album download is now the explicit **GET** button that appears on hover. This resolves the common confusion where users clicked the cover expecting to open the album and instead queued a download, never finding the tracklist.
- **Paste-to-bulk-download is now discoverable.** A hint under the search box tells users they can paste Deezer / Spotify / Qobuz links, and that pasting several downloads them in bulk, a capability that already existed but was invisible. Localized across all 21 languages.

### Fixed

- **Spotify → Deezer conversion no longer misreports a rate-limit as "no match."** The converter's Deezer client now retries transient failures (with jittered backoff) via the shared hardened helper, and a real rate-limit surfaces as a clear "Deezer is rate-limiting, try again" message instead of silently marking every track unmatched.
- **Truncated downloads are now detected.** If a transfer closes cleanly but delivers fewer bytes than promised, it's rejected and cleaned up instead of being saved as a corrupt file.
- **Download-row cover art no longer flashes when a cover fails to load.** A failed cover (e.g. a flaky CDN response) used to trigger an infinite reload loop against a broken placeholder; it now settles on a fallback tile.
- **Track preview button now has a tooltip.**

## [2.2.2] - 2026-07-22

### Fixed

- **Spotify Link Analyzer no longer fails opaquely (#119).** The Spotify client used to collapse every non-JSON response into a bare "Failed to parse Spotify response," hiding the real cause (a transient gateway error, a rate-limit, an empty body, or a proxy page) and never retrying. It now retries transient failures (429/5xx and network errors) with backoff honoring Retry-After, and when a response genuinely can't be read it reports the HTTP status and a snippet instead of a dead-end message. The editorial-playlist error now names the real cause, Spotify's late-2024 API change that made its own curated/algorithmic playlists (Today's Top Hits, RapCaviar, Discover Weekly, links starting `37i9`) require a personal login this app doesn't use. Reported by lazside and alex5908.
- **Playlist M3U is saved with the music (#121).** With "create playlist folder" on, the `.m3u8` was written to the download root while the tracks went into the playlist's own subfolder, so it appeared to be missing. It's now written inside the playlist folder, next to the songs, with correct relative paths. Reported by username227.

## [2.2.1] - 2026-07-22

### Fixed

- **Canceling a download actually stops it (#118).** Trash-canning a queue row previously only removed it from the screen, the server kept downloading every remaining track (an entire album, in the report) until the app was quit. Cancel now stops the server-side work: pending tracks are dequeued, the in-flight stream is aborted mid-transfer with its partial file cleaned up, and completed tracks are left untouched. Clear All had the same defect and now aborts in-flight work too. Canceling in the instant before the server has even replied with download ids is also handled. Reported by cisko99za.

## [2.2.0] - 2026-07-20

### Added

- **Token-based Qobuz login (#114).** Settings → Qobuz gains an "Or connect with a token" field: paste a bare `user_auth_token` (e.g. from another tool's configuration, or when the login window is unavailable in your region) and Qobuz identifies the account from the token itself, single-field paste, validated with a plan check, stored through the same encrypted path as the login window. A bad token can never disturb an existing session.
- **Retagger Qobuz fallback (#108).** Files Deezer can't match by ISRC now fall back to Qobuz's catalog (search-then-verify, a candidate is only accepted when its ISRC equals the file's). Retag rows disclose cross-catalog sourcing with a Q chip; fields Qobuz doesn't expose stay untouched rather than guessed.
- **Full localization of the Qobuz era (#109).** Every Channel Q / Genres / token-login / downloads-UX string is keyed and translated across all 20 non-English locales.
- **Qobuz artist Top Tracks wired.** Qobuz artist pages now load the artist's popularity-ordered top tracks (the same list Qobuz's own artist page shows), so the Top Tracks section renders and Download Top Tracks queues them; the button is disabled instead of silently inert when no top tracks exist.
- **Duplicate toast covers album-downloaded tracks.** Album and playlist rows remember the catalog ids of their contained tracks, so re-queuing one of those songs as a single is refused with the familiar "already downloaded" toast instead of creating a row the ISRC library check then skips. Failed tracks inside an album stay re-downloadable.

### Performance

- **Album/playlist downloads skip a per-track metadata round-trip (#112).** The queue reuses the listing's own track metadata, falling back to a live fetch only when essentials are missing.
- **The Downloads view stays smooth with huge queues (#113).** Queue and history rows use browser-native windowing (content-visibility) so a 1,000-row Transfer Rack renders at the cost of the visible screen; the queue endpoint no longer logs a status reduce on every poll.

## [2.1.2] - 2026-07-19

### Added

- **Full genre browsing.** The Genres tab is now dual-service. Qobuz (primary): every primary genre, with a feed-tabbed (New Releases / Most Streamed / Press Awards / Editor's Picks), continuously paginated catalog grid that goes to the end of the genre. Deezer: editorial picks plus Top Tracks / Top Albums now paginate toward Deezer's 100-per-chart API cap (the public API's per-genre limit; its editorial releases endpoint is dead upstream).

- **Qobuz album covers are fetched once per album, not once per track.** The Qobuz path was missing the artwork cache the Deezer path has always had, every track re-downloaded the album cover (at >600px settings, the multi-megabyte original scan), a major share of per-track overhead on large album/playlist runs.

- **Permanent Qobuz link indicator + expiry toast.** The title-bar Q readout no longer disappears when disconnected, it shows Q:LINKED (lit cyan LED) or Q:OFFLINE (dark LED) at all times, with a tooltip. When Qobuz rejects the session token, a toast now announces it immediately ("reconnect your Qobuz account in Settings") and the indicator drops to Q:OFFLINE, previously the user only found out when a download failed.

### Security

- **Spotify client secret is never stored in cleartext.** The legacy localStorage fallback could persist the secret unencrypted when OS-level safeStorage was unavailable; it is now stored safeStorage-encrypted only, or kept in-memory for the session.
- **Server error responses never leak stack traces.** All error-status payloads pass through a central scrub that strips stack fields and collapses raw error objects to message-only.
- **Outbound request guards hardened.** The share-link redirect resolver now also rejects non-default ports, and the Deezer API proxy pins the full origin (scheme + host + port), not just the hostname.
- **Log-forgery hygiene.** User-supplied ids are passed to loggers as arguments instead of being interpolated into format strings.
- All eight open CodeQL alerts resolved; triage log at `docs/SECURITY_TRIAGE.md`.

## [2.1.1] - 2026-07-19

### Added

- **In Library chip.** Downloads whose tracks all skipped as library duplicates show an emerald IN LIBRARY chip (queue + history) explaining nothing was re-downloaded, disambiguating the bare FLAC badge from rows with a real delivered tier.
- **Hover tooltips across the Downloads views.** Truncated album/track titles reveal their full name on hover; every action icon (open folder, retry, retry-failed, download next, delete, remove) carries an instant styled descriptor.

### Fixed

- **Download queue and history now survive app updates.** Both lived only in renderer localStorage, which proved lossy across macOS version rolls, the Transfer Rack and full download history vanished on every update. They now persist to a real file in the app's data folder (`downloads-state.json`, written atomically), with existing localStorage state migrated automatically on first launch.

- **Large Qobuz playlists and albums now download in full (#100).** Qobuz pages track listings at 50 per request, and only the first page was ever fetched, a 273-track playlist queued just 50 tracks. Track pages are now followed until the full listing is held, for both playlists and albums.
- **Qobuz no longer falsely reports "session expired" on Windows and other setups (#100).** Qobuz answers an invalid request *signature* with the same HTTP 401 as a dead session token, so a wrong/stale app secret during download-URL signing killed the whole session state, Settings said connected while everything else demanded a reconnect, forever. Signature failures are now treated as app-credential problems (never session problems); genuine token expiry is still detected on ordinary authenticated calls and via an explicit token-error check.
- **Qobuz artist pages no longer render broken for imageless duplicate catalog entities** (rolled into the final 2.1.0 build): missing artist images self-heal from an exact-name sibling entity, an initial-letter tile stands in when Qobuz truly has no image, and the empty "fans" label is hidden.
- **Open-folder icon restored on duplicate-skipped downloads.** Completions that skipped every track (already in library) never recorded a file path on the queue row, hiding the open-folder button and the delivered-tier badge.

## [2.1.0] - 2026-07-18

### Added

- **Qobuz integration (hi-res downloads).** Connect your Qobuz account (Settings → Qobuz) via a real Qobuz login window, your session token is stored encrypted in OS secure storage, never in plain files. Paste a Qobuz track, album, or playlist link into the Link Analyzer, or search/browse Qobuz directly, everything flows through the same Transfer Rack queue. Qobuz files come down DRM-free, so downloads reach true hi-res FLAC (up to 24-bit/192 kHz) when your plan and the track allow, tagged (title/artist/album/ISRC + embedded cover art) and organized with your existing folder-structure and track-naming templates. Albums and playlists download as one grouped queue item; multi-disc albums get CD subfolders. A paid Qobuz plan is required (free accounts can't download). Deezer and Spotify behavior is unchanged.
- **Channel Q, a Qobuz discover tab.** Your Purchases and Favorites lead, followed by Qobuz's editorial feeds (New Releases, Editor's Picks, Press Awards, Most Streamed) and playlists, with per-row LOAD MORE and SEE ALL full-catalog pages, genre filter chips (Qobuz's own genre taxonomy), and 30-second track previews. Search has a source toggle (Deezer/Qobuz) that sticks between sessions, and Qobuz artist pages get release-type tabs (Albums/EPs/Singles/Compilations) with download buttons throughout.
- **Quality transparency on Qobuz.** Album cards carry a quality-ceiling chip (e.g. "24/192" for hi-res, "CD" for 16-bit), and downloads report the actually-delivered tier ("FLAC 24/96"). When a hi-res stream is repeatedly cut off by the CDN, the app steps down one lossless tier only if Bitrate Fallback is enabled, never silently, and the delivered tier is always disclosed.
- **Genre browsing for Deezer too.** A Genres view with Deezer's editorial picks and per-genre charts (#106).

### Fixed

- **Qobuz downloads honor the app's settings in full parity with Deezer.** Quality follows the Quality setting exactly (a format-key mismatch made every Qobuz download silently fall back to MP3 320 even with FLAC selected); Bitrate Fallback is enforced with correct file extensions and the "Lower bitrate" indicator; playlist folder/track-template/compilation tagging, cover files, embedded artwork, duplicate-track skip (by ISRC), overwrite modes, and the full tagging option set all apply. Qobuz has no lyrics API, so lyrics settings don't apply to Qobuz downloads.
- **Large-transfer reliability.** Qobuz streams use the same battle-tested HTTPS transport as Deezer with a stall watchdog, incomplete-transfer detection, and automatic fresh-URL retries; purchased releases that Qobuz only serves through its own account page now say so plainly instead of failing cryptically.
- **Track Total and Disc Total tags write for Deezer downloads (#107)**, carried in from 2.0.3.
- Review hardening: cancelling a Qobuz download now aborts the in-flight stream immediately; duplicate GET clicks can't queue an album twice; expired preview links resolve fresh on every play; failed playlist loads show a retry instead of a blank page; search and genre browsing are protected against slow stale responses overwriting newer results.

### Security

- **Deletes are recoverable and bounded.** "Delete Files" moves to the system Trash (never permanent deletion), and the download root itself can never be deleted, enforced at the app's process boundary.
- **Credential hygiene.** The Qobuz session token lives only in OS secure storage, it is never written to the settings file, browser storage, settings/configuration exports, or Backup & Restore files (the credentials segment covers Deezer/Spotify only, by design, reconnect Qobuz after restoring on another machine). Qobuz session expiry is now detected and surfaced as a clear "reconnect in Settings" prompt.
- All Qobuz server endpoints validate ids and sanitize error messages before they reach the UI.

## [2.0.3] - 2026-07-18

### Fixed

- **Track Total and Disc Total tags now write for Deezer downloads (#107).** With "Track total" / "Disc total" enabled, files were still tagged with a bare track/disc number (e.g. `5` instead of `5/12`, no disc-of-total). Deezer's private track metadata carries the track's own number but not the album-wide totals, so the tagger never had a value to write. The totals are now sourced from the album, the album context on album/playlist downloads, or an authoritative album lookup for standalone tracks, and applied to the Track Total / Disc Total tags and the `%tracktotal%` / `%disctotal%` filename tokens on both MP3 and FLAC.

## [2.0.2] - 2026-07-16

### Fixed

- **Restored the "New Releases" section on Home, now showing genuinely new, dated releases.** Deezer retired the public endpoint that fed it, so the section had quietly disappeared. It now reads Deezer's real new-release feed, including your personalized "New releases for you" list when signed in, newest first from the last 90 days. Home shows the 30 most recent; See All shows the full window. Old catalog stays out.

## [2.0.1] - 2026-07-15

### Fixed

- **Lyrics files now match their audio file's name (#104).** Synced `.lrc` and plain `.txt` lyrics were named from the bare track title, so with a template like `03 - Song` the lyrics file was called `Song.lrc` and players that match by filename never found it. Lyrics files now take their name directly from the audio file, on every download path including playlist and artist sync.

## [2.0.0] - 2026-07-14

### Changed

- **A complete redesign: "Signal Deck."** The app moves to an industrial-console look: acid chartreuse on blue-black, bold display type, hard edges, and monospaced readouts. The title bar is a live status strip (connection LED, region, quality, real-time throughput, clock), the sidebar is a numbered channel rail with a download-activity sparkline, and the download panel is a "Transfer Rack" where each download is a hardware-style unit with a 16-segment meter and a status edge-light. Search is a QUERY command bar with dense console rows. Signal is the new default theme, every previous theme is kept, and light mode gets a tuned "paper console" variant. Downloads, sync, retag, and settings behave exactly as before.

### Added

- **New DM/RM "Console Stack" app icon**, stacked chartreuse letters with a cyan cursor, on the Dock/taskbar, sidebar, and every OS build.
- **Live album and playlist download speed, plus a clickable "Alternate version" badge** that lists exactly which tracks were fulfilled from an ISRC-matched alternate release, in the panel and in history.

## Earlier releases

Versions before 2.0.0 (the 1.10.x line and earlier) are not detailed here. See the [GitHub Releases page](https://github.com/DRAZY/deemix-remastered/releases) for the full history.
