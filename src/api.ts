// Rust commands the window uses directly (the engine's own ones are in engine/tauri.ts).
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

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  notes: string;
  /** A newer version whose file for this computer is still being built. */
  pending?: string | null;
}

export interface CookieState {
  loaded: boolean;
  name: string;
}

export const api = {
  ytdlpInfo: () => invoke<ToolState>("ytdlp_info"),
  ytdlpInstall: () => invoke<string>("ytdlp_install"),
  pickLibrary: () => invoke<string | null>("pick_download_folder"),
  setCookieBrowser: (browser: string | null) => invoke<void>("dl_set_cookies", { browser }),
  pickPaths: (kind: "folder" | "folders" | "audio") => invoke<string[]>("pick_paths", { kind }),
  pickImage: () => invoke<string | null>("pick_image"),
  cookiesInfo: () => invoke<CookieState>("cookies_info"),
  cookiesLoad: () => invoke<CookieState>("cookies_load"),
  cookiesDelete: () => invoke<CookieState>("cookies_delete"),
  youtubeSignIn: () => invoke<CookieState>("youtube_sign_in"),
  linksTake: () => invoke<string[]>("links_take"),
  imageData: (path: string) => invoke<string | null>("image_data", { path }),
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
};

/** Tauri reports errors from Rust as plain strings. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong.";
}

export const isMac = navigator.userAgent.includes("Mac");
export const fileManager = isMac ? "Finder" : "Explorer";

/** Small per-window conveniences (remembered search filters, open sections). */
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
