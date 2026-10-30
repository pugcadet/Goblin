// The engine's host in the app: every call goes to a checked Rust command (src-tauri/src/host.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Entry, Host, HostInfo, ProcOut, ProcReq } from "./host";

type LineHandler = (line: string, err: boolean) => void;
const handlers = new Map<string, LineHandler>();
let listening: Promise<unknown> | null = null;

function ensureListening() {
  listening ??= listen<{ id: string; err: boolean; line: string }>("proc-line", ({ payload }) => handlers.get(payload.id)?.(payload.line, payload.err));
  return listening;
}

export const tauriHost: Host = {
  info: () => invoke<HostInfo>("host_info"),
  async run(req: ProcReq, onLine?: LineHandler): Promise<ProcOut> {
    if (onLine) {
      await ensureListening();
      handlers.set(req.id, onLine);
    }
    try {
      return await invoke<ProcOut>("proc_run", { req: { ...req, stream: req.stream ?? !!onLine } });
    } finally {
      handlers.delete(req.id);
    }
  },
  kill: (id) => invoke("proc_kill", { id }),
  http: (req) => invoke("http_request", { req }),
  download: (url, dest) => invoke("http_download", { url, dest }),
  workDir: (id) => invoke("work_dir", { id }),
  workClear: (id) => invoke("work_clear", { id }),
  list: (path) => invoke<Entry[]>("fs_list", { path }),
  exists: (path) => invoke("fs_exists", { path }),
  readText: (path) => invoke("fs_read_text", { path }),
  writeText: (path, text) => invoke("fs_write_text", { path, text }),
  size: (path) => invoke("fs_size", { path }),
  move: (src, dst) => invoke("fs_move", { src, dst }),
  mkdirs: (path) => invoke("fs_mkdirs", { path }),
  trash: (path) => invoke("fs_trash", { path }),
  audioFiles: (paths, limit) => invoke("fs_audio_files", { paths, limit }),
  reveal: (path) => invoke("reveal", { path }),
  openUrl: (url) => invoke("open_url", { url }),
  read: (name) => invoke("store_read", { name }),
  write: (name, text) => invoke("store_write", { name, text }),
  remove: (name) => invoke("store_delete", { name }),
  addLyrics: (path, text) => invoke("mp3_add_lyrics", { path, text }),
};
