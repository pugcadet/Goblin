import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, fileManager, isMac } from "../api";
import { askConfirm } from "../confirm";
import { preview, PreviewRow, recommend } from "../engine/fix";
import { host } from "../engine/host";
import { jobs } from "../engine/jobs";
import { Candidate, EXTRA_DEFAULTS, JobInfo, Options, Preset } from "../engine/model";
import { dirname } from "../engine/host";
import { store } from "../engine/store";
import { subs } from "../engine/subs";
import { ago, I, Modal, Pic, Seg, Switch, tildify, toast, useJobs, useStore } from "../ui";

export const OPTS = {
  quality: [["best", "Best"], ["2160", "2160p · 4K"], ["1440", "1440p"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["360", "360p"]] as [string, string][],
  container: [["any", "Any format"], ["mkv", "MKV"], ["mp4", "MP4"], ["webm", "WebM"]] as [string, string][],
  codec: [["any", "Any codec"], ["h264", "H.264"], ["h265", "H.265"], ["av1", "AV1"], ["vp9", "VP9"]] as [string, string][],
  audioFormat: [["mp3", "MP3"], ["m4a", "M4A"], ["opus", "Opus"], ["flac", "FLAC"], ["wav", "WAV"]] as [string, string][],
  audioQuality: [["320", "320 kbps"], ["V2", "V2 (~190)"], ["192", "192 kbps"], ["128", "128 kbps"]] as [string, string][],
  capSource: [["fallback", "Real, else auto"], ["manual", "Real subs only"], ["auto", "Auto-generated only"]] as [string, string][],
  loudness: [["off", "Leave as is"], ["replaygain", "ReplayGain tags (lossless)"], ["normalize", "Normalize audio (−14 LUFS)"]] as [string, string][],
};

/** Preset fields the add bar can change for one download; anything changed makes it "Custom". */
const DKEYS = ["kind", "quality", "container", "codec", "subtitles", "embedChapters", "audioFormat", "audioQuality", "musicbrainz", "lyrics", "sponsorBlock", "splitChapters", "ytdlpArgs"] as const;

type D = Options & { presetId: string };

function seed(presetId: string): D {
  const p = store.preset(presetId);
  const s = store.settings;
  const d: D = { ...EXTRA_DEFAULTS, presetId: p.id, autoStart: s.autoStart, itemsLimit: s.playlistItemLimit, subInterval: s.subInterval };
  for (const k of DKEYS) (d as Record<string, unknown>)[k] = p[k];
  return d;
}

const isCustom = (d: D) => {
  const p = store.preset(d.presetId);
  return DKEYS.some((k) => String((d as Record<string, unknown>)[k] ?? "") !== String(p[k] ?? ""));
};

/** What the engine gets: the preset id, changed preset fields and the extras that differ from the defaults. */
function options(d: D): Options {
  const p = store.preset(d.presetId);
  const o: Options = { presetId: d.presetId };
  for (const k of DKEYS) if (String((d as Record<string, unknown>)[k]) !== String(p[k])) (o as Record<string, unknown>)[k] = (d as Record<string, unknown>)[k];
  for (const k of Object.keys(EXTRA_DEFAULTS) as (keyof typeof EXTRA_DEFAULTS)[]) {
    const v = (d as Record<string, unknown>)[k];
    if (v !== undefined && v !== EXTRA_DEFAULTS[k]) (o as Record<string, unknown>)[k] = v;
  }
  return o;
}

let lastD: D | null = null;

/** How many of the per-download choices differ from the preset. */
const changes = (d: D) => {
  const p = store.preset(d.presetId);
  return DKEYS.filter((k) => String((d as Record<string, unknown>)[k] ?? "") !== String(p[k] ?? "")).length;
};

/** "1080p · MKV · subtitles" / "MP3 320 · tags + cover" for the recipe button. */
function summary(d: D): string {
  const name = store.preset(d.presetId).name.toLowerCase();
  return parts(d).filter((t) => !name.includes(t.toLowerCase())).join(" · ");
}

function parts(d: D): string[] {
  const kind = d.kind ?? "video";
  if (kind === "music") {
    const f = String(d.audioFormat ?? "mp3").toUpperCase();
    return [d.audioFormat === "mp3" ? `${f} ${d.audioQuality}` : f, d.musicbrainz && "tags + cover", d.lyrics && "lyrics"].filter(Boolean) as string[];
  }
  const q = d.quality === "best" ? "Best" : d.quality === "2160" ? "4K" : `${d.quality}p`;
  return [q, d.container !== "any" && String(d.container).toUpperCase(), d.codec !== "any" && OPTS.codec.find((c) => c[0] === d.codec)?.[1], d.subtitles && "subtitles", d.sponsorBlock && "no sponsors"].filter(Boolean) as string[];
}

export default function Downloads() {
  const st = useStore();
  const list = useJobs();
  const [d, setDState] = useState<D>(() => lastD && st.presets.some((p) => p.id === lastD!.presetId) ? lastD : seed(st.settings.defaultPresetId));
  const setD = (patch: Partial<D>) => setDState((x) => (lastD = { ...x, ...patch }));
  const [text, setText] = useState("");
  const [panel, setPanel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pv, setPv] = useState<PreviewRow[] | null>(null);
  const [showLog, setShowLog] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const p = store.preset(d.presetId);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const det = lines.length && st.settings.autoDetect !== "off" ? recommend(lines) : null;
  const toolsReady = !!st.info?.ytdlp;
  const kind = d.kind ?? p.kind;

  // Auto-detect "apply": switch the preset as soon as the links say so.
  useEffect(() => {
    if (det && st.settings.autoDetect === "apply" && det.presetId && det.presetId !== d.presetId) setDState((lastD = seed(det.presetId)));
  }, [det?.presetId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go(what: "download" | "subscribe" | "preview") {
    if (!lines.length) return;
    if (what === "preview" || (what === "download" && st.settings.previewBeforeDownload)) {
      setPv([]);
      try {
        setPv(await preview(text, options(d)));
      } catch (e) {
        setPv(null);
        toast("Preview failed", errorText(e));
      }
      return;
    }
    setBusy(true);
    try {
      if (what === "subscribe") {
        const added = await subs.add(text, options(d));
        toast(added.length ? `Subscribed to ${added.length}` : "Already subscribed", added.map((s) => s.name).join(", "));
      } else {
        const added = jobs.add(text, options(d));
        if (added.length < lines.length) toast(`${lines.length - added.length} already in the queue`);
      }
      setText("");
    } catch (e) {
      toast("Couldn't add that", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const home = st.info?.home ?? "";
  const dest = d.folder || p.outputDir || st.dir(kind === "music" ? (p.podcast ? st.settings.dirPodcasts : st.settings.dirMusic) : p.metaMode === "youtube" ? st.settings.dirYoutube : st.settings.dirOther);
  const destTail = kind === "music" ? (p.albumFolders && !p.podcast ? "/{artist}/{album}" : "") : p.metaMode === "youtube" && !d.folder && !p.outputDir ? "/{channel}" : "";
  const n = changes(d);

  return (
    <main className="page">
      <header className="page-head">
        <h1>Download</h1>
        <span className="muted">Paste links, one per line, or type “Artist - Song”.</span>
      </header>

      <section className="card addbar" aria-label="Add downloads">
        <textarea
          className="links"
          aria-label="Links"
          rows={Math.min(8, Math.max(2, lines.length + 1))}
          value={text}
          spellCheck={false}
          autoFocus
          placeholder={"https://www.youtube.com/watch?v=…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (toolsReady) void go("download");
            }
          }}
        />
        {det && (
          <div className="detect">
            <span className="tag ok">{I.check} {lines.length} item{lines.length > 1 ? "s" : ""}: {det.summary}</span>
            {det.presetId && det.presetId !== d.presetId && st.settings.autoDetect === "suggest" && (
              <>
                <span className="muted small">Looks like {det.why}.</span>
                <button className="small-btn soft" onClick={() => setDState((lastD = { ...seed(det.presetId!), folder: d.folder }))}>Use “{store.preset(det.presetId).name}”</button>
              </>
            )}
            {det.subHint && <button className="small-btn" onClick={() => void go("subscribe")}>{I.bell} Subscribe instead</button>}
          </div>
        )}
        <div className="recipe">
          <div className="recipe-anchor">
            <button className={`recipe-btn ${panel ? "open" : ""}`} aria-expanded={panel} aria-haspopup="dialog" onClick={() => setPanel(!panel)} title="Preset and options for this download">
              <span className="recipe-icon">{kind === "music" ? (p.podcast ? I.mic : I.music) : I.film}</span>
              <b>{p.name}</b>
              <span className="muted ell">{summary(d)}</span>
              {n > 0 && <span className="tag warn">{n} change{n > 1 ? "s" : ""}</span>}
              {I.chevron}
            </button>
            {panel && <RecipePanel d={d} setD={setD} setDState={(x) => setDState((lastD = x))} onClose={() => setPanel(false)} onImport={() => { setPanel(false); setImporting(true); }} />}
          </div>
          <span className="muted" aria-hidden="true">→</span>
          <button className="recipe-btn dest" title="Where this download is saved. Click to choose another folder for it." onClick={async () => {
            const [f] = await api.pickPaths("folder").catch(() => [] as string[]);
            if (f) setD({ folder: f });
          }}>
            <span className="recipe-icon">{I.folder}</span><span className="mono ell">{tildify(dest, home)}{destTail}</span>
          </button>
          {d.folder && <button className="icon" title="Back to the normal folder" onClick={() => setD({ folder: "" })}>{I.x}</button>}
          <div className="spacer" />
          <button className="small-btn tall" disabled={!lines.length || !toolsReady} onClick={() => void go("preview")} title="Qualities, size, subtitles and chapters before downloading">{I.eye} Preview</button>
          <button className="primary" disabled={!lines.length || busy || !toolsReady} onClick={() => void go("download")}>{I.down} Download <span className="kbd">{isMac ? "⌘↵" : "Ctrl+↵"}</span></button>
        </div>
      </section>

      <Queue list={list} onLog={setShowLog} />

      {pv && (
        <PreviewModal rows={pv} preset={p} custom={isCustom(d)} onClose={() => setPv(null)} onGo={() => {
          const added = jobs.add(text, options(d));
          setText("");
          setPv(null);
          toast(`Queued ${added.length}`);
        }} />
      )}
      {showLog && <LogModal id={showLog} onClose={() => setShowLog(null)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onAdd={(t) => { jobs.add(t, options(d)); setImporting(false); }} />}
    </main>
  );
}

/** The popover behind the recipe button: pick a preset, then change things for this download only. */
function RecipePanel({ d, setD, setDState, onClose, onImport }: { d: D; setD: (p: Partial<D>) => void; setDState: (d: D) => void; onClose: () => void; onImport: () => void }) {
  const st = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const p = store.preset(d.presetId);
  const kind = d.kind ?? p.kind;
  const n = changes(d);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !(t as Element).closest?.(".recipe-btn")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [onClose]);
  const icon = (x: Preset) => (x.kind === "music" ? (x.podcast ? I.mic : I.music) : x.metaMode === "none" ? I.star : I.film);
  const hint = (x: Preset) => (x.kind === "music" ? [formatShort(x), x.musicbrainz && "tags + cover", x.lyrics && "lyrics", x.podcast && "chapters"] : [formatShort(x), x.metaMode === "youtube" ? "channel folders" : "original title", x.subtitles && "subtitles"]).filter(Boolean).join(" · ");
  const row = (label: string, ctl: ReactNode, title?: string) => <div className="field"><span className="field-label" title={title}>{label}</span><div className="field-ctl">{ctl}</div></div>;
  return (
    <div className="popover recipe-panel" role="dialog" aria-label="Download options" ref={ref}>
      <div className="pop-sect">
        <div className="pop-title">Preset</div>
        {st.presets.map((x) => (
          <button key={x.id} className={`preset-opt ${x.id === d.presetId ? "on" : ""}`} onClick={() => setDState({ ...seed(x.id), folder: d.folder })}>
            <span className="recipe-icon">{icon(x)}</span>{x.name}<span className="muted small ell">{hint(x)}</span>
          </button>
        ))}
      </div>
      <div className="pop-sect">
        <div className="pop-title row tight">
          Just for this download<div className="spacer" />{n > 0 && <span className="tag warn">{n} change{n > 1 ? "s" : ""}</span>}
        </div>
        {row("Get", <Seg value={kind} onChange={(k) => setD({ kind: k })} options={[["video", <>{I.film} Video</>], ["music", <>{I.music} Audio</>]]} />)}
        {kind === "music" ? (
          <>
            {row("Format", <Seg value={String(d.audioFormat)} onChange={(v) => setD({ audioFormat: v })} options={OPTS.audioFormat} />)}
            {d.audioFormat === "mp3" && row("Quality", <Seg value={String(d.audioQuality)} onChange={(v) => setD({ audioQuality: v })} options={OPTS.audioQuality.map(([k, l]) => [k, l.replace(" kbps", "")])} />)}
            <label className="check"><Switch checked={!!d.musicbrainz} onChange={(v) => setD({ musicbrainz: v })} /> Tags + cover art (MusicBrainz)</label>
            <label className="check"><Switch checked={!!d.lyrics} onChange={(v) => setD({ lyrics: v })} /> Synced lyrics</label>
            <label className="check"><Switch checked={!!d.splitChapters} onChange={(v) => setD({ splitChapters: v })} /> Split by chapters (full-album uploads)</label>
          </>
        ) : (
          <>
            {row("Quality", <Seg value={String(d.quality)} onChange={(v) => setD({ quality: v })} options={[["best", "Best"], ["2160", "4K"], ["1440", "1440"], ["1080", "1080"], ["720", "720"], ["480", "480"]]} />)}
            {row("Format", <Seg value={String(d.container)} onChange={(v) => setD({ container: v })} options={[["any", "Any"], ["mkv", "MKV"], ["mp4", "MP4"], ["webm", "WebM"]]} />)}
            {row("Codec", <Seg value={String(d.codec)} onChange={(v) => setD({ codec: v })} options={[["any", "Any"], ["h264", "H.264"], ["h265", "H.265"], ["av1", "AV1"], ["vp9", "VP9"]]} />, "H.264 plays on nearly every TV without transcoding")}
            <label className="check"><Switch checked={!!d.subtitles} onChange={(v) => setD({ subtitles: v })} /> Subtitles (embedded)</label>
            <label className="check"><Switch checked={!!d.embedChapters} onChange={(v) => setD({ embedChapters: v })} /> Chapters</label>
            <label className="check"><Switch checked={!!d.sponsorBlock} onChange={(v) => setD({ sponsorBlock: v })} /> Cut sponsor segments</label>
            <label className="check"><Switch checked={!!d.splitChapters} onChange={(v) => setD({ splitChapters: v })} /> One file per chapter</label>
          </>
        )}
      </div>
      <details className="pop-sect more-opts">
        <summary>More: clip, name prefix, playlist limit, password, extra yt-dlp options</summary>
        <div className="more-body">
          {row("Clip", <><input className="time" value={d.clipStart ?? ""} placeholder="start 0:00" onChange={(e) => setD({ clipStart: e.target.value })} /><span className="muted">→</span><input className="time" value={d.clipEnd ?? ""} placeholder="end" onChange={(e) => setD({ clipEnd: e.target.value })} /></>, "Only download this part")}
          {row("Name prefix", <input value={d.prefix ?? ""} placeholder="e.g. [Live] " onChange={(e) => setD({ prefix: e.target.value })} />, "Added in front of the file name")}
          {d.splitChapters && kind === "video" && row("Chapter names", <input className="mono" value={d.chapterTemplate || "%(section_number)02d - %(section_title)s.%(ext)s"} onChange={(e) => setD({ chapterTemplate: e.target.value })} />)}
          {row("Playlist limit", <><input type="number" min={0} className="num" value={d.itemsLimit ?? 0} onChange={(e) => setD({ itemsLimit: Number(e.target.value) || 0 })} /><span className="muted small">items, 0 = all</span></>)}
          {row("Start right away", <Switch checked={d.autoStart !== false} onChange={(v) => setD({ autoStart: v })} />, "Off: downloads wait in the queue until you press Start")}
          {row("Video password", <input type="password" autoComplete="off" value={d.password ?? ""} onChange={(e) => setD({ password: e.target.value })} />)}
          {row("yt-dlp options", <input className="mono" value={d.ytdlpArgs ?? ""} placeholder="--embed-info-json" onChange={(e) => setD({ ytdlpArgs: e.target.value })} />, "Options that run programs or read other files are refused")}
          <div className="pop-title">When subscribing from here</div>
          {row("Check every", <><input type="number" min={5} className="num" value={d.subInterval ?? st.settings.subInterval} onChange={(e) => setD({ subInterval: Number(e.target.value) || 60 })} /><span className="muted small">minutes</span></>)}
          {row("Title filter", <input className="mono" value={d.subFilter ?? ""} placeholder="e.g. (?i)official" onChange={(e) => setD({ subFilter: e.target.value })} />)}
          {row("Skip members-only", <Switch checked={d.skipMembers !== false} onChange={(v) => setD({ skipMembers: v })} />)}
          <div className="row tight">
            <button className="small-btn" onClick={onImport}>Import a list of links…</button>
            <button className="small-btn" onClick={() => { void navigator.clipboard.writeText(jobs.exportURLs()); toast("Copied every link in the list"); }}>{I.copy} Copy all links</button>
          </div>
        </div>
      </details>
      <div className="pop-foot">
        <button className="small-btn" disabled={!n} onClick={() => setDState({ ...seed(d.presetId), folder: d.folder })}>Reset to preset</button>
        <div className="spacer" />
        <button className="small-btn" disabled={!n} onClick={async () => {
          const patch: Partial<Preset> = {};
          for (const k of DKEYS) (patch as Record<string, unknown>)[k] = (d as Record<string, unknown>)[k];
          const saved = await store.savePreset({ ...p, ...patch, id: "", name: `${p.name} (${parts(d).slice(0, 2).join(" ")})` });
          setDState({ ...seed(saved.id), folder: d.folder });
          toast(`Saved as preset “${saved.name}”`, "Rename or change it under Presets.");
        }}>Save as preset…</button>
        <button className="primary small" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

const formatShort = (x: Preset) => (x.kind === "music" ? (x.audioFormat === "mp3" ? `MP3 ${x.audioQuality}` : x.audioFormat.toUpperCase()) : `${x.quality === "best" ? "Best" : x.quality === "2160" ? "4K" : x.quality + "p"}${x.container !== "any" ? " " + x.container.toUpperCase() : ""}`);

function ImportModal({ onClose, onAdd }: { onClose: () => void; onAdd: (t: string) => void }) {
  const [t, setT] = useState("");
  return (
    <Modal title="Import links" onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" disabled={!t.trim()} onClick={() => onAdd(t)}>Add {t.split(/\r?\n/).filter((l) => l.trim()).length}</button></>}>
      <p className="muted small">Paste a list of links (one per line), for example an exported list from Goblin or MeTube. Choose a .txt file:</p>
      <input type="file" accept=".txt,.csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setT(await f.text()); }} />
      <textarea className="links" rows={10} value={t} onChange={(e) => setT(e.target.value)} spellCheck={false} />
    </Modal>
  );
}

// ------------------------------------------------------------------ queue

const RUNNING = ["working", "downloading"];
const WAITING = ["queued", "pending"];
const ACTIVE = [...RUNNING, ...WAITING, "review"];
type Filter = "all" | "done" | "failed";

function Queue({ list, onLog }: { list: JobInfo[]; onLog: (id: string) => void }) {
  const st = useStore();
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [allNext, setAllNext] = useState(false);
  const review = list.filter((j) => j.status === "review");
  const running = list.filter((j) => RUNNING.includes(j.status));
  const waiting = list.filter((j) => WAITING.includes(j.status));
  const pending = waiting.filter((j) => j.status === "pending");
  const active = list.filter((j) => ACTIVE.includes(j.status));
  const finished = list.filter((j) => !ACTIVE.includes(j.status));
  const failedCount = finished.filter((j) => j.status === "error").length;
  const shown = finished.filter((j) => filter === "all" || (filter === "done" ? j.status === "done" || j.status === "skipped" : j.status === "error" || j.status === "canceled"));
  // Albums and playlists as one row you can open.
  const groups = useMemo(() => {
    if (!st.settings.groupAlbums) return shown.map((j) => ({ key: j.id, jobs: [j] }));
    const out: { key: string; jobs: JobInfo[] }[] = [];
    const at = new Map<string, number>();
    for (const j of shown) {
      const g = j.albumHint && j.kind === "music" ? "a:" + j.albumHint : j.playlistTitle ? "p:" + j.playlistTitle : null;
      if (!g) out.push({ key: j.id, jobs: [j] });
      else if (at.has(g)) out[at.get(g)!].jobs.push(j);
      else {
        at.set(g, out.length);
        out.push({ key: g, jobs: [j] });
      }
    }
    return out;
  }, [shown, st.settings.groupAlbums]);
  const toggle = (ids: string[]) => setSel((s) => {
    const n = new Set(s);
    const all = ids.every((i) => n.has(i));
    ids.forEach((i) => (all ? n.delete(i) : n.add(i)));
    return n;
  });
  const selIds = [...sel].filter((id) => finished.some((j) => j.id === id));
  const nextShown = allNext ? waiting : waiting.slice(0, 3);
  const compact = st.settings.compactList;
  const parts = [running.length && `${running.length} downloading`, waiting.length && `${waiting.length} waiting`, review.length && `${review.length} need${review.length === 1 ? "s" : ""} you`, finished.length && `${finished.length} finished`].filter(Boolean);

  if (!list.length)
    return (
      <section className="card queue empty-queue">
        <div className="empty-big">
          <span className="dicon">{I.down}</span>
          <b>Nothing in the queue yet</b>
          <span className="muted small">Paste a link above, find something in Search, or subscribe to a channel.</span>
        </div>
      </section>
    );

  return (
    <section className="card queue" aria-label="Queue">
      <div className="queue-head">
        <h2>Queue</h2>
        <span className="muted small">{parts.join(" · ")}</span>
        <div className="spacer" />
        {pending.length > 0 && <button className="small-btn" onClick={() => jobs.start(pending.map((j) => j.id))}>{I.play} Start {pending.length}</button>}
        {active.length > 0 && <button className="small-btn" onClick={async () => (await askConfirm(`Cancel all ${active.length} downloads?`, { okLabel: "Cancel all", danger: true })) && jobs.cancelAll()}>Cancel all</button>}
      </div>

      {review.length > 0 && <div className="sect warn">Needs you <span className="sect-n">{review.length}</span></div>}
      {review.map((j) => <ActiveRow key={j.id} j={j} onLog={onLog} compact={compact} />)}

      {running.length > 0 && <div className="sect">Now</div>}
      {running.map((j) => <ActiveRow key={j.id} j={j} onLog={onLog} compact={compact} />)}

      {waiting.length > 0 && <div className="sect">Up next <span className="sect-n">{waiting.length}</span></div>}
      {nextShown.map((j) => <ActiveRow key={j.id} j={j} onLog={onLog} compact />)}
      {waiting.length > 3 && <button className="link small sect-more" onClick={() => setAllNext(!allNext)}>{allNext ? "Show fewer" : `Show all ${waiting.length}`}</button>}

      {finished.length > 0 && (
        <>
          <div className="sect sect-bar">
            <input type="checkbox" aria-label="Select all finished" checked={!!shown.length && shown.every((j) => sel.has(j.id))} onChange={() => toggle(shown.map((j) => j.id))} />
            Finished <span className="sect-n">{finished.length}</span>
            <Seg className="small" value={filter} onChange={setFilter} options={[["all", "All"], ["done", "Done"], ["failed", `Failed${failedCount ? ` ${failedCount}` : ""}`]]} />
            <div className="spacer" />
            {selIds.length > 0 ? (
              <>
                <span className="muted small">{selIds.length} selected</span>
                <button className="small-btn" onClick={() => { jobs.retry(selIds); setSel(new Set()); }}>{I.retry} Retry</button>
                <button className="small-btn" onClick={() => { void jobs.remove(selIds, false); setSel(new Set()); }}>Remove</button>
                <button className="small-btn danger-outline" onClick={async () => {
                  if (await askConfirm(`Move the files of ${selIds.length} downloads to the ${isMac ? "Trash" : "Recycle Bin"}?`, { okLabel: "Move to Trash", danger: true })) {
                    await jobs.remove(selIds, true);
                    setSel(new Set());
                  }
                }}>{I.trash} Delete files</button>
              </>
            ) : (
              <>
                <button className="link small" onClick={() => jobs.clear("done")}>Clear done</button>
                {failedCount > 0 && <button className="link small" onClick={() => jobs.clear("failed")}>Clear failed</button>}
              </>
            )}
          </div>
          {groups.map((g) =>
            g.jobs.length === 1 ? (
              <DoneRow key={g.key} j={g.jobs[0]} selected={sel.has(g.jobs[0].id)} onSelect={() => toggle([g.jobs[0].id])} onLog={onLog} compact={compact} />
            ) : (
              <div className="group" key={g.key}>
                <div className="qrow done group-head" onClick={() => setOpen((o) => { const n = new Set(o); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })}>
                  <input type="checkbox" aria-label="Select group" checked={g.jobs.every((j) => sel.has(j.id))} onClick={(e) => e.stopPropagation()} onChange={() => toggle(g.jobs.map((j) => j.id))} />
                  <Pic src={g.jobs[0].thumbnail} className={`qthumb ${g.key.startsWith("a:") ? "sq" : ""}`} fallback={g.key.startsWith("a:") ? I.disc : I.film} />
                  <div className="qmain">
                    <div className="job-title">{g.key.slice(2)}</div>
                    <div className="muted small">
                      {g.jobs.filter((j) => j.status === "done").length} of {g.jobs.length} {g.key.startsWith("a:") ? "songs" : "videos"}
                      {g.jobs.some((j) => j.status === "error") && <span className="error-text"> · {g.jobs.filter((j) => j.status === "error").length} failed</span>}
                    </div>
                  </div>
                  <div className="qstate muted small">{open.has(g.key) ? "▾ hide" : "▸ show"}</div>
                  <div className="job-actions">
                    {g.jobs.some((j) => j.status === "error") && <button className="small-btn" onClick={(e) => { e.stopPropagation(); jobs.retry(g.jobs.filter((j) => j.status === "error").map((j) => j.id)); }}>{I.retry} Retry failed</button>}
                  </div>
                </div>
                {open.has(g.key) && g.jobs.map((j) => <DoneRow key={j.id} j={j} selected={sel.has(j.id)} onSelect={() => toggle([j.id])} onLog={onLog} nested compact />)}
              </div>
            ),
          )}
          {!shown.length && <p className="muted empty">Nothing here.</p>}
        </>
      )}
    </section>
  );
}

function ActiveRow({ j, onLog, compact }: { j: JobInfo; onLog: (id: string) => void; compact: boolean }) {
  const pct = Math.round(j.progress * 100);
  const waiting = WAITING.includes(j.status);
  const sub = [j.presetName, j.subName ?? j.playlistTitle, j.qualityLabel && j.formatShort ? `${j.qualityLabel} ${j.formatShort}` : null, j.size].filter(Boolean).join(" · ");
  return (
    <div className={`qrow st-${j.status} ${compact ? "compact" : ""}`}>
      <span />
      {compact ? <span /> : <Pic src={j.thumbnail} className={`qthumb ${j.kind === "music" ? "sq" : ""}`} fallback={j.kind === "music" ? I.music : I.film} />}
      <div className="qmain">
        <div className="job-title" title={j.url ?? j.input}>{j.title}</div>
        {!compact && <div className="muted small job-text">{j.status === "review" ? "Pick the right match below, or keep the original title." : sub}</div>}
        {j.status === "review" && <Review j={j} />}
      </div>
      <div className="qstate">
        {j.status === "downloading" && pct > 0 ? (
          <>
            <div className="progress"><span style={{ width: `${Math.max(2, pct)}%` }} /></div>
            <div className="muted small mono">{pct}%{j.speed ? ` · ${j.speed}` : ""}{j.eta ? ` · ${j.eta === "live" ? "live" : `${j.eta} left`}` : ""}</div>
          </>
        ) : j.status === "working" || j.status === "downloading" ? (
          <>
            <div className="progress"><span className="busy" style={{ width: `${j.progress > 0.9 ? 99 : 8}%` }} /></div>
            <div className="muted small ell" title={j.stage}>{j.stage}</div>
          </>
        ) : j.status === "review" ? (
          <span className="tag warn">Waiting for you</span>
        ) : (
          <span className="muted small">{j.status === "pending" ? "Not started" : "Queued"}</span>
        )}
      </div>
      <div className="job-actions">
        {j.status === "pending" && <button className="small-btn" onClick={() => jobs.start([j.id])}>{I.play} Start</button>}
        {!waiting && <button className="icon" aria-label="Log" title="Log" onClick={() => onLog(j.id)}>{I.log}</button>}
        <button className="icon" aria-label="Cancel" title="Cancel" onClick={() => jobs.cancel([j.id])}>{I.x}</button>
      </div>
    </div>
  );
}

function Review({ j }: { j: JobInfo }) {
  const [q, setQ] = useState(j.title);
  const [cands, setCands] = useState<Candidate[]>(j.candidates ?? []);
  const [busy, setBusy] = useState(false);
  return (
    <div className="review">
      {cands.slice(0, 6).map((c) => (
        <button key={c.id} className="cand" onClick={() => jobs.resolveReview(j.id, c)}>
          <Pic src={c.image} className="square small" />
          <span className="cand-text"><span className="strong">{c.title}</span><span className="muted small">{c.subtitle}</span></span>
          <span className={`score ${c.score >= 0.8 ? "good" : c.score >= 0.6 ? "fair" : "poor"}`}>{Math.round(c.score * 100)}</span>
        </button>
      ))}
      <div className="row tight">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Artist - Title" onKeyDown={async (e) => {
          if (e.key !== "Enter") return;
          setBusy(true);
          setCands(await jobs.reviewSearch(j.id, q));
          setBusy(false);
        }} />
        <button className="small-btn" disabled={busy} onClick={async () => { setBusy(true); setCands(await jobs.reviewSearch(j.id, q)); setBusy(false); }}>{I.search} Search</button>
        <button className="small-btn" onClick={() => jobs.resolveReview(j.id, null)}>Keep original title</button>
      </div>
    </div>
  );
}

function DoneRow({ j, selected, onSelect, onLog, nested, compact }: { j: JobInfo; selected: boolean; onSelect: () => void; onLog: (id: string) => void; nested?: boolean; compact?: boolean }) {
  const st = useStore();
  const ok = j.status === "done";
  const failed = j.status === "error";
  const where = j.finalPath ? tildify(dirname(j.finalPath), st.info?.home ?? "") : "";
  const sub = failed ? j.error : [j.matchLabel ?? (j.status === "skipped" ? j.stage : where), [j.qualityLabel, j.formatShort, j.size].filter(Boolean).join(" "), j.chapters?.length ? `${j.chapters.length} files` : null].filter(Boolean).join(" · ");
  return (
    <div className={`qrow done st-${j.status} ${nested ? "nested" : ""} ${compact ? "compact" : ""}`}>
      <input type="checkbox" aria-label="Select" checked={selected} onChange={onSelect} />
      {compact ? <span /> : <Pic src={j.thumbnail} className={`qthumb ${j.kind === "music" ? "sq" : ""}`} fallback={j.kind === "music" ? I.music : I.film} />}
      <div className="qmain">
        <div className="job-title" title={j.finalPath ?? j.url ?? j.input}>{j.title}</div>
        {!compact && <div className={`small job-text ${failed ? "error-text" : "muted"}`} title={sub ?? ""}>{sub}</div>}
      </div>
      <div className={`qstate small state-line ${ok ? "ok" : failed ? "bad" : "muted"}`}>
        {ok ? I.check : failed ? I.warn : null}
        <span>{ok ? "Done" : failed ? "Couldn't download" : j.status === "skipped" ? "Skipped" : "Canceled"}{ok && j.finished ? ` · ${ago(j.finished)}` : ""}</span>
      </div>
      <div className="job-actions">
        {j.finalPath && <button className="icon" aria-label={`Show in ${fileManager}`} title={`Show in ${fileManager}`} onClick={() => void host().reveal(j.finalPath!).catch((e) => toast("Couldn't show it", errorText(e)))}>{I.folder}</button>}
        {(failed || j.status === "canceled") && <button className="icon" aria-label="Retry" title="Retry" onClick={() => jobs.retry([j.id])}>{I.retry}</button>}
        <button className="icon" aria-label="Log" title="Log" onClick={() => onLog(j.id)}>{I.log}</button>
        {(j.url ?? j.input).startsWith("https://") && <button className="icon" aria-label="Open the link" title="Open the link" onClick={() => void host().openUrl(j.url ?? j.input)}>{I.ext}</button>}
        <button className="icon" aria-label="Remove from the list" title="Remove from the list" onClick={() => void jobs.remove([j.id], false)}>{I.x}</button>
      </div>
    </div>
  );
}

function LogModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [lines, setLines] = useState(() => jobs.log(id));
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const t = setInterval(() => setLines([...jobs.log(id)]), 700);
    return () => clearInterval(t);
  }, [id]);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  const j = jobs.snapshot().find((x) => x.id === id);
  return (
    <Modal title={`Log · ${j?.title ?? ""}`} onClose={onClose} wide footer={<><span className="spacer" /><button onClick={() => { void navigator.clipboard.writeText(lines.join("\n")); toast("Log copied"); }}>{I.copy} Copy</button></>}>
      <pre className="log" ref={ref}>{lines.join("\n") || "Nothing yet."}</pre>
    </Modal>
  );
}

function PreviewModal({ rows, preset, custom, onClose, onGo }: { rows: PreviewRow[]; preset: Preset; custom: boolean; onClose: () => void; onGo: () => void }) {
  return (
    <Modal title={`Preview${rows.length ? ` · ${rows.length} item${rows.length > 1 ? "s" : ""}` : ""}`} onClose={onClose} wide footer={<>
      <span className="muted small spacer">Preset: <b>{preset.name}</b>{custom ? " (custom)" : ""}</span>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" onClick={onGo}>{I.down} Download</button>
    </>}>
      {!rows.length && <p className="muted">Reading the links…</p>}
      {rows.map((r, i) => (
        <div className="job" key={i}>
          <Pic src={r.thumbnail} className={r.kind === "audio" ? "square" : "thumb"} fallback={r.kind === "audio" ? I.music : I.film} />
          <div className="job-main">
            <div className="job-title">{r.title}</div>
            <div className="muted small">{[r.channel, r.duration].filter(Boolean).join(" · ")}</div>
            <div className="pills">
              {r.error && <span className="pill bad">{r.error}</span>}
              {r.label && <span className="pill">{r.label}</span>}
              {r.kind === "audio" && (r.official ? <span className="pill ok">{I.check} Official audio</span> : <span className="pill warn">Music video{preset.preferOfficialAudio ? " (pasted links are downloaded as they are)" : ""}</span>)}
              {r.source && <span className="pill">{r.source} → {preset.audioFormat.toUpperCase()}</span>}
              {r.qualities?.map((q) => <span key={q} className={`pill ${q === r.chosen ? "ok" : ""}`}>{q}</span>)}
              {r.size && <span className="pill">≈ {r.size}</span>}
              {r.subs && r.subs !== "none" && <span className="pill ok">CC {r.subs}</span>}
              {r.chapters ? <span className="pill">{r.chapters} chapters</span> : null}
              {r.live && <span className="pill bad">LIVE</span>}
            </div>
          </div>
        </div>
      ))}
    </Modal>
  );
}
