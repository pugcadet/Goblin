import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, fileManager, isMac } from "../api";
import { askConfirm } from "../confirm";
import { preview, PreviewRow, recommend } from "../engine/fix";
import { host } from "../engine/host";
import { jobs } from "../engine/jobs";
import { Candidate, EXTRA_DEFAULTS, JobInfo, Options, Preset } from "../engine/model";
import { store } from "../engine/store";
import { subs } from "../engine/subs";
import { I, Modal, Pic, Seg, Select, Switch, tildify, toast, useJobs, useStore } from "../ui";

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
const DKEYS = ["kind", "quality", "container", "codec", "audioFormat", "audioQuality", "musicbrainz", "sponsorBlock", "splitChapters", "ytdlpArgs"] as const;

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

export default function Downloads() {
  const st = useStore();
  const list = useJobs();
  const [d, setDState] = useState<D>(() => lastD && st.presets.some((p) => p.id === lastD!.presetId) ? lastD : seed(st.settings.defaultPresetId));
  const setD = (patch: Partial<D>) => setDState((x) => (lastD = { ...x, ...patch }));
  const [text, setText] = useState("");
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pv, setPv] = useState<PreviewRow[] | null>(null);
  const [showLog, setShowLog] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const p = store.preset(d.presetId);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const det = lines.length && st.settings.autoDetect !== "off" ? recommend(lines) : null;
  const toolsReady = !!st.info?.ytdlp;

  // Auto-detect "apply": switch the preset as soon as the links say so.
  useEffect(() => {
    if (det && st.settings.autoDetect === "apply" && det.presetId && det.presetId !== d.presetId) setDState((lastD = seed(det.presetId)));
  }, [det?.presetId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go(kind: "download" | "subscribe" | "preview") {
    if (!lines.length) return;
    if (kind === "preview" || (kind === "download" && st.settings.previewBeforeDownload)) {
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
      if (kind === "subscribe") {
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
  const dest = d.folder || p.outputDir || st.dir(p.kind === "music" ? (p.podcast ? st.settings.dirPodcasts : st.settings.dirMusic) : p.metaMode === "youtube" ? st.settings.dirYoutube : st.settings.dirOther);

  return (
    <main className="page">
      <section className="card form addbar">
        <textarea
          className="links"
          rows={Math.min(8, Math.max(2, lines.length + 1))}
          value={text}
          spellCheck={false}
          autoFocus
          placeholder={"Paste links, one per line, or type “Artist - Song”…"}
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
            <span className="chip static">{I.wand} {lines.length} item{lines.length > 1 ? "s" : ""}: {det.summary}</span>
            {det.presetId && det.presetId !== d.presetId && st.settings.autoDetect === "suggest" ? (
              <>
                <span className="muted small">Looks like {det.why} →</span>
                <button className="soft small-btn" onClick={() => setDState((lastD = seed(det.presetId!)))}>Use “{store.preset(det.presetId).name}”</button>
              </>
            ) : det.presetId ? <span className="muted small">{I.check} {p.name}</span> : null}
            {det.subHint && <button className="small-btn" onClick={() => void go("subscribe")}>{I.bell} Subscribe instead</button>}
          </div>
        )}
        <div className="row optrow">
          <Select value={d.presetId} title="Preset" options={st.presets.map((x) => [x.id, x.name])} onChange={(id) => setDState((lastD = seed(id)))} />
          <Seg value={d.kind ?? p.kind} onChange={(k) => setD({ kind: k })} options={[["video", <>{I.film} Video</>], ["music", <>{I.music} Audio</>]]} />
          {(d.kind ?? p.kind) === "music" ? (
            <>
              <Select value={d.audioFormat ?? p.audioFormat} options={OPTS.audioFormat} onChange={(v) => setD({ audioFormat: v })} title="Format" />
              {["mp3"].includes(d.audioFormat ?? p.audioFormat) && <Select value={d.audioQuality ?? p.audioQuality} options={OPTS.audioQuality} onChange={(v) => setD({ audioQuality: v })} title="Quality" />}
              <button className={`small-btn ${d.musicbrainz ? "soft" : ""}`} onClick={() => setD({ musicbrainz: !d.musicbrainz })} title="Tags and cover art from MusicBrainz, written into the file">{I.music} Tags + cover</button>
            </>
          ) : (
            <>
              <Select value={d.quality ?? p.quality} options={OPTS.quality} onChange={(v) => setD({ quality: v })} title="Max quality" />
              <Select value={d.container ?? p.container} options={OPTS.container} onChange={(v) => setD({ container: v })} title="Format" />
              <Select value={d.codec ?? p.codec} options={OPTS.codec} onChange={(v) => setD({ codec: v })} title="Video codec" />
            </>
          )}
          {isCustom(d) && <span className="custom-tag">Custom <button className="link small" onClick={() => setDState((lastD = { ...seed(d.presetId), folder: d.folder }))}>reset</button></span>}
          <div className="spacer" />
          <button className={`small-btn ${adv ? "soft" : ""}`} onClick={() => setAdv(!adv)}>{I.sliders} Advanced</button>
        </div>
        {adv && <Advanced d={d} setD={setD} onImport={() => setImporting(true)} />}
        <div className="row optrow">
          <button className="chip static dest" title="Where this download is saved. Click to choose another folder for it." onClick={async () => {
            const [f] = await api.pickPaths("folder").catch(() => [] as string[]);
            if (f) setD({ folder: f });
          }}>{I.folder} {tildify(dest, home)}</button>
          {d.folder && <button className="icon" title="Back to the library folder" onClick={() => setD({ folder: "" })}>{I.x}</button>}
          <div className="spacer" />
          <span className="muted small">{isMac ? "⌘" : "Ctrl"}+Enter</span>
          <button className="small-btn" disabled={!lines.length || !toolsReady} onClick={() => void go("preview")} title="Qualities, size, subtitles and chapters before downloading">{I.eye} Preview</button>
          <button className="small-btn" disabled={!lines.length || busy} onClick={() => void go("subscribe")} title="Check this channel, playlist or podcast for new uploads while Goblin is open">{I.bell} Subscribe</button>
          <button className="primary" disabled={!lines.length || busy || !toolsReady} onClick={() => void go("download")}>{I.down} Download</button>
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

function Advanced({ d, setD, onImport }: { d: D; setD: (p: Partial<D>) => void; onImport: () => void }) {
  const st = useStore();
  const [ck, setCk] = useState<{ loaded: boolean; name: string } | null>(null);
  useEffect(() => void api.cookiesInfo().then(setCk).catch(() => undefined), []);
  const row = (label: string, ctl: ReactNode, title?: string) => <div className="arow"><label title={title}>{label}</label><div className="ctl">{ctl}</div></div>;
  const kind = d.kind ?? store.preset(d.presetId).kind;
  return (
    <div className="adv">
      <div className="advcard">
        <h4>Output</h4>
        {row("Name prefix", <input value={d.prefix ?? ""} placeholder="e.g. [Live] " onChange={(e) => setD({ prefix: e.target.value })} />, "Added in front of the file name")}
        {row("Remove sponsor segments", <Switch checked={!!d.sponsorBlock} onChange={(v) => setD({ sponsorBlock: v })} />, "SponsorBlock")}
        {row("Split by chapters", <>
          <Switch checked={!!d.splitChapters} onChange={(v) => setD({ splitChapters: v })} />
          {d.splitChapters && kind === "video" && <input className="mono" value={d.chapterTemplate || "%(section_number)02d - %(section_title)s.%(ext)s"} onChange={(e) => setD({ chapterTemplate: e.target.value })} />}
        </>, kind === "music" ? "Turns a full-album upload into separate tracks" : "One file per chapter")}
        {row("Clip", <><input className="time" value={d.clipStart ?? ""} placeholder="start 0:00" onChange={(e) => setD({ clipStart: e.target.value })} /> → <input className="time" value={d.clipEnd ?? ""} placeholder="end" onChange={(e) => setD({ clipEnd: e.target.value })} /></>, "Only download this part")}
      </div>
      <div className="advcard">
        <h4>Behavior</h4>
        {row("Start right away", <Switch checked={d.autoStart !== false} onChange={(v) => setD({ autoStart: v })} />, "Off: downloads wait as “pending” until you press Start")}
        {row("Playlist items limit", <><input type="number" min={0} className="num" value={d.itemsLimit ?? 0} onChange={(e) => setD({ itemsLimit: Number(e.target.value) || 0 })} /><span className="muted small">0 = all</span></>)}
        {row("Subscription check", <><input type="number" min={5} className="num" value={d.subInterval ?? st.settings.subInterval} onChange={(e) => setD({ subInterval: Number(e.target.value) || 60 })} /><span className="muted small">minutes</span></>)}
        {row("Subscription title filter", <input className="mono" value={d.subFilter ?? ""} placeholder="e.g. (?i)official" onChange={(e) => setD({ subFilter: e.target.value })} />)}
        {row("Skip members-only", <Switch checked={d.skipMembers !== false} onChange={(v) => setD({ skipMembers: v })} />)}
      </div>
      <div className="advcard">
        <h4>yt-dlp</h4>
        {row("Video password", <input type="password" autoComplete="off" value={d.password ?? ""} onChange={(e) => setD({ password: e.target.value })} />)}
        {row("Extra options", <input className="mono" value={d.ytdlpArgs ?? ""} placeholder="--embed-info-json" onChange={(e) => setD({ ytdlpArgs: e.target.value })} />, "Command-line options added to this download")}
        <div className="muted small">Options that run programs or read other files are refused.</div>
      </div>
      <div className="advcard">
        <h4>Tools</h4>
        {row("cookies.txt", <>
          <span className={`dot ${ck?.loaded ? "on" : ""}`} /><span className="muted small grow-text">{ck?.loaded ? ck.name : "None loaded"}</span>
          <button className="small-btn" onClick={() => void api.cookiesLoad().then(setCk).catch((e) => toast("Couldn't load it", errorText(e)))}>Load…</button>
          {ck?.loaded && <button className="icon" title="Delete" onClick={() => void api.cookiesDelete().then(setCk)}>{I.trash}</button>}
        </>, "Only used when YouTube says a video is age-restricted or members-only")}
        {row("Bulk", <>
          <button className="small-btn" onClick={onImport}>Import URLs</button>
          <button className="small-btn" onClick={() => { void navigator.clipboard.writeText(jobs.exportURLs()); toast("Copied every link in the list"); }}>{I.copy} Copy URLs</button>
        </>)}
      </div>
    </div>
  );
}

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

const ACTIVE = ["working", "downloading", "review", "queued", "pending"];
type Filter = "all" | "done" | "failed";

function Queue({ list, onLog }: { list: JobInfo[]; onLog: (id: string) => void }) {
  const st = useStore();
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const active = list.filter((j) => ACTIVE.includes(j.status));
  const finished = list.filter((j) => !ACTIVE.includes(j.status));
  const shown = finished.filter((j) => filter === "all" || (filter === "done" ? j.status === "done" || j.status === "skipped" : j.status === "error" || j.status === "canceled"));
  const pending = active.filter((j) => j.status === "pending");
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

  return (
    <>
      <section className="card list">
        <div className="row list-head">
          <h2>Downloading</h2>
          <span className="badge">{active.length}</span>
          <div className="spacer" />
          {pending.length > 0 && <button className="small-btn" onClick={() => jobs.start(pending.map((j) => j.id))}>{I.play} Start {pending.length}</button>}
          {active.length > 0 && <button className="small-btn" onClick={async () => (await askConfirm(`Cancel all ${active.length} downloads?`, { okLabel: "Cancel all", danger: true })) && jobs.cancelAll()}>Cancel all</button>}
          <button className="link" onClick={() => void host().reveal(st.library).catch((e) => toast("Couldn't open it", errorText(e)))}>Open library</button>
        </div>
        {!active.length && <p className="muted empty">Nothing downloading. Paste a link above, or find something on the Search tab.</p>}
        {active.map((j) => <ActiveRow key={j.id} j={j} onLog={onLog} compact={st.settings.compactList} />)}
      </section>

      {finished.length > 0 && (
        <section className="card list">
          <div className="row list-head">
            <input type="checkbox" checked={!!shown.length && shown.every((j) => sel.has(j.id))} onChange={() => toggle(shown.map((j) => j.id))} title="Select all" />
            <h2>Completed</h2>
            <span className="badge">{finished.length}</span>
            <Seg value={filter} onChange={setFilter} options={[["all", "All"], ["done", "Done"], ["failed", "Failed"]]} />
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
                <button className="link" onClick={() => jobs.clear("done")}>Clear done</button>
                <button className="link" onClick={() => jobs.clear("failed")}>Clear failed</button>
              </>
            )}
          </div>
          {groups.map((g) =>
            g.jobs.length === 1 ? (
              <DoneRow key={g.key} j={g.jobs[0]} selected={sel.has(g.jobs[0].id)} onSelect={() => toggle([g.jobs[0].id])} onLog={onLog} />
            ) : (
              <div className="group" key={g.key}>
                <div className="job done-row group-head" onClick={() => setOpen((o) => { const n = new Set(o); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })}>
                  <input type="checkbox" checked={g.jobs.every((j) => sel.has(j.id))} onClick={(e) => e.stopPropagation()} onChange={() => toggle(g.jobs.map((j) => j.id))} />
                  <Pic src={g.jobs[0].thumbnail} className={g.key.startsWith("a:") ? "square" : "thumb"} fallback={g.key.startsWith("a:") ? I.disc : I.film} />
                  <div className="job-main">
                    <div className="job-title">{g.key.slice(2)}</div>
                    <div className="muted small">
                      {g.jobs.filter((j) => j.status === "done").length} of {g.jobs.length} {g.key.startsWith("a:") ? "tracks" : "videos"}
                      {g.jobs.some((j) => j.status === "error") && <span className="error-text"> · {g.jobs.filter((j) => j.status === "error").length} failed</span>}
                    </div>
                  </div>
                  <span className="muted small">{open.has(g.key) ? "▾" : "▸"}</span>
                  {g.jobs.some((j) => j.status === "error") && <button className="small-btn" onClick={(e) => { e.stopPropagation(); jobs.retry(g.jobs.filter((j) => j.status === "error").map((j) => j.id)); }}>{I.retry} Retry failed</button>}
                </div>
                {open.has(g.key) && g.jobs.map((j) => <DoneRow key={j.id} j={j} selected={sel.has(j.id)} onSelect={() => toggle([j.id])} onLog={onLog} nested />)}
              </div>
            ),
          )}
          {!shown.length && <p className="muted empty">Nothing here.</p>}
        </section>
      )}
    </>
  );
}

function ActiveRow({ j, onLog, compact }: { j: JobInfo; onLog: (id: string) => void; compact: boolean }) {
  const pct = Math.round(j.progress * 100);
  return (
    <div className={`job active-row st-${j.status} ${compact ? "compact" : ""}`}>
      {!compact && <Pic src={j.thumbnail} className={j.kind === "music" ? "square" : "thumb"} fallback={j.kind === "music" ? I.music : I.film} />}
      <div className="job-main">
        <div className="job-title" title={j.url ?? j.input}>{j.title}</div>
        {j.status !== "review" && <div className="progress"><span className={j.status} style={{ width: `${j.status === "downloading" ? Math.max(2, pct) : j.status === "working" && j.progress > 0.9 ? 99 : 0}%` }} /></div>}
        <div className="muted small job-text">
          <span>{j.stage}</span>
          {j.status === "downloading" && pct > 0 && <span className="mono"> · {pct}%</span>}
          {j.speed && <span className="mono"> · {j.speed}</span>}
          {j.eta && <span className="mono"> · {j.eta === "live" ? "live" : `${j.eta} left`}</span>}
          {j.size && <span className="mono"> · {j.size}</span>}
          <span> · {j.presetName}{j.subName ? ` · ${j.subName}` : ""}</span>
        </div>
        {j.status === "review" && <Review j={j} />}
      </div>
      <div className="job-actions">
        {j.status === "pending" && <button className="small-btn" onClick={() => jobs.start([j.id])}>{I.play} Start</button>}
        <button className="icon" title="Log" onClick={() => onLog(j.id)}>{I.log}</button>
        <button className="icon" title="Cancel" onClick={() => jobs.cancel([j.id])}>{I.x}</button>
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

function DoneRow({ j, selected, onSelect, onLog, nested }: { j: JobInfo; selected: boolean; onSelect: () => void; onLog: (id: string) => void; nested?: boolean }) {
  const pill = j.status === "done" ? ["ok", "Done"] : j.status === "skipped" ? ["", "Skipped"] : j.status === "canceled" ? ["", "Canceled"] : ["bad", "Failed"];
  return (
    <div className={`job done-row st-${j.status} ${nested ? "nested" : ""}`}>
      <input type="checkbox" checked={selected} onChange={onSelect} />
      <Pic src={j.thumbnail} className={j.kind === "music" ? "square" : "thumb"} fallback={j.kind === "music" ? I.music : I.film} />
      <div className="job-main">
        <div className="job-title" title={j.finalPath ?? j.url ?? j.input}>{j.title}</div>
        <div className={`small job-text ${j.status === "error" ? "error-text" : "muted"}`}>
          <span className={`pill ${pill[0]}`}>{pill[1]}</span>{" "}
          {j.status === "error" ? j.error : j.stage}
          {j.matchLabel && j.status === "done" && <span className="muted"> · {j.matchLabel}</span>}
          {[j.qualityLabel, j.formatShort, j.size].filter(Boolean).length > 0 && <span className="mono"> · {[j.qualityLabel, j.formatShort, j.size].filter(Boolean).join(" · ")}</span>}
          {j.chapters?.length ? <span> · {j.chapters.length} files</span> : null}
        </div>
      </div>
      <div className="job-actions">
        {j.finalPath && <button className="small-btn" onClick={() => void host().reveal(j.finalPath!).catch((e) => toast("Couldn't show it", errorText(e)))}>{I.folder} {fileManager}</button>}
        {(j.url ?? j.input).startsWith("https://") && <button className="icon" title="Open the link" onClick={() => void host().openUrl(j.url ?? j.input)}>{I.ext}</button>}
        <button className="icon" title="Log" onClick={() => onLog(j.id)}>{I.log}</button>
        {(j.status === "error" || j.status === "canceled") && <button className="icon" title="Retry" onClick={() => jobs.retry([j.id])}>{I.retry}</button>}
        <button className="icon" title="Remove from the list" onClick={() => void jobs.remove([j.id], false)}>{I.x}</button>
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
