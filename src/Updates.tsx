// In-app updates of Goblin itself (same flow as Media Hub's Updates.tsx).
import { useEffect, useState } from "react";
import { api, errorText, isMac, UpdateInfo } from "./api";
import { askConfirm } from "./confirm";
import { jobs } from "./engine/jobs";

async function install(info: UpdateInfo): Promise<void> {
  const busy = jobs.activeCount() > 0 ? " Downloads that are still busy stop; Retry continues them later." : "";
  const ok = await askConfirm(
    `Update Goblin from ${info.current} to ${info.latest}? ${isMac ? "Goblin downloads the new version, checks it, replaces itself and restarts." : "Goblin downloads the installer, checks it and starts it; Goblin closes while it installs."}${busy}`,
    { okLabel: "Update now" },
  );
  if (ok) {
    jobs.cancelAll();
    await jobs.saveNow();
    await api.installUpdate();
  }
}

/** Settings block: this version, the newest one, and a manual check. */
export function UpdateSettings() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = () => {
    setBusy("Checking…");
    setError(null);
    api.checkUpdate().then(setInfo).catch((e) => setError(errorText(e))).finally(() => setBusy(null));
  };
  useEffect(check, []);
  return (
    <section className="card form">
      <h2>Goblin updates</h2>
      <div className="setting">
        <div>
          <div>Version {info?.current ?? "…"}</div>
          <div className="muted small">
            {info ? (info.available ? `Goblin ${info.latest} is out.` : `You have the newest version${info.latest ? ` (${info.latest})` : ""}.`) : "Checks GitHub for a newer Goblin."}
            {" "}Updates are checked against their published checksum before they're installed.
          </div>
          {error && <div className="error small">{error}</div>}
        </div>
        <div className="row tight">
          <button disabled={!!busy} onClick={check}>{busy === "Checking…" ? "Checking…" : "Check"}</button>
          {info?.available && (
            <button className="primary" disabled={!!busy} onClick={() => {
              setBusy("Updating…");
              install(info).catch((e) => setError(errorText(e))).finally(() => setBusy(null));
            }}>{busy === "Updating…" ? "Downloading…" : `Update to ${info.latest}`}</button>
          )}
        </div>
      </div>
      {info?.available && info.notes && <p className="muted small notes">{info.notes.slice(0, 600)}</p>}
    </section>
  );
}

/** Shown once, a few seconds after start, when a new version is out. */
export function UpdateToast() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => api.checkUpdate().then(setInfo).catch(() => setInfo(null)), 4000);
    return () => window.clearTimeout(t);
  }, []);
  if (!info?.available || hidden) return null;
  return (
    <div className="update-toast" role="status">
      <div className="strong">Goblin {info.latest} is out</div>
      <div className="muted small">
        You have {info.current}.
        {info.notes ? <> <button className="link small" onClick={() => setNotes(!notes)}>{notes ? "Hide" : "What's new"}</button></> : null}
      </div>
      {notes && <div className="small notes">{info.notes.slice(0, 800)}</div>}
      {error && <div className="error small">{error}</div>}
      <div className="row end tight">
        <button onClick={() => setHidden(true)}>Later</button>
        <button className="primary" disabled={busy} onClick={() => {
          setBusy(true);
          install(info).catch((e) => setError(errorText(e))).finally(() => setBusy(false));
        }}>{busy ? "Updating…" : "Update now"}</button>
      </div>
    </div>
  );
}
