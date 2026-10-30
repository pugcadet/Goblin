import { useEffect, useState } from "react";
import { askConfirm } from "../confirm";
import { host, uid } from "../engine/host";
import { Subscription } from "../engine/model";
import { store } from "../engine/store";
import { Older, subs } from "../engine/subs";
import { eta } from "../engine/text";
import { ago, I, LazyInput, Modal, Pic, Select, Switch, toast, useStore, useSubs } from "../ui";

export default function Subscriptions() {
  const st = useStore();
  const list = useSubs();
  const [text, setText] = useState("");
  const [preset, setPreset] = useState(st.settings.defaultPresetId);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [older, setOlder] = useState<Subscription | null>(null);

  return (
    <main className="page">
      <section className="card form">
        <div className="row search-row">
          <input className="grow" value={text} placeholder="Channel, playlist or podcast feed link" spellCheck={false} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && document.getElementById("subAdd")?.click()} />
          <Select value={preset} options={st.presets.map((p) => [p.id, p.name])} onChange={setPreset} />
          <button id="subAdd" className="primary" disabled={busy || !text.trim()} onClick={async () => {
            setBusy(true);
            const added = await subs.add(text, { presetId: preset });
            setBusy(false);
            setText("");
            toast(added.length ? `Subscribed to ${added.map((s) => s.name).join(", ")}` : "Already subscribed", added.length ? (st.settings.subCatchUp ? "Getting what's already there, then new uploads" : "Only new uploads from now on") : undefined);
          }}>{I.bell} Subscribe</button>
        </div>
        <p className="muted small">Checked while Goblin is open (also right after it starts). Nothing runs in the background after you quit.</p>
      </section>

      <section className="card list">
        <div className="row list-head">
          <h2>Subscriptions</h2>
          <span className="badge">{list.length}</span>
          <div className="spacer" />
          {list.length > 0 && <button className="small-btn" onClick={() => subs.check(list.filter((s) => s.status !== "paused").map((s) => s.id))}>{I.retry} Check all now</button>}
        </div>
        {!list.length && <p className="muted empty">No subscriptions yet. Paste a channel, playlist or podcast feed above, or use “Subscribe” in Search.</p>}
        {list.map((s) => <SubRow key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} onOlder={() => setOlder(s)} />)}
      </section>
      {older && <OlderModal s={older} onClose={() => setOlder(null)} />}
    </main>
  );
}

function SubRow({ s, open, onToggle, onOlder }: { s: Subscription; open: boolean; onToggle: () => void; onOlder: () => void }) {
  const st = useStore();
  const r = s.rules;
  const set = (patch: Parameters<typeof subs.update>[1]) => void subs.update(s.id, patch);
  const status = s.status === "checking" ? "Checking…" : s.status === "paused" ? "Paused" : s.status === "error" ? "Problem" : "Active";
  return (
    <div className="sub">
      <div className="job">
        <Pic src={s.thumbnail} className="square round" fallback={I.bell} />
        <div className="job-main">
          <div className="job-title">{s.name}</div>
          <div className="muted small job-text">
            <span className={`pill ${s.status === "error" ? "bad" : s.status === "active" ? "ok" : ""}`}>{status}</span>{" "}
            every {s.interval} min · checked {ago(s.lastChecked)}{s.lastChecked ? ` · ${s.lastNew} new` : ""} · {s.seen} seen · {store.preset(s.presetId).name}
          </div>
          {s.error && <div className="error-text small">{s.error}</div>}
        </div>
        <div className="job-actions">
          <button className="small-btn" disabled={s.status === "checking"} onClick={() => subs.check([s.id])}>{I.retry} Check now</button>
          <button className="small-btn" onClick={() => set({ status: s.status === "paused" ? "active" : "paused" })}>{s.status === "paused" ? "Resume" : "Pause"}</button>
          <button className="small-btn" onClick={onOlder} title="Pick older uploads to download">{I.down} Older videos…</button>
          <button className={`small-btn ${open ? "soft" : ""}`} onClick={onToggle}>{I.sliders} Rules</button>
          <button className="icon" title="Open the link" onClick={() => void host().openUrl(s.url).catch(() => undefined)}>{I.ext}</button>
          <button className="icon" title="Unsubscribe" onClick={async () => (await askConfirm(`Unsubscribe from ${s.name}? Files already downloaded stay.`, { okLabel: "Unsubscribe" })) && void subs.remove([s.id])}>{I.trash}</button>
        </div>
      </div>
      {open && (
        <div className="rules">
          <div className="rules-grid">
            <label>Name<LazyInput value={s.name} onCommit={(v) => set({ name: v })} /></label>
            <label>Preset<Select value={s.presetId} options={st.presets.map((p) => [p.id, p.name])} onChange={(v) => set({ presetId: v })} /></label>
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
      )}
    </div>
  );
}

const fmtDate = (t?: number) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

/** Lists what's already on the channel/playlist so you can download older uploads too. */
function OlderModal({ s, onClose }: { s: Subscription; onClose: () => void }) {
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
  const toggle = (ids: string[], on: boolean) => { const n = new Set(sel); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); setSel(n); };

  return (
    <Modal wide title={<>Older videos · {s.name}</>} onClose={onClose} footer={<>
      <span className="muted small grow-text">{picked.length} picked · downloaded with “{store.preset(s.presetId).name}”</span>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!picked.length || busy} onClick={async () => {
        setBusy(true);
        const n = await subs.getOlder(s.id, picked);
        toast(`Queued ${n} older ${n === 1 ? "video" : "videos"}`, `From ${s.name}, oldest first`);
        onClose();
      }}>{I.down} Download {picked.length || ""}</button>
    </>}>
      <div className="row checks">
        <label className="check">Look at the newest <Select value={limit} options={[[50, "50"], [100, "100"], [250, "250"], [1000, "1,000"], [0, "everything"]]} onChange={setLimit} /></label>
        <label className="check"><Switch checked={onlyRules} onChange={setOnlyRules} /> Only what fits the rules</label>
        <label className="check"><Switch checked={hideHave} onChange={setHideHave} /> Hide downloaded</label>
        <div className="spacer" />
        {!!shown.length && <>
          <button className="link small" onClick={() => toggle(shown.map((e) => e.id), true)}>Select all</button>
          <button className="link small" onClick={() => toggle(shown.map((e) => e.id), false)}>None</button>
        </>}
      </div>
      {s.rules.keep > 0 && <p className="muted small">{I.warn} This subscription keeps only the newest {s.rules.keep}: older files go to the Trash as new ones finish. Set “Keep only the newest” to 0 in Rules to keep them all.</p>}
      {error && <p className="error-text small">{error}</p>}
      {!items && !error && <p className="muted">Reading the list from YouTube… {limit === 0 && "(everything can take a minute for big channels)"}</p>}
      {items && !shown.length && <p className="muted empty">{items.length ? "Nothing left to get here. Turn off the filters above to see everything." : "Nothing found."}</p>}
      {!!shown.length && (
        <div className="tracks older-list">
          {shown.map((e) => (
            <label key={e.id} className={`older ${e.passes ? "" : "off"}`}>
              <input type="checkbox" checked={sel.has(e.id)} onChange={(x) => toggle([e.id], x.target.checked)} />
              <Pic src={e.thumb} className="thumb-sm" fallback={I.film} />
              <span className="ell">{e.title}</span>
              <span className="muted small">{e.have ? "downloaded" : !e.passes ? "outside rules" : ""}</span>
              <span className="muted small num-col">{fmtDate(e.time)}</span>
              <span className="muted small num-col">{eta(e.duration)}</span>
            </label>
          ))}
        </div>
      )}
      {items && limit > 0 && items.length >= limit && <button className="link small" onClick={() => setLimit(limit < 250 ? 250 : limit < 1000 ? 1000 : 0)}>Look further back…</button>}
    </Modal>
  );
}
