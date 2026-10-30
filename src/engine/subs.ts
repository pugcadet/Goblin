// Subscriptions (Subscriptions.swift): channels, playlists and podcast feeds, checked while Goblin is open.
// Nothing is scheduled outside the app.
import { basename, dirname, host, uid } from "./host";
import { jobs } from "./jobs";
import { effective, merged, Options, RULE_DEFAULTS, Subscription, SubRules } from "./model";
import { store } from "./store";
import { isWebUrl } from "./text";
import { bestThumbnail, entryURL, flat, J, thumbById } from "./ytdlp";

type Listener = () => void;

class Subs {
  list: Subscription[] = [];
  private checking = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<Listener>();

  async load() {
    const raw = await host().read("subscriptions.json");
    if (raw) {
      try {
        this.list = (JSON.parse(raw) as Subscription[]).map((s) => ({ ...s, rules: merged(RULE_DEFAULTS, s.rules), status: s.status === "checking" ? "active" : s.status }));
      } catch {
        this.list = [];
      }
    }
    jobs.onFinished((i) => void this.jobFinished(i.subId, i.finalPath));
    this.emit();
  }

  start() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 60_000);
    setTimeout(() => this.tick(), 8_000); // let the app settle first
  }

  subscribe(f: Listener) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit() {
    this.list = [...this.list];
    this.listeners.forEach((f) => f());
  }

  private async save() {
    await host().write("subscriptions.json", JSON.stringify(this.list));
    this.emit();
  }

  private tick() {
    const now = Date.now();
    const due = this.list.filter((s) => s.status !== "paused" && !this.checking.has(s.id) && (!s.lastChecked || now - s.lastChecked >= Math.max(5, s.interval) * 60_000));
    for (const s of due.slice(0, Math.max(0, 2 - this.checking.size))) this.check([s.id]);
  }

  async add(text: string, options: Options): Promise<Subscription[]> {
    const [preset, extra] = effective(store.presets, store.settings, options);
    const out: Subscription[] = [];
    for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(isWebUrl)) {
      if (this.list.some((s) => s.url === line)) continue;
      let name = (() => {
        try {
          return new URL(line).hostname;
        } catch {
          return line;
        }
      })();
      let thumbnail: string | undefined;
      try {
        const info = await flat(line, 1);
        name = (line.includes("list=") ? info.title : null) ?? info.channel ?? info.uploader ?? info.title ?? name;
        name = name.replace(/\s+-\s+(Videos|Shorts|Live|Home)$/i, "");
        thumbnail = thumbById(info, "avatar_uncropped") ?? bestThumbnail(info);
      } catch {
        /* name from the address */
      }
      const s: Subscription = {
        id: uid("s"), name, url: line, thumbnail, presetId: preset.id, options: { ...options, presetId: preset.id },
        interval: extra.subInterval > 0 ? extra.subInterval : store.settings.subInterval, filter: extra.subFilter, skipMembers: extra.skipMembers,
        rules: { ...RULE_DEFAULTS }, status: "active", lastNew: 0, seen: 0, files: [],
      };
      this.list.push(s);
      out.push(s);
    }
    await this.save();
    this.check(out.map((s) => s.id)); // the first check marks existing uploads as seen (or gets them with back-catalog on)
    return out;
  }

  async update(id: string, patch: Partial<Omit<Subscription, "rules">> & { rules?: Partial<SubRules> }) {
    const i = this.list.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = { ...this.list[i] };
    if (patch.name !== undefined) s.name = patch.name;
    if (patch.filter !== undefined) s.filter = patch.filter;
    if (patch.interval !== undefined) s.interval = Math.max(5, patch.interval);
    if (patch.presetId !== undefined) {
      s.presetId = patch.presetId;
      s.options = { ...s.options, presetId: patch.presetId };
    }
    if (patch.skipMembers !== undefined) s.skipMembers = patch.skipMembers;
    if (patch.status !== undefined) {
      s.status = patch.status;
      if (patch.status === "active") s.error = undefined;
    }
    if (patch.rules) s.rules = merged(RULE_DEFAULTS, { ...s.rules, ...patch.rules });
    this.list[i] = s;
    await this.save();
  }

  async remove(ids: string[]) {
    this.list = this.list.filter((s) => !ids.includes(s.id));
    for (const id of ids) await host().remove(`seen-${id}.txt`).catch(() => undefined);
    await this.save();
  }

  check(ids: string[]) {
    for (const id of ids) {
      if (this.checking.has(id)) continue;
      this.checking.add(id);
      const s = this.list.find((x) => x.id === id);
      const wasPaused = s?.status === "paused";
      if (s && !wasPaused) {
        s.status = "checking";
        this.emit();
      }
      void this.run(id, wasPaused).finally(() => this.checking.delete(id));
    }
  }

  private async run(id: string, wasPaused: boolean) {
    const sub = this.list.find((s) => s.id === id);
    if (!sub) return;
    const seenList = ((await host().read(`seen-${id}.txt`)) ?? "").split("\n").filter(Boolean);
    const seen = new Set(seenList);
    const newSeen = [...seenList];
    try {
      const list = await flat(sub.url, Math.max(5, store.settings.subScanEnd), true);
      const entries: J[] = list.entries ?? [];
      const first = !seenList.length;
      let toQueue: J[] = [];
      for (const e of [...entries].reverse()) {
        // oldest first
        if (!e.id || seen.has(e.id)) continue;
        if (e.live_status === "is_upcoming") continue; // not downloadable yet: look again next time
        seen.add(e.id);
        newSeen.push(e.id);
        if (first && !store.settings.subCatchUp) continue;
        if (passes(e, sub)) toQueue.push(e);
      }
      if (sub.rules.maxPer > 0 && toQueue.length > sub.rules.maxPer) toQueue = toQueue.slice(-sub.rules.maxPer);
      let queued = 0;
      for (const e of toQueue) {
        const url = entryURL(e);
        if (!url) continue;
        queued += jobs.add(url, { ...sub.options, presetId: sub.presetId }, { titleHint: e.title, thumb: e.thumbnails?.slice(-1)[0]?.url, subId: sub.id, subName: sub.name, playlistTitle: list.title }).length;
      }
      await host().write(`seen-${id}.txt`, newSeen.slice(-Math.max(100, store.settings.subMaxSeen)).join("\n"));
      Object.assign(sub, {
        lastChecked: Date.now(), lastNew: queued, seen: newSeen.length, status: wasPaused ? "paused" : "active", error: undefined,
        thumbnail: sub.thumbnail ?? thumbById(list, "avatar_uncropped"),
      });
    } catch (e) {
      Object.assign(sub, { lastChecked: Date.now(), status: "error", error: e instanceof Error ? e.message : String(e) });
    }
    await this.save();
  }

  /** "Keep only the newest N": after each finished download from a subscription, older files go to the Trash. */
  private async jobFinished(subId?: string, path?: string) {
    const s = this.list.find((x) => x.id === subId);
    if (!s || !path) return;
    s.files.push(path);
    const keep = s.rules.keep;
    if (keep > 0 && s.files.length > keep) {
      const old = s.files.splice(0, s.files.length - keep);
      for (const p of old) {
        const base = basename(p).replace(/\.[^.]+$/, "");
        for (const f of await host().list(dirname(p)).catch(() => [])) if (f.name.startsWith(base)) await host().trash(f.path).catch(() => undefined);
      }
    }
    await this.save();
  }
}

export function passes(e: J, sub: Subscription): boolean {
  const r = sub.rules;
  const title: string = e.title ?? "";
  const url = entryURL(e) ?? "";
  const dur: number | undefined = e.duration ?? undefined;
  if (r.skipShorts && (url.includes("/shorts/") || (dur ?? 999) <= 60)) return false;
  if (r.skipLive && ["is_live", "post_live", "was_live"].includes(e.live_status ?? "")) return false;
  if (sub.skipMembers && ["subscriber_only", "premium_only", "needs_auth"].includes(e.availability ?? "")) return false;
  if (dur != null) {
    if (r.minLen > 0 && dur < r.minLen * 60) return false;
    if (r.maxLen > 0 && dur > r.maxLen * 60) return false;
  }
  const ts = e.timestamp ?? e.release_timestamp;
  if (r.days > 0 && ts && Date.now() / 1000 - ts > r.days * 86400) return false;
  const matches = (pattern: string) => {
    if (!pattern) return true;
    try {
      return new RegExp(pattern.replace(/^\(\?i\)/, ""), "i").test(title);
    } catch {
      return title.toLowerCase().includes(pattern.toLowerCase());
    }
  };
  if (sub.filter && !matches(sub.filter)) return false;
  if (r.include && !matches(r.include)) return false;
  if (r.exclude && matches(r.exclude)) return false;
  return true;
}

export const subs = new Subs();
