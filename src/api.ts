import { invoke } from "@tauri-apps/api/core";

export interface ToolState {
  path: string | null;
  version: string | null;
  managed: boolean;
  folder: string | null;
  ffmpeg: string | null;
  deno: string | null;
  cookies: string | null;
}

export interface DlRequest {
  url: string;
  kind: "video" | "audio";
  maxHeight: number;
  format: string;
  subtitles: boolean;
  subLangs: string[];
  sponsorblock: boolean;
  playlist: boolean;
  naming: "title" | "channel" | "series";
  seriesName: string | null;
  season: number | null;
}

export interface Hit {
  url: string;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string | null;
}

export interface DlEvent {
  id: number;
  kind: "progress" | "status" | "title" | "file" | "done" | "failed" | "cancelled";
  percent: number | null;
  speed: string | null;
  eta: string | null;
  item: string | null;
  text: string | null;
}

export const api = {
  ytdlpInfo: () => invoke<ToolState>("ytdlp_info"),
  ytdlpInstall: () => invoke<string>("ytdlp_install"),
  pickDownloadFolder: () => invoke<string | null>("pick_download_folder"),
  setCookies: (browser: string | null) => invoke<void>("dl_set_cookies", { browser }),
  search: (query: string, kind: "songs" | "videos") => invoke<Hit[]>("dl_search", { query, kind }),
  start: (req: DlRequest) => invoke<number>("dl_start", { req }),
  cancel: (id: number) => invoke<void>("dl_cancel", { id }),
  reveal: (path: string | null) => invoke<void>("dl_reveal", { path }),
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
};

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  notes: string;
}

/** Tauri reports errors from Rust as plain strings. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong.";
}

export function duration(sec: number | null | undefined): string {
  if (!sec || sec < 0) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export const isMac = navigator.userAgent.includes("Mac");
export const fileManager = isMac ? "Finder" : "Explorer";

/** Small saved conveniences (download choices, number of downloads at once). */
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not essential */
  }
}
