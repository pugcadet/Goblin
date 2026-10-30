// The download queue and pipelines (Downloads.swift): probe → split playlists → video or music pipeline,
// review prompts for uncertain matches, signed-in retries only when YouTube asks for them.
import { basename, dirname, extname, host, join, sleep, stem, uid } from "./host";
import { Candidate, effective, Extra, folderArtist, formatLabel, JobInfo, JobStatus, Options, Preset, TrackMeta, year } from "./model";
import { cleanArtist, parseSong, tagStyle } from "./parse";
import { Deezer, MusicBrainz, syncedLyrics, trackMetaFromRelease } from "./services";
import { countCookieUse, store } from "./store";
import { encode, extFor, measure, prepareCover, replayGainTags } from "./tagger";
import { bytes, eta, fill, folderParts, fsSafe, isWebUrl, similarity, splitArgs, ymd } from "./text";
import * as YTM from "./ytmusic";
import { bestThumbnail, Cancelled, cleanLink, entryURL, errorLine, findOfficialAudio, flat, friendlyStep, globalArgs, GoblinError, isSingleYouTubeVideo, J, needsSignIn, POLITE, probe, videoID } from "./ytdlp";

class Skip extends Error {}

/** Extra facts about where a download came from (playlist expansion, subscription, album finder…). */
export interface Seed {
  titleHint?: string;
  thumb?: string;
  albumHint?: string;
  mb?: Record<string, string>;
  tags?: Record<string, string>;
  subId?: string;
  subName?: string;
  playlistTitle?: string;
  playlistIndex?: number;
}

class Job {
  info: JobInfo;
  log: string[] = [];
  procs = new Set<string>();
  canceled = false;
  useCookies = false; // only after YouTube says this video needs sign-in
  review?: (c: Candidate | null) => void;
  constructor(info: JobInfo) {
    this.info = info;
  }
  get active() {
    return ["working", "downloading", "review"].includes(this.info.status);
  }
  get waiting() {
    return this.info.status === "queued" || this.info.status === "pending";
  }
  /** When this job last started working, for the seconds shown in its log. */
  t0 = 0;
  addLog(s: string) {
    if (!this.t0) this.t0 = Date.now();
    this.log.push(`[${((Date.now() - this.t0) / 1000).toFixed(1).padStart(5)}s] ${s}`);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 300);
  }
  check() {
    if (this.canceled) throw new Cancelled();
  }
  procId() {
    const id = `${this.info.id}-${this.procs.size + 1}`;
    this.procs.add(id);
    return id;
  }
}

const PP: Record<string, string> = {
  Merger: "Merging", FFmpegEmbedSubtitle: "Embedding subtitles", FFmpegExtractAudio: "Converting audio",
  FFmpegSubtitlesConvertor: "Converting subtitles", ModifyChapters: "Removing sponsor segments", EmbedThumbnail: "Embedding artwork",
  FFmpegMetadata: "Writing metadata", FFmpegSplitByChapters: "Splitting chapters", FFmpegVideoRemuxer: "Remuxing", SponsorBlock: "Checking SponsorBlock",
};

type Listener = () => void;

class Manager {
  private list: Job[] = [];
  private byId = new Map<string, Job>();
  private listeners = new Set<Listener>();
  private finishedHooks = new Set<(i: JobInfo) => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseCache = new Map<string, J>();
  private ready = false;
  private snapshotCache: JobInfo[] | null = null;
  // Signed-in downloads: one at a time, at least 30 s apart.
  private cookieHolder: string | null = null;
  private cookieLast = 0;

  // ---------------------------------------------------------------- public API

  async load() {
    const raw = await host().read("history.json");
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as JobInfo[];
      this.set(arr.map((i) => {
        if (["working", "downloading", "review"].includes(i.status)) Object.assign(i, { status: "queued", stage: "Queued", progress: 0 });
        return new Job(i);
      }));
    } catch {
      /* a damaged history file is simply ignored */
    }
    this.changed();
  }

  /** False until yt-dlp is installed (first seconds of the first start). */
  setReady(v: boolean) {
    this.ready = v;
    if (v) this.pump();
  }

  subscribe(f: Listener) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  onFinished(f: (i: JobInfo) => void) {
    this.finishedHooks.add(f);
  }

  /** A stable snapshot for the window (newest first). */
  snapshot(): JobInfo[] {
    if (!this.snapshotCache) this.snapshotCache = this.list.map((j) => j.info);
    return this.snapshotCache;
  }

  activeCount() {
    return this.list.filter((j) => j.active || j.info.status === "queued").length;
  }

  overall(): number | null {
    const act = this.list.filter((j) => j.active || j.info.status === "queued");
    return act.length ? act.reduce((a, j) => a + j.info.progress, 0) / act.length : null;
  }

  /** One job per non-empty line. */
  add(text: string, options: Options, seed: Seed = {}): JobInfo[] {
    const [preset, extra] = effective(store.presets, store.settings, options);
    const inputs = text.split(/\r?\n/).map((l) => cleanLink(l.trim())).filter(Boolean);
    const added: JobInfo[] = [];
    for (const input of inputs) {
      if (this.list.some((j) => j.info.input === input && j.info.presetId === preset.id && (j.active || j.waiting))) continue;
      const vid = videoID(input);
      const i: JobInfo = {
        id: uid("j"), input, presetId: preset.id, presetName: preset.name, kind: preset.kind, options: { ...options, presetId: preset.id },
        title: seed.titleHint ?? input, thumbnail: seed.thumb ?? (vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : undefined),
        status: extra.autoStart ? "queued" : "pending", stage: extra.autoStart ? "Queued" : "Pending · press Start", progress: 0, added: Date.now(),
        albumHint: seed.albumHint, mb: seed.mb, tags: seed.tags, subId: seed.subId, subName: seed.subName,
        playlistTitle: seed.playlistTitle, playlistIndex: seed.playlistIndex, formatLabel: formatLabel(preset),
      };
      this.set([new Job(i), ...this.list]);
      added.push(i);
    }
    this.changed(true);
    this.pump();
    return added;
  }

  start(ids: string[]) {
    for (const j of this.list) if (ids.includes(j.info.id) && j.info.status === "pending") this.update(j, { status: "queued", stage: "Queued" });
    this.pump();
  }

  cancel(ids: string[]) {
    for (const id of ids) {
      const j = this.byId.get(id);
      if (!j || !(j.active || j.waiting)) continue;
      j.canceled = true;
      for (const p of j.procs) void host().kill(p);
      j.review?.(null);
      j.review = undefined;
      this.finish(j, "canceled", "Canceled"); // immediately, whatever step it was in
    }
  }

  cancelAll() {
    this.cancel(this.list.filter((j) => j.active || j.waiting).map((j) => j.info.id));
  }

  retry(ids: string[]) {
    for (const id of ids) {
      const j = this.byId.get(id);
      if (!j || j.active || j.waiting) continue;
      const i = j.info;
      this.set(this.list.filter((x) => x.info.id !== id));
      this.add(i.input, i.options, {
        titleHint: i.title, thumb: i.thumbnail, albumHint: i.albumHint, mb: i.mb, tags: i.tags,
        subId: i.subId, subName: i.subName, playlistTitle: i.playlistTitle, playlistIndex: i.playlistIndex,
      });
    }
  }

  async remove(ids: string[], deleteFiles: boolean) {
    this.cancel(ids);
    if (deleteFiles || store.settings.deleteFileOnRemove) {
      for (const j of this.list) if (ids.includes(j.info.id) && j.info.finalPath) await host().trash(j.info.finalPath).catch(() => undefined);
    }
    this.set(this.list.filter((j) => !ids.includes(j.info.id)));
    this.changed(true);
  }

  /** "Clear" never deletes files. */
  clear(which: "done" | "failed" | "all") {
    this.set(this.list.filter((j) => {
      const s = j.info.status;
      if (which === "done") return !(s === "done" || s === "skipped");
      if (which === "failed") return !(s === "error" || s === "canceled");
      return j.active || j.waiting;
    }));
    this.changed(true);
  }

  autoClear() {
    const secs = Number(store.settings.clearCompletedAfter);
    if (!secs) return;
    const cutoff = Date.now() - secs * 1000;
    const before = this.list.length;
    this.set(this.list.filter((j) => !((j.info.status === "done" || j.info.status === "skipped") && (j.info.finished ?? Date.now()) < cutoff)));
    if (this.list.length !== before) this.changed(true);
  }

  exportURLs(): string {
    return [...this.list].reverse().map((j) => j.info.url ?? j.info.input).join("\n");
  }

  resolveReview(id: string, c: Candidate | null) {
    const j = this.byId.get(id);
    const r = j?.review;
    if (!j || !r) return;
    j.review = undefined;
    r(c);
  }

  /** Manual search from a review panel. */
  async reviewSearch(id: string, q: string): Promise<Candidate[]> {
    const j = this.byId.get(id);
    if (!j || !q.trim()) return [];
    const p = parseSong(q.trim());
    return MusicBrainz.search(p.artist, p.title, undefined, undefined).catch(() => []);
  }

  log(id: string): string[] {
    return this.byId.get(id)?.log ?? [];
  }

  // ---------------------------------------------------------------- internals

  private set(list: Job[]) {
    this.list = list;
    this.byId = new Map(list.map((j) => [j.info.id, j]));
  }

  /** Window updates at most ~5 times a second, however chatty yt-dlp is. */
  private changed(save = false) {
    this.snapshotCache = null;
    if (save) this.scheduleSave();
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.listeners.forEach((f) => f());
    }, 200);
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 1000);
  }

  async saveNow() {
    await host().write("history.json", JSON.stringify(this.list.slice(0, 1000).map((j) => ({ ...j.info, candidates: undefined })))).catch(() => undefined);
  }

  private update(j: Job, patch: Partial<JobInfo> | ((i: JobInfo) => Partial<JobInfo>)) {
    if (j.canceled && j.info.status === "canceled") return; // late updates from a step that was still running
    const p = typeof patch === "function" ? patch(j.info) : patch;
    j.info = { ...j.info, ...p };
    this.changed();
  }

  private pump() {
    if (!this.ready) return;
    const limit = Math.max(1, Math.min(8, store.settings.concurrency));
    let running = this.list.filter((j) => j.active && j.info.status !== "review").length;
    for (const j of [...this.list].reverse()) {
      if (running >= limit) break;
      if (j.info.status !== "queued") continue;
      running++;
      j.canceled = false;
      j.t0 = Date.now();
      this.update(j, { status: "working", stage: "Starting" });
      void this.run(j);
    }
  }

  private finish(j: Job, status: JobStatus, stage: string, error?: string) {
    if (this.cookieHolder === j.info.id) this.cookieHolder = null;
    // A canceled job stays canceled, even if the step it was in finishes a moment later.
    if (j.canceled && status !== "canceled") return;
    if (j.canceled && j.info.status === "canceled") return;
    this.update(j, (i) => ({
      status, stage, error, finished: Date.now(), speed: undefined, eta: undefined, candidates: undefined,
      progress: status === "done" || status === "skipped" ? 1 : i.progress,
    }));
    this.changed(true);
    this.pump();
    if (status === "done") this.finishedHooks.forEach((f) => f(j.info));
  }

  private async run(j: Job) {
    const work = await host().workDir(j.info.id);
    const [preset, extra] = effective(store.presets, store.settings, j.info.options);
    try {
      if (preset.kind === "music") await this.runMusic(j, preset, extra, work);
      else await this.runVideo(j, preset, extra, work);
    } catch (e) {
      if (e instanceof Cancelled || j.canceled) this.finish(j, "canceled", "Canceled");
      else if (e instanceof Skip) this.finish(j, "skipped", e.message);
      else {
        const msg = e instanceof Error ? e.message : String(e);
        j.addLog("ERROR: " + msg);
        this.finish(j, "error", "Failed", msg);
      }
    } finally {
      await host().workClear(j.info.id).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- signed-in retries

  private cookiesAvailable() {
    const i = store.info;
    return !!(i?.cookiesFile || i?.cookiesBrowser);
  }

  /** Waits for the single signed-in slot (cancellable), checks the daily cap, then marks the job as signed-in. */
  private async acquireCookies(j: Job) {
    if (!this.cookiesAvailable()) throw new GoblinError("This video needs a signed-in YouTube account. Set one up under Settings → YouTube sign-in.");
    for (;;) {
      j.check();
      const wait = 30_000 - (Date.now() - this.cookieLast);
      if (!this.cookieHolder && wait <= 0) break;
      this.update(j, { stage: this.cookieHolder ? "Age-restricted · waiting for another signed-in download" : `Age-restricted · waiting ${Math.ceil(wait / 1000)}s (protects your account)` });
      await sleep(1000);
    }
    const cap = await countCookieUse();
    if (!cap.ok) throw new GoblinError(`Signed-in limit for today reached (${cap.cap}). This protects your account; change it in Settings → YouTube sign-in.`);
    this.cookieHolder = j.info.id;
    this.cookieLast = Date.now();
    j.useCookies = true;
  }

  // ---------------------------------------------------------------- reading links

  /** Probes the input; playlists and channels become one job per entry. */
  private async probe(j: Job, p: Preset, x: Extra, input: string, work: string): Promise<[J, string]> {
    this.update(j, { stage: "Reading link" });
    const limit = x.itemsLimit > 0 ? x.itemsLimit : store.settings.playlistItemLimit;
    const read = () =>
      probe(input, {
        playlist: p.allowPlaylists, limit, cookies: j.useCookies, procId: j.procId(),
        onLine: (line) => {
          j.addLog(line);
          const step = friendlyStep(line);
          if (step && j.info.stage.startsWith("Reading link")) this.update(j, { stage: `Reading link · ${step}` });
        },
      });
    let info: J;
    try {
      info = await read();
    } catch (e) {
      if (!(e instanceof GoblinError) || j.useCookies || !needsSignIn(e.message) || !this.cookiesAvailable()) throw e;
      // Age-restricted / members-only: retry this one video signed in.
      j.addLog(`YouTube needs sign-in for this video (${e.message}). Retrying signed in.`);
      await this.acquireCookies(j);
      this.update(j, { stage: "Reading link · signed in" });
      info = await read();
    }
    j.check();
    if (info._type === "playlist") {
      const entries: J[] = info.entries ?? [];
      if (!entries.length) throw new GoblinError("Playlist is empty");
      const ptitle: string | undefined = info.title;
      const album: string | undefined = info.album ?? (p.kind === "music" ? ptitle?.replace("Album - ", "") : undefined);
      entries.forEach((e, n) => {
        const url = entryURL(e);
        if (!url) return;
        this.add(url, { ...j.info.options, playlistIndex: n + 1 }, {
          titleHint: e.title, thumb: (e.thumbnails as J[])?.slice(-1)[0]?.url, albumHint: album,
          subId: j.info.subId, subName: j.info.subName, playlistTitle: ptitle, playlistIndex: n + 1,
        });
      });
      throw new Skip(`Split into ${entries.length} downloads`);
    }
    const infoPath = join(work, "info.json");
    await host().writeText(infoPath, JSON.stringify(info));
    this.update(j, (i) => ({ title: info.title ?? i.title, thumbnail: bestThumbnail(info) ?? i.thumbnail, url: info.webpage_url ?? i.url ?? i.input, live: !!info.is_live }));
    return [info, infoPath];
  }

  private commonArgs(p: Preset, x: Extra): string[] {
    const a: string[] = [];
    if (x.clipStart.trim() || x.clipEnd.trim()) a.push("--download-sections", `*${x.clipStart.trim() || "0"}-${x.clipEnd.trim() || "inf"}`);
    if (x.password) a.push("--video-password", x.password);
    a.push(...globalArgs(), ...splitArgs(p.ytdlpArgs));
    return a;
  }

  /** Runs the actual yt-dlp download and returns the file it produced. */
  private async download(j: Job, extraArgs: string[], infoJSON: string | null, input: string, work: string): Promise<string> {
    this.update(j, (i) => ({ status: "downloading", stage: i.live ? "Recording live stream" : infoJSON ? "Downloading" : "Reading link", progress: 0 }));
    const s = store.settings;
    const args = [
      ...(j.useCookies ? POLITE : []),
      "--newline", "--progress", "--no-mtime",
      "-N", String(Math.max(1, Math.min(j.useCookies ? 4 : 16, s.fragments))),
      "-o", join(work, "media.%(ext)s"), "-o", "subtitle:" + join(work, "media.%(ext)s"), "-o", "thumbnail:" + join(work, "thumb.%(ext)s"),
      "--progress-template", "download:[goblin] %(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
      "--progress-template", "postprocess:[goblinpp] %(progress.postprocessor)s|%(progress.status)s",
      "--print", "after_move:[goblinfile] %(filepath)s",
    ];
    if (s.useArchive && store.info) args.push("--download-archive", join(store.info.dataDir, "data", "archive.txt"));
    args.push(...extraArgs);
    const usedInfo = !!infoJSON && (await host().exists(infoJSON));
    const tail = usedInfo ? ["--load-info-json", infoJSON!] : ["--no-playlist", "--", input];
    let r = await this.runYtDlp(j, [...args, ...tail]);
    j.check();
    if (r.file) return r.file;
    if (!j.useCookies && needsSignIn(r.error) && this.cookiesAvailable()) {
      j.addLog(`YouTube needs sign-in for this video (${r.error}). Retrying signed in.`);
      await this.acquireCookies(j);
      return this.download(j, extraArgs, null, input, work);
    }
    if (usedInfo) {
      // Cached info can go stale (expired stream addresses): retry once from the link itself.
      j.addLog("Retrying without cached info");
      r = await this.runYtDlp(j, [...args, "--no-playlist", "--", input]);
      j.check();
      if (r.file) return r.file;
    }
    throw new GoblinError(r.error);
  }

  private async runYtDlp(j: Job, args: string[]): Promise<{ file?: string; error: string }> {
    let file: string | undefined;
    const r = await host().run(
      { id: j.procId(), tool: "yt-dlp", args, stream: true, stallSec: j.info.live ? 0 : 900, cookies: j.useCookies },
      (line) => {
        if (line.startsWith("[goblinfile] ")) file = line.slice(13).trim();
        else this.handleLine(j, line);
      },
    );
    if (r.killed) throw new Cancelled();
    if (file && (await host().exists(file))) return { file, error: "" };
    if (r.stalled) return { error: "The download stopped moving for 15 minutes." };
    if (r.code === 0 && store.settings.useArchive && !r.stderr.includes("ERROR")) throw new Skip("Already downloaded before (archive)");
    return { error: errorLine(r.stderr) ?? `yt-dlp stopped with code ${r.code}` };
  }

  private handleLine(j: Job, line: string) {
    if (line.startsWith("[goblin] ")) {
      const p = line.slice(9).split("|").map((v) => {
        const n = Number(v);
        return v !== "NA" && v !== "None" && isFinite(n) ? n : null;
      });
      if (p.length < 5) return;
      const done = p[0] ?? 0;
      const total = p[1] ?? p[2];
      this.update(j, (i) => ({
        progress: total && total > 0 ? Math.min(0.99, done / total) : i.progress,
        speed: p[3] ? `${bytes(p[3])}/s` : undefined,
        eta: i.live ? "live" : eta(p[4]),
        size: bytes(total ?? (i.live ? done : null)) || i.size,
      }));
      return;
    }
    if (line.startsWith("[goblininfo] ")) {
      const f = line.slice(13).split("\t");
      this.update(j, (i) => ({
        title: f[0] && f[0] !== "NA" ? f[0] : i.title,
        thumbnail: f[1]?.startsWith("http") ? f[1] : i.thumbnail,
        url: f[2]?.startsWith("http") ? f[2] : i.url,
        stage: i.live ? i.stage : "Downloading",
      }));
      return;
    }
    if (line.startsWith("[goblinpp] ")) {
      const parts = line.slice(11).split("|");
      if (parts[parts.length - 1] === "started") this.update(j, { stage: PP[parts[0]] ?? "Processing", speed: undefined, eta: undefined });
      return;
    }
    j.addLog(line);
  }

  // ---------------------------------------------------------------- video

  private async runVideo(j: Job, p: Preset, x: Extra, work: string) {
    let input = j.info.input;
    if (!isWebUrl(input)) input = "ytsearch1:" + input;
    // Fast path: one YouTube video needs nothing up front, so yt-dlp reads the link and downloads in ONE run.
    const fast = isSingleYouTubeVideo(input, p.allowPlaylists) && p.metaMode === "youtube" && !p.splitChapters;
    let info: J = {};
    let infoPath = join(work, "info.json");
    let plan: Plan | null = null;
    if (!fast) {
      [info, infoPath] = await this.probe(j, p, x, input, work);
      plan = this.planVideo(j, p, x, info);
    }
    j.check();
    // Subtitles are embedded whenever possible: "any" format becomes MKV so .srt can go inside.
    const ext = p.container === "any" ? (p.subtitles ? "mkv" : null) : p.container;
    if (plan?.base && ext) {
      const out = join(plan.dir, `${plan.base}.${ext}`);
      if (await host().exists(out)) {
        this.update(j, { finalPath: out });
        throw new Skip("Already in your library");
      }
    }
    const sort: string[] = [];
    if (p.quality !== "best") sort.push(`res:${p.quality}`);
    const codec = ({ h264: "vcodec:h264", h265: "vcodec:h265", av1: "vcodec:av01", vp9: "vcodec:vp9" } as Record<string, string>)[p.codec];
    if (codec) sort.push(codec);
    if (ext === "mp4") sort.push("ext:mp4:m4a");
    const args = ["-f", "bv*+ba/b", "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg"];
    if (ext) args.push("--merge-output-format", ext, "--remux-video", ext);
    if (sort.length) args.push("-S", sort.join(","));
    if (p.embedChapters) args.push("--embed-chapters");
    const subArgs: string[] = [];
    if (p.subtitles) {
      // "en.*" matches many near-identical English tracks, one request each: that's what makes YouTube answer 429.
      const langs = !p.subLangs || p.subLangs === "en.*,en" ? "en,en-US,en-GB" : p.subLangs;
      subArgs.push("--sub-langs", langs + ",-live_chat", "--convert-subs", "srt", "--sleep-subtitles", "2");
      subArgs.push(...(p.capSource === "manual" ? ["--write-subs"] : p.capSource === "auto" ? ["--write-auto-subs"] : ["--write-subs", "--write-auto-subs"]));
      subArgs.push("--embed-subs"); // inside the video; the .srt files stay in the work folder
    }
    args.push(...subArgs);
    if (p.sponsorBlock) args.push("--sponsorblock-remove", p.sponsorCats || "sponsor");
    if (p.splitChapters && (info.chapters as J[] | undefined)?.length) {
      const tmpl = x.chapterTemplate || store.settings.outputTemplateChapter || "%(section_number)02d - %(section_title)s.%(ext)s";
      args.push("--split-chapters", "-o", "chapter:" + join(work, "chapters", tmpl));
    }
    if (plan?.template) args.push("-o", join(work, "out", plan.template));
    if (fast) args.push("--write-info-json", "-o", "infojson:" + join(work, "fast"), "--print", "before_dl:[goblininfo] %(title)s\t%(thumbnail)s\t%(webpage_url)s");
    args.push(...this.commonArgs(p, x));

    let noSubs = false;
    let file: string;
    try {
      file = await this.download(j, args, fast ? null : infoPath, input, work);
    } catch (e) {
      const m = e instanceof Error ? e.message.toLowerCase() : "";
      if (!subArgs.length || !(m.includes("subtitle") && (m.includes("429") || m.includes("too many requests")))) throw e;
      // YouTube rate-limited the subtitles: don't lose the video over it.
      j.addLog("YouTube rate-limited the subtitles (429). Retrying without subtitles.");
      this.update(j, { stage: "Subtitles rate-limited · retrying without them" });
      await sleep(3000);
      j.check();
      const at = args.indexOf(subArgs[0]);
      const retry = at >= 0 ? [...args.slice(0, at), ...args.slice(at + subArgs.length)] : args;
      file = await this.download(j, retry, fast ? null : infoPath, input, work);
      noSubs = true;
    }
    this.update(j, { status: "working", stage: "Moving to your library", speed: undefined, eta: undefined });
    if (!plan) {
      const txt = await host().readText(join(work, "fast.info.json"));
      try {
        info = txt ? JSON.parse(txt) : {};
      } catch {
        info = {};
      }
      const made = this.planVideo(j, p, x, info);
      if (made.base) {
        const out = join(made.dir, `${made.base}.${extname(file)}`);
        if (await host().exists(out)) {
          this.update(j, { finalPath: out });
          throw new Skip("Already in your library");
        }
      }
      plan = made;
    }
    const outRoot = join(work, "out");
    let target: string;
    if (plan.template && file.startsWith(outRoot)) target = join(plan.dir, file.slice(outRoot.length));
    else target = join(plan.dir, `${plan.base ?? `${fsSafe(info.title ?? "video")} [${info.id ?? ""}]`}.${extname(file)}`);
    if (x.prefix) target = join(dirname(target), fsSafe(x.prefix + basename(target)));
    const final = await host().move(file, target);

    // Chapter files go in a folder next to the video.
    let chapters: string[] | undefined;
    const chapFiles = (await host().list(join(work, "chapters")).catch(() => [])).filter((e) => !e.dir);
    if (chapFiles.length) {
      const dest = join(dirname(final), `${stem(final)} - chapters`);
      chapters = [];
      for (const f of chapFiles) chapters.push(basename(await host().move(f.path, join(dest, f.name))));
    }
    const labels = await videoLabels(final);
    const size = await host().size(final).catch(() => 0);
    this.update(j, (i) => ({ finalPath: final, chapters, qualityLabel: labels[0], formatShort: labels[1], size: bytes(size) || i.size }));
    const saved = plan.label ? `Saved as ${plan.label}` : "Saved";
    this.finish(j, "done", noSubs ? saved + " · no subtitles (YouTube rate limit)" : saved);
  }

  private planVideo(j: Job, p: Preset, x: Extra, info: J): Plan {
    const s = store.settings;
    const override = x.folder || p.outputDir || null;
    const title: string = info.title ?? j.info.title;
    const id: string = info.id ?? "";
    if (p.metaMode === "youtube") {
      const channel = fsSafe(info.channel ?? info.uploader ?? "Unknown channel");
      const date = ymd(info.upload_date);
      const vals = {
        channel, title, date, year: date.slice(0, 4), id, uploader: info.uploader ?? channel, playlist: j.info.playlistTitle ?? "",
        index: j.info.playlistIndex ? String(j.info.playlistIndex).padStart(2, "0") : "",
      };
      const name = fill(s.videoName, vals, "{title}");
      const dir = join(override ?? store.dir(s.dirYoutube), ...folderParts(s.youtubeFolder, { channel, year: date.slice(0, 4), playlist: j.info.playlistTitle ?? "", uploader: info.uploader ?? channel }, "{channel}"));
      return { dir, base: name, label: [channel, date].filter(Boolean).join(" / ") };
    }
    // Keep the original title, optionally through your own yt-dlp template.
    let tmpl = "";
    if (p.fileTemplate) tmpl = p.fileTemplate;
    else if (j.info.playlistTitle && s.outputTemplatePlaylist) tmpl = s.outputTemplatePlaylist;
    else if (info.channel_url && info.channel_url === j.info.input && s.outputTemplateChannel) tmpl = s.outputTemplateChannel;
    else if (s.outputTemplate) tmpl = s.outputTemplate;
    const dir = override ?? store.dir(s.dirOther);
    if (!tmpl) return { dir, base: `${fsSafe(title)} [${id}]` };
    return { dir, template: fillPlaylistFields(tmpl, j.info) };
  }

  // ---------------------------------------------------------------- music & podcasts

  private async runMusic(j: Job, p: Preset, x: Extra, work: string) {
    const s = store.settings;
    let input = j.info.input;
    let info: J | undefined;
    let infoPath: string | undefined;
    let meta: TrackMeta = { title: "", artist: "", ids: {}, coverURLs: [] };
    let square = false;
    const root = x.folder || p.outputDir || store.dir(p.podcast ? s.dirPodcasts : s.dirMusic);
    const ext = extFor(p.audioFormat);
    const t = j.info.tags;

    if (t && t.source === "ytmusic") {
      // YouTube Music search/album: exactly this track, tagged from YouTube Music. No lookups, no swaps, one yt-dlp run.
      meta = {
        title: t.title || "Unknown", artist: t.artist || "Unknown Artist", album: t.album, albumArtist: t.albumArtist,
        track: num(t.track), trackTotal: num(t.trackTotal), date: t.date || undefined, lengthSec: num(t.length), ids: {}, coverURLs: [],
      };
      if (t.cover) meta.coverURLs = [t.cover];
      else square = true; // crop the video thumbnail
      this.update(j, { title: `${meta.artist} – ${meta.title}`, matchLabel: "YouTube Music" + (meta.album ? ` · ${meta.album}` : ""), url: input });
    } else if (t && t.title && t.artist) {
      // From the album finder or a Deezer search: tags are decided; only MusicBrainz ids are added.
      meta = {
        title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist, date: t.date, track: num(t.track), trackTotal: num(t.trackTotal),
        disc: num(t.disc), discTotal: num(t.discTotal), genre: t.genre, label: t.label, isrc: t.isrc, lengthSec: num(t.length), ids: {}, coverURLs: t.cover ? [t.cover] : [],
      };
      if (meta.track == null && t.dzAlbum) {
        this.update(j, { stage: "Album details" });
        try {
          const [a, list] = await Promise.all([Deezer.album(t.dzAlbum), Deezer.albumTracks(t.dzAlbum)]);
          let idx = list.findIndex((tr) => String(tr.title ?? "").toLowerCase() === t.title.toLowerCase());
          if (idx < 0) list.forEach((tr, k) => { if (idx < 0 || similarity(tr.title ?? "", t.title) > similarity(list[idx].title ?? "", t.title)) idx = k; });
          const tr = list[idx];
          if (tr) {
            meta.albumArtist = a.artist?.name ?? meta.artist;
            meta.date = a.release_date;
            meta.track = tr.track_position ?? idx + 1;
            meta.trackTotal = list.length;
            meta.disc = tr.disk_number;
            meta.discTotal = Math.max(...list.map((x) => x.disk_number ?? 1));
            meta.genre = a.genres?.data?.[0]?.name;
            meta.label = a.label;
            meta.isrc = tr.isrc ?? meta.isrc;
          }
        } catch {
          /* tags without album details */
        }
      }
      if (p.musicbrainz && meta.isrc) {
        this.update(j, { stage: "MusicBrainz IDs" });
        meta.ids = await MusicBrainz.ids(meta.isrc, meta.album);
      }
      this.update(j, { title: `${meta.artist} – ${meta.title}`, matchLabel: `Deezer · ${meta.album ?? meta.title}` });
      if (!isWebUrl(input)) {
        this.update(j, { stage: "Finding official audio" });
        const found = await findOfficialAudio(meta.artist, meta.title, meta.lengthSec, meta.isrc);
        if (!found) throw new GoblinError(`No official audio found on YouTube Music for “${meta.artist} – ${meta.title}”`);
        input = found.url;
      }
      j.check();
      this.update(j, { url: input });
    } else if (j.info.mb?.release && j.info.mb?.recording) {
      // From the MusicBrainz album finder: tags are decided, the link is already the right track.
      this.update(j, { stage: "Album details" });
      const rel = this.releaseCache.get(j.info.mb.release) ?? (await MusicBrainz.release(j.info.mb.release));
      this.releaseCache.set(j.info.mb.release, rel);
      const m = trackMetaFromRelease(rel, j.info.mb.recording);
      if (!m) throw new GoblinError("Track missing from release");
      meta = m;
      if (j.info.mb.cover) meta.coverURLs.unshift(j.info.mb.cover);
      this.update(j, { title: `${meta.artist} – ${meta.title}`, matchLabel: `MusicBrainz · ${meta.album ?? ""}`, url: input });
    } else {
      let parsed: { artist?: string; title: string };
      let duration: number | undefined;
      if (isWebUrl(input)) {
        [info, infoPath] = await this.probe(j, p, x, input, work);
        const channel: string | undefined = info.channel ?? info.uploader;
        parsed = info.track ? { artist: info.artists?.[0] ?? info.artist ?? (channel ? cleanArtist(channel) : undefined), title: info.track } : parseSong(info.title ?? "", channel);
        duration = info.duration;
      } else {
        parsed = parseSong(input);
        this.update(j, { title: input });
      }
      j.check();

      if (p.podcast && info) {
        const show: string = info.playlist_title ?? j.info.playlistTitle ?? info.series ?? info.channel ?? info.uploader ?? "Podcast";
        const date = ymd(info.upload_date) || undefined;
        meta = {
          title: info.title ?? parsed.title, artist: info.uploader ?? info.channel ?? show, album: show, date: date ?? info.release_year?.toString(),
          genre: "Podcast", track: j.info.playlistIndex, ids: {}, coverURLs: [],
        };
        meta.albumArtist = meta.artist;
        const target = join(root, fsSafe(show), fsSafe([date, fsSafe(meta.title)].filter(Boolean).join(" - ")) + "." + ext);
        return this.finishMusic(j, p, x, work, meta, info, infoPath, input, target, true, root);
      }

      meta = {
        title: parsed.title, artist: parsed.artist ?? "Unknown Artist", album: info?.album ?? j.info.albumHint,
        date: info?.release_year?.toString() ?? info?.release_date?.slice(0, 4), track: info?.track_number, ids: {}, coverURLs: [],
      };
      // YouTube Music already knows track/artist/album for official uploads: use that, skip MusicBrainz.
      const hasYTMTags = !!(info?.track && info?.album);
      if (hasYTMTags) this.update(j, { matchLabel: `YouTube Music · ${meta.album ?? ""}` });
      if (p.musicbrainz && !hasYTMTags) {
        this.update(j, { stage: "Looking up MusicBrainz" });
        const cands = await MusicBrainz.search(parsed.artist, parsed.title, duration, meta.album).catch(() => [] as Candidate[]);
        j.check();
        const pick = await this.choose(j, cands, [parsed.artist, parsed.title].filter(Boolean).join(" - "));
        if (pick?.meta.recording) {
          try {
            meta = await MusicBrainz.trackMeta(pick.meta.recording, pick.meta.release || undefined);
            this.update(j, { matchLabel: "MusicBrainz · " + (meta.album ?? meta.title) + (year(meta) ? ` (${year(meta)})` : "") });
          } catch (e) {
            j.addLog(`MusicBrainz details failed: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
      j.check();
      this.update(j, { title: `${meta.artist} – ${meta.title}` });
      // A pasted link is downloaded exactly as pasted. Only typed text ("Artist - Song") is looked up.
      if (!isWebUrl(input)) {
        this.update(j, { stage: "Searching YouTube Music" });
        const top = (await YTM.searchSongs(j.info.input).catch(() => [] as YTM.YTMItem[]))[0];
        if (top?.videoId) {
          input = `https://music.youtube.com/watch?v=${top.videoId}`;
          if (top.title) meta.title = top.title;
          if (top.artist) meta.artist = top.artist;
          if (!meta.album && top.album) meta.album = top.album;
          if (top.thumb && !meta.coverURLs.length) meta.coverURLs = [top.thumb];
        } else {
          const r = await flat(`https://music.youtube.com/search?q=${encodeURIComponent(j.info.input)}#songs`, 1, false, j.procId());
          const id = r.entries?.[0]?.id;
          if (!id) throw new GoblinError(`Nothing found for “${j.info.input}”`);
          input = `https://music.youtube.com/watch?v=${id}`;
        }
        this.update(j, { title: `${meta.artist} – ${meta.title}` });
      }
      this.update(j, { url: input });
    }

    meta = tagStyle(meta, p); // Presets → Tags
    if (!meta.album) meta.album = meta.title; // singles group nicely this way
    if (meta.albumArtist == null) meta.albumArtist = meta.artist;
    const target = musicPath(root, meta, ext, p.albumFolders, s.trackName);
    return this.finishMusic(j, p, x, work, meta, info, infoPath, input, target, square, root);
  }

  /** Download the best audio once, then one ffmpeg pass per output file: cut → loudness → encode → tags → cover. */
  private async finishMusic(j: Job, p: Preset, x: Extra, work: string, meta: TrackMeta, info: J | undefined, infoPath: string | undefined, input: string, target: string, square: boolean, root: string) {
    const s = store.settings;
    const chapters: J[] = info?.chapters ?? [];
    const split = p.splitChapters && chapters.length > 1 && !p.podcast;
    if (!split && (await host().exists(target))) {
      this.update(j, { finalPath: target });
      throw new Skip("Already in your library");
    }
    const args = ["-f", p.audioFormat === "m4a" ? "bestaudio[ext=m4a]/bestaudio/best" : "bestaudio/best", "--write-thumbnail", "--convert-thumbnails", "jpg", ...this.commonArgs(p, x)];
    const raw = await this.download(j, args, infoPath ?? null, input, work);
    this.update(j, { status: "working", stage: "Album art", speed: undefined, eta: undefined, progress: 0.99 });

    let cover: string | null = null;
    if (p.embedCover) {
      const rawCover = join(work, "cover-src.img");
      for (const u of meta.coverURLs) {
        if (!(await host().download(u, rawCover))) continue;
        // YouTube video thumbnails are 16:9 with the cover in the middle: crop them square.
        cover = await prepareCover(rawCover, square || u.includes("ytimg.com"), join(work, "cover.jpg"));
        if (cover) break;
      }
      if (!cover) {
        const thumb = (await host().list(work)).find((e) => e.name.startsWith("thumb."));
        if (thumb) cover = await prepareCover(thumb.path, true, join(work, "cover.jpg"));
      }
    }
    const loud = p.loudness || s.loudness;
    const fmt = p.audioFormat;
    const outputs: string[] = [];
    if (split) {
      for (let n = 0; n < chapters.length; n++) {
        j.check();
        const ch = chapters[n];
        let m: TrackMeta = { ...meta, ids: {}, coverURLs: meta.coverURLs };
        m.title = parseSong(ch.title ?? `Track ${n + 1}`).title;
        m.track = n + 1;
        m.trackTotal = chapters.length;
        if (meta.album === meta.title && info?.title) m.album = parseSong(info.title).title;
        m = tagStyle(m, p);
        this.update(j, { stage: `Track ${n + 1} of ${chapters.length}` });
        let extra: Record<string, string> = {};
        if (loud === "replaygain") {
          const mm = await measure(raw, ch.start_time, ch.end_time);
          if (mm) extra = replayGainTags(mm);
        }
        const out = musicPath(root, m, extname(target), p.albumFolders, s.trackName);
        const tmp = join(work, `track${n}.${extname(target)}`);
        await encode({ input: raw, output: tmp, format: fmt, quality: p.audioQuality, normalize: loud === "normalize", meta: m, extraTags: extra, cover, start: ch.start_time, end: ch.end_time, id3: p.tagId3, procId: j.procId() });
        outputs.push(await host().move(tmp, out));
      }
    } else {
      this.update(j, { stage: loud === "normalize" ? "Normalizing + tagging" : "Tagging" });
      // Lyrics are looked up while ffmpeg measures loudness; they go inside the file, never as a separate .lrc.
      const want = p.lyrics && s.lyrics && !p.podcast;
      const lyricsTask = want ? syncedLyrics(meta.artist, meta.title, meta.album, meta.lengthSec ?? info?.duration) : Promise.resolve(null);
      let extra: Record<string, string> = {};
      if (loud === "replaygain") {
        const mm = await measure(raw);
        if (mm) extra = replayGainTags(mm);
      }
      const lyrics = await lyricsTask;
      if (lyrics && fmt !== "mp3") extra = { ...extra, lyrics };
      const tmp = join(work, `tagged.${extname(target)}`);
      await encode({ input: raw, output: tmp, format: fmt, quality: p.audioQuality, normalize: loud === "normalize", meta, extraTags: extra, cover, keepChapters: p.podcast, id3: p.tagId3, procId: j.procId() });
      if (lyrics && fmt === "mp3") await host().addLyrics(tmp, lyrics);
      outputs.push(await host().move(tmp, target));
    }
    if (!outputs.length) throw new GoblinError("Nothing was saved");
    const q = fmt === "mp3" ? (p.audioQuality.startsWith("V") ? p.audioQuality : `${p.audioQuality} kbps`) : ["flac", "wav"].includes(fmt) ? "Lossless" : "Original stream";
    let total = 0;
    for (const o of outputs) total += await host().size(o).catch(() => 0);
    this.update(j, (i) => ({
      finalPath: split ? dirname(outputs[0]) : outputs[0],
      chapters: split ? outputs.map(basename) : undefined,
      qualityLabel: q,
      formatShort: fmt.toUpperCase(),
      thumbnail: i.thumbnail ?? meta.coverURLs[0],
      size: bytes(total) || i.size,
    }));
    const where = p.podcast ? meta.album ?? "Podcasts" : `${folderArtist(meta)} / ${meta.album ?? meta.title}`;
    this.finish(j, "done", split ? `Split into ${outputs.length} tracks · ${where}` : `Saved to ${where}`);
  }

  /** Picks the best candidate, or asks when confidence is low. */
  private async choose(j: Job, cands: Candidate[], query: string): Promise<Candidate | null> {
    const s = store.settings;
    const top = cands[0];
    if (top && (top.score >= s.reviewThreshold || !s.askOnLowConfidence)) {
      this.update(j, { matchLabel: `MusicBrainz · ${top.title}`, confidence: top.score });
      return top;
    }
    if (!cands.length && !s.askOnLowConfidence) return null;
    this.update(j, { status: "review", stage: cands.length ? "Check the match" : `No match for “${query}”. Search or skip.`, candidates: cands, speed: undefined, eta: undefined });
    this.pump(); // a job waiting for you doesn't hold up the queue
    const picked = await new Promise<Candidate | null>((r) => (j.review = r));
    j.check();
    this.update(j, { status: "working", candidates: undefined, stage: picked ? "Matched" : "Using original title", ...(picked ? { matchLabel: `MusicBrainz · ${picked.title}`, confidence: 1 } : {}) });
    return picked;
  }
}

interface Plan {
  dir: string;
  base?: string; // undefined → the yt-dlp template decides
  label?: string;
  template?: string;
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return s && isFinite(n) && n > 0 ? n : undefined;
};

/** Artist / album folders from Settings → Library & naming (default "{albumartist}/{album} ({year})"). */
export function musicFolder(root: string, meta: TrackMeta): string {
  const vals = { albumartist: folderArtist(meta), artist: meta.artist, album: meta.album ?? meta.title, year: year(meta) ?? "", genre: meta.genre ?? "" };
  return join(root, ...folderParts(store.settings.musicFolder, vals, "{albumartist}/{album} ({year})"));
}

export function trackNumber(meta: TrackMeta): string {
  const multi = (meta.discTotal ?? 1) > 1;
  return meta.track != null ? (multi ? `${meta.disc ?? 1}-` : "") + String(meta.track).padStart(2, "0") : "";
}

export function musicPath(root: string, meta: TrackMeta, ext: string, folders: boolean, name: string): string {
  const file = fill(folders ? name : "{artist} - {title}", {
    track: trackNumber(meta), title: meta.title, artist: meta.artist, album: meta.album ?? "", year: year(meta) ?? "", albumartist: folderArtist(meta), disc: meta.disc ? String(meta.disc) : "",
  }, "{title}");
  return folders ? join(musicFolder(root, meta), `${file}.${ext}`) : join(root, `${file}.${ext}`);
}

/** yt-dlp doesn't know playlist fields when downloading from one video's info, so fill them in ourselves. */
export function fillPlaylistFields(t: string, i: JobInfo): string {
  let out = t.endsWith(".%(ext)s") ? t : t + ".%(ext)s";
  const vals: Record<string, string> = { playlist_title: i.playlistTitle ?? "", playlist: i.playlistTitle ?? "", playlist_index: i.playlistIndex ? String(i.playlistIndex) : "" };
  for (const [k, v] of Object.entries(vals)) {
    out = out.replace(new RegExp(`%\\(${k}\\)(0?)(\\d*)([sd])`, "g"), (_m, pad: string, width: string) => {
      if (!v) return "NA";
      if (pad === "0" && /^\d+$/.test(v)) return v.padStart(Math.max(1, Number(width) || 1), "0");
      return fsSafe(v);
    });
  }
  return out;
}

async function videoLabels(file: string): Promise<[string | undefined, string | undefined]> {
  const r = await host().run({ id: uid("v"), tool: "ffprobe", args: ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height,codec_name", "-of", "json", file], timeoutSec: 60 }).catch(() => null);
  const ext = extname(file).toUpperCase();
  try {
    const st = JSON.parse(r?.stdout ?? "").streams?.[0];
    if (!st) return [undefined, ext];
    const codec = ({ h264: "H.264", hevc: "H.265", av1: "AV1", vp9: "VP9", vp8: "VP8" } as Record<string, string>)[st.codec_name] ?? String(st.codec_name ?? "").toUpperCase();
    return [st.height ? `${st.height}p` : undefined, [ext, codec].filter(Boolean).join(" · ")];
  } catch {
    return [undefined, ext];
  }
}

export const jobs = new Manager();
