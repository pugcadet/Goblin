// Presets, settings, per-download options and jobs (the Mac app's Models.swift, without shows and web pages).

export interface Preset {
  id: string;
  name: string;
  kind: "video" | "music";
  // Video
  quality: string; // best, 2160, 1440, 1080, 720, 480, 360
  container: string; // any, mkv, mp4, webm
  codec: string; // any, h264, h265, av1, vp9
  subtitles: boolean;
  subLangs: string;
  capSource: string; // fallback, manual, auto
  embedChapters: boolean;
  splitChapters: boolean;
  sponsorBlock: boolean;
  sponsorCats: string;
  metaMode: string; // youtube (Channel folder + name pattern), none (keep the original title / yt-dlp template)
  fileTemplate: string;
  // Music
  audioFormat: string; // mp3, m4a, opus, flac, wav
  audioQuality: string; // 320, V2, 192, 128
  preferOfficialAudio: boolean;
  musicbrainz: boolean;
  embedCover: boolean;
  lyrics: boolean;
  loudness: string; // off, replaygain, normalize ("" = Settings)
  podcast: boolean;
  albumFolders: boolean;
  tagCleanTitle: boolean;
  tagFeat: string; // keep, title, artist
  tagArtistSep: string;
  tagAlbumArtist: boolean;
  tagYear: boolean;
  tagGenre: boolean;
  tagComment: string;
  tagId3: string; // 2.3, 2.4
  // Shared
  allowPlaylists: boolean;
  outputDir: string;
  ytdlpArgs: string;
}

export const PRESET_DEFAULTS: Preset = {
  id: "",
  name: "New preset",
  kind: "video",
  quality: "1080",
  container: "mkv",
  codec: "any",
  subtitles: true,
  subLangs: "en.*,en",
  capSource: "fallback",
  embedChapters: true,
  splitChapters: false,
  sponsorBlock: false,
  sponsorCats: "sponsor,selfpromo,interaction",
  metaMode: "youtube",
  fileTemplate: "",
  audioFormat: "mp3",
  audioQuality: "320",
  preferOfficialAudio: true,
  musicbrainz: true,
  embedCover: true,
  lyrics: true,
  loudness: "replaygain",
  podcast: false,
  albumFolders: true,
  tagCleanTitle: true,
  tagFeat: "keep",
  tagArtistSep: ", ",
  tagAlbumArtist: true,
  tagYear: true,
  tagGenre: true,
  tagComment: "",
  tagId3: "2.3",
  allowPlaylists: true,
  outputDir: "",
  ytdlpArgs: "",
};

export const BUILT_IN: Preset[] = [
  { ...PRESET_DEFAULTS, id: "youtube", name: "YouTube · 1080p MP4", container: "mp4", codec: "h264", sponsorBlock: true },
  { ...PRESET_DEFAULTS, id: "best", name: "YouTube · best quality MKV", quality: "best" },
  { ...PRESET_DEFAULTS, id: "music", name: "Music · MP3 320", kind: "music" },
  {
    ...PRESET_DEFAULTS, id: "podcast", name: "Podcast · MP3", kind: "music", podcast: true,
    musicbrainz: false, preferOfficialAudio: false, audioQuality: "V2", lyrics: false,
  },
];

export interface Settings {
  dirYoutube: string;
  dirMusic: string;
  dirPodcasts: string;
  dirOther: string;
  defaultPresetId: string;
  videoName: string;
  trackName: string;
  youtubeFolder: string;
  musicFolder: string;
  askOnLowConfidence: boolean;
  reviewThreshold: number;
  mbContact: string;
  autoDetect: string; // suggest, apply, off
  previewBeforeDownload: boolean;
  concurrency: number;
  fragments: number;
  autoStart: boolean;
  playlistItemLimit: number;
  useArchive: boolean;
  clearCompletedAfter: string; // seconds
  deleteFileOnRemove: boolean;
  loudness: string;
  lyrics: boolean;
  subInterval: number;
  subScanEnd: number;
  subMaxSeen: number;
  subCatchUp: boolean;
  outputTemplate: string;
  outputTemplatePlaylist: string;
  outputTemplateChannel: string;
  outputTemplateChapter: string;
  autoUpdate: boolean;
  ytdlpGlobal: string;
  compactList: boolean;
  groupAlbums: boolean;
  cookieDailyMax: number;
  cookieDay: string;
  cookieCount: number;
  limitRate: string;
  searchFilters: string;
}

export const NAMING = {
  video: "{title}",
  track: "{title}",
  youtubeFolder: "{channel}",
  musicFolder: "{albumartist}/{album} ({year})",
};

export const SETTINGS_DEFAULTS: Settings = {
  dirYoutube: "YouTube",
  dirMusic: "Music",
  dirPodcasts: "Podcasts",
  dirOther: "Other",
  defaultPresetId: "youtube",
  videoName: NAMING.video,
  trackName: NAMING.track,
  youtubeFolder: NAMING.youtubeFolder,
  musicFolder: NAMING.musicFolder,
  askOnLowConfidence: true,
  reviewThreshold: 0.72,
  mbContact: "",
  autoDetect: "suggest",
  previewBeforeDownload: false,
  concurrency: 3,
  fragments: 4,
  autoStart: true,
  playlistItemLimit: 0,
  useArchive: true,
  clearCompletedAfter: "0",
  deleteFileOnRemove: false,
  loudness: "replaygain",
  lyrics: true,
  subInterval: 60,
  subScanEnd: 50,
  subMaxSeen: 50000,
  subCatchUp: false,
  outputTemplate: "",
  outputTemplatePlaylist: "",
  outputTemplateChannel: "",
  outputTemplateChapter: "",
  autoUpdate: true,
  ytdlpGlobal: "",
  compactList: false,
  groupAlbums: true,
  cookieDailyMax: 20,
  cookieDay: "",
  cookieCount: 0,
  limitRate: "",
  searchFilters: "",
};

/** Per-download options from the add bar that aren't preset fields. */
export interface Extra {
  folder: string;
  prefix: string;
  clipStart: string;
  clipEnd: string;
  password: string;
  autoStart: boolean;
  itemsLimit: number;
  subInterval: number;
  subFilter: string;
  skipMembers: boolean;
  chapterTemplate: string;
  playlistIndex: number;
}

export const EXTRA_DEFAULTS: Extra = {
  folder: "",
  prefix: "",
  clipStart: "",
  clipEnd: "",
  password: "",
  autoStart: true,
  itemsLimit: 0,
  subInterval: 60,
  subFilter: "",
  skipMembers: true,
  chapterTemplate: "",
  playlistIndex: 0,
};

/** The add bar's options: a preset id plus any preset fields you changed and the extras. */
export type Options = Partial<Preset> & Partial<Extra> & { presetId?: string };

export interface Candidate {
  id: string;
  title: string;
  subtitle: string;
  image: string | null;
  kind: string;
  score: number;
  meta: Record<string, string>;
}

export type JobStatus = "pending" | "queued" | "working" | "downloading" | "review" | "done" | "skipped" | "error" | "canceled";

export interface JobInfo {
  id: string;
  input: string;
  url?: string;
  presetId: string;
  presetName: string;
  kind: "video" | "music";
  options: Options;
  title: string;
  thumbnail?: string;
  status: JobStatus;
  stage: string;
  progress: number;
  speed?: string;
  eta?: string;
  size?: string;
  error?: string;
  finalPath?: string;
  matchLabel?: string;
  confidence?: number;
  candidates?: Candidate[];
  added: number;
  finished?: number;
  formatLabel?: string;
  qualityLabel?: string;
  formatShort?: string;
  live?: boolean;
  subId?: string;
  subName?: string;
  chapters?: string[];
  albumHint?: string;
  mb?: Record<string, string>;
  tags?: Record<string, string>;
  playlistTitle?: string;
  playlistIndex?: number;
}

export interface SubRules {
  skipShorts: boolean;
  skipLive: boolean;
  minLen: number;
  maxLen: number;
  days: number;
  include: string;
  exclude: string;
  maxPer: number;
  keep: number;
}

export const RULE_DEFAULTS: SubRules = { skipShorts: true, skipLive: true, minLen: 0, maxLen: 0, days: 0, include: "", exclude: "", maxPer: 0, keep: 0 };

export interface Subscription {
  id: string;
  name: string;
  url: string;
  thumbnail?: string;
  presetId: string;
  options: Options;
  interval: number;
  filter: string;
  skipMembers: boolean;
  rules: SubRules;
  status: "active" | "paused" | "error" | "checking";
  error?: string;
  lastChecked?: number;
  lastNew: number;
  seen: number;
  files: string[];
}

export interface TrackMeta {
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string; // "" = album-artist tag turned off in the preset
  date?: string;
  track?: number;
  trackTotal?: number;
  disc?: number;
  discTotal?: number;
  genre?: string;
  label?: string;
  isrc?: string;
  lengthSec?: number;
  ids: Record<string, string>; // MusicBrainz Track/Album/Artist/Release Group Id, comment
  coverURLs: string[];
}

export const year = (m: TrackMeta) => (m.date ? m.date.slice(0, 4) : undefined);
/** Album artist for folders and names: falls back to the artist (also when the album-artist tag is off). */
export const folderArtist = (m: TrackMeta) => (m.albumArtist ? m.albumArtist : m.artist);

/** Fills missing fields from defaults; unknown fields from older/newer versions are kept harmlessly. */
export function merged<T extends object>(defaults: T, value: unknown): T {
  if (!value || typeof value !== "object") return { ...defaults };
  const out = { ...defaults } as Record<string, unknown>;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const d = (defaults as Record<string, unknown>)[k];
    if (d === undefined || typeof d === typeof v) out[k] = v;
  }
  return out as T;
}

/** The preset with your per-download changes applied, plus the extras. */
export function effective(presets: Preset[], settings: Settings, options: Options): [Preset, Extra] {
  const id = options.presetId ?? settings.defaultPresetId;
  const base = presets.find((p) => p.id === id) ?? presets.find((p) => p.id === settings.defaultPresetId) ?? presets[0] ?? BUILT_IN[0];
  const p: Preset = { ...base };
  for (const k of Object.keys(PRESET_DEFAULTS) as (keyof Preset)[]) {
    if (k === "id" || k === "name") continue;
    const v = (options as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && typeof v === typeof PRESET_DEFAULTS[k]) (p as unknown as Record<string, unknown>)[k] = v;
  }
  const x = merged(EXTRA_DEFAULTS, options);
  if (typeof options.autoStart === "string") x.autoStart = options.autoStart !== "false";
  if (typeof options.itemsLimit === "string") x.itemsLimit = Number(options.itemsLimit) || 0;
  return [p, x];
}

export function formatLabel(p: Preset): string {
  if (p.kind === "music") {
    if (p.podcast) return `Podcast ${p.audioFormat.toUpperCase()}`;
    return p.audioFormat === "mp3" ? `MP3 ${p.audioQuality}` : p.audioFormat.toUpperCase();
  }
  const q = p.quality === "best" ? "Best" : `${p.quality}p`;
  return p.container === "any" ? q : `${q} ${p.container.toUpperCase()}`;
}
