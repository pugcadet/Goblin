// The engine talks to the computer only through this interface. In the app it is backed by the
// Rust host tools (src-tauri/src/host.rs); in tests by Node (test/nodehost.ts).

export interface ProcReq {
  id: string;
  tool: "yt-dlp" | "ffmpeg" | "ffprobe";
  args: string[];
  timeoutSec?: number;
  stallSec?: number;
  /** Send every line to onLine while it runs (stdout is then not returned). */
  stream?: boolean;
  /** yt-dlp: use the cookies (only after YouTube said the video needs sign-in). */
  cookies?: boolean;
}

export interface ProcOut {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stalled: boolean;
  killed: boolean;
}

export interface HostInfo {
  dataDir: string;
  tmpDir: string;
  library: string | null;
  platform: "mac" | "windows" | "linux";
  home: string;
  ytdlp: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
  deno: string | null;
  cookiesFile: boolean;
  cookiesBrowser: string | null;
  version: string;
}

export interface Entry {
  path: string;
  name: string;
  dir: boolean;
  size: number;
}

export interface Host {
  info(): Promise<HostInfo>;
  run(req: ProcReq, onLine?: (line: string, err: boolean) => void): Promise<ProcOut>;
  kill(id: string): Promise<void>;
  http(req: { method?: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }>;
  download(url: string, dest: string): Promise<boolean>;
  workDir(id: string): Promise<string>;
  workClear(id: string): Promise<void>;
  list(path: string): Promise<Entry[]>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  size(path: string): Promise<number>;
  move(src: string, dst: string): Promise<string>;
  mkdirs(path: string): Promise<void>;
  trash(path: string): Promise<void>;
  audioFiles(paths: string[], limit?: number): Promise<string[]>;
  reveal(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  addLyrics(mp3: string, text: string): Promise<boolean>;
}

let current: Host | null = null;

export function setHost(h: Host) {
  current = h;
}

export function host(): Host {
  if (!current) throw new Error("Goblin's engine started before its host was set.");
  return current;
}

/** Path joining that works for both / and \ (the host gives back native paths). */
export function join(...parts: string[]): string {
  // Windows paths ("C:\Users\…") keep backslashes; everything else uses "/".
  const sep = (parts[0] ?? "").includes("\\") ? "\\" : "/";
  return parts
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}

export function stem(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

let seq = 0;
/** A short unique id (jobs, processes, work folders). */
export function uid(prefix = "g"): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for full paths: /Users/x, C:\x, C:/x and \\server\share. */
export const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
