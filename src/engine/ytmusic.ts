// YouTube Music's own web API (the one music.youtube.com itself calls), read-only, for search and album pages.
// One request per search, titles/artists/years/square covers in YouTube Music's own order. yt-dlp still downloads.
// Parsing walks the JSON for the renderers it needs instead of hard-coding deep paths, so small layout changes don't break it.
import { host } from "./host";
import { GoblinError, J } from "./ytdlp";

export interface YTMItem {
  title: string;
  artist: string;
  album: string;
  year: string;
  duration?: number;
  videoId?: string;
  browseId?: string;
  thumb?: string;
  kind: string; // Album / Single / EP on album rows
  plays?: number;
  albumId?: string; // the song's own album (MPREb_…)
}

export interface YTMAlbum {
  title: string;
  artist: string;
  year: string;
  thumb?: string;
  tracks: YTMItem[];
  kind: string;
}

const SONGS = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
const ALBUMS = "EgWKAQIYAWoMEA4QChADEAQQCRAF";

function clientVersion(): string {
  const d = new Date(Date.now() - 3 * 86400000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `1.${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.01.00`;
}

async function call(endpoint: string, body: J, query = ""): Promise<J> {
  const b = { ...body, context: { client: { clientName: "WEB_REMIX", clientVersion: clientVersion(), hl: "en", gl: "US" } } };
  const r = await host().http({
    method: "POST",
    url: `https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false${query}`,
    headers: {
      "Content-Type": "application/json",
      Origin: "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    },
    body: JSON.stringify(b),
  });
  if (r.status !== 200) throw new GoblinError(`YouTube Music answered HTTP ${r.status}`);
  try {
    return JSON.parse(r.body);
  } catch {
    throw new GoblinError("YouTube Music gave an unexpected answer");
  }
}

/** Depth-first visit of every (key, value) pair. */
function walk(v: unknown, f: (k: string, x: unknown) => void) {
  if (Array.isArray(v)) for (const x of v) walk(x, f);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as J)) {
      f(k, x);
      walk(x, f);
    }
  }
}

const runsText = (v: J | undefined): string[] => ((v?.runs as J[]) ?? []).map((r) => String(r.text ?? ""));
const cleanRuns = (v: J | undefined) => runsText(v).map((s) => s.trim()).filter((s) => s && s !== "•");
const seconds = (t: string) => t.split(":").reduce((a, x) => a * 60 + (Number(x) || 0), 0);

/** "1.2B plays" / "345K views" / "12,345 plays" → number */
export function playCount(s: string): number | undefined {
  const m = s.trim().match(/^([\d.,]+)\s*([KMB]?)\s+(plays|views)$/i);
  if (!m) return undefined;
  return Number(m[1].replace(/,/g, "")) * ({ K: 1e3, M: 1e6, B: 1e9 } as Record<string, number>)[m[2].toUpperCase()] || Number(m[1].replace(/,/g, ""));
}

/** Largest thumbnail anywhere under `v`, upscaled to 1200 px when it's a Google image address. */
export function bestThumb(v: unknown): string | undefined {
  let best: [number, string] | undefined;
  walk(v, (k, x) => {
    if (k !== "thumbnails" || !Array.isArray(x)) return;
    for (const t of x as J[]) {
      if (typeof t.url !== "string") continue;
      const w = Number(t.width ?? 0);
      if (!best || w > best[0]) best = [w, t.url];
    }
  });
  if (!best) return undefined;
  const url = best[1].startsWith("//") ? "https:" + best[1] : best[1];
  return url.replace(/=w\d+-h\d+.*$/, "=w1200-h1200-l90-rj");
}

function firstString(v: unknown, key: string, ok: (s: string) => boolean = () => true): string | undefined {
  let found: string | undefined;
  walk(v, (k, x) => {
    if (found === undefined && k === key && typeof x === "string" && ok(x)) found = x;
  });
  return found;
}

function item(r: J): YTMItem {
  const it: YTMItem = { title: "", artist: "", album: "", year: "", kind: "" };
  const cols: J[][] = ((r.flexColumns as J[]) ?? []).map((c) => (c.musicResponsiveListItemFlexColumnRenderer?.text?.runs as J[]) ?? []);
  const titleRuns = cols[0] ?? ((r.title?.runs as J[]) ?? []);
  it.title = titleRuns.map((x) => x.text ?? "").join("");
  // Second column: "Artist • Album • 3:07" (songs) or "Album • Artist • 2003" (albums), in any order.
  const meta: J[] = [...cols.slice(1).flat(), ...(((r.subtitle?.runs as J[]) ?? []))];
  const artists: string[] = [];
  const firstText: string = meta.map((x) => x.text).find((t) => typeof t === "string") ?? "";
  if (["Album", "Single", "EP"].includes(firstText)) it.kind = firstText;
  for (const run of meta) {
    const t = run.text;
    if (typeof t !== "string") continue;
    const page = String(run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ?? "");
    if (page.includes("ARTIST")) artists.push(t);
    else if (page.includes("ALBUM")) {
      it.album = t;
      it.albumId = run.navigationEndpoint?.browseEndpoint?.browseId;
    } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) it.duration = seconds(t);
    else if (/^\d{4}$/.test(t)) it.year = t;
    else {
      const n = playCount(t);
      if (n != null) it.plays = n;
    }
  }
  if (!artists.length) {
    // Unlinked artist names: the first plain run that isn't a type label, separator, duration or year.
    const labels = new Set(["Song", "Album", "Single", "EP", "Video", "•", " • ", "&", ", "]);
    const a = meta
      .map((x) => x.text)
      .filter((t): t is string => typeof t === "string")
      .find((t) => {
        const x = t.trim();
        return x && !labels.has(x) && !labels.has(t) && !/^(\d{1,2}:\d{2}(:\d{2})?|\d{4}|[\d.,]+[KMB]?( (plays|views))?)$/.test(x);
      });
    if (a) artists.push(a);
  }
  it.artist = artists.join(", ");
  if (it.duration == null) {
    walk(r.fixedColumns ?? [], (k, x) => {
      if ((k === "text" || k === "simpleText") && typeof x === "string" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(x)) it.duration = seconds(x);
    });
  }
  it.videoId = r.playlistItemData?.videoId ?? firstString(r, "videoId");
  it.browseId = r.navigationEndpoint?.browseEndpoint?.browseId ?? firstString(r, "browseId", (s) => s.startsWith("MPRE"));
  it.thumb = bestThumb(r);
  return it;
}

/** Every musicResponsiveListItemRenderer (search rows, album tracks), in document order. */
export function items(root: unknown): YTMItem[] {
  const out: YTMItem[] = [];
  walk(root, (k, v) => {
    if (k === "musicResponsiveListItemRenderer" && v && typeof v === "object") out.push(item(v as J));
  });
  return out;
}

/** Token for the next page, in the older or the newer response format. */
export function continuation(o: unknown): string | undefined {
  let token: string | undefined;
  walk(o, (k, v) => {
    if (token !== undefined || !v || typeof v !== "object") return;
    if (k === "nextContinuationData") token = (v as J).continuation;
    else if (k === "continuationCommand") token = (v as J).token;
  });
  return token;
}

export interface Page {
  items: YTMItem[];
  next?: string;
}

async function page(q: string, params: string, next?: string): Promise<J> {
  if (next) {
    const t = encodeURIComponent(next);
    return call("search", {}, `&ctoken=${t}&continuation=${t}&type=next`);
  }
  return call("search", { query: q, params });
}

export async function songsPage(q: string, next?: string): Promise<Page> {
  const o = await page(q, SONGS, next);
  return { items: items(o).filter((i) => i.videoId), next: continuation(o) };
}

export async function albumsPage(q: string, next?: string): Promise<Page> {
  const o = await page(q, ALBUMS, next);
  return { items: items(o).filter((i) => i.browseId?.startsWith("MPRE")), next: continuation(o) };
}

export const searchSongs = async (q: string) => (await songsPage(q)).items;
export const searchAlbums = async (q: string) => (await albumsPage(q)).items;

/** Several result pages in a row (each page's token unlocks the next), merged. */
export async function chain(kind: "songs" | "albums", q: string, next: string | undefined, pages: number): Promise<Page | null> {
  const items: YTMItem[] = [];
  let token = next;
  let got = false;
  for (let i = 0; i < pages; i++) {
    if (i > 0 && !token) break;
    try {
      const pg = kind === "songs" ? await songsPage(q, token) : await albumsPage(q, token);
      items.push(...pg.items);
      token = pg.next;
      got = true;
    } catch {
      break;
    }
  }
  return got ? { items, next: token } : null;
}

export async function album(browseId: string): Promise<YTMAlbum> {
  const o = await call("browse", { browseId });
  const a: YTMAlbum = { title: "", artist: "", year: "", tracks: [], kind: "" };
  let h: J | undefined;
  walk(o, (k, v) => {
    if (!h && ["musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer", "musicImmersiveHeaderRenderer"].includes(k) && v && typeof v === "object") h = v as J;
  });
  if (h) {
    a.title = cleanRuns(h.title)[0] ?? "";
    const strapFull = runsText(h.straplineTextOne).join("");
    const sub = cleanRuns(h.subtitle);
    const artistRun = ((h.subtitle?.runs as J[]) ?? []).find((r) => JSON.stringify(r.navigationEndpoint ?? "").includes("ARTIST"))?.text;
    a.artist = strapFull || artistRun || "";
    a.kind = sub.find((s) => ["Album", "Single", "EP"].includes(s)) ?? "";
    a.year = [...sub, ...cleanRuns(h.secondSubtitle)].find((s) => /^\d{4}$/.test(s)) ?? "";
    // Only the header's own picture: the header also carries the artist's avatar.
    a.thumb = h.thumbnail ? bestThumb(h.thumbnail) : undefined;
  }
  // Unavailable tracks stay in the list (without videoId) so numbering stays right.
  a.tracks = items(o);
  if (!a.thumb) a.thumb = a.tracks.find((t) => t.thumb)?.thumb;
  if (!a.artist) a.artist = a.tracks.find((t) => t.artist)?.artist ?? "";
  return a;
}
