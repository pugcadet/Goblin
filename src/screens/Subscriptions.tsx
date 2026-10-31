import { useEffect, useState } from "react";
import { errorText, fileManager } from "../api";
import { askConfirm } from "../confirm";
import { host, uid } from "../engine/host";
import { Subscription } from "../engine/model";
import { store } from "../engine/store";
import { Older, subs } from "../engine/subs";
import { eta } from "../engine/text";
import { ago, I, LazyInput, Pic, Select, Switch, toast, useJobs, useStore, useSubs } from "../ui";

type Tab = "new" | "older" | "rules";
let lastOpen: string | null = null;

export default function Subscriptions() {
  const st = useStore();
  const list = useSubs();
  const [open, setOpenState] = useState<string | null>(lastOpen);
  const [tab, setTab] = useState<Tab>("new");
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const setOpen = (id: string) => { lastOpen = id; setOpenState(id); setTab("new"); };
  const shown = list.filter((s) => !q.trim() || s.name.toLowerCase().includes(q.toLowerCase()));
  const cur = list.find((s) => s.id === open) ?? list[0];

  if (!list.length)
    return (
      <main className="page">
        <header className="page-head"><h1>Subscriptions</h1><span className="muted">New uploads download by themselves while Goblin is open.</span></header>
        <AddCard onDone={(id) => id && setOpen(id)} />
        <div className="empty-big"><span className="dicon">{I.bell}</span><b>No subscriptions yet</b><span className="muted small">Paste a channel, playlist or podcast feed above, or use “Subscribe” in Search.</span></div>
      </main>
    );

  return (
    <main className="subs-page">
      <aside className="subs-list" aria-label="Subscriptions">
        <div className="subs-list-head">
          <h1>Subscriptions</h1>
          <div className="spacer" />
          <button className={`icon ${adding ? "on" : ""}`} aria-label="Add a subscription" title="Add a subscription" onClick={() => setAdding(!adding)}>{I.plus}</button>
        </div>
        {adding && <AddCard compact onDone={(id) => { setAdding(false); if (id) setOpen(id); }} />}
        {list.length > 6 && <input className="subs-filter" aria-label="Filter" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />}
        <div className="subs-items">
          {shown.map((s) => (
            <button key={s.id} className={`sub-item ${cur?.id === s.id ? "on" : ""}`} onClick={() => setOpen(s.id)}>
              <Pic src={s.thumbnail} className="square small round" fallback={I.bell} />
              <span className="sub-text">
                <span className="sub-name">{s.name}</span>
                <span className="muted small ell">{s.status === "checking" ? "checking…" : `checked ${ago(s.lastChecked)}`} · {store.preset(s.presetId).name.split(" · ")[0]}</span>
              </span>
              {s.status === "error" ? <span className="tag bad">Problem</span> : s.status === "paused" ? <span className="tag">Paused</span> : s.lastNew > 0 ? <span className="count">{s.lastNew} new</span> : null}
            </button>
          ))}
        </div>
        <button className="small-btn subs-checkall" onClick={() => subs.check(list.filter((s) => s.status !== "paused").map((s) => s.id))}>{I.retry} Check all now</button>
        <p className="muted small subs-note">Checked while Goblin is open (also right after it starts). Nothing runs after you quit.</p>
      </aside>
      {cur && <Detail key={cur.id} s={cur} tab={tab} setTab={setTab} presets={st.presets.map((p) => [p.id, p.name])} />}
    </main>
  );
}

function AddCard({ onDone, compact }: { onDone: (id?: string) => void; compact?: boolean }) {
  const st = useStore();
  const [text, setText] = useState("");
  const [preset, setPreset] = useState(st.settings.defaultPresetId);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const added = await subs.add(text, { presetId: preset });
    setBusy(false);
    setText("");
    toast(added.length ? `Subscribed to ${added.map((s) => s.name).join(", ")}` : "Already subscribed", added.length ? (st.settings.subCatchUp ? "Getting what's already there, then new uploads" : "Only new uploads from now on. Use “Older videos” to get earlier ones.") : undefined);
    onDone(added[0]?.id);
  };
  return (
    <section className={`card add-sub ${compact ? "compact" : ""}`}>
      <input aria-label="Channel, playlist or feed link" value={text} autoFocus placeholder="Channel, playlist or podcast feed link" spellCheck={false} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && void go()} />
      <div className="row tight">
        <Select value={preset} options={st.presets.map((p) => [p.id, p.name])} onChange={setPreset} />
        <div className="spacer" />
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void go()}>{I.bell} Subscribe</button>
      </div>
    </section>
  );
}

function Detail({ s, tab, setTab, presets }: { s: Subscription; tab: Tab; setTab: (t: Tab) => void; presets: [string, string][] }) {
  const set = (patch: Parameters<typeof subs.update>[1]) => void subs.update(s.id, patch);
  return (
    <section className="sub-detail" aria-label={s.name}>
      <header className="sub-head">
        <Pic src={s.thumbnail} className="square round" fallback={I.bell} />
        <div className="qmain">
          <div className="sub-title">{s.name}</div>
          <div className="muted small" title={s.url}>every {s.interval} min · {store.preset(s.presetId).name} · {s.seen} uploads seen{s.lastChecked ? ` · checked ${ago(s.lastChecked)}` : ""}</div>
        </div>
        <button className="small-btn" disabled={s.status === "checking"} onClick={() => subs.check([s.id])}>{I.retry} {s.status === "checking" ? "Checking…" : "Check now"}</button>
        <button className="small-btn" onClick={() => set({ status: s.status === "paused" ? "active" : "paused" })}>{s.status === "paused" ? <>{I.play} Resume</> : "Pause"}</button>
        <button className="icon" aria-label="Open the link" title="Open the link" onClick={() => void host().openUrl(s.url).catch(() => undefined)}>{I.ext}</button>
        <button className="icon" aria-label="Unsubscribe" title="Unsubscribe" onClick={async () => (await askConfirm(`Unsubscribe from ${s.name}? Files already downloaded stay.`, { okLabel: "Unsubscribe" })) && void subs.remove([s.id])}>{I.trash}</button>
      </header>
      {s.error && <div className="notice bad inline"><span>{s.error}</span></div>}
      <div className="ptabs" role="tablist">
        {([["new", "New uploads"], ["older", "Older videos"], ["rules", "Rules"]] as [Tab, string][]).map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`ptab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{l}</button>
        ))}
      </div>
      {tab === "new" && <Recent s={s} />}
      {tab === "older" && <OlderPanel s={s} />}
      {tab === "rules" && <Rules s={s} presets={presets} />}
    </section>
  );
}

/** What this subscription downloaded lately (from the queue and its history). */
function Recent({ s }: { s: Subscription }) {
  const list = useJobs().filter((j) => j.subId === s.id).slice(0, 30);
  if (!list.length)
    return <p className="muted empty-pad">Nothing downloaded from here yet. New uploads appear here after a check finds them. Want earlier ones? Open “Older videos”.</p>;
  return (
    <div className="card list">
      {list.map((j) => (
        <div className="vid-row" key={j.id}>
          <Pic src={j.thumbnail} className="qthumb" fallback={I.film} />
          <div className="qmain">
            <div className="job-title">{j.title}</div>
            <div className={`small ${j.status === "error" ? "error-text" : "muted"}`}>{j.status === "error" ? j.error : j.status === "done" ? `Done · ${ago(j.finished)}` : j.stage}</div>
          </div>
          {j.finalPath && <button className="icon" aria-label={`Show in ${fileManager}`} title={`Show in ${fileManager}`} onClick={() => void host().reveal(j.finalPath!).catch((e) => toast("Couldn't show it", errorText(e)))}>{I.folder}</button>}
        </div>
      ))}
    </div>
  );
}

function Rules({ s, presets }: { s: Subscription; presets: [string, string][] }) {
  const r = s.rules;
  const set = (patch: Parameters<typeof subs.update>[1]) => void subs.update(s.id, patch);
  return (
    <div className="card form rules-card">
      <div className="rules-grid">
        <label>Name<LazyInput value={s.name} onCommit={(v) => set({ name: v })} /></label>
        <label>Preset<Select value={s.presetId} options={presets} onChange={(v) => set({ presetId: v })} /></label>
        <label>Check every (minutes)<LazyInput type="number" value={String(s.interval)} onCommit={(v) => set({ interval: Number(v) || 60 })} /></label>
        <label>Title must match<LazyInput mono value={s.filter} placeholder="regex or words" onCommit={(v) => set({ filter: v })} /></label>
        <label>Title must include<LazyInput mono value={r.include} placeholder="e.g. episode" onCommit={(v) => set({ rules: { include: v } })} /></label>
        <label>Title must not include<LazyInput mono value={r.exclude} placeholder="e.g. trailer|teaser" onCommit={(v) => set({ rules: { exclude: v } })} /></label>
        <label>Shortest (minutes, 0 = any)<LazyInput type="number" value={String(r.minLen)} onCommit={(v) => set({ rules: { minLen: Number(v) || 0 } })} /></label>
        <label>Longest (minutes, 0 = any)<LazyInput type="number" value={String(r.maxLen)} onCommit={(v) => set({ rules: { maxLen: Number(v) || 0 } })} /></label>
        <label>Only from the last (days, 0 = any)<LazyInput type="number" value={String(r.days)} onCommit={(v) => set({ rules: { days: Number(v) || 0 } })} /></label>
        <label>At most per check (0 = all)<LazyInput type="number" value={String(r.maxPer)} onCommit={(v) => set({ rules: { maxPer: Number(v) || 0 } })} /></label>
        <label>Keep only the newest (0 = all)<LazyInput type="number" value={String(r.keep)} onCommit={(v) => set({ rules: { keep: Number(v) || 0 } })} /></label>
      </div>
      <div className="row checks">
        <label className="check"><Switch checked={r.skipShorts} onChange={(v) => set({ rules: { skipShorts: v } })} /> Skip Shorts</label>
        <label className="check"><Switch checked={r.skipLive} onChange={(v) => set({ rules: { skipLive: v } })} /> Skip live streams</label>
        <label className="check"><Switch checked={s.skipMembers} onChange={(v) => set({ skipMembers: v })} /> Skip members-only</label>
      </div>
      {r.keep > 0 && <p className="muted small">Older files from this subscription go to the Trash when a new one finishes.</p>}
    </div>
  );
}

const fmtDate = (t?: number) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

/** What's already on the channel/playlist, to download older uploads too. */
function OlderPanel({ s }: { s: Subscription }) {
  const [limit, setLimit] = useState(100);
  const [items, setItems] = useState<Older[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [hideHave, setHideHave] = useState(true);
  const [onlyRules, setOnlyRules] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const proc = uid("older");
    let live = true;
    setItems(null);
    setError("");
    subs.older(s.id, limit, proc)
      .then((list) => {
        if (!live) return;
        setItems(list);
        setSel(new Set(list.filter((e) => e.passes && !e.have).map((e) => e.id)));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; void host().kill(proc).catch(() => undefined); };
  }, [s.id, limit]);

  const shown = (items ?? []).filter((e) => (!hideHave || !e.have) && (!onlyRules || e.passes));
  const picked = (items ?? []).filter((e) => sel.has(e.id));
  const hiddenHave = (items ?? []).filter((e) => e.have).length;
  const toggle = (ids: string[], on: boolean) => { const n = new Set(sel); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); setSel(n); };

  return (
    <div className="older-panel">
      <div className="filterbar">
        {([[50, "Last 50"], [100, "Last 100"], [250, "Last 250"], [1000, "Last 1,000"], [0, "Everything"]] as [number, string][]).map(([n, l]) => (
          <button key={n} className={`chip ${limit === n ? "on" : ""}`} aria-pressed={limit === n} onClick={() => setLimit(n)}>{l}</button>
        ))}
        <span className="tabs-sep" />
        <button className={`chip ${onlyRules ? "on" : ""}`} aria-pressed={onlyRules} onClick={() => setOnlyRules(!onlyRules)}>{onlyRules && I.check} Fits the rules</button>
        <button className={`chip ${hideHave ? "on" : ""}`} aria-pressed={hideHave} onClick={() => setHideHave(!hideHave)}>{hideHave && I.check} Hide downloaded</button>
        <div className="spacer" />
        {!!shown.length && <>
          <button className="link small" onClick={() => toggle(shown.map((e) => e.id), true)}>Select all</button>
          <button className="link small" onClick={() => toggle(shown.map((e) => e.id), false)}>None</button>
        </>}
      </div>
      {s.rules.keep > 0 && <p className="note small">{I.warn} This subscription keeps only the newest {s.rules.keep}: older files go to the Trash as new ones finish. Set “Keep only the newest” to 0 under Rules to keep them all.</p>}
      {error && <p className="error-text small">{error}</p>}
      {!items && !error && <p className="muted empty-pad">Reading the list from YouTube… {limit === 0 && "(everything can take a minute for big channels)"}</p>}
      {items && !shown.length && <p className="muted empty-pad">{items.length ? "Nothing left to get here. Turn off the filters above to see everything." : "Nothing found."}</p>}
      {!!shown.length && (
        <div className="card list older-list">
          {shown.map((e) => (
            <label key={e.id} className={`older ${e.passes ? "" : "off"} ${sel.has(e.id) ? "sel" : ""}`}>
              <input type="checkbox" checked={sel.has(e.id)} onChange={(x) => toggle([e.id], x.target.checked)} />
              <Pic src={e.thumb} className="qthumb" fallback={I.film} />
              <span className="ell">{e.title}</span>
              <span className="muted small">{e.have ? "downloaded" : !e.passes ? "outside rules" : ""}</span>
              <span className="muted small num-col">{fmtDate(e.time)}</span>
              <span className="muted small num-col">{eta(e.duration)}</span>
            </label>
          ))}
        </div>
      )}
      {items && limit > 0 && items.length >= limit && <button className="link small" onClick={() => setLimit(limit < 250 ? 250 : limit < 1000 ? 1000 : 0)}>Look further back…</button>}
      {items && (
        <div className="older-foot">
          <b>{picked.length} picked</b>
          <span className="muted small">oldest first, with “{store.preset(s.presetId).name}”{hideHave && hiddenHave ? ` · ${hiddenHave} already downloaded, hidden` : ""}</span>
          <div className="spacer" />
          <button className="primary" disabled={!picked.length || busy} onClick={async () => {
            setBusy(true);
            const n = await subs.getOlder(s.id, picked);
            setBusy(false);
            setSel(new Set());
            toast(`Queued ${n} older ${n === 1 ? "video" : "videos"}`, `From ${s.name}, oldest first`);
          }}>{I.down} Download {picked.length || ""}</button>
        </div>
      )}
    </div>
  );
}
