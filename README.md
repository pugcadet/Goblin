# Goblin

A video and music downloader for **Mac and Windows**, built on [yt-dlp](https://github.com/yt-dlp/yt-dlp), with a
MeTube-style window and everything the original Mac-only Goblin did for videos and music. Everything runs on your own
computer: no account, no server, no Docker, and nothing keeps running after you quit.

It shares its download module with [Media Hub](https://github.com/pugcadet/media-hub) (`src-tauri/src/downloads.rs`)
and its look and update system (`updater.rs`, `Updates.tsx`).

## What it does

| Screen | |
| --- | --- |
| **Download** | Paste links one per line (⌘/Ctrl+Enter) or type “Artist - Song”. One line says what will happen: **[preset · summary] → [folder]**. Click the preset for a popover: pick another preset, or change quality, format, codec, subtitles, chapters, SponsorBlock, audio format, tags and lyrics *just for this download* (with *Reset* and *Save as preset…*). **More** in the popover: clip (start → end), name prefix, playlist limit, start right away, video password, extra yt-dlp options, import / copy links. **Auto-detect** suggests (or applies) the right preset, or offers *Subscribe instead*. **Preview** shows qualities, size, subtitles, chapters and whether audio is the official track. |
| **Queue** | One list in sections: **Needs you** (low-confidence music matches: pick one, search, or keep the title), **Now** (stage, progress, speed, time left), **Up next**, and **Finished** with Done / Failed filters, albums and playlists grouped, bulk retry / remove / delete files, Show in Finder/Explorer and a log per download. History is kept between starts. |
| **Search** | One search box with **Songs / Albums / Videos / Podcasts** and **Artist discography**. Songs: YouTube Music's own search with plays and filters (hide covers & karaoke, minimum plays, most played, per artist). Albums: hover a cover for **Get album**, or open it to check every track first. Tick songs, albums or videos and a bar at the bottom downloads them all with one preset. Podcasts: the Apple Podcasts directory, subscribe to the feed. |
| **Album finder** | Open any album: its tracklist, untick tracks, choose the cover (YouTube Music, Apple Music, Deezer, Cover Art Archive, your own picture or a link), MusicBrainz editions, every track checked against YouTube Music (✓ / ⚠ / pick another upload), then download with all tags decided. |
| **Music tagging** | MusicBrainz tags (album, album artist, track/disc numbers, date, genre, label, ISRC, MusicBrainz IDs), Cover Art Archive covers (square, up to 1200 px), synced lyrics from LRCLIB embedded in the file, ReplayGain or loudness normalization, clean-up of “(Official Audio)” and friends, featured artists in the title or the artist, ID3v2.3/2.4. One ffmpeg pass per file. Typed “Artist - Song” finds the official studio track. Podcast mode files episodes by show and date. |
| **Subscriptions** | Channels, playlists and podcast feeds, checked while Goblin is open. A list on the left (new, paused or problem at a glance) and a panel with **New uploads**, **Older videos** (what is already on the channel, newest 50 up to everything, already-downloaded ones hidden, pick and download) and **Rules** (skip Shorts or live streams, members-only, length, recent only, title must match / include / not include, a maximum per check, keep only the newest N). |
| **Fix music** | Choose old files or folders: Goblin matches each on MusicBrainz and fixes tags, cover, ReplayGain, lyrics and names, as a copy in your library or in place. *Other match…*, *Set album for selected…* (lines your files up with an album's tracks), and **Find missing tracks** (compares the albums in a music folder with YouTube Music and lists what you don't have). |
| **Presets** | Your own presets for video and music: every option above, a default, duplicate, reset. |
| **Settings** | Pages for **Folders & names** (the library, and per type — videos, music, podcasts, original title — a sub-folder or any folder such as your NAS, with name patterns and a live example), **Downloads**, **Music**, **Subscriptions**, **YouTube account** (sign in / out), **Appearance**, **Advanced** (yt-dlp, helpers, global options, speed limit, templates) and **Updates**. Search finds a setting on any page. |

**Browser button** (bookmarklet): Settings → Downloads. It sends the page you're on to Goblin through `goblin://add?url=…` (no server).

Shows (TMDB / your own series), web pages and the menu bar of the Mac-only Goblin are left out on purpose: FileBot
or Media Hub do the TV naming.

## Where files go

Everything lands in one **library** folder (default `Downloads/Goblin`), ready to copy to your NAS:

```
YouTube/Veritasium/The Surprising Genius of Sewing Machines.mp4     (patterns in Settings)
Music/Daft Punk/Random Access Memories (2013)/Get Lucky.mp3          (cover and lyrics inside the file)
Podcasts/Hardcore History/2025-09-01 - Episode.mp3
Other/Original title [id].mkv                                       ("Keep original title" presets)
```

## Install

1. Open the **Releases** page and download the newest version: `Goblin-macos.dmg` (Mac) or `Goblin-windows-setup.exe` (Windows).
2. The app is not signed with a paid developer certificate, so the first start needs one extra click:
   - **Mac:** drag Goblin to Applications and open it. If macOS blocks it, open System Settings → Privacy & Security and click **Open Anyway**.
     If macOS says the app is damaged, run once in Terminal: `xattr -dr com.apple.quarantine /Applications/Goblin.app`
   - **Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**.
3. Start it. Goblin fetches yt-dlp on first start (checked against its published checksum).

ffmpeg, ffprobe and deno come **inside** the app. Macs with Apple silicon and 64-bit Windows 10/11 are supported.

**Updates**: Goblin checks GitHub for a newer version a few seconds after start (Settings → Goblin updates), verifies
it against its `SHA256SUMS` file and replaces itself. GitHub only answers this check anonymously for **public**
repositories; while this repository is private, download new versions from the Releases page yourself.

## Safety

- **No shell, no open ports.** yt-dlp, ffmpeg and ffprobe are started directly with an argument list. yt-dlp options
  that run programs or read other files (`--exec`, `--netrc-cmd`, `--external-downloader`, `--plugin-dirs`,
  `--config-location`, …) are refused, also in “extra options”.
- **The window can only do a short list of things** (`src-tauri/src/host.rs`): web requests only to MusicBrainz,
  Cover Art Archive, LRCLIB, Deezer, Apple, YouTube Music and their picture servers; files only inside your library
  folder, Goblin's own data folder and folders you picked in a dialog; deleting only to the Trash / Recycle Bin.
- **YouTube sign-in is optional and local.** Settings → YouTube sign-in → *Sign in to YouTube…* opens Google's own
  sign-in page in a private window that can't talk to Goblin. Once you're signed in, Goblin copies only the
  youtube.com cookies (no password, no google.com cookies) to `cookies.txt` in its own data folder (readable only
  by you), closes the window and throws its session away. *Sign out* deletes the file. Nothing leaves your computer
  except the normal requests to YouTube.
- **The sign-in is only used when YouTube says a video is age-restricted or members-only**: that one video, one at
  a time, 30 s apart, with a daily cap. Search, subscriptions, YouTube Music and normal videos never send it.

## Building it yourself

Every push to `main` builds and tests on Mac and Windows (GitHub Actions) and publishes one release per version
(`v1.2.0`, …, from `src-tauri/tauri.conf.json`). Bump the version in `tauri.conf.json`, `Cargo.toml` and
`package.json` to publish a new one. Build logs are kept on the `ci-logs` branch.

```bash
npm install
bash scripts/fetch-sidecars.sh          # ffmpeg, ffprobe and deno for this computer (Git Bash on Windows)
npx tauri dev                           # run it
npx tauri build                         # make the .app/.dmg or the Windows installer
cargo test --manifest-path src-tauri/Cargo.toml
```

## Code

- `src/engine/` – the downloader itself, in TypeScript: `jobs.ts` (queue and the video/music pipelines),
  `search.ts` (search and album finder), `subs.ts`, `fix.ts` (Fix music, missing tracks, preview, auto-detect),
  `services.ts` (MusicBrainz, LRCLIB, Deezer, Apple), `ytmusic.ts`, `tagger.ts` (ffmpeg), `ytdlp.ts`.
  It only talks to the computer through `host.ts`.
- `src-tauri/src/host.rs` – the checked tools the engine may use. `downloads.rs` – yt-dlp install/update (shared with Media Hub).
  `updater.rs` – Goblin updates (same as Media Hub's).
- `src/screens/` – the window (React). `src/styles.css` follows Media Hub's look with Goblin's green.
- `test/e2e.ts` – runs the engine with real yt-dlp and ffmpeg on local media (see the file for how).
