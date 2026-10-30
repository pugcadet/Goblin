// Running yt-dlp for information (probe, flat listings, searches) and the small helpers around it (Media.swift → YT).
import { host, uid } from "./host";
import { cleanArtist, parseSong } from "./parse";
import { store } from "./store";
import { similarity, splitArgs } from "./text";

export type J = Record<string, any>; // yt-dlp / web JSON

export class GoblinError extends Error {}
export class Cancelled extends Error {
  constructor() {
    super("Canceled");
  }
}

/** Options from Settings that go with every yt-dlp run. */
export function globalArgs(): string[] {
  const s = store.settings;
  const a: string[] = [];
  if (s.limitRate.trim()) a.push("--limit-rate", s.limitRate.trim());
  a.push(...splitArgs(s.ytdlpGlobal.replace(/\n/g, " ")));
  return a;
}

/** Signed-in runs are slow and steady. */
export const POLITE = ["--sleep-requests", "1.5", "--sleep-interval", "5", "--max-sleep-interval", "12"];

/** "[youtube] abc: Downloading android player API JSON" → "Downloading android player API JSON" */
export function friendlyStep(line: string): string | null {
  const m = line.match(/^\[[^\]]+\]\s*(.*)$/);
  if (!m) return null;
  let rest = m[1].trim();
  const c = rest.indexOf(": ");
  if (c > 0 && c <= 40 && !rest.slice(0, c).includes(" ")) rest = rest.slice(c + 2);
  if (!rest) return null;
  return rest.length > 60 ? rest.slice(0, 57) + "…" : rest;
}

/** The last ERROR line in plain words. */
export function errorLine(stderr: string): string | null {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith("ERROR:")) ?? lines[lines.length - 1];
  if (!err) return null;
  let t = err.replace(/^ERROR:\s*/, "");
  const m = t.match(/^\[[^\]]+\]\s+(\S+):\s+(.+)$/);
  if (m) t = m[2];
  return t.slice(0, 300);
}

/** YouTube's "needs an account" errors. Deliberately NOT "confirm you're not a bot": cookies for that get accounts flagged. */
export function needsSignIn(msg: string): boolean {
  const m = msg.toLowerCase();
  if (m.includes("not a bot")) return false;
  return ["confirm your age", "inappropriate for some users", "age-restricted", "age restricted", "members-only", "members only", "join this channel", "granted access"].some((x) => m.includes(x));
}

export interface ProbeOpts {
  playlist: boolean;
  limit?: number;
  cookies?: boolean;
  procId?: string;
  onLine?: (line: string) => void;
}

/** `yt-dlp -J --flat-playlist`: everything about a link in one run. */
export async function probe(input: string, o: ProbeOpts): Promise<J> {
  const args = ["-J", "--flat-playlist", o.playlist ? "--yes-playlist" : "--no-playlist"];
  if (o.cookies) args.push(...POLITE);
  if (o.limit && o.limit > 0) args.push("--playlist-end", String(o.limit));
  args.push(...globalArgs(), "--", input);
  const id = o.procId ?? uid("p");
  // stderr is yt-dlp's chatter ("Downloading webpage"); stdout is one big JSON blob.
  const r = await host().run({ id, tool: "yt-dlp", args, timeoutSec: 150, cookies: o.cookies }, o.onLine ? (l, err) => err && o.onLine!(l) : undefined);
  if (r.killed) throw new Cancelled();
  if (r.timedOut) throw new GoblinError("Reading this link took too long (2½ minutes). " + (errorLine(r.stderr) ?? ""));
  try {
    if (r.code === 0) return JSON.parse(r.stdout);
  } catch {
    /* fall through */
  }
  throw new GoblinError(errorLine(r.stderr) ?? "Could not read that link");
}

/** Flat listing of a channel, playlist or search. `approxDates` asks YouTube tabs for (approximate) upload dates. */
export async function flat(url: string, limit: number, approxDates = false, procId?: string): Promise<J> {
  const args = ["-J", "--flat-playlist", "--yes-playlist"];
  if (limit > 0) args.push("--playlist-end", String(limit));
  if (approxDates) args.push("--extractor-args", "youtubetab:approximate_date");
  args.push("--", url);
  const r = await host().run({ id: procId ?? uid("f"), tool: "yt-dlp", args, timeoutSec: 300 });
  if (r.killed) throw new Cancelled();
  try {
    if (r.code === 0) return JSON.parse(r.stdout);
  } catch {
    /* fall through */
  }
  throw new GoblinError(errorLine(r.stderr) ?? `Could not read ${url}`);
}

/** The 11-character video id of a youtube.com / youtu.be / music.youtube.com link. */
export function videoID(s: string): string | null {
  try {
    const u = new URL(s.trim());
    const host = u.hostname.toLowerCase();
    let id: string | null = null;
    if (host.endsWith("youtu.be")) id = u.pathname.split("/").filter(Boolean)[0] ?? null;
    else if (host.endsWith("youtube.com")) {
      id = u.searchParams.get("v");
      if (!id) {
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length >= 2 && ["shorts", "live", "embed"].includes(parts[0])) id = parts[1];
      }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** "watch?v=…&list=RD…" is one song opened from an endless mix/radio: keep just the video. */
export function cleanLink(s: string): string {
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if (!(h.includes("youtube.com") || h.includes("youtu.be")) || !u.searchParams.get("v")) return s;
    const list = u.searchParams.get("list");
    if (!list || !(list.startsWith("RD") || list === "LM" || list.startsWith("LL") || list.startsWith("WL"))) return s;
    for (const k of ["list", "index", "start_radio", "pp", "si"]) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return s;
  }
}

/** One YouTube video (watch / youtu.be / shorts / live) that is not meant to expand into a playlist. */
export function isSingleYouTubeVideo(u: string, playlists: boolean): boolean {
  const l = u.toLowerCase();
  if (!l.startsWith("http") || !(l.includes("youtube.com/watch") || l.includes("youtu.be/") || l.includes("youtube.com/shorts/") || l.includes("youtube.com/live/"))) return false;
  return !(playlists && l.includes("list="));
}

export function bestThumbnail(info: J): string | undefined {
  const thumbs = ((info.thumbnails as J[]) ?? []).filter((t) => String(t.url ?? "").startsWith("https") && !String(t.id ?? "").includes("avatar") && !String(t.id ?? "").includes("banner"));
  let best: J | undefined;
  for (const t of thumbs) {
    const k = [t.preference ?? 0, t.width ?? 0];
    if (!best || k[0] > (best.preference ?? 0) || (k[0] === (best.preference ?? 0) && k[1] > (best.width ?? 0))) best = t;
  }
  return best?.url ?? info.thumbnail ?? undefined;
}

export function thumbById(info: J, id: string): string | undefined {
  return ((info.thumbnails as J[]) ?? []).find((t) => t.id === id)?.url;
}

export function entryURL(e: J): string | undefined {
  if (typeof e.url === "string" && e.url.startsWith("http")) return e.url;
  if (typeof e.webpage_url === "string") return e.webpage_url;
  if (typeof e.id === "string" && e.id.length === 11) return `https://www.youtube.com/watch?v=${e.id}`;
  return typeof e.url === "string" ? e.url : undefined;
}

export function isOfficialAudio(info: J): boolean {
  const channel = String(info.channel ?? info.uploader ?? "");
  if (channel.endsWith(" - Topic")) return true;
  const desc = String(info.description ?? "");
  return desc.includes("Provided to YouTube by") || desc.includes("Auto-generated by YouTube");
}

const q = (s: string) => encodeURIComponent(s);

/** Finds the official studio track ("Art Track" / "- Topic" upload) on YouTube Music, matched on title, artist and length. */
export async function findOfficialAudio(artist: string, title: string, targetSec?: number, isrc?: string): Promise<{ url: string; label: string } | null> {
  // An ISRC search on YouTube Music usually lands exactly on the official recording.
  if (isrc) {
    try {
      const o = await flat(`https://music.youtube.com/search?q=${q(isrc)}#songs`, 3);
      const e = ((o.entries as J[]) ?? []).find((e) => targetSec != null && e.duration != null && Math.abs(e.duration - targetSec) <= 3 && similarity(e.title ?? "", title) >= 0.6);
      if (e?.id) return { url: `https://music.youtube.com/watch?v=${e.id}`, label: `${cleanArtist(e.channel ?? e.uploader ?? artist)} – ${e.title ?? title}` };
    } catch {
      /* try the normal searches */
    }
  }
  const sources = [`https://music.youtube.com/search?q=${q(`${artist} ${title}`)}#songs`, `ytsearch8:${artist} - ${title} official audio`];
  const avoid = /\b(live|remix|acoustic|karaoke|instrumental|cover|sped\s*up|slowed|nightcore|8d|reverb|edit|version|piano)\b/i;
  const wants = new Set(["live", "remix", "acoustic", "instrumental", "edit", "version"].filter((w) => title.toLowerCase().includes(w)));
  for (let i = 0; i < sources.length; i++) {
    let o: J;
    try {
      o = await flat(sources[i], 8);
    } catch {
      continue;
    }
    let best: [number, string, string] | null = null;
    for (const e of (o.entries as J[]) ?? []) {
      if (!e.id) continue;
      const et = String(e.title ?? "");
      const ch = String(e.channel ?? e.uploader ?? "");
      const parsed = parseSong(et, ch);
      let s = similarity(parsed.title, title) * 0.45;
      const names = [ch, cleanArtist(ch), parsed.artist ?? "", ...(((e.artists as string[]) ?? []))];
      s += Math.max(...names.map((n) => similarity(n, artist))) * 0.3;
      if (targetSec != null && e.duration != null) {
        const d = Math.abs(targetSec - e.duration);
        s += d < 3 ? 0.25 : d < 8 ? 0.12 : d < 20 ? 0 : -0.3;
      } else s += 0.08;
      if (i === 0) s += 0.05;
      if (ch.endsWith(" - Topic")) s += 0.15;
      if (/official audio/i.test(et)) s += 0.08;
      if (/official (music )?video|\bmv\b/i.test(et)) s -= 0.25;
      const bad = et.toLowerCase().match(avoid);
      if (bad && !wants.has(bad[1])) s -= 1.5; // never a live/remix… upload
      if (!best || s > best[0]) best = [s, `https://music.youtube.com/watch?v=${e.id}`, `${cleanArtist(ch)} – ${et}`];
    }
    if (best && best[0] >= 0.62) return { url: best[1], label: best[2] };
  }
  return null;
}

/** The best-matching YouTube Music album playlists (top 2), each as its entry list. */
export async function albumPlaylists(artist: string, album: string): Promise<J[][]> {
  let res: J;
  try {
    res = await flat(`https://music.youtube.com/search?q=${q(`${artist} ${album}`)}#albums`, 6);
  } catch {
    return [];
  }
  const urls = ((res.entries as J[]) ?? [])
    .map((e): [number, string | undefined] => [similarity(e.title ?? "", album) + similarity(e.channel ?? e.uploader ?? "", artist) * 0.3, entryURL(e)])
    .sort((a, b) => b[0] - a[0])
    .slice(0, 2)
    .filter((x) => x[0] > 0.6 && x[1])
    .map((x) => x[1]!);
  const lists = await Promise.all(urls.map((u) => flat(u, 0).then((o) => (o.entries as J[]) ?? []).catch(() => [] as J[])));
  return lists.filter((l) => l.length);
}
