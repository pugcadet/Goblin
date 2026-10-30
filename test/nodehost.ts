// A Host backed by Node, for running the engine outside the app (tests and checks on a dev machine).
// It mirrors host.rs: yt-dlp gets the same fixed options, paths stay inside the given roots.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Entry, Host, HostInfo, ProcOut } from "../src/engine/host";

export function nodeHost(o: { dataDir: string; library: string; ytdlp: string; ffmpeg: string; ffprobe: string; http?: (url: string, init: RequestInit) => Promise<Response> }): Host {
  const procs = new Map<string, ReturnType<typeof spawn>>();
  const killed = new Set<string>();
  const data = path.join(o.dataDir, "data");
  fs.mkdirSync(data, { recursive: true });
  const tmp = path.join(o.dataDir, "tmp");
  const doFetch = o.http ?? ((u: string, i: RequestInit) => fetch(u, i));
  const AUDIO = ["mp3", "m4a", "flac", "opus", "ogg", "wav", "aac", "alac"];
  return {
    async info(): Promise<HostInfo> {
      return { dataDir: o.dataDir, tmpDir: tmp, library: o.library, platform: "linux", home: o.dataDir, ytdlp: o.ytdlp, ffmpeg: o.ffmpeg, ffprobe: o.ffprobe, deno: null, cookiesFile: false, cookiesBrowser: null, version: "test" };
    },
    run(req, onLine) {
      const bin = req.tool === "yt-dlp" ? o.ytdlp : req.tool === "ffmpeg" ? o.ffmpeg : o.ffprobe;
      const pre = req.tool === "yt-dlp" ? ["--ignore-config", "--no-colors", "--encoding", "utf-8", "--ffmpeg-location", o.ffmpeg] : [];
      return new Promise<ProcOut>((resolve) => {
        const p = spawn(bin, [...pre, ...req.args], { stdio: ["ignore", "pipe", "pipe"] });
        procs.set(req.id, p);
        let out = "", err = "";
        let last = Date.now();
        const lines = (buf: { s: string }, chunk: string, isErr: boolean) => {
          buf.s += chunk;
          let i;
          while ((i = buf.s.indexOf("\n")) >= 0) {
            const l = buf.s.slice(0, i).replace(/\r$/, "");
            buf.s = buf.s.slice(i + 1);
            onLine?.(l, isErr);
          }
        };
        const bo = { s: "" }, be = { s: "" };
        p.stdout!.setEncoding("utf8").on("data", (c: string) => { last = Date.now(); out += c; if (req.stream || onLine) lines(bo, c, false); });
        p.stderr!.setEncoding("utf8").on("data", (c: string) => { last = Date.now(); err += c; if (onLine) lines(be, c, true); });
        let timedOut = false, stalled = false;
        const started = Date.now();
        const t = setInterval(() => {
          if (req.timeoutSec && Date.now() - started > req.timeoutSec * 1000) { timedOut = true; p.kill(); }
          if (req.stallSec && Date.now() - last > req.stallSec * 1000) { stalled = true; p.kill(); }
        }, 200);
        p.on("close", (code) => {
          clearInterval(t);
          procs.delete(req.id);
          resolve({ code, stdout: req.stream ? "" : out, stderr: err.slice(-48000), timedOut, stalled, killed: killed.delete(req.id) });
        });
      });
    },
    async kill(id) { const p = procs.get(id); if (p) { killed.add(id); p.kill(); } },
    async http(req) {
      const r = await doFetch(req.url, { method: req.method ?? "GET", headers: req.headers, body: req.body });
      return { status: r.status, body: await r.text() };
    },
    async download(url, dest) {
      try {
        const r = await doFetch(url, {});
        if (!r.ok) return false;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
        return true;
      } catch { return false; }
    },
    async workDir(id) { const d = path.join(tmp, id); fs.mkdirSync(d, { recursive: true }); return d; },
    async workClear(id) { fs.rmSync(path.join(tmp, id), { recursive: true, force: true }); },
    async list(p): Promise<Entry[]> {
      if (!fs.existsSync(p)) return [];
      return fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ path: path.join(p, e.name), name: e.name, dir: e.isDirectory(), size: e.isFile() ? fs.statSync(path.join(p, e.name)).size : 0 })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async exists(p) { return fs.existsSync(p); },
    async readText(p) { return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; },
    async writeText(p, t) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); },
    async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
    async move(src, dst) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      let target = dst, n = 2;
      const ext = path.extname(dst), base = dst.slice(0, dst.length - ext.length);
      while (fs.existsSync(target)) target = `${base} (${n++})${ext}`;
      fs.renameSync(src, target);
      return target;
    },
    async mkdirs(p) { fs.mkdirSync(p, { recursive: true }); },
    async trash(p) { fs.rmSync(p, { recursive: true, force: true }); },
    async audioFiles(paths, limit = 1000) {
      const out: string[] = [];
      const walk = (p: string) => {
        if (out.length >= limit || path.basename(p).startsWith(".")) return;
        const st = fs.statSync(p);
        if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
        else if (AUDIO.includes(path.extname(p).slice(1).toLowerCase())) out.push(p);
      };
      paths.forEach(walk);
      return out.sort();
    },
    async reveal() {},
    async openUrl() {},
    async read(n) { const f = path.join(data, n); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; },
    async write(n, t) { fs.writeFileSync(path.join(data, n), t); },
    async remove(n) { fs.rmSync(path.join(data, n), { force: true }); },
    async addLyrics() { return false; },
  };
}
