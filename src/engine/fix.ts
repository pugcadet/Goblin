// Fix music (FixMusic.swift), Find missing tracks (Missing.swift) and Preview before downloading (Extras.swift).
import { basename, dirname, extname, host, join, stem, uid } from "./host";
import { jobs, musicFolder, trackNumber } from "./jobs";
import { Candidate, effective, Options, TrackMeta, year } from "./model";
import { parseSong, tagStyle } from "./parse";
import { search, Album } from "./search";
import { MusicBrainz, syncedLyrics } from "./services";
import { store } from "./store";
import { encode, measure, prepareCover, replayGainTags } from "./tagger";
import { bytes, eta, fill, isWebUrl, normalized, similarity } from "./text";
import * as YTM from "./ytmusic";
import { bestThumbnail, isOfficialAudio, J, probe } from "./ytdlp";

export interface FileProbe {
  tags: Record<string, string>;
  duration?: number;
  hasCover: boolean;
}

export async function probeFile(path: string): Promise<FileProbe> {
  const r = await host().run({ id: uid("fp"), tool: "ffprobe", args: ["-v", "error", "-show_entries", "format=duration:format_tags:stream=codec_type,disposition", "-of", "json", path], timeoutSec: 60 }).catch(() => null);
  try {
    const o = JSON.parse(r?.stdout ?? "");
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.format?.tags ?? {})) if (typeof v === "string") tags[k.toLowerCase()] = v;
    const d = Number(o.format?.duration);
    return { tags, duration: isFinite(d) ? d : undefined, hasCover: ((o.streams as J[]) ?? []).some((s) => s.codec_type === "video") };
  } catch {
    return { tags: {}, hasCover: false };
  }
}

export interface FixItem {
  path: string;
  file: string;
  old: string;
  oldArt: string;
  score: number;
  ttl: string;
  dur: number;
  trackNo: number;
  newName: string;
  new: string;
  newArt: string;
  changes: string[];
  candidate?: Candidate & { tags?: Record<string, string> };
}

type Progress = (done: number, total: number) => void;

class Fixer {
  cancelled = false;
  private cache = new Map<string, Candidate[]>();

  async scan(paths: string[], progress: Progress): Promise<FixItem[]> {
    const files = await host().audioFiles(paths, 1000);
    const items: FixItem[] = [];
    this.cancelled = false;
    const thumbs = await host().workDir("fix-thumbs");
    for (let i = 0; i < files.length; i++) {
      if (this.cancelled) break;
      progress(i, files.length);
      const f = files[i];
      const pr = await probeFile(f);
      let oldArt = "";
      if (pr.hasCover) {
        const t = join(thumbs, `${uid("t")}.jpg`);
        const r = await host().run({ id: uid("ft"), tool: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-y", "-i", f, "-an", "-frames:v", "1", "-vf", "scale=120:-2", t], timeoutSec: 120 });
        if (r.code === 0) oldArt = t;
      }
      const parsed = pr.tags.title ? { artist: pr.tags.artist, title: pr.tags.title } : parseSong(stem(f).replace(/^\d{1,3}[\s._-]+/, ""));
      const cands = await MusicBrainz.search(parsed.artist, parsed.title, pr.duration, pr.tags.album).catch(() => [] as Candidate[]);
      this.cache.set(f, cands);
      const old = [[pr.tags.artist, pr.tags.title].filter(Boolean).join(" – "), pr.tags.album, pr.hasCover ? "" : "no cover"].filter(Boolean).join(" · ");
      const item: FixItem = {
        path: f, file: basename(f), old: old || "no tags", oldArt, score: cands[0]?.score ?? 0, ttl: parsed.title, dur: pr.duration ?? 0,
        trackNo: Number((pr.tags.track ?? "").split("/")[0]) || 0, newName: "No match", new: "Try “Other match…”", newArt: "", changes: [],
      };
      if (cands[0]) Object.assign(item, describe(cands[0], pr));
      items.push(item);
    }
    progress(files.length, files.length);
    return items;
  }

  async candidates(path: string): Promise<Candidate[]> {
    const c = this.cache.get(path);
    if (c?.length) return c;
    const pr = await probeFile(path);
    const p = parseSong(pr.tags.title ? `${pr.tags.artist ?? ""} - ${pr.tags.title}` : stem(path));
    return MusicBrainz.search(p.artist, p.title, pr.duration, pr.tags.album).catch(() => []);
  }

  /** mode "ready": fixed copies into the library's Music folder; "inplace": replaces the originals (old ones to the Trash).
   *  name: file-name pattern (empty = keep names). folders: "album" = Artist/Album (Year), "keep" = no sub-folders. */
  async apply(items: FixItem[], mode: "ready" | "inplace", loudness: string, name: string, folders: "album" | "keep", progress: Progress): Promise<{ fixed: number; failed: number; errors: string[] }> {
    const s = store.settings;
    const style = store.preset("music");
    let fixed = 0;
    let failed = 0;
    const errors: string[] = [];
    const work = await host().workDir(uid("fix"));
    this.cancelled = false;
    try {
      for (let i = 0; i < items.length; i++) {
        if (this.cancelled) break;
        progress(i, items.length);
        const it = items[i];
        const c = it.candidate;
        if (!c) {
          failed++;
          continue;
        }
        try {
          let meta: TrackMeta;
          if (c.tags) {
            // "Set album": tags straight from the album you picked, no lookup.
            const g = (k: string) => c.tags![k] || undefined;
            meta = {
              title: g("title") ?? stem(it.path), artist: g("artist") ?? "Unknown Artist", album: g("album"), albumArtist: g("albumArtist"), date: g("date"),
              track: Number(g("track")) || undefined, trackTotal: Number(g("trackTotal")) || undefined, ids: {}, coverURLs: g("cover") ? [g("cover")!] : [],
            };
          } else {
            if (!c.meta.recording) throw new Error("No recording");
            meta = await MusicBrainz.trackMeta(c.meta.recording, c.meta.release || undefined);
          }
          meta = tagStyle(meta, style);
          if (!meta.album) meta.album = meta.title;
          let cover: string | null = null;
          for (const u of meta.coverURLs) {
            if (u.startsWith("http")) {
              const raw = join(work, `c${i}.img`);
              if (!(await host().download(u, raw))) continue;
              cover = await prepareCover(raw, u.includes("ytimg.com"), join(work, `c${i}.jpg`));
            } else cover = await prepareCover(u, true, join(work, `c${i}.jpg`)); // your own picture
            if (cover) break;
          }
          const lyricsTask = s.lyrics ? syncedLyrics(meta.artist, meta.title, meta.album, meta.lengthSec) : Promise.resolve(null);
          let extra: Record<string, string> = {};
          if (loudness === "replaygain") {
            const m = await measure(it.path);
            if (m) extra = replayGainTags(m);
          }
          const ext = extname(it.path);
          const format = ({ m4a: "m4a", aac: "m4a", alac: "m4a", flac: "flac", opus: "opus", ogg: "opus", wav: "wav" } as Record<string, string>)[ext] ?? "mp3";
          const lyrics = await lyricsTask;
          if (lyrics && format !== "mp3") extra.lyrics = lyrics;
          const tmp = join(work, `out${i}.${ext}`);
          await encode({ input: it.path, output: tmp, format, quality: "copy", normalize: loudness === "normalize", meta, extraTags: extra, cover, id3: style.tagId3 });
          if (lyrics && format === "mp3") await host().addLyrics(tmp, lyrics);
          const fileName = name.trim()
            ? fill(name, { track: trackNumber(meta), title: meta.title, artist: meta.artist, album: meta.album ?? "", year: year(meta) ?? "", albumartist: meta.albumArtist || meta.artist, disc: meta.disc ? String(meta.disc) : "" }, "{title}")
            : stem(it.path);
          const root = mode === "inplace" ? dirname(it.path) : store.dir(s.dirMusic);
          const base = folders === "album" ? musicFolder(root, meta) : root;
          if (mode === "inplace") await host().trash(it.path);
          await host().move(tmp, join(base, `${fileName}.${ext}`));
          fixed++;
        } catch (e) {
          failed++;
          errors.push(`${it.file}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      progress(items.length, items.length);
      await host().workClear(basename(work)).catch(() => undefined);
    }
    return { fixed, failed, errors };
  }
}

function describe(c: Candidate, pr: FileProbe): Partial<FixItem> {
  const changes: string[] = [];
  const parts = c.title.split(" – ");
  if ((pr.tags.title ?? "") !== (parts[parts.length - 1] ?? "") || (pr.tags.artist ?? "") !== (parts[0] ?? "")) changes.push("Tags");
  if (!pr.tags.album || !pr.tags.date) changes.push("Album + year");
  if (!pr.hasCover) changes.push("Cover");
  if (!pr.tags.replaygain_track_gain) changes.push("ReplayGain");
  changes.push("Renamed");
  return { newName: c.title, new: c.subtitle, newArt: c.image ?? "", changes, score: c.score, candidate: c };
}

export const fixer = new Fixer();

// ------------------------------------------------------------------ find missing tracks

export interface MissingAlbum {
  album: string;
  artist: string;
  year: string;
  folder: string;
  have: number;
  total: number;
  missing: { n: number; title: string; len: string }[];
  status: "missing" | "notfound" | "complete";
  cover: string;
  release?: string;
  note?: string;
}

const cleanT = (s: string) => s.replace(/\s*[([][^)\]]*(feat|ft\.|with |remaster|explicit|clean|version|edit)[^)\]]*[)\]]/gi, "").replace(/\s+(feat\.?|ft\.)\s+.*$/i, "").trim();

class Missing {
  cancelled = false;

  /** Reads the albums in a music folder and lists the tracks you don't have yet (nothing downloads until you pick). */
  async scan(root: string, progress: (stage: string, done: number, total: number) => void): Promise<MissingAlbum[]> {
    this.cancelled = false;
    progress("Listing files…", 0, 0);
    const files = await host().audioFiles([root], 20000);
    const probes: [string, FileProbe][] = [];
    for (let at = 0; at < files.length && !this.cancelled; at += 6) {
      const batch = files.slice(at, at + 6);
      probes.push(...(await Promise.all(batch.map(async (f): Promise<[string, FileProbe]> => [f, await probeFile(f)]))));
      progress("Reading tags", Math.min(at + 6, files.length), files.length);
    }
    type Local = { album: string; artist: string; year: string; folder: string; numbers: Set<number>; titles: string[]; total: number; count: number };
    const albums = new Map<string, Local>();
    for (const [f, p] of probes) {
      const t = p.tags;
      const album = (t.album ?? "").trim();
      if (!album) continue;
      const artist = (t.album_artist ?? t.albumartist ?? t.artist ?? "").trim();
      const key = artist.toLowerCase() + "|" + album.toLowerCase();
      const l = albums.get(key) ?? { album, artist, year: "", folder: dirname(f), numbers: new Set<number>(), titles: [], total: 0, count: 0 };
      if (!l.year) l.year = (t.date ?? t.year ?? "").slice(0, 4);
      const tr = (t.track ?? "").split("/").map((x) => Number(x.trim()) || 0);
      if (tr[0] > 0) l.numbers.add(tr[0]);
      if (tr.length > 1) l.total = Math.max(l.total, tr[1]);
      l.titles.push(t.title ?? stem(f).replace(/^\d{1,3}[\s._-]+/, ""));
      l.count++;
      albums.set(key, l);
    }
    const list = [...albums.values()].sort((a, b) => (a.artist + a.album).localeCompare(b.artist + b.album));
    const out: MissingAlbum[] = [];
    for (let i = 0; i < list.length && !this.cancelled; i++) {
      const l = list[i];
      progress(`Checking ${l.artist} – ${l.album}`, i, list.length);
      out.push(await this.compare(l));
    }
    progress("Done", list.length, list.length);
    const rank = { missing: 0, notfound: 1, complete: 2 };
    return out.sort((a, b) => rank[a.status] - rank[b.status]);
  }

  private async compare(l: { album: string; artist: string; year: string; folder: string; numbers: Set<number>; titles: string[]; total: number; count: number }): Promise<MissingAlbum> {
    const base: MissingAlbum = { album: l.album, artist: l.artist, year: l.year, folder: l.folder, have: l.count, total: l.total, missing: [], status: "notfound", cover: "" };
    const a = await this.findAlbum(l);
    if (!a) {
      // Not on YouTube Music: the track-number tags can still tell about gaps.
      if (l.total > l.count) {
        const gaps = Array.from({ length: l.total }, (_, k) => k + 1).filter((n) => !l.numbers.has(n));
        base.missing = gaps.map((n) => ({ n, title: `Track ${n}`, len: "" }));
        base.note = `Not found on YouTube Music. The track numbers in your files say ${gaps.length} missing.`;
      } else base.note = "Not found on YouTube Music.";
      return base;
    }
    const local = l.titles.map(cleanT);
    const missing = a.tracks.filter((t) => {
      const title = cleanT(t.title);
      const byNumber = l.numbers.has(t.n) && local.some((x) => similarity(x, title) >= 0.5);
      const byTitle = local.some((x) => similarity(x, title) >= 0.8 || normalized(x) === normalized(title));
      return !(byNumber || byTitle);
    });
    return { ...base, release: a.id, total: a.tracks.length, cover: a.cover, missing: missing.map((t) => ({ n: t.n, title: t.title, len: t.len })), status: missing.length ? "missing" : "complete" };
  }

  /** Best YouTube Music album: same title and artist; with several editions, the one whose track count matches your files. */
  private async findAlbum(l: { album: string; artist: string; total: number; count: number }): Promise<Album | null> {
    const items = await YTM.searchAlbums(`${l.artist} ${l.album}`).catch(() => [] as YTM.YTMItem[]);
    const want = cleanT(l.album);
    const scored = items
      .filter((it) => it.browseId)
      .map((it): [YTM.YTMItem, number, number, number] => {
        const ts = similarity(cleanT(it.title), want);
        const as = l.artist ? similarity(it.artist, l.artist) : 0.7;
        return [it, ts * 0.7 + as * 0.3, ts, as];
      })
      .filter(([, , ts, as]) => ts >= 0.6 && as >= 0.4)
      .sort((a, b) => b[1] - a[1]);
    let first: Album | null = null;
    for (const [it] of scored.slice(0, 3)) {
      const r = await search.ytmAlbum(`ytm:${it.browseId}`, it.artist, it.title, it.thumb).catch(() => null);
      if (!r) continue;
      first ??= r;
      if (l.total > 0 ? r.tracks.length === l.total : r.tracks.length >= l.count) return r;
    }
    return first;
  }

  /** Queues only the missing tracks, tagged with YOUR album name/artist/year so they land next to the rest. */
  download(items: { release: string; ns: number[]; album: string; artist: string; year: string }[], presetId: string): number {
    let queued = 0;
    for (const it of items) {
      const a = search.albums.get(it.release);
      if (!a) continue;
      const want = new Set(it.ns);
      const copy: Album = { ...a, trackTotal: a.tracks.length, tracks: a.tracks.filter((t) => want.has(t.n)), title: it.album || a.title, artist: it.artist || a.artist, year: it.year || a.year };
      queued += search.download(copy, presetId, {}, "").length;
    }
    return queued;
  }
}

export const missing = new Missing();

// ------------------------------------------------------------------ preview before downloading

export interface PreviewRow {
  input: string;
  title: string;
  kind: "audio" | "video" | "playlist" | "search" | "error";
  label?: string;
  error?: string;
  thumbnail?: string;
  duration?: string;
  channel?: string;
  live?: boolean;
  chapters?: number;
  qualities?: string[];
  chosen?: string;
  size?: string;
  subs?: string;
  official?: boolean;
  source?: string;
}

export async function preview(text: string, options: Options): Promise<PreviewRow[]> {
  const [preset] = effective(store.presets, store.settings, options);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 20);
  const out: PreviewRow[] = new Array(lines.length);
  let next = 0;
  const one = async (line: string): Promise<PreviewRow> => {
    if (!isWebUrl(line)) return { input: line, title: line, kind: "search", label: preset.kind === "music" ? "Search YouTube Music" : "Search YouTube" };
    let info: J;
    try {
      info = await probe(line, { playlist: true, limit: 200 });
    } catch {
      return { input: line, title: line, kind: "error", error: "Couldn't read this link" };
    }
    if (info._type === "playlist") return { input: line, title: info.title ?? line, kind: "playlist", label: `Playlist · ${(info.entries ?? []).length} items`, thumbnail: info.thumbnails?.slice(-1)[0]?.url };
    const r: PreviewRow = { input: line, title: info.title ?? line, kind: "video", thumbnail: bestThumbnail(info), duration: eta(info.duration), channel: info.channel ?? info.uploader ?? "", live: !!info.is_live, chapters: (info.chapters ?? []).length };
    const formats: J[] = info.formats ?? [];
    r.qualities = [...new Set(formats.map((f) => f.height).filter((h) => h >= 360))].sort((a, b) => b - a).slice(0, 6).map((h) => `${h}p`);
    const size = (f: J) => f.filesize ?? f.filesize_approx ?? 0;
    const audio = formats.filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none").sort((a, b) => size(b) - size(a))[0];
    if (preset.kind === "music") {
      r.kind = "audio";
      r.official = isOfficialAudio(info);
      r.size = bytes(audio ? size(audio) : 0);
      r.source = audio ? `${String(audio.acodec).split(".")[0]} ${Math.round(audio.abr ?? 0)}k` : "";
    } else {
      const limit = Number(preset.quality) || 99999;
      const video = formats.filter((f) => f.vcodec && f.vcodec !== "none" && (f.height ?? 0) <= limit).sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || size(b) - size(a))[0];
      r.chosen = video?.height ? `${video.height}p` : "";
      r.size = bytes((video ? size(video) : 0) + (audio ? size(audio) : 0));
      const subs = Object.keys(info.subtitles ?? {}).filter((k) => k.startsWith("en")).sort();
      const auto = Object.keys(info.automatic_captions ?? {}).some((k) => k === "en" || k === "en-orig");
      r.subs = subs.length ? subs.slice(0, 3).join(", ") + (auto ? ", en (auto)" : "") : auto ? "en (auto)" : "none";
    }
    return r;
  };
  await Promise.all(Array.from({ length: Math.min(4, lines.length) }, async () => {
    while (next < lines.length) {
      const i = next++;
      out[i] = await one(lines[i]);
    }
  }));
  return out;
}

// ------------------------------------------------------------------ auto-detect

export type LinkKind = "search" | "album" | "song" | "channel" | "playlist" | "video" | "podcast" | "web";

export function classify(line: string): { kind: LinkKind; label: string } {
  const l = line.trim();
  if (!/^https?:\/\//i.test(l)) return { kind: "search", label: "search" };
  if (/music\.youtube\.com\/(playlist|browse)/i.test(l) || /list=OLAK5uy_/i.test(l)) return { kind: "album", label: "YouTube Music album" };
  if (/music\.youtube\.com/i.test(l)) return { kind: "song", label: "YouTube Music track" };
  if (/youtube\.com\/(@|c\/|channel\/|user\/)/i.test(l)) return { kind: "channel", label: "YouTube channel" };
  if (/[?&]list=/i.test(l) && !/[?&]v=/i.test(l)) return { kind: "playlist", label: "playlist" };
  if (/youtube\.com\/shorts\//i.test(l)) return { kind: "video", label: "YouTube Short" };
  if (/(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|dailymotion)/i.test(l)) return { kind: "video", label: "video" };
  if (/(soundcloud\.com|bandcamp\.com)/i.test(l)) return { kind: "song", label: "track" };
  if (/\.(rss|xml)(\?|$)|\/feed\/?$|\/rss\/?$|podcasts\.apple\.com/i.test(l)) return { kind: "podcast", label: "podcast feed" };
  return { kind: "web", label: "link" };
}

/** Which preset fits what you pasted (or null), and why. */
export function recommend(lines: string[]): { presetId: string | null; why: string; subHint: boolean; summary: string } {
  const cls = lines.map(classify);
  const count = new Map<string, number>();
  for (const c of cls) count.set(c.label, (count.get(c.label) ?? 0) + 1);
  const summary = [...count].map(([k, n]) => `${n} ${k}${n > 1 && !k.endsWith("s") && k !== "search" ? "s" : ""}`).join(", ");
  const kinds = cls.map((c) => c.kind);
  const has = (k: LinkKind) => kinds.includes(k);
  const P = store.presets;
  let rec: string | null = null;
  let why = "";
  if (has("album") || has("song") || (has("search") && lines.some((x) => / - /.test(x)))) {
    rec = P.find((p) => p.kind === "music" && !p.podcast)?.id ?? null;
    why = "music";
  } else if (has("podcast")) {
    rec = P.find((p) => p.podcast)?.id ?? null;
    why = "a podcast";
  } else if (has("video") || has("playlist") || has("channel") || has("web")) {
    rec = P.find((p) => p.kind === "video" && p.metaMode === "youtube")?.id ?? null;
    why = "video";
  }
  return { presetId: rec, why, subHint: has("channel") || has("playlist") || has("podcast"), summary };
}

export { jobs };
