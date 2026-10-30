// End-to-end check of the engine with real yt-dlp + ffmpeg on locally served media, and canned answers in the
// exact shape MusicBrainz / Cover Art Archive / LRCLIB / YouTube Music return (so no internet is needed).
//   node test/e2e.cjs <yt-dlp> <ffmpeg> <ffprobe> <workdir> <media-server-base>
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setHost } from "../src/engine/host";
import { jobs } from "../src/engine/jobs";
import { store } from "../src/engine/store";
import { fixer, classify, recommend } from "../src/engine/fix";
import { passes } from "../src/engine/subs";
import { parseSong, tagStyle } from "../src/engine/parse";
import { encodeArgs, parseLoudness } from "../src/engine/tagger";
import { items as ytmItems, playCount } from "../src/engine/ytmusic";
import { fill, fsSafe, similarity, splitArgs } from "../src/engine/text";
import { BUILT_IN, effective, RULE_DEFAULTS } from "../src/engine/model";
import { fillPlaylistFields } from "../src/engine/jobs";
import { nodeHost } from "./nodehost";

const [ytdlp, ffmpeg, ffprobe, work, base] = process.argv.slice(2);
let failures = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.log("  ✗ " + msg);
  }
};

// ---- canned web services
const cover = fs.readFileSync(path.join(process.env.MEDIA_DIR ?? ".", "cover.jpg"));
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
const calls: string[] = [];
async function fakeHttp(url: string): Promise<Response> {
  calls.push(url);
  const u = new URL(url);
  if (u.hostname.endsWith("musicbrainz.org") && u.pathname === "/ws/2/recording") {
    return json({ recordings: [{
      id: "rec-1", score: 100, title: "Get Lucky", length: 6000, "artist-credit": [{ name: "Daft Punk", joinphrase: " feat. " }, { name: "Pharrell Williams" }],
      releases: [{ id: "rel-1", title: "Random Access Memories", status: "Official", date: "2013-05-17", "release-group": { id: "rg-1", "primary-type": "Album", "secondary-types": [] }, media: [{ track: [{ number: "8" }] }] }],
    }] });
  }
  if (u.hostname.endsWith("musicbrainz.org") && u.pathname === "/ws/2/release/rel-1") {
    return json({
      id: "rel-1", title: "Random Access Memories", status: "Official", date: "2013-05-17", "artist-credit": [{ name: "Daft Punk", artist: { id: "art-1" } }],
      "label-info": [{ label: { name: "Columbia" } }], genres: [{ name: "disco", count: 5 }], "release-group": { id: "rg-1", "primary-type": "Album" },
      media: [{ position: 1, "track-count": 13, tracks: [{ position: 8, number: "8", title: "Get Lucky", length: 6000, "artist-credit": [{ name: "Daft Punk", joinphrase: " feat. " }, { name: "Pharrell Williams" }], recording: { id: "rec-1", isrcs: ["USQX91300108"] } }] }],
    });
  }
  if (u.hostname.endsWith("coverartarchive.org")) return new Response(cover, { status: 200 });
  if (u.hostname === "lrclib.net") return json({ syncedLyrics: "[00:01.00]Like the legend of the phoenix" });
  return new Response("not here", { status: 404 });
}

async function waitIdle(ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!jobs.snapshot().some((j) => ["queued", "working", "downloading"].includes(j.status))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("jobs didn't finish");
}

const probe = (f: string) => JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format_tags:stream=codec_name,codec_type,width,height", "-of", "json", f]).toString());

async function main() {
  const library = path.join(work, "Library");
  fs.rmSync(work, { recursive: true, force: true });
  setHost(nodeHost({ dataDir: path.join(work, "data"), library, ytdlp, ffmpeg, ffprobe, http: (u) => fakeHttp(u) }));
  await store.load();
  await store.saveSettings({ askOnLowConfidence: false, useArchive: true });
  await jobs.load();
  jobs.setReady(true);

  console.log("pure helpers");
  ok(parseSong("Daft Punk - Get Lucky (Official Video) ft. Pharrell Williams").artist === "Daft Punk" && parseSong("Daft Punk - Get Lucky (Official Video)").title === "Get Lucky", "song titles are parsed");
  ok(fill("{track} - {title}", { track: "", title: "Get Lucky" }, "{title}") === "Get Lucky", "empty fields vanish from names");
  ok(fsSafe("AC/DC: Live?") === "AC-DC- Live-", "file names are made safe");
  ok(similarity("Get Lucky", "get lucky!") === 1 && similarity("abc", "xyz") === 0, "fuzzy matching");
  ok(JSON.stringify(splitArgs(`--a 'b c' -x`)) === JSON.stringify(["--a", "b c", "-x"]), "option strings are split like a shell");
  const m = tagStyle({ title: "Song (Official Audio)", artist: "A, B", ids: {}, coverURLs: [] }, { ...BUILT_IN[2], tagFeat: "title" });
  ok(m.title === "Song (feat. B)" && m.artist === "A", "featured artists move into the title");
  ok(parseLoudness("Integrated loudness:\n    I:         -9.5 LUFS\n  True peak:\n    Peak:       -0.4 dBFS")?.lufs === -9.5, "loudness is read from ffmpeg");
  const ea = encodeArgs({ input: "in", output: "out.mp3", format: "mp3", quality: "320", normalize: false, meta: { title: "T", artist: "A", ids: {}, coverURLs: [] }, cover: "c.jpg" }, "opus");
  ok(ea.includes("libmp3lame") && ea.includes("attached_pic") && ea.includes("title=T"), "one ffmpeg pass: encode + tags + cover");
  ok(fillPlaylistFields("%(playlist_index)03d - %(title)s", { playlistIndex: 7 } as never) === "007 - %(title)s.%(ext)s", "playlist fields are filled in");
  ok(!passes({ id: "x", title: "Short", duration: 30, url: "https://youtube.com/shorts/x" }, { rules: RULE_DEFAULTS, filter: "", skipMembers: true } as never), "subscription rules skip Shorts");
  ok(passes({ id: "x", title: "Episode 12", duration: 900 }, { rules: { ...RULE_DEFAULTS, include: "episode" }, filter: "", skipMembers: true } as never), "subscription rules keep matching uploads");
  ok(classify("https://music.youtube.com/playlist?list=OLAK5uy_x").kind === "album" && recommend(["https://youtu.be/abc"]).presetId === "youtube", "auto-detect picks a preset");
  ok(playCount("1.2B plays") === 1.2e9, "YouTube Music play counts");
  const yt = ytmItems({ contents: [{ musicResponsiveListItemRenderer: {
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Get Lucky" }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [
        { text: "Song" }, { text: " • " },
        { text: "Daft Punk", navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } },
        { text: " • " },
        { text: "Random Access Memories", navigationEndpoint: { browseEndpoint: { browseId: "MPREb_x", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } } } } },
        { text: " • " }, { text: "6:09" }, { text: " • " }, { text: "1.2B plays" },
      ] } } },
    ],
    playlistItemData: { videoId: "5NV6Rdv1a3I" },
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://lh3.googleusercontent.com/x=w60-h60-l90-rj", width: 60 }, { url: "https://lh3.googleusercontent.com/x=w120-h120-l90-rj", width: 120 }] } } },
  } }] });
  ok(yt[0]?.artist === "Daft Punk" && yt[0]?.album === "Random Access Memories" && yt[0]?.duration === 369 && yt[0]?.videoId === "5NV6Rdv1a3I" && yt[0]?.thumb?.endsWith("=w1200-h1200-l90-rj"), "YouTube Music search rows are read");
  const [pp, xx] = effective(store.presets, store.settings, { presetId: "youtube", quality: "720", clipStart: "0:05", autoStart: "false" as never });
  ok(pp.quality === "720" && pp.container === "mp4" && xx.clipStart === "0:05" && xx.autoStart === false, "per-download changes on top of a preset");

  console.log("video download (YouTube preset, MP4)");
  jobs.add(`${base}/clip.mp4`, { presetId: "youtube" });
  await waitIdle();
  let j = jobs.snapshot()[0];
  ok(j.status === "done", `finished: ${j.stage} ${j.error ?? ""}`);
  ok(j.finalPath && fs.existsSync(j.finalPath) && j.finalPath.includes(path.join("Library", "YouTube")), `saved in the library: ${j.finalPath?.replace(work, "")}`);
  ok(j.qualityLabel === "360p" && j.formatShort?.startsWith("MP4"), `labels: ${j.qualityLabel} · ${j.formatShort}`);

  console.log("same link again → skipped (remembered)");
  jobs.add(`${base}/clip.mp4`, { presetId: "youtube" });
  await waitIdle();
  j = jobs.snapshot()[0];
  ok(j.status === "skipped", `skipped: ${j.stage}`);

  console.log("clip + keep-original-title preset");
  await store.savePreset({ ...BUILT_IN[0], id: "orig", name: "Original", metaMode: "none", container: "mkv", useArchive: false } as never);
  await store.saveSettings({ useArchive: false });
  jobs.add(`${base}/clip.mp4`, { presetId: "orig", clipStart: "0:01", clipEnd: "0:03", prefix: "[Clip] " });
  await waitIdle();
  j = jobs.snapshot()[0];
  const d = j.finalPath ? Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", j.finalPath]).toString()) : 0;
  ok(j.status === "done" && j.finalPath?.includes(path.join("Library", "Other")) && path.basename(j.finalPath).startsWith("[Clip] ") && d > 1 && d < 3.5, `clip of ${d.toFixed(1)}s saved as ${j.finalPath ? path.basename(j.finalPath) : "?"}`);

  console.log("music download (MusicBrainz match, cover, lyrics, ReplayGain)");
  jobs.add(`${base}/Daft%20Punk%20-%20Get%20Lucky%20(Official%20Video).mp4`, { presetId: "music" });
  await waitIdle();
  j = jobs.snapshot()[0];
  ok(j.status === "done", `finished: ${j.stage} ${j.error ?? ""}`);
  const want = path.join(library, "Music", "Daft Punk", "Random Access Memories (2013)", "Get Lucky.mp3");
  ok(j.finalPath === want, `artist/album folders: ${j.finalPath?.replace(work, "")}`);
  if (j.finalPath && fs.existsSync(j.finalPath)) {
    const pr = probe(j.finalPath);
    const tags = Object.fromEntries(Object.entries(pr.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    ok(tags.album === "Random Access Memories" && tags.album_artist === "Daft Punk" && String(tags.track).startsWith("8"), `tags: ${tags.artist} / ${tags.album} / track ${tags.track} / ${tags.date}`);
    ok(tags.replaygain_track_gain && String(tags.replaygain_track_gain).endsWith("dB"), `ReplayGain: ${tags.replaygain_track_gain}`);
    ok(tags["musicbrainz track id"] === "rec-1" || tags.musicbrainz_trackid === "rec-1" || JSON.stringify(tags).includes("rec-1"), "MusicBrainz ids written");
    const pic = (pr.streams as { codec_type: string; width: number; height: number }[]).find((s) => s.codec_type === "video");
    ok(pic && pic.width === pic.height, `square cover embedded (${pic?.width}×${pic?.height})`);
  }
  ok(calls.some((c) => c.includes("lrclib.net")), "synced lyrics looked up");

  console.log("cancel");
  jobs.add(`${base}/slow/clip2.mp4`, { presetId: "orig" });
  await new Promise((r) => setTimeout(r, 1200));
  const running = jobs.snapshot()[0];
  jobs.cancel([running.id]);
  await waitIdle();
  ok(jobs.snapshot()[0].status === "canceled", `canceled while "${running.stage}"`);

  console.log("Fix music (in a copy)");
  const raw = path.join(work, "Old");
  fs.mkdirSync(raw, { recursive: true });
  execFileSync(ffmpeg, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-c:a", "libmp3lame", path.join(raw, "Track 08.mp3")]);
  const granted = nodeHost({ dataDir: path.join(work, "data"), library, ytdlp, ffmpeg, ffprobe, http: (u) => fakeHttp(u) });
  setHost(granted);
  const found = await fixer.scan([raw], () => undefined);
  ok(found.length === 1 && found[0].candidate?.meta.recording === "rec-1", `matched on MusicBrainz: ${found[0]?.newName}`);
  const res = await fixer.apply(found, "ready", "replaygain", "{track} - {title}", "album", () => undefined);
  const fixedPath = path.join(library, "Music", "Daft Punk", "Random Access Memories (2013)", "08 - Get Lucky.mp3");
  ok(res.fixed === 1 && fs.existsSync(fixedPath), `fixed copy: ${fixedPath.replace(work, "")} ${res.errors.join(" ")}`);
  ok(fs.existsSync(path.join(raw, "Track 08.mp3")), "original untouched");

  await jobs.saveNow();
  ok(JSON.parse((await granted.read("history.json")) ?? "[]").length >= 4, "history saved");
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
