// The download queue. Links wait here and start a few at a time, so a long list of
// links never starts dozens of downloads at once. It lives outside the screens, so
// switching between Download, Search and Settings never loses anything.
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { api, DlEvent, DlRequest, errorText, loadLocal, saveLocal } from "./api";

export type JobState = "waiting" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  key: string;
  id: number | null;
  req: DlRequest;
  /** The link, until yt-dlp reports the real title. */
  title: string;
  /** In a playlist: the title of the video being downloaded now. */
  current: string;
  state: JobState;
  percent: number;
  speed: string;
  eta: string;
  item: string;
  text: string;
  files: string[];
}

let jobs: Job[] = [];
const subs = new Set<() => void>();
const notify = () => {
  subs.forEach((f) => f());
};

let parallel = loadLocal("goblin-queue", { parallel: 3 }).parallel;

export function getParallel() {
  return parallel;
}

export function setParallel(n: number) {
  parallel = Math.max(1, Math.min(6, Math.round(n) || 3));
  saveLocal("goblin-queue", { parallel });
  pump();
}

function update(key: string, f: (j: Job) => Job) {
  jobs = jobs.map((j) => (j.key === key ? f(j) : j));
  notify();
}

// Events can arrive before dl_start has told us the job's id; keep them until it has.
const early = new Map<number, DlEvent[]>();

function apply(j: Job, e: DlEvent): Job {
  switch (e.kind) {
    case "progress":
      return { ...j, percent: e.percent ?? j.percent, speed: e.speed ?? "", eta: e.eta ?? "", item: e.item ?? j.item };
    case "status":
      return { ...j, text: e.text ?? j.text };
    case "title": {
      const t = e.text ?? "";
      // The first title replaces the link; in a playlist later ones show which video is busy.
      return { ...j, title: j.title === j.req.url ? t || j.title : j.title, current: t, text: "Downloading" };
    }
    case "file":
      return e.text ? { ...j, files: [...j.files, e.text] } : j;
    case "done":
      return { ...j, state: "done", percent: 100, eta: "", speed: "", text: e.text ?? "Finished" };
    case "failed":
      return { ...j, state: "failed", speed: "", eta: "", text: e.text ?? "Failed" };
    case "cancelled":
      return { ...j, state: "cancelled", speed: "", eta: "", text: "Cancelled" };
    default:
      return j;
  }
}

let listening = false;
function ensureListening() {
  if (listening) return;
  listening = true;
  void listen<DlEvent>("dl-event", ({ payload: e }) => {
    const job = jobs.find((j) => j.id === e.id);
    if (!job) {
      early.set(e.id, [...(early.get(e.id) ?? []), e]);
      return;
    }
    update(job.key, (j) => apply(j, e));
    if (e.kind === "done" || e.kind === "failed" || e.kind === "cancelled") pump();
  });
}

let counter = 0;
// Cancel pressed while the download was still starting.
const wantCancel = new Set<string>();

function pump() {
  let running = jobs.filter((j) => j.state === "running").length;
  for (const j of jobs.slice().reverse()) {
    if (running >= parallel) break;
    if (j.state !== "waiting") continue;
    running++;
    void begin(j.key);
  }
}

async function begin(key: string) {
  const job = jobs.find((j) => j.key === key);
  if (!job) return;
  update(key, (j) => ({ ...j, state: "running", text: "Reading link…", percent: 0, files: [] }));
  try {
    const id = await api.start(job.req);
    update(key, (j) => {
      let next: Job = { ...j, id };
      for (const e of early.get(id) ?? []) next = apply(next, e);
      return next;
    });
    early.delete(id);
    if (wantCancel.delete(key)) void api.cancel(id);
    if (jobs.find((j) => j.key === key)?.state !== "running") pump();
  } catch (e) {
    update(key, (j) => ({ ...j, state: "failed", text: errorText(e) }));
    pump();
  }
}

/** Splits pasted text into web links: one per line (several on one line, separated by spaces, also work). */
export function splitLinks(text: string): { links: string[]; bad: string[] } {
  const links: string[] = [];
  const bad: string[] = [];
  const isLink = (t: string) => {
    try {
      const u = new URL(t);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (!parts.every(isLink)) {
      bad.push(line);
      continue;
    }
    for (const t of parts) if (!links.includes(t)) links.push(t);
  }
  return { links, bad };
}

/** Adds downloads to the queue. Returns how many were new (the same link and type twice is skipped). */
export function enqueue(reqs: DlRequest[], title?: string): number {
  ensureListening();
  let added = 0;
  for (const req of reqs) {
    const dup = jobs.some((j) => j.req.url === req.url && j.req.kind === req.kind && (j.state === "waiting" || j.state === "running"));
    if (dup) continue;
    const key = `j${++counter}`;
    const job: Job = {
      key, id: null, req, title: title && reqs.length === 1 ? title : req.url, current: "",
      state: "waiting", percent: 0, speed: "", eta: "", item: "", text: "Waiting", files: [],
    };
    jobs = [job, ...jobs];
    added++;
  }
  notify();
  pump();
  return added;
}

export function cancel(key: string) {
  const j = jobs.find((x) => x.key === key);
  if (!j) return;
  if (j.state === "waiting") update(key, (x) => ({ ...x, state: "cancelled", text: "Cancelled" }));
  else if (j.state === "running" && j.id !== null) void api.cancel(j.id);
  else if (j.state === "running") {
    wantCancel.add(key);
    update(key, (x) => ({ ...x, text: "Cancelling…" }));
  }
}

export function retry(key: string) {
  update(key, (j) => ({ ...j, id: null, state: "waiting", text: "Waiting", percent: 0, speed: "", eta: "", item: "", files: [] }));
  pump();
}

export function remove(key: string) {
  jobs = jobs.filter((j) => j.key !== key || j.state === "running");
  notify();
}

export function clearFinished() {
  jobs = jobs.filter((j) => j.state === "running" || j.state === "waiting");
  notify();
}

export function cancelAll() {
  for (const j of jobs) cancel(j.key);
}

export function activeCount(): number {
  return jobs.filter((j) => j.state === "running" || j.state === "waiting").length;
}

export function useJobs(): Job[] {
  ensureListening();
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => jobs,
  );
}
