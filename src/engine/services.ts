// Web services for music metadata (Metadata.swift): MusicBrainz, Cover Art Archive, LRCLIB, Deezer, Apple.
import { host, sleep } from "./host";
import type { Candidate, TrackMeta } from "./model";
import { store } from "./store";
import { eta, normalized, similarity } from "./text";
import { GoblinError, J } from "./ytdlp";

export async function getJSON(url: string, headers: Record<string, string> = {}): Promise<J> {
  const r = await host().http({ url, headers: { Accept: "application/json", ...headers } });
  if (r.status === 404) throw new GoblinError("Not found");
  if (r.status === 503 || r.status === 429) throw new GoblinError("The service is busy. Try again in a moment.");
  if (r.status < 200 || r.status >= 300) throw new GoblinError(`The service answered ${r.status}`);
  try {
    return JSON.parse(r.body);
  } catch {
    throw new GoblinError("Unexpected answer");
  }
}

const qs = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

// ------------------------------------------------------------------ MusicBrainz

const credit = (o: J): string => (((o["artist-credit"] as J[]) ?? []).map((c) => (c.name ?? "") + (c.joinphrase ?? "")).join("") || "").trim();
const capital = (s?: string) => (s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : undefined);
const quoteLucene = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

let mbChain: Promise<unknown> = Promise.resolve();
let mbLast = 0;

/** MusicBrainz allows about one request per second per client: requests wait their turn. */
async function mb(path: string, query: Record<string, string>): Promise<J> {
  const run = async () => {
    const wait = 1050 - (Date.now() - mbLast);
    if (wait > 0) await sleep(wait);
    mbLast = Date.now();
    const contact = store.settings.mbContact.trim();
    const url = `https://musicbrainz.org/ws/2${path.split("/").map(encodeURIComponent).join("/")}?${qs({ ...query, fmt: "json" })}`;
    return getJSON(url, contact ? { "User-Agent": `Goblin/2 ( ${contact} )` } : {});
  };
  const next = mbChain.then(run, run);
  mbChain = next.catch(() => undefined);
  return next;
}

export const MusicBrainz = {
  credit,

  /** Searches recordings and scores every (recording, release) pair. */
  async search(artist: string | undefined, title: string, durationSec?: number, albumHint?: string): Promise<Candidate[]> {
    let query = `recording:${quoteLucene(title)}`;
    if (artist) query += ` AND artist:${quoteLucene(artist)}`;
    let recs: J[] = (await mb("/recording", { query, limit: "15" })).recordings ?? [];
    if (!recs.length && artist) recs = (await mb("/recording", { query: `${title} ${artist}`, limit: "15" })).recordings ?? [];
    const wantsLive = /\blive\b/i.test(title);
    const wantsRemix = /remix|mix\)|edit\)/i.test(title);
    const out: Candidate[] = [];
    for (const r of recs) {
      const rid = r.id as string;
      if (!rid) continue;
      const rTitle = r.title ?? title;
      const rArtist = credit(r);
      const lengthSec = r.length != null ? r.length / 1000 : undefined;
      let base = ((r.score ?? 50) / 100) * 0.3;
      base += similarity(rTitle, title) * 0.25;
      if (artist) base += Math.max(similarity(rArtist, artist), normalized(rArtist).includes(normalized(artist)) ? 0.9 : 0) * 0.2;
      else base += 0.1;
      if (durationSec != null && lengthSec != null) {
        const diff = Math.abs(durationSec - lengthSec);
        base += diff < 3 ? 0.15 : diff < 8 ? 0.08 : diff < 20 ? 0 : -0.2;
      }
      const releases: J[] = r.releases ?? [];
      if (!releases.length) {
        out.push({ id: `mb:${rid}:`, title: `${rArtist} – ${rTitle}`, subtitle: "No release info", image: null, kind: "recording", score: Math.min(1, base), meta: { recording: rid, provider: "mb" } });
        continue;
      }
      for (const rel of releases.slice(0, 12)) {
        const relId = rel.id as string;
        if (!relId) continue;
        const rg: J = rel["release-group"] ?? {};
        const primary: string = rg["primary-type"] ?? "";
        const secondary: string[] = rg["secondary-types"] ?? [];
        let s = base;
        s += rel.status === "Official" ? 0.08 : -0.1;
        s += primary === "Album" ? 0.07 : primary === "EP" ? 0.05 : primary === "Single" ? 0.04 : 0;
        for (const sec of secondary) {
          if (sec === "Live" && wantsLive) continue;
          if (sec === "Remix" && wantsRemix) continue;
          s -= 0.12; // Compilation, Live, Soundtrack, DJ-mix, Remix…
        }
        if (albumHint && rel.title && similarity(rel.title, albumHint) > 0.8) s += 0.1;
        const date: string = rel.date ?? "";
        const y = Number(date.slice(0, 4));
        if (y) s += Math.max(0, 2030 - y) / 3000; // slight preference for the original release
        const trackNo = (rel.media?.[0]?.track?.[0]?.number as string) ?? undefined;
        const typeLabel = [primary, ...secondary].filter(Boolean).join(" + ");
        const parts = [rel.title, date ? date.slice(0, 4) : null, typeLabel || null, trackNo ? `track ${trackNo}` : null, lengthSec ? eta(lengthSec) : null];
        out.push({
          id: `mb:${rid}:${relId}`,
          title: `${rArtist} – ${rTitle}`,
          subtitle: parts.filter(Boolean).join(" · "),
          image: `https://coverartarchive.org/release/${relId}/front-250`,
          kind: "recording",
          score: Math.min(1, Math.max(0, s)),
          meta: { recording: rid, release: relId, releaseGroup: rg.id ?? "", provider: "mb" },
        });
      }
    }
    out.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    return out.filter((c) => !seen.has(c.title + "|" + c.subtitle) && !!seen.add(c.title + "|" + c.subtitle)).slice(0, 12);
  },

  /** Full track data for a chosen recording (+ release). */
  async trackMeta(recording: string, release?: string): Promise<TrackMeta> {
    if (!release) {
      const r = await mb(`/recording/${recording}`, { inc: "artist-credits+isrcs+genres" });
      const genre = ((r.genres as J[]) ?? []).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0]?.name;
      return {
        title: r.title ?? "",
        artist: credit(r),
        lengthSec: r.length != null ? r.length / 1000 : undefined,
        isrc: r.isrcs?.[0],
        genre: capital(genre),
        ids: { "MusicBrainz Track Id": recording, "MusicBrainz Artist Id": r["artist-credit"]?.[0]?.artist?.id ?? "" },
        coverURLs: [],
      };
    }
    const rel = await this.release(release);
    const m = trackMetaFromRelease(rel, recording);
    if (!m) throw new GoblinError("Track not found on that release");
    return m;
  },

  release(id: string): Promise<J> {
    return mb(`/release/${id}`, { inc: "recordings+media+labels+artist-credits+release-groups+genres+isrcs" });
  },

  async releasesLight(group: string): Promise<J[]> {
    return (await mb("/release", { "release-group": group, inc: "media+labels", limit: "100" })).releases ?? [];
  },

  async searchReleaseGroups(q: string): Promise<J[]> {
    const parts = q.split(" - ");
    let query = `releasegroup:${quoteLucene(q)} OR ${q}`;
    if (parts.length === 2) query = `releasegroup:${quoteLucene(parts[1].trim())} AND artist:${quoteLucene(parts[0].trim())}`;
    return (await mb("/release-group", { query, limit: "24" }))["release-groups"] ?? [];
  },

  /** MusicBrainz ids for a track known by ISRC (from Deezer), picking the release that matches the album title. */
  async ids(isrc: string, album?: string): Promise<Record<string, string>> {
    let o: J;
    try {
      o = await mb(`/isrc/${isrc}`, { inc: "releases+release-groups+artist-credits" });
    } catch {
      return {};
    }
    const rec = o.recordings?.[0];
    if (!rec?.id) return {};
    const ids: Record<string, string> = { "MusicBrainz Track Id": rec.id };
    const aid = rec["artist-credit"]?.[0]?.artist?.id;
    if (aid) ids["MusicBrainz Artist Id"] = aid;
    const rels: J[] = rec.releases ?? [];
    let rel = rels[0];
    if (album) for (const r of rels) if (similarity(r.title ?? "", album) > similarity(rel?.title ?? "", album)) rel = r;
    if (rel && similarity(rel.title ?? "", album ?? "") > 0.7) {
      ids["MusicBrainz Album Id"] = rel.id;
      if (rel["release-group"]?.id) ids["MusicBrainz Release Group Id"] = rel["release-group"].id;
    }
    return ids;
  },
};

/** Full track tags from a release object (with recordings), without another request. */
export function trackMetaFromRelease(rel: J, recording: string): TrackMeta | null {
  const release = rel.id ?? "";
  const media: J[] = rel.media ?? [];
  const genres = [...((rel.genres as J[]) ?? []), ...((rel["release-group"]?.genres as J[]) ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const m: TrackMeta = {
    title: "",
    artist: "",
    album: rel.title,
    albumArtist: credit(rel),
    date: rel.date ?? rel["release-group"]?.["first-release-date"],
    discTotal: media.length,
    label: rel["label-info"]?.[0]?.label?.name,
    genre: capital(genres[0]?.name),
    ids: {},
    coverURLs: [],
  };
  outer: for (const md of media) {
    for (const t of (md.tracks as J[]) ?? []) {
      if (t.recording?.id !== recording) continue;
      const rec: J = t.recording ?? {};
      m.title = t.title ?? rec.title ?? "";
      m.artist = credit(t) || credit(rec);
      m.track = t.position ?? (Number(t.number) || undefined);
      m.trackTotal = md["track-count"];
      m.disc = md.position;
      const len = t.length ?? rec.length;
      m.lengthSec = len != null ? len / 1000 : undefined;
      m.isrc = rec.isrcs?.[0];
      const aid = (t["artist-credit"]?.[0] ?? rec["artist-credit"]?.[0])?.artist?.id;
      if (aid) m.ids["MusicBrainz Artist Id"] = aid;
      break outer;
    }
  }
  if (!m.title) return null;
  m.ids["MusicBrainz Track Id"] = recording;
  m.ids["MusicBrainz Album Id"] = release;
  const aa = rel["artist-credit"]?.[0]?.artist?.id;
  if (aa) m.ids["MusicBrainz Album Artist Id"] = aa;
  const rgid = rel["release-group"]?.id;
  if (rgid) m.ids["MusicBrainz Release Group Id"] = rgid;
  const type = rel["release-group"]?.["primary-type"];
  if (type) m.ids["MusicBrainz Album Type"] = String(type).toLowerCase();
  if (rel.status) m.ids["MusicBrainz Album Status"] = String(rel.status).toLowerCase();
  m.coverURLs = [`https://coverartarchive.org/release/${release}/front-1200`, `https://coverartarchive.org/release/${release}/front`];
  if (rgid) m.coverURLs.push(`https://coverartarchive.org/release-group/${rgid}/front-1200`);
  return m;
}

// ------------------------------------------------------------------ LRCLIB, Apple, Deezer

/** Synced lyrics from LRCLIB (free, no key): LRC text or null. */
export async function syncedLyrics(artist: string, title: string, album?: string, duration?: number): Promise<string | null> {
  const p: Record<string, string> = { artist_name: artist, track_name: title };
  if (album) p.album_name = album;
  if (duration && isFinite(duration) && duration > 0 && duration < 1e7) p.duration = String(Math.round(duration));
  try {
    const o = await getJSON(`https://lrclib.net/api/get?${qs(p)}`);
    return typeof o.syncedLyrics === "string" && o.syncedLyrics ? o.syncedLyrics : null;
  } catch {
    return null;
  }
}

export async function podcastSearch(term: string): Promise<J[]> {
  return (await getJSON(`https://itunes.apple.com/search?${qs({ media: "podcast", term, limit: "24" })}`)).results ?? [];
}

async function dz(path: string, q: Record<string, string> = {}): Promise<J> {
  const o = await getJSON(`https://api.deezer.com${path}${Object.keys(q).length ? "?" + qs(q) : ""}`);
  if (o.error) throw new GoblinError(`Deezer: ${o.error.message ?? "error"}`);
  return o;
}

/** "Artist - Album" becomes an exact field search; anything else is Deezer's (typo-tolerant) free search. */
const dzQuery = (q: string, field: string) => {
  const parts = q.split(" - ");
  return parts.length === 2 ? `artist:"${parts[0].trim()}" ${field}:"${parts[1].trim()}"` : q;
};

export const Deezer = {
  albums: async (q: string): Promise<J[]> => (await dz("/search/album", { q: dzQuery(q, "album"), limit: "40" })).data ?? [],
  artists: async (q: string): Promise<J[]> => (await dz("/search/artist", { q, limit: "12" })).data ?? [],
  artistAlbums: async (id: string): Promise<J[]> => (await dz(`/artist/${id}/albums`, { limit: "200" })).data ?? [],
  album: (id: string): Promise<J> => dz(`/album/${id}`),
  albumTracks: async (id: string): Promise<J[]> => (await dz(`/album/${id}/tracks`, { limit: "500" })).data ?? [],
};

const coverFits = (title: string, album: string) => !album || similarity(title, album) >= 0.55 || title.toLowerCase().startsWith(album.toLowerCase());

export async function appleCovers(term: string, album: string): Promise<{ url: string; label: string }[]> {
  try {
    const o = await getJSON(`https://itunes.apple.com/search?${qs({ entity: "album", limit: "12", term })}`);
    return ((o.results as J[]) ?? [])
      .filter((r) => r.artworkUrl100 && coverFits(r.collectionName ?? "", album))
      .map((r) => ({ url: String(r.artworkUrl100).replace("100x100bb", "1400x1400bb"), label: `Apple Music · ${r.collectionName ?? ""}` }));
  } catch {
    return [];
  }
}

export async function deezerCovers(term: string, album: string): Promise<{ url: string; label: string }[]> {
  try {
    return (await Deezer.albums(term))
      .slice(0, 10)
      .filter((a) => a.cover_xl && coverFits(a.title ?? "", album))
      .map((a) => ({ url: a.cover_xl, label: `Deezer · ${a.title ?? ""}` }));
  } catch {
    return [];
  }
}

export async function caaCovers(artist: string, album: string): Promise<{ url: string; label: string }[]> {
  try {
    return (await MusicBrainz.searchReleaseGroups(`${artist} - ${album}`))
      .slice(0, 4)
      .filter((g) => g.id && coverFits(g.title ?? "", album))
      .map((g) => ({ url: `https://coverartarchive.org/release-group/${g.id}/front-1200`, label: `Cover Art Archive · ${g.title ?? ""}` }));
  } catch {
    return [];
  }
}
