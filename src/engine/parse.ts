// Song-title parsing and tag clean-up (Metadata.swift → Parse, Media.swift → TagStyle).
import type { Preset, TrackMeta } from "./model";

export interface ParsedSong {
  artist?: string;
  title: string;
  featured?: string;
}

const SONG_JUNK = String.raw`official\s*(?:hd\s*)?(?:music\s*)?(?:video|audio|visuali[sz]er|lyric\s*video|clip)|(?:lyric|lyrics)(?:\s*video)?|audio|video\s*clip|music\s*video|visuali[sz]er|hd|hq|4k|explicit|clean|m/?v|\d{4}\s*remaster(?:ed)?|remaster(?:ed)?(?:\s*\d{4})?`;

export function cleanArtist(c: string): string {
  return c
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/, "")
    .replace(/\s*(?:Official(?:\s+Channel)?|Music)$/i, "")
    .trim();
}

/** "Daft Punk - Get Lucky (Official Video) ft. Pharrell" → artist, title, featured. */
export function parseSong(raw: string, channel?: string | null): ParsedSong {
  let s = raw;
  let featured: string | undefined;
  const m =
    s.match(/[([]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]/i) ??
    s.match(/\s(?:feat\.?|ft\.?|featuring)\s+(.+?)(?=\s*[([\-|]|$)/i);
  if (m) {
    featured = m[1].trim();
    s = s.replace(m[0], " ");
  }
  s = s.replace(new RegExp(String.raw`[([](?:\s*(?:${SONG_JUNK})\s*)+[)\]]`, "gi"), " ");
  s = s.replace(new RegExp(String.raw`\s[-|]\s*(?:${SONG_JUNK})\s*$`, "i"), " ");
  s = s.replace(/\s+(?:official\s+(?:music\s+)?(?:video|audio))\s*$/i, " ");
  const bar = s.indexOf(" | ");
  if (bar >= 0) s = s.slice(0, bar);
  s = s.replace(/"/g, "").replace(/\s{2,}/g, " ").trim();
  let artist = channel ? cleanArtist(channel) : undefined;
  for (const sep of [" - ", " – ", " — ", " ~ "]) {
    const i = s.indexOf(sep);
    if (i >= 0) {
      const a = s.slice(0, i).trim();
      const t = s.slice(i + sep.length).trim();
      if (a && t) {
        artist = a;
        s = t;
      }
      break;
    }
  }
  s = s.replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, "");
  return { artist: artist || undefined, title: s || raw, featured };
}

/** Covers, karaoke, tributes, lullaby/8-bit/piano versions, sped-up edits… (hidden by default in search). */
export const JUNK = /\b(karaoke|tribute|cover(s|ed)?|lullab(y|ies)|8[- ]?bit|in the style of|made famous|originally performed|as performed by|piano (version|cover|tribute|renditions?)|instrumental versions?|sped[ -]?up|slowed|nightcore|reverb|8d audio|parody|chipmunks?|music box|rockabye baby|string quartet|kidz bop|workout|re-?recorded by|vs\.?)\b/i;
export const isJunk = (...parts: string[]) => parts.some((p) => JUNK.test((p || "").toLowerCase()));

/** Live, remix, acoustic… versions: never picked for a studio track unless the track itself is one. */
export const VARIANT = /\b(live|remix|acoustic|karaoke|instrumental|cover|sped\s*up|slowed|nightcore|8d|reverb|demo|edit|version|piano|tribute)\b/i;

const TAG_JUNK = /\s*[([](official\s+)?(music\s+)?(audio|video|lyric video|lyrics?|visuali[sz]er|explicit|clean|hq|hd|4k|remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?)[)\]]/gi;
const REMASTER_SUFFIX = /\s+-\s+(\d{4}\s+)?(digital\s+)?remaster(ed)?(\s+(version|\d{4}))?.*$/i;
const FEAT_IN_TITLE = /\s*[([](feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]/i;

/** Presets → Tags: clean titles, where featured artists go, artist separators, which tags to write. */
export function tagStyle(meta: TrackMeta, p: Preset): TrackMeta {
  const m: TrackMeta = { ...meta, ids: { ...meta.ids }, coverURLs: [...meta.coverURLs] };
  if (p.tagCleanTitle) {
    m.title = m.title.replace(TAG_JUNK, "").replace(REMASTER_SUFFIX, "").trim();
    if (m.album) m.album = m.album.replace(TAG_JUNK, "").trim();
  }
  let artists = m.artist
    .split(", ")
    .flatMap((a) => a.split("; "))
    .map((a) => a.trim())
    .filter(Boolean);
  if (p.tagFeat === "title" && artists.length > 1) {
    // Main artist only; everyone else goes into the title as "(feat. …)".
    const guests = artists.slice(1);
    artists = [artists[0]];
    if (!FEAT_IN_TITLE.test(m.title)) {
      m.title += " (feat. " + (guests.length > 1 ? guests.slice(0, -1).join(", ") + " & " + guests[guests.length - 1] : guests[0]) + ")";
    }
  } else if (p.tagFeat === "artist") {
    // Guests out of the title, into the artist field.
    const f = m.title.match(FEAT_IN_TITLE);
    if (f) {
      m.title = m.title.replace(f[0], "").trim();
      for (const g of f[2].split(", ").flatMap((x) => x.split(" & ")).map((x) => x.trim())) {
        if (g && !artists.includes(g)) artists.push(g);
      }
    }
  }
  if (artists.length) m.artist = artists.join(p.tagArtistSep || ", ");
  if (!p.tagAlbumArtist) m.albumArtist = "";
  if (!p.tagYear) m.date = undefined;
  if (!p.tagGenre) m.genre = undefined;
  if (p.tagComment.trim()) m.ids.comment = p.tagComment.trim();
  return m;
}
