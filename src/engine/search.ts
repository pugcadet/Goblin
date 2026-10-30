// Search tab + album finder (Search.swift). Songs and albums come from YouTube Music itself (its own order and covers);
// albums can also come from Deezer (artist discographies) or MusicBrainz (editions), matched to YouTube Music tracks.
import { JobInfo } from "./model";
import { isJunk, VARIANT } from "./parse";
import { appleCovers, caaCovers, Deezer, deezerCovers, MusicBrainz, podcastSearch } from "./services";
import { store } from "./store";
import { eta, folderParts, similarity } from "./text";
import { join } from "./host";
import * as YTM from "./ytmusic";
import { albumPlaylists, entryURL, findOfficialAudio, flat, GoblinError, J } from "./ytdlp";
import { jobs } from "./jobs";

export interface SongRow {
  title: string;
  artist: string;
  album: string;
  year: string;
  albumId: string;
  plays: number;
  junk: boolean;
  dur: string;
  art: string;
  url: string;
  tags: Record<string, string>;
}

export interface VideoRow {
  title: string;
  channel: string;
  views: string;
  dur: string;
  art: string;
  url: string;
  channelUrl: string;
}

export interface AlbumCard {
  id: string; // ytm:MPREb_… | dz:123 | <MusicBrainz release-group id>
  title: string;
  artist: string;
  year: string;
  type: string;
  tracks?: number;
  plays?: number;
  art: string;
  junk?: boolean;
  fans?: number;
}

export interface PodcastRow {
  title: string;
  author: string;
  episodes: number;
  freq: string;
  art: string;
  url: string;
}

export interface Track {
  n: number;
  pos?: number;
  disc?: number;
  title: string;
  len: string;
  lenSec: number;
  artist: string;
  url?: string;
  recording?: string;
  isrc?: string;
  yt: string;
  ytLen: string;
  status: "ok" | "warn" | "missing" | "searching";
}

export interface Album {
  id: string;
  group: string;
  title: string;
  artist: string;
  year: string;
  date?: string;
  type: string;
  label: string;
  genre?: string;
  discTotal?: number;
  cover: string;
  editions: { id: string; label: string }[];
  tracks: Track[];
  trackTotal?: number;
  pending: boolean;
  source: "ytmusic" | "deezer" | "musicbrainz";
  dest: string;
  plays?: number;
}

const q = (s: string) => encodeURIComponent(s);

/** Where an album will be saved (Settings → Library & naming → Music folders). */
export function albumDest(artist: string, title: string, year: string): string {
  return join(store.dir(store.settings.dirMusic), ...folderParts(store.settings.musicFolder, { albumartist: artist, artist, album: title, year }, "{albumartist}/{album} ({year})"));
}

/** YouTube Music cover addresses end in "=w120-h120-…"; ask for 1200 px. */
export function bigArt(u?: string): string | undefined {
  if (!u) return undefined;
  if (/googleusercontent\.com|ggpht\.com/.test(u)) return u.replace(/=w\d+-h\d+.*$/, "=w1200-h1200-l90-rj");
  return u;
}

const ytmArtist = (e: J): string | undefined => e.artists?.[0] ?? e.artist ?? ((e.channel ?? e.uploader) ? String(e.channel ?? e.uploader).replace(/\s*-\s*Topic$/i, "") : undefined);

function albumKey(title: string, artist: string) {
  return title.toLowerCase().replace(/\s*[([](explicit|clean|edited)[)\]]/g, "").trim() + "|" + (artist.split(", ")[0] ?? artist).toLowerCase().trim();
}

class SearchEngine {
  private cache = new Map<string, unknown[]>();
  private cursors = new Map<string, string | undefined>();
  private shown = new Map<string, Set<string>>();
  private videoCount = new Map<string, number>();
  readonly albums = new Map<string, Album>(); // opened albums (instant re-open)
  private matched = new Map<string, Track[]>();
  private ytAlbum = new Map<string, Promise<J[][]>>();

  async search(mode: "songs" | "albums" | "videos" | "podcasts", query: string): Promise<unknown[]> {
    const qq = query.trim();
    if (!qq) return [];
    const lq = qq.toLowerCase();
    switch (mode) {
      case "songs": {
        const key = "songs|" + lq;
        if (this.cache.has(key)) return this.cache.get(key)!;
        const pg = await YTM.chain("songs", qq, undefined, 3);
        if (pg?.items.length) {
          this.cursors.set(key, pg.next);
          this.shown.set(key, new Set());
          const out = this.songRows(pg.items, key);
          this.cache.set(key, out);
          return out;
        }
        // YouTube Music's own search gave nothing: fall back to yt-dlp.
        const r = await flat(`https://music.youtube.com/search?q=${q(qq)}#songs`, 20);
        return ((r.entries as J[]) ?? [])
          .filter((e) => e.id)
          .map((e): SongRow => {
            const title = e.track ?? e.title ?? "";
            const artist = ytmArtist(e) ?? "";
            return { title, artist, album: e.album ?? "", year: "", albumId: "", plays: 0, junk: isJunk(title, artist), dur: eta(e.duration), art: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, url: `https://music.youtube.com/watch?v=${e.id}`, tags: { source: "ytmusic", title, artist } };
          });
      }
      case "albums": {
        const key = "albums|" + lq;
        if (this.cache.has(key)) return this.cache.get(key)!;
        // The albums behind YouTube Music's top songs first (least noise), then its album search, without duplicates.
        const [sp, ap] = await Promise.all([YTM.chain("songs", qq, undefined, 3), YTM.chain("albums", qq, undefined, 3)]);
        this.cursors.set("albums-songs|" + lq, sp?.next);
        this.cursors.set("albums-albums|" + lq, ap?.next);
        this.shown.set(key, new Set());
        const out = await this.albumCards(sp?.items ?? [], ap?.items ?? [], key);
        if (out.length) {
          this.cache.set(key, out);
          return out;
        }
        const r = await flat(`https://music.youtube.com/search?q=${q(qq)}#albums`, 24);
        return ((r.entries as J[]) ?? [])
          .map((e): AlbumCard | null => {
            const url = entryURL(e);
            return url ? { id: url, title: e.title ?? "", artist: ytmArtist(e) ?? "", year: e.release_year ? String(e.release_year) : "", type: "Album", art: bigArt(e.thumbnails?.slice(-1)[0]?.url) ?? "" } : null;
          })
          .filter((x): x is AlbumCard => !!x);
      }
      case "videos": {
        this.videoCount.set("videos|" + lq, 60);
        return this.videoRows((await flat(`ytsearch60:${qq}`, 60)).entries ?? []);
      }
      case "podcasts":
        return (await podcastSearch(qq))
          .filter((p) => p.feedUrl)
          .map((p): PodcastRow => ({ title: p.collectionName ?? "", author: p.artistName ?? "", episodes: p.trackCount ?? 0, freq: p.releaseDate ? `updated ${String(p.releaseDate).slice(0, 10)}` : "", art: p.artworkUrl600 ?? "", url: p.feedUrl }));
    }
    return [];
  }

  /** The next batch for the same search (empty when there's nothing more). */
  async more(mode: string, query: string): Promise<unknown[]> {
    const qq = query.trim();
    const lq = qq.toLowerCase();
    if (mode === "songs") {
      const key = "songs|" + lq;
      const next = this.cursors.get(key);
      if (!next) return [];
      const pg = await YTM.chain("songs", qq, next, 3);
      if (!pg) return [];
      this.cursors.set(key, pg.next);
      const out = this.songRows(pg.items, key);
      this.cache.set(key, [...(this.cache.get(key) ?? []), ...out]);
      return out;
    }
    if (mode === "albums") {
      const sNext = this.cursors.get("albums-songs|" + lq);
      const aNext = this.cursors.get("albums-albums|" + lq);
      if (!sNext && !aNext) return [];
      const [sp, ap] = await Promise.all([sNext ? YTM.chain("songs", qq, sNext, 3) : null, aNext ? YTM.chain("albums", qq, aNext, 3) : null]);
      this.cursors.set("albums-songs|" + lq, sp?.next);
      this.cursors.set("albums-albums|" + lq, ap?.next);
      const out = await this.albumCards(sp?.items ?? [], ap?.items ?? [], "albums|" + lq);
      this.cache.set("albums|" + lq, [...(this.cache.get("albums|" + lq) ?? []), ...out]);
      return out;
    }
    if (mode === "videos") {
      const have = this.videoCount.get("videos|" + lq) ?? 60;
      const want = have + 60;
      const r = await flat(`ytsearch${want}:${qq}`, want);
      this.videoCount.set("videos|" + lq, want);
      return this.videoRows(((r.entries as J[]) ?? []).slice(have));
    }
    return [];
  }

  private songRows(items: YTM.YTMItem[], key: string): SongRow[] {
    const seen = this.shown.get(key) ?? new Set<string>();
    this.shown.set(key, seen);
    return items.slice(0, 150).flatMap((it): SongRow[] => {
      if (!it.videoId || seen.has(it.videoId)) return [];
      seen.add(it.videoId);
      const tags: Record<string, string> = { source: "ytmusic", title: it.title, artist: it.artist, album: it.album, date: it.year };
      if (it.thumb) tags.cover = it.thumb;
      if (it.duration && isFinite(it.duration) && it.duration > 0) tags.length = String(Math.round(it.duration));
      for (const k of Object.keys(tags)) if (!tags[k]) delete tags[k];
      return [{
        title: it.title, artist: it.artist, album: it.album, year: it.year, albumId: it.albumId ? `ytm:${it.albumId}` : "", plays: it.plays ?? 0,
        junk: isJunk(it.title, it.artist, it.album), dur: eta(it.duration), art: it.thumb ?? `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`,
        url: `https://music.youtube.com/watch?v=${it.videoId}`, tags,
      }];
    });
  }

  private videoRows(entries: J[]): VideoRow[] {
    return entries.flatMap((e): VideoRow[] => {
      const url = entryURL(e);
      if (!url) return [];
      const v = e.view_count;
      const views = v == null ? "" : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B views` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M views` : v >= 1e3 ? `${Math.round(v / 1e3)}K views` : `${v} views`;
      return [{ title: e.title ?? "", channel: e.channel ?? e.uploader ?? "", views, dur: eta(e.duration), art: e.thumbnails?.slice(-1)[0]?.url ?? "", url, channelUrl: e.channel_url ?? "" }];
    });
  }

  /** Album cards from song rows (their album links) and album rows; every album page is opened (10 at a time) for real counts. */
  private async albumCards(songs: YTM.YTMItem[], albums: YTM.YTMItem[], key: string): Promise<AlbumCard[]> {
    const seen = new Set(this.shown.get(key) ?? []);
    type C = { id: string; title: string; artist: string; art?: string; year: string; fromSongs: number; plays: number };
    const order: C[] = [];
    const at = new Map<string, number>();
    for (const it of songs) {
      if (!it.albumId || !it.album) continue;
      const artist = it.artist.split(", ")[0] ?? it.artist;
      const k = at.get(it.albumId);
      if (k != null) {
        order[k].fromSongs++;
        order[k].plays += it.plays ?? 0;
        continue;
      }
      const nk = albumKey(it.album, artist);
      if (seen.has(it.albumId) || seen.has(nk)) continue;
      seen.add(it.albumId).add(nk);
      at.set(it.albumId, order.length);
      order.push({ id: it.albumId, title: it.album, artist, art: it.thumb, year: it.year, fromSongs: 1, plays: it.plays ?? 0 });
    }
    for (const it of albums) {
      if (!it.browseId) continue;
      const nk = albumKey(it.title, it.artist);
      if (seen.has(it.browseId) || seen.has(nk)) continue;
      seen.add(it.browseId).add(nk);
      order.push({ id: it.browseId, title: it.title, artist: it.artist, art: it.thumb, year: it.year, fromSongs: 0, plays: 0 });
    }
    const ids = order.slice(0, 90);
    const shown = this.shown.get(key) ?? new Set<string>();
    for (const c of ids) shown.add(c.id).add(albumKey(c.title, c.artist));
    this.shown.set(key, shown);
    const pages = new Map<string, YTM.YTMAlbum>();
    const todo = ids.map((c) => c.id).filter((id) => !this.albums.has(`ytm:${id}`));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(10, todo.length) }, async () => {
      while (next < todo.length) {
        const id = todo[next++];
        try {
          pages.set(id, await YTM.album(id));
        } catch {
          /* card without counts */
        }
      }
    }));
    return ids.map((c): AlbumCard => {
      const a: AlbumCard = { id: `ytm:${c.id}`, title: c.title, artist: c.artist, year: c.year, type: "Album", art: c.art ?? "", junk: isJunk(c.title, c.artist), plays: c.plays };
      let full = this.albums.get(`ytm:${c.id}`);
      const page = pages.get(c.id);
      if (!full && page) {
        try {
          full = this.ytmAlbumResult(`ytm:${c.id}`, page, c.artist, c.title, c.art);
        } catch {
          /* no playable tracks */
        }
      }
      if (full) {
        a.tracks = full.tracks.length;
        if (full.year) a.year = full.year;
        if (full.plays) a.plays = full.plays;
      }
      if (page?.kind) a.type = page.kind;
      return a;
    });
  }

  /** A YouTube Music album page → the album the window shows (cached, so opening it later is instant). */
  ytmAlbumResult(url: string, a: YTM.YTMAlbum, artistHint?: string, titleHint?: string, artHint?: string): Album {
    if (!a.tracks.some((t) => t.videoId)) throw new GoblinError("YouTube Music returned no playable tracks for this album");
    const title = a.title || titleHint || "Album";
    const artist = a.artist || artistHint || "Unknown Artist";
    // The cover shown in the search row is the one you saw and expect: use it first.
    const cover = artHint || a.thumb || "";
    const tracks = a.tracks.flatMap((t, i): Track[] =>
      t.videoId
        ? [{ n: i + 1, title: t.title, len: eta(t.duration), lenSec: t.duration ?? 0, artist: t.artist || artist, url: `https://music.youtube.com/watch?v=${t.videoId}`, yt: t.title, ytLen: eta(t.duration), status: "ok" }]
        : [],
    );
    const result: Album = {
      id: url, group: url, title, artist, year: a.year, type: a.kind || "Album", label: "", cover, editions: [], tracks, pending: false, source: "ytmusic",
      trackTotal: a.tracks.length, plays: a.tracks.reduce((s, t) => s + (t.plays ?? 0), 0), dest: albumDest(artist, title, a.year),
    };
    this.albums.set(url, result);
    return result;
  }

  /** An album straight from YouTube Music: its own tracklist, order and cover. */
  async ytmAlbum(url: string, artistHint?: string, titleHint?: string, artHint?: string): Promise<Album> {
    const c = this.albums.get(url);
    if (c) return c;
    if (url.startsWith("ytm:")) return this.ytmAlbumResult(url, await YTM.album(url.slice(4)), artistHint, titleHint, artHint);
    const r = await flat(url, 0);
    const entries: J[] = r.entries ?? [];
    if (!entries.length) throw new GoblinError("YouTube Music returned no tracks for this album");
    let title: string = titleHint || r.title || "Album";
    if (title.startsWith("Album - ")) title = title.slice(8);
    const artist = artistHint || ytmArtist(r) || (entries[0] ? ytmArtist(entries[0]) : undefined) || "Unknown Artist";
    const year = r.release_year ? String(r.release_year) : "";
    const tracks = entries.flatMap((e, i): Track[] => {
      const u = entryURL(e);
      return u ? [{ n: i + 1, title: e.title ?? `Track ${i + 1}`, len: eta(e.duration), lenSec: e.duration ?? 0, artist: ytmArtist(e) ?? artist, url: u, yt: e.title ?? "", ytLen: eta(e.duration), status: "ok" }] : [];
    });
    const result: Album = { id: url, group: url, title, artist, year, type: "Album", label: "", cover: artHint || bigArt(r.thumbnails?.slice(-1)[0]?.url) || "", editions: [], tracks, pending: false, source: "ytmusic", dest: albumDest(artist, title, year) };
    this.albums.set(url, result);
    return result;
  }

  // ---------------------------------------------------------------- artists (bulk album downloads)

  async artists(query: string): Promise<{ id: string; title: string; albums: number; fans: number; art: string }[]> {
    return (await Deezer.artists(query)).map((a) => ({ id: String(a.id), title: a.name ?? "", albums: a.nb_album ?? 0, fans: a.nb_fan ?? 0, art: a.picture_xl ?? a.picture_big ?? "" }));
  }

  /** An artist's discography, newest first. */
  async artistAlbums(id: string): Promise<AlbumCard[]> {
    const all = await Deezer.artistAlbums(id);
    const seen = new Set<string>();
    return all
      .sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")))
      .flatMap((a): AlbumCard[] => {
        const k = String(a.title ?? "").toLowerCase() + "|" + (a.record_type ?? "");
        if (!a.id || seen.has(k)) return [];
        seen.add(k);
        const type = ({ album: "Album", single: "Single", ep: "EP", compile: "Compilation" } as Record<string, string>)[a.record_type] ?? "Album";
        return [{ id: `dz:${a.id}`, title: a.title ?? "", artist: "", year: String(a.release_date ?? "").slice(0, 4), type, fans: a.fans ?? 0, art: a.cover_xl ?? a.cover_big ?? "" }];
      });
  }

  // ---------------------------------------------------------------- album finder

  /** Phase 1: the tracklist (instantly for YouTube Music; Deezer and MusicBrainz tracks come back as "searching"). */
  async albumMatch(id: string, release?: string, artistHint?: string, titleHint?: string, artHint?: string): Promise<Album> {
    if (id.startsWith("http") || id.startsWith("ytm:")) return this.ytmAlbum(id, artistHint, titleHint, artHint);
    if (id.startsWith("dz:")) return this.deezerAlbum(id.slice(3));
    return this.mbAlbum(id, release, artistHint, titleHint);
  }

  private prefetch(artist: string, album: string): Promise<J[][]> {
    const k = `${artist.toLowerCase()}|${album.toLowerCase()}`;
    let t = this.ytAlbum.get(k);
    if (!t) {
      t = albumPlaylists(artist, album);
      this.ytAlbum.set(k, t);
    }
    return t;
  }

  private async deezerAlbum(id: string): Promise<Album> {
    const key = `dz:${id}`;
    const cached = this.albums.get(key);
    if (cached) {
      const done = this.matched.get(key);
      return done ? { ...cached, tracks: done, pending: false } : cached;
    }
    const [a, list0] = await Promise.all([Deezer.album(id), Deezer.albumTracks(id).catch(() => null)]);
    const list: J[] = list0 ?? a.tracks?.data ?? [];
    if (!list.length) throw new GoblinError("This album has no tracks on Deezer");
    const artist = a.artist?.name ?? "";
    const title = a.title ?? "";
    const date = a.release_date ?? "";
    const tracks = list.map((t, i): Track => ({
      n: i + 1, pos: t.track_position ?? i + 1, disc: t.disk_number ?? 1, title: t.title ?? "", len: eta(t.duration), lenSec: t.duration ?? 0,
      artist: t.artist?.name ?? artist, isrc: t.isrc ?? "", yt: "", ytLen: "", status: "searching",
    }));
    const type = ({ album: "Album", single: "Single", ep: "EP", compile: "Compilation" } as Record<string, string>)[a.record_type] ?? "Album";
    const yr = date.slice(0, 4);
    void this.prefetch(artist, title);
    const result: Album = {
      id: key, group: key, title, artist, year: yr, date, type, label: a.label ?? "", genre: a.genres?.data?.[0]?.name ?? "",
      discTotal: Math.max(1, ...list.map((t) => t.disk_number ?? 1)), cover: a.cover_xl ?? a.cover_big ?? "", editions: [],
      tracks: this.matched.get(key) ?? tracks, pending: !this.matched.has(key), source: "deezer", dest: albumDest(artist, title, yr),
    };
    this.albums.set(key, result);
    return result;
  }

  private light = new Map<string, J[]>();
  private full = new Map<string, J>();

  private async mbAlbum(group: string, wanted?: string, artistHint?: string, titleHint?: string): Promise<Album> {
    if (artistHint && titleHint) void this.prefetch(artistHint, titleHint);
    let releases = this.light.get(group);
    if (!releases) {
      releases = await MusicBrainz.releasesLight(group);
      this.light.set(group, releases);
    }
    if (!releases.length) throw new GoblinError("No releases for this album on MusicBrainz");
    const count = (r: J) => ((r.media as J[]) ?? []).reduce((s, m) => s + (m["track-count"] ?? (m.tracks as J[])?.length ?? 0), 0);
    const counts = new Map<number, number>();
    for (const r of releases) counts.set(count(r), (counts.get(count(r)) ?? 0) + 1);
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const score = (r: J) => {
      let v = r.status === "Official" ? 4 : 0;
      const f = ((r.media as J[]) ?? []).map((m) => m.format);
      v += f.includes("Digital Media") ? 2 : f.includes("CD") ? 1.5 : 0;
      if (count(r) === common) v += 2;
      const y = Number(String(r.date ?? "").slice(0, 4));
      if (y) v += (2100 - y) / 100;
      if (r.country === "XW") v += 0.5;
      return v;
    };
    const ranked = [...releases].sort((a, b) => score(b) - score(a));
    const relId: string = (wanted && releases.find((r) => r.id === wanted)?.id) || ranked[0].id;
    let rel = this.full.get(relId);
    if (!rel) {
      rel = await MusicBrainz.release(relId);
      this.full.set(relId, rel);
    }
    const artist = MusicBrainz.credit(rel);
    const title: string = rel.title ?? "";
    void this.prefetch(artist, title);
    let n = 0;
    let tracks: Track[] = [];
    for (const m of (rel.media as J[]) ?? [])
      for (const t of (m.tracks as J[]) ?? []) {
        n++;
        const len = (t.length ?? t.recording?.length) != null ? (t.length ?? t.recording.length) / 1000 : 0;
        tracks.push({ n, disc: m.position ?? 1, title: t.title ?? "", len: eta(len), lenSec: len, recording: t.recording?.id ?? "", artist: MusicBrainz.credit(t), yt: "", ytLen: "", status: "searching" });
      }
    const done = this.matched.get(relId);
    if (done) tracks = done;
    const label = (r: J) => {
      const media: J[] = r.media ?? [];
      const fmt = [...new Set(media.map((m) => m.format).filter(Boolean))].join("+");
      const lab = r["label-info"]?.[0]?.label?.name;
      return [String(r.date ?? "").slice(0, 4), fmt, `${count(r)} tracks`, r.country, lab ? `(${lab})` : ""].filter(Boolean).join(" · ");
    };
    const seenL = new Set<string>();
    const editions = ranked.flatMap((r) => {
      const l = label(r);
      if (seenL.has(l) || !r.id) return [];
      seenL.add(l);
      return [{ id: r.id as string, label: l }];
    });
    const yr = String(rel.date ?? "").slice(0, 4);
    const result: Album = {
      id: relId, group, title, artist, year: yr, type: rel["release-group"]?.["primary-type"] ?? "Album", label: rel["label-info"]?.[0]?.label?.name ?? "",
      cover: `https://coverartarchive.org/release/${relId}/front-500`, editions, tracks, pending: !done, source: "musicbrainz", dest: albumDest(artist, title, yr),
    };
    this.albums.set(relId, result);
    return result;
  }

  /** Phase 2: match every track to YouTube Music; leftovers are searched one by one, 4 at a time. */
  async albumYT(album: Album): Promise<Track[]> {
    const done = this.matched.get(album.id);
    if (done) return done;
    const tracks = album.tracks.map((t) => ({ ...t }));
    const playlists = await this.prefetch(album.artist, album.title);
    if (!playlists.length) this.ytAlbum.delete(`${album.artist.toLowerCase()}|${album.title.toLowerCase()}`);
    // The playlist whose length fits this edition best.
    let yt: J[] = [];
    for (const p of playlists) if (!yt.length || Math.abs(p.length - tracks.length) < Math.abs(yt.length - tracks.length)) yt = p;
    if (Math.abs(yt.length - tracks.length) > Math.max(2, Math.floor(tracks.length / 4))) yt = [];
    const variant = (s: string) => VARIANT.test(s.toLowerCase());
    const score = (t: Track, e: J) => {
      const et = e.title ?? "";
      let sc = similarity(et, t.title);
      if (e.duration != null && t.lenSec > 0) {
        const d = Math.abs(e.duration - t.lenSec);
        sc += d <= 3 ? 0.35 : d <= 8 ? 0.1 : d <= 20 ? -0.2 : -0.6;
      }
      if (variant(et) && !variant(t.title)) sc -= 1.5;
      return sc;
    };
    const assigned = new Map<number, J>();
    // The official album playlist is in album order: trust the position when it agrees.
    if (yt.length === tracks.length) tracks.forEach((t, i) => { if (score(t, yt[i]) >= 0.75) assigned.set(i, yt[i]); });
    // Everything else: best pairs first across the whole album, so one track can't steal another's upload.
    const used = new Set([...assigned.values()].map((e) => e.id));
    const pairs: [number, number, J][] = [];
    tracks.forEach((t, i) => {
      if (!assigned.has(i)) for (const e of yt) if (e.id && !used.has(e.id)) pairs.push([score(t, e), i, e]);
    });
    for (const [sc, i, e] of pairs.sort((a, b) => b[0] - a[0])) {
      if (sc < 0.7 || assigned.has(i) || used.has(e.id)) continue;
      assigned.set(i, e);
      used.add(e.id);
    }
    const leftovers: number[] = [];
    tracks.forEach((t, i) => {
      const e = assigned.get(i);
      if (!e) return void leftovers.push(i);
      const diff = Math.abs((e.duration ?? t.lenSec) - t.lenSec);
      Object.assign(t, { yt: e.title ?? "", ytLen: eta(e.duration), url: `https://music.youtube.com/watch?v=${e.id}`, status: diff <= 4 && score(t, e) >= 1 ? "ok" : "warn" });
    });
    const todo = leftovers.slice(0, 16);
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
      while (k < todo.length) {
        const i = todo[k++];
        const t = tracks[i];
        const f = await findOfficialAudio(t.artist || album.artist, t.title, t.lenSec || undefined, t.isrc || undefined).catch(() => null);
        if (f) Object.assign(t, { yt: f.label, ytLen: "", url: f.url, status: "warn" });
        else Object.assign(t, { yt: "Not found", ytLen: "", status: "missing" });
      }
    }));
    for (const i of leftovers.slice(16)) Object.assign(tracks[i], { yt: "Not found", status: "missing" });
    this.matched.set(album.id, tracks);
    return tracks;
  }

  /** Cover choices: YouTube Music's own, Apple Music, Deezer and Cover Art Archive, filtered to the same album title. */
  async covers(album: Album): Promise<{ url: string; label: string }[]> {
    const out: { url: string; label: string }[] = [];
    if (album.cover) out.push({ url: album.cover, label: album.source === "ytmusic" ? "YouTube Music" : album.source === "deezer" ? "Deezer" : "Cover Art Archive" });
    const term = `${album.artist} ${album.title}`.trim();
    const [a, d, c] = await Promise.all([appleCovers(term, album.title), deezerCovers(term, album.title), caaCovers(album.artist, album.title)]);
    const seen = new Set<string>();
    return [...out, ...a, ...d, ...c].filter((x) => x.url && !seen.has(x.url) && !!seen.add(x.url));
  }

  /** Queues an album's tracks with their tags already decided. `skip` = track numbers you unticked; `picks` = your own choice of upload. */
  download(album: Album, presetId: string, picks: Record<number, string>, cover: string, skip: Set<number> = new Set()): JobInfo[] {
    const opts = { presetId };
    const out: JobInfo[] = [];
    const total = album.trackTotal ?? album.tracks.length;
    const art = cover || album.cover;
    for (const t of album.tracks) {
      if (skip.has(t.n)) continue;
      const url = picks[t.n] ?? t.url;
      if (!url) continue;
      const hint = { titleHint: `${t.artist || album.artist} – ${t.title}`, thumb: album.cover, albumHint: album.title };
      if (album.source === "musicbrainz") {
        if (!t.recording) continue;
        const mb: Record<string, string> = { release: album.id, recording: t.recording };
        if (cover) mb.cover = cover;
        out.push(...jobs.add(url, opts, { ...hint, mb }));
        continue;
      }
      const tags: Record<string, string> = album.source === "ytmusic"
        ? { source: "ytmusic", title: t.title, artist: t.artist || album.artist, albumArtist: album.artist, album: album.title, date: album.year, track: String(t.n), trackTotal: String(total), length: t.lenSec ? String(Math.round(t.lenSec)) : "", cover: art }
        : {
            title: t.title, artist: t.artist || album.artist, albumArtist: album.artist, album: album.title, date: album.date || album.year, track: String(t.pos ?? t.n), trackTotal: String(total),
            disc: String(t.disc ?? 1), discTotal: String(album.discTotal ?? 1), genre: album.genre ?? "", label: album.label, isrc: t.isrc ?? "", length: t.lenSec ? String(Math.round(t.lenSec)) : "", cover: art,
          };
      for (const k of Object.keys(tags)) if (!tags[k]) delete tags[k];
      out.push(...jobs.add(url, opts, { ...hint, tags }));
    }
    return out;
  }

  /** Bulk: open and queue several albums, one after another. */
  async queueAlbums(items: AlbumCard[], presetId: string, report: (msg: string, sub: string) => void) {
    for (const it of items) {
      try {
        let a = await this.albumMatch(it.id, undefined, it.artist, it.title, it.art);
        if (a.pending) a = { ...a, tracks: await this.albumYT(a), pending: false };
        const added = this.download(a, presetId, {}, "");
        report(`Queued ${added.length} tracks`, `${a.artist} – ${a.title}`);
      } catch (e) {
        report(`Couldn't queue ${it.title}`, e instanceof Error ? e.message : String(e));
      }
    }
  }
}

export const search = new SearchEngine();
