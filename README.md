<p align="center">
  <img src="docs/banner.png" alt="Deemix Remastered" width="800" />
</p>

<p align="center">
  <strong>Deemix Remastered is exactly what it sounds like: the classic downloader, remastered.</strong>
  <br /><br />
  Built from scratch with zero original code, just the spirit of Deemix re-engineered into something faster, sharper, and far more capable. True hi-res FLAC from Qobuz, the full Deezer catalog, Spotify conversion, pro-grade tagging, and a live-telemetry interface (the "Signal Deck") that makes downloading music feel like operating studio hardware.
</p>

<p align="center">
  <a href="https://github.com/DRAZY/deemix-remastered/releases"><img alt="Release" src="https://img.shields.io/github/v/release/DRAZY/deemix-remastered?color=C8F135&label=release" /></a>
  <a href="https://github.com/DRAZY/deemix-remastered/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/DRAZY/deemix-remastered/total?color=C8F135&label=downloads" /></a>
  <a href="https://github.com/DRAZY/deemix-remastered/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/DRAZY/deemix-remastered?color=C8F135" /></a>
  <a href="https://github.com/DRAZY/deemix-remastered/actions/workflows/typecheck.yml"><img alt="CI" src="https://github.com/DRAZY/deemix-remastered/actions/workflows/typecheck.yml/badge.svg" /></a>
  <img alt="Last commit" src="https://img.shields.io/github/last-commit/DRAZY/deemix-remastered?color=C8F135" />
  <br />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white" />
  <img alt="Vue" src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-GPL--3.0-green" />
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" />
</p>

---

## Features

### Qobuz Integration, True Hi-Res Downloads

- **Hi-Res FLAC up to 24-bit/192 kHz:** DRM-free at the highest tier your plan and the track allow (paid Qobuz plan required)
- **Channel Q Tab:** a dedicated Qobuz home with your Purchases and Favorites, editorial feeds, playlists, and genre filters
- **Native Search & Browse:** a Deezer/Qobuz source toggle, Qobuz artist pages with release-type tabs, and 30-second previews
- **Link Analyzer:** paste any Qobuz track, album, or playlist URL and download it directly
- **Quality Transparency:** cards show each release's quality ceiling, and every download reports the tier actually delivered
- **Full Settings Parity:** folder structure, naming, artwork, tagging, duplicate skip, and overwrite modes all apply to Qobuz
- **Secure by Design:** your Qobuz session token lives only in OS secure storage, never in settings, exports, or backups
- **Flexible Login:** sign in through the Qobuz window, paste a bare token, or pair a token from another tool with its App ID and Secret

### Music Discovery & Browsing

- **Home Dashboard:** new releases, top tracks, top albums, and popular playlists at a glance
- **Search:** tracks, albums, artists, and playlists with tabbed filtering and batch selection
- **Charts:** global and country-specific charts for tracks, albums, artists, and playlists
- **Artist Pages:** full discographies filtered by albums, EPs, singles, compilations, and features, sortable by name or date
- **Genres:** a dual-service genre browser with full Qobuz catalogs per genre plus Deezer editorial picks and charts
- **Album & Playlist Views:** track listings with metadata, selective downloads, and audio previews
- **Link Analyzer:** paste one Deezer, Spotify, or Qobuz URL, or a whole list of them, to view details and download directly
- **Favorites Import:** pull your liked tracks, albums, artists, and playlists from Deezer

### Downloading

- **Audio Formats:** MP3 128, MP3 320, and FLAC, with Qobuz reaching hi-res FLAC up to 24-bit/192 kHz
- **Batch & Bulk:** download whole albums and playlists, select individual tracks, or paste many links to queue at once
- **Download Queue:** pause, resume, reorder by drag-and-drop, cancel, and retry, with retries grouped under their album or playlist
- **Resume on Startup:** optionally continue any download still running when you last closed the app (off by default)
- **Duplicate Detection:** warns when an album is already on disk, with an optional ISRC skip that catches the same recording across releases
- **Smooth at Any Scale:** the queue and history virtualize, so a 1,000-track rack scrolls like a 10-track one
- **Live Throughput:** album and playlist rows show real combined speed, mirrored in the sidebar sparkline and title-bar meter
- **Smart Fallbacks:** automatic bitrate and format fallback, plus three-tier resolution (FALLBACK, ISRC) when a version is unavailable
- **Natural Pacing:** optional random delays between downloads so a large batch does not hit Deezer as one burst (off by default)
- **History & Stats:** a persistent log of the last 500 downloads, plus totals, top artists, format breakdown, and weekly activity
- **Concurrent Downloads:** configurable from 2 to 50 at once (default 5)
- **Delete Files:** remove downloads from the app, sending the whole album or playlist folder to the system Trash

### Metadata & Organization

- **ID3 Tagging:** 26 configurable fields including title, artist, album, lyrics, ISRC, BPM, and Release Type
- **Featured Artists:** all credited artists included, with a configurable separator
- **M3U Playlists:** optional M3U8 generation for playlists, with a separate toggle for albums and a customizable filename template
- **Artwork:** embedded and local cover art with configurable size and format, plus a playlist cover saved as `cover.jpg`
- **Synced Lyrics:** optional LRC file generation
- **Folder & Track Templates:** customizable organization with variables like `%artist%`, `%album%`, `%year%`, `%explicit%`, and `%barcode%`

### Retag Library

- **Metadata-Only Retag:** rewrite tags on your existing `.mp3`/`.flac` files with no re-download, leaving the audio stream byte-identical
- **ISRC Matching:** files are matched by their stored ISRC via Deezer's public API, so retagging needs no login and no quota, and unmatched files are skipped rather than guessed
- **Qobuz Fallback:** files Deezer cannot match fall back to Qobuz on an exact ISRC only, and rows carry a Q chip when Qobuz sourced the tags
- **Merge, Never Replace:** only the tags you enable are rewritten, and everything else, including artwork, is preserved
- **Dry-Run Preview:** see exactly which tags would change, per file, before writing
- **Refresh from an Album/Playlist:** retag files you already have using the exact release you are viewing, so barcode, label, and genre come from the right edition

### Spotify Integration

- **Multi-Service Conversion:** convert a Spotify link to Deezer, Qobuz, or both, with the picker right on the Link Analyzer
- **Availability Matrix:** in Both mode, see per track which service has it, set a preferred source with fallback, or override any track
- **Track Matching:** ISRC-based matching with search fallback and confidence scoring
- **Mixed Downloads:** a cross-service conversion lands as one playlist tagged D and Q, and every track shows its source
- **Public/Private Badge:** Spotify playlists show visibility status in the Link Analyzer

### Playlist & Artist Sync

- **Automatic Sync:** watch Spotify and Deezer playlists and pinned artists for new tracks and releases, on a schedule you set
- **Diff-Based:** only new tracks download, and failed tracks retry on the next sync
- **First-Sync Modes:** for artists, choose subscribe-forward (default), download-backlog, or date-threshold, with per-artist release-type filters
- **One-Click Pin:** pin any favorite playlist or artist to sync, individually or all at once, each with a live status badge
- **Settings-Aware:** uses your configured quality, folder structure, and metadata

### User Experience

- **"Signal Deck" Interface:** an industrial-console design with a live status-strip title bar, a numbered channel rail, a Transfer Rack with VU meters, and a command-bar search
- **Themes:** 9 color themes with dark, light, and system mode
- **Readable Text:** secondary text meets the WCAG AA contrast minimum on every theme, mode, and surface
- **Settings Profiles:** save, apply, export, and import named configurations (Audiophile, Quick, and Balanced built-ins plus your own)
- **Backup & Restore:** one backup file for your whole app data, with per-segment and per-profile selection
- **Quality of Life:** slim sidebar, keyboard shortcuts, search history, context menus, offline detection, toasts, and an auto-update checker

### Supported Languages

Arabic, Chinese (Simplified & Traditional), Croatian, English, Filipino, French, German, Greek, Indonesian, Italian, Korean, Polish, Portuguese (Brazil & Portugal), Russian, Serbian, Spanish, Thai, Turkish, and Vietnamese, fully translated across the entire app.

### Security

- **Encrypted Credentials:** ARL tokens, Spotify secrets, and the Qobuz token stored via Electron safeStorage, never in settings, exports, or backups
- **Recoverable Deletes:** "Delete Files" moves to the system Trash, and the download root itself can never be deleted
- **Hardened I/O:** path-traversal and SSRF protection, URL validation, error sanitization, and sandboxed windows

---

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/link-analyzer.png" alt="Link Analyzer - Cross-Service Availability Matrix" /><br />
      <sub><b>Link Analyzer:</b> the cross-service availability matrix. Convert a Spotify link against Deezer and Qobuz at once and see where every track lives</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/link-analyzer-convert.png" alt="Link Analyzer - Service Picker & Live Progress" /><br />
      <sub><b>Link Analyzer:</b> the Deezer / Qobuz / Both service picker with a live conversion progress bar</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/home.png" alt="Home - New Releases" /><br />
      <sub><b>Home:</b> the Signal Deck console, with new releases and the Transfer Rack stacking finished hi-res albums</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/channel-q.png" alt="Channel Q - Qobuz Discover" /><br />
      <sub><b>Channel Q:</b> the Qobuz tab, with Purchases and Favorites, quality badges, editorial feeds, and genre chips</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/downloads.png" alt="Downloads - Completed Hi-Res Albums" /><br />
      <sub><b>Downloads:</b> per-album completion with delivered-quality chips, status edge-lights, and the stats dashboard</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/settings.png" alt="Settings - Profiles & Appearance" /><br />
      <sub><b>Settings:</b> quick presets, custom profiles, export and import, and 9 color themes across dark and light modes</sub>
    </td>
  </tr>
</table>

---

## Downloads

Pre-built binaries are available on the [Releases](../../releases) page.

| Platform | Architecture | Formats |
|----------|-------------|---------|
| **macOS** | Universal (Intel + Apple Silicon), ARM64 (Apple Silicon) | `.dmg` |
| **Windows** | x64, ARM64 | `.exe` (Installer), `.exe` (Portable) |
| **Linux** | x64, ARM64 | `.AppImage`, `.deb` |

If the app earns a place in your workflow, a star on this repository is the easiest way to say so. It costs nothing, and it is how other people find the project.

---

## Getting Started

### 1. Install the App

Download the appropriate build for your platform from the [Releases](../../releases) page and install it.

### 2. Log In with Your Deezer ARL Token

A Deezer ARL (Authentication) token is required to download music:

1. Log in to [deezer.com](https://www.deezer.com) in your browser
2. Open Developer Tools (`F12`) and go to the **Application** tab
3. Under **Cookies** > `https://www.deezer.com`, find the `arl` cookie
4. Copy its value and paste it into the app's login dialog

> **Note:** A Deezer Premium or HiFi subscription is required for high-quality downloads (FLAC and 320 kbps).

### 2b. (Optional) Connect Qobuz for Hi-Res

Go to **Settings → Qobuz** and click **Connect**. A real Qobuz login window opens; sign in and you're done. Your session is stored encrypted on your machine. A paid Qobuz plan is required for downloads, and hi-res tiers follow your plan.

### 3. Browse, Search, or Paste a Link

Use the search bar, browse charts and new releases (or the **Channel Q** tab for Qobuz), or paste a Deezer/Spotify/Qobuz URL into the Link Analyzer to find music.

### 4. Download

Click the download button on any track, album, or playlist and select your preferred quality.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + K` or `Cmd/Ctrl + F` | Focus search |
| `Cmd/Ctrl + D` | Go to downloads |
| `Cmd/Ctrl + ,` | Open settings |
| `Cmd/Ctrl + H` | Go to home |
| `Cmd/Ctrl + /` or `Cmd/Ctrl + Shift + ?` | Show shortcuts help |
| `Escape` | Close modals |

### Spotify Playlist Conversion

1. Go to **Settings** and enter your Spotify API credentials (Client ID and Secret)
2. Navigate to **Link Analyzer**
3. Paste a Spotify playlist or album URL
4. Choose Deezer, Qobuz, or Both, and let the app match tracks by ISRC with search fallback
5. Download the matched tracks

**Two limits Spotify imposes, both outside this app's control:**

- **The account that creates the developer app needs Spotify Premium.** Spotify [changed this in February 2026](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security), effective 9 March 2026. It applies to the app's owner only, not to anyone whose playlists you read. Without it, credentials appear to save correctly but every request is refused.
- **Spotify's own playlists cannot be read.** Editorial lists such as "All Out 60s" and auto-generated ones such as "Discover Weekly" are blocked for all third-party apps. Their links contain an ID starting `37i9dQZ`. Copy the tracks into a playlist of your own and use that instead.

Both are explained in more detail, with fixes, in [Troubleshooting](docs/TROUBLESHOOTING.md#spotify-integration).

---

## Settings Overview

The Settings page offers deep customization organized into these categories:

| Category | Key Options |
|----------|-------------|
| **Appearance** | Theme (9 color themes, Signal default), dark/light/system mode, slim sidebar, slim downloads |
| **Downloads** | Quality (128/320/FLAC), max concurrent, natural download pacing, overwrite mode, bitrate fallback, playlist file (with a separate album toggle) and M3U filename template |
| **Folder Structure** | Create artist/album/playlist/CD folders, templates with `%explicit%`, `%owner%`, `%date%` support |
| **Track Naming** | Templates for single tracks, album tracks, and playlist tracks |
| **Metadata Tags** | Toggle 21 individual ID3 tag fields (title, artist, album, lyrics, ISRC, BPM, etc.) |
| **Album Covers** | Save covers, embedded/local artwork size, JPEG quality, PNG option |
| **Text Processing** | Artist separator, date format, featured artists handling, title/artist casing |
| **Language** | Choose from 22 supported languages |
| **Account** | Deezer ARL token management |
| **Spotify** | Client ID, Client Secret, fallback search toggle |
| **Playlist Sync** | Add Spotify/Deezer playlists, set sync schedule, enable/disable |
| **Profiles** | Save, apply, export, import named settings configurations |
| **Backup and Restore Settings** | Full app-data backup file with per-segment selection (app preferences · download profiles · synced playlists · synced artists · favourites · login info) plus per-profile picker on both export and restore |

---

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- [npm](https://www.npmjs.com/) 9 or later
- [Git](https://git-scm.com/)

**Building Linux `.deb` packages on macOS** additionally requires:

```bash
brew install dpkg fakeroot binutils
```

(`fpm` shells out to `ar`; macOS ships BSD ar which produces malformed Debian archives. The repo includes a `scripts/build-tools/ar` shim that redirects to GNU ar from `binutils` when running on macOS, and the npm scripts wire it in automatically.)

### Setup

```bash
git clone https://github.com/DRAZY/deemix-remastered.git
cd deemix-remastered
npm install
```

### Development

```bash
# Start the Vite dev server + Electron
npm run electron:dev

# Or start just the Vite dev server (web only)
npm run dev
```

### Build

```bash
# Build for the current platform
npm run build

# Platform-specific builds
npm run build:mac          # macOS Universal (Intel + Apple Silicon)
npm run build:mac-arm64    # macOS Apple Silicon only
npm run build:win          # Windows x64
npm run build:win-arm64    # Windows ARM64
npm run build:linux        # Linux x64
npm run build:linux-arm64  # Linux ARM64

# Build all platforms
npm run build:all
```

Build output is written to the `release/` directory.

---

## Documentation

- **[Architecture](docs/ARCHITECTURE.md):** how the renderer, preload bridge, and main process fit together, including the project layout and walkthroughs of common data flows
- **[Troubleshooting](docs/TROUBLESHOOTING.md):** solutions for login issues, download failures, M3U glitches, Spotify integration, Qobuz connection issues, and more
- **[Qobuz Integration Notes](docs/QOBUZ_INTEGRATION.md):** build log and API notes behind the Qobuz integration
- **[Security Triage Log](docs/SECURITY_TRIAGE.md):** disposition record for every CodeQL alert: what was found, what was fixed, and why

---

## Versioning

This project follows [Semantic Versioning](https://semver.org/). See the [Releases](../../releases) page for the full changelog.

---

## Support the Project

Deemix Remastered is free, open source, and built in spare time. If you like the app, the single most useful thing you can do is [star the repository](../../stargazers). Stars are how GitHub ranks projects in search and recommendations, so every one of them puts the app in front of someone who has not found it yet.

Beyond that, the ways to help are the usual ones: report bugs with a log line or a file attached, answer a question in [Discussions](../../discussions), or tell someone who still uses the original.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Please open an [issue](../../issues) first for major changes to discuss the approach.

---

## License

This project is licensed under the [GPL-3.0 License](LICENSE).

---

## Disclaimer

This application is not affiliated with or endorsed by Deezer, Qobuz, or Spotify. Use responsibly and in accordance with your local laws regarding music downloading. Please respect copyright laws and the terms of service of music streaming platforms. Qobuz features require your own active Qobuz subscription.

---

<p align="center">
  Made with care by <strong>Team MAXIMUS</strong>
</p>
