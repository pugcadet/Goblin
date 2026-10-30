import { useState } from "react";
import { askConfirm } from "../confirm";
import { host } from "../engine/host";
import { Subscription } from "../engine/model";
import { store } from "../engine/store";
import { subs } from "../engine/subs";
import { ago, I, LazyInput, Pic, Select, Switch, toast, useStore, useSubs } from "../ui";

export default function Subscriptions() {
  const st = useStore();
  const list = useSubs();
  const [text, setText] = useState("");
  const [preset, setPreset] = useState(st.settings.defaultPresetId);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

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
        {list.map((s) => <SubRow key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />)}
      </section>
    </main>
  );
}

function SubRow({ s, open, onToggle }: { s: Subscription; open: boolean; onToggle: () => void }) {
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
