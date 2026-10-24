# Goblin

A simple, local video and music downloader for **Mac and Windows**, built on [yt-dlp](https://github.com/yt-dlp/yt-dlp).
Paste links (or search), pick Video or Music, done. Everything runs on your own computer: no account, no server,
no Docker, and nothing keeps running after you quit.

This is the standalone version of the downloader inside [Media Hub](https://github.com/pugcadet/media-hub).
Both apps use the same download engine (`src-tauri/src/downloads.rs`), so a fix in one is a copy-paste away from the other.

## What it does

| Screen | |
| --- | --- |
| **Download** | Paste one or more links (one per line, ⌘/Ctrl+Enter). **Video**: up to 4K/1440p/1080p/720p/480p, MP4 or MKV, optional subtitles (embedded), chapters and thumbnail inside the file. **Music**: M4A, MP3, Opus or FLAC with title/artist/album tags and a square cover. Whole playlists and albums, cut sponsor segments, file names as *Title [id]* / *Artist - Title* or a folder per channel/artist. |
| **Queue** | A few downloads at once (you choose how many), the rest wait. Live progress, speed, time left, "item 3/12" for playlists. Cancel, retry, show the file in Finder/Explorer. |
| **Search** | Search YouTube Music songs or YouTube videos and download as music or video with one click. |
| **Settings** | Download folder, downloads at once, optional YouTube sign-in cookies from your browser, yt-dlp version and update. |

Organizing and renaming for Jellyfin is left to FileBot (or Media Hub's Renamer); Goblin just downloads, cleanly named.

## Install

1. Open the **Releases** page of this repository and download the newest file for your computer
   (`.dmg` for Mac, `-setup.exe` for Windows).
2. The app is not signed with a paid developer certificate, so the first start needs one extra click:
   - **Mac:** drag Goblin to Applications and open it. If macOS blocks it, open System Settings → Privacy & Security and click **Open Anyway**.
     If macOS says the app is damaged, run once in Terminal:
     `xattr -dr com.apple.quarantine /Applications/Goblin.app`
   - **Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**.
3. Start it. Goblin fetches yt-dlp on first start (checked against its published checksum) and saves to
   `Downloads/Goblin` until you choose another folder.

ffmpeg and deno come **inside** the app; there is nothing else to install. Macs with Apple silicon (M1 and newer)
and 64-bit Windows 10/11 are supported.

## Reliable by design

- **yt-dlp stays current.** YouTube changes often, so Goblin quietly updates yt-dlp every few days
  (Settings → Tools → *Update now* does it right away). Every download of yt-dlp is checked against its SHA-256 checksum.
- **All of YouTube's qualities.** deno (shipped inside the app) lets yt-dlp run YouTube's player code.
- **Retries** on flaky connections, **resume** of half-finished downloads, **never overwrites** an existing file.
- **Playlists keep going** when one video is private or removed; the row says "Finished with problems".
- **Quit means quit.** Closing the window stops every download and everything it started (also ffmpeg).

## Safety

- **No shell.** yt-dlp is started directly with a fixed set of options; your yt-dlp config files are ignored;
  only `http(s)` links are accepted and the link always comes after `--`, so it can never act as an option.
- **No open ports, no web server.** The window talks to the app through Tauri's built-in bridge.
  The window itself has no file-system, shell or network access.
- **Files stay in your download folder.** "Show in Finder/Explorer" only works for files inside it.
- **Cookies are off by default.** When switched on (Settings → YouTube sign-in), yt-dlp reads them from your
  browser on this computer only when it needs them; Goblin never stores or sends them anywhere else.

## Where things live

| What | Where |
| --- | --- |
| Downloads | The folder you choose (default: `Downloads/Goblin`) |
| Settings, Goblin's copy of yt-dlp | The app's data folder: Mac `~/Library/Application Support/app.goblin.downloader`, Windows `%APPDATA%\app.goblin.downloader` |
| ffmpeg, ffprobe, deno | Inside the app (next to the Goblin program) |

## Building it yourself

Every push to `main` builds and tests on Mac and Windows (GitHub Actions) and publishes the installers on the
Releases page. Build logs are kept on the `ci-logs` branch.

On your own computer you need Node 22 and Rust:

```bash
npm install
bash scripts/fetch-sidecars.sh          # ffmpeg, ffprobe and deno for this computer (Git Bash on Windows)
npx tauri dev                           # run it
npx tauri build                         # make the .app/.dmg or the Windows installer
cargo test --manifest-path src-tauri/Cargo.toml
```

## Code

- `src-tauri/src/downloads.rs` – the download engine, **shared with Media Hub** (keep both copies identical).
  Pure parts are unit tested: the yt-dlp command line, progress parsing, search results, checksums, error text.
- `src-tauri/src/` – the rest of the small Rust core: settings (`config.rs`, `state.rs`), file-name rules (`naming.rs`).
- `src/` – the window (React + TypeScript). `queue.ts` is the download queue, `prefs.ts` the remembered choices.
  `styles.css` is Media Hub's stylesheet plus a short Goblin section at the end.
- `scripts/fetch-sidecars.sh` – downloads and verifies ffmpeg, ffprobe and deno for the build.
- `.github/workflows/build.yml` – builds, tests and publishes the Mac and Windows installers.
