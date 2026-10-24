import { useState } from "react";
import { api, errorText, fileManager, isMac, ToolState } from "./api";
import { cancel, clearFinished, enqueue, Job, remove, retry, splitLinks, useJobs } from "./queue";
import { Prefs, requestFor, setPrefs, usePrefs } from "./prefs";

export default function Download({ tool }: { tool: ToolState | null }) {
  const p = usePrefs();
  const jobs = useJobs();
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const ready = !!tool?.version && !!tool?.folder;

  function start() {
    const { links, bad } = splitLinks(text);
    if (!links.length) {
      setMessage({ text: "Paste a web address starting with https://", error: true });
      return;
    }
    const added = enqueue(links.map((l) => requestFor(l, p)));
    const skipped = links.length - added;
    setText(bad.join("\n"));
    setMessage(
      bad.length
        ? { text: `${bad.length === 1 ? "This line is" : "These lines are"} not a web address and stayed in the box.`, error: true }
        : skipped
          ? { text: `${skipped} ${skipped === 1 ? "link is" : "links are"} already in the queue.`, error: false }
          : null,
    );
  }

  const set = (patch: Partial<Prefs>) => setPrefs(patch);
  const counts = {
    running: jobs.filter((j) => j.state === "running").length,
    waiting: jobs.filter((j) => j.state === "waiting").length,
    finished: jobs.filter((j) => j.state !== "running" && j.state !== "waiting").length,
  };

  return (
    <main className="page">
      <section className="card form">
        <textarea
          className="links"
          value={text}
          rows={3}
          spellCheck={false}
          autoFocus
          placeholder="Paste links here, one per line: YouTube, YouTube Music, SoundCloud, Vimeo, …"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (ready) start();
            }
          }}
        />
        <div className="row">
          <div className="seg big">
            <button className={p.kind === "video" ? "on" : ""} onClick={() => set({ kind: "video" })}>Video</button>
            <button className={p.kind === "audio" ? "on" : ""} onClick={() => set({ kind: "audio" })}>Music</button>
          </div>
          {p.kind === "video" ? (
            <>
              <label className="wide-label">Quality
                <select value={p.maxHeight} onChange={(e) => set({ maxHeight: Number(e.target.value) })}>
                  {[2160, 1440, 1080, 720, 480].map((h) => <option key={h} value={h}>Up to {h === 2160 ? "4K" : `${h}p`}</option>)}
                </select>
              </label>
              <label className="wide-label">File type
                <select value={p.videoFormat} onChange={(e) => set({ videoFormat: e.target.value as Prefs["videoFormat"] })}>
                  <option value="mp4">MP4 (plays everywhere)</option>
                  <option value="mkv">MKV</option>
                </select>
              </label>
            </>
          ) : (
            <label className="wide-label">File type
              <select value={p.audioFormat} onChange={(e) => set({ audioFormat: e.target.value as Prefs["audioFormat"] })}>
                <option value="m4a">M4A (best for Apple)</option>
                <option value="mp3">MP3 (plays everywhere)</option>
                <option value="opus">Opus</option>
                <option value="flac">FLAC</option>
              </select>
            </label>
          )}
          <label className="wide-label">File names
            <select value={p.naming} onChange={(e) => set({ naming: e.target.value as Prefs["naming"] })}>
              <option value="title">{p.kind === "video" ? "Title [id]" : "Artist - Title"}</option>
              <option value="channel">{p.kind === "video" ? "Folder per channel" : "Folder per artist"}</option>
            </select>
          </label>
        </div>
        <div className="row checks">
          <label className="check"><input type="checkbox" checked={p.playlist} onChange={(e) => set({ playlist: e.target.checked })} />Whole playlist or album</label>
          <label className="check"><input type="checkbox" checked={p.sponsorblock} onChange={(e) => set({ sponsorblock: e.target.checked })} />Cut sponsor segments</label>
          {p.kind === "video" && (
            <>
              <label className="check"><input type="checkbox" checked={p.subtitles} onChange={(e) => set({ subtitles: e.target.checked })} />Subtitles</label>
              {p.subtitles && (
                <input className="langs" value={p.langs} onChange={(e) => set({ langs: e.target.value })} placeholder="en, nl" title="Subtitle languages" />
              )}
            </>
          )}
          <div className="spacer" />
          <span className="muted small">{isMac ? "⌘" : "Ctrl"}+Enter</span>
          <button className="primary" disabled={!ready || !text.trim()} onClick={start}>Download</button>
        </div>
        {message && <p className={message.error ? "error" : "note"}>{message.text}</p>}
      </section>

      <section className="card list">
        <div className="row list-head">
          <h2>Queue</h2>
          <span className="muted small">
            {counts.running} downloading{counts.waiting ? ` · ${counts.waiting} waiting` : ""}
          </span>
          <div className="spacer" />
          <button className="link" onClick={() => void api.reveal(null).catch((e) => setMessage({ text: errorText(e), error: true }))}>Open folder</button>
          {counts.finished > 0 && <button className="link" onClick={clearFinished}>Clear finished</button>}
        </div>
        {jobs.length === 0 && <p className="muted empty">Nothing here yet. Paste a link above, or find something on the Search tab.</p>}
        {jobs.map((j) => <JobRow key={j.key} j={j} onError={(t) => setMessage({ text: t, error: true })} />)}
      </section>
    </main>
  );
}

function JobRow({ j, onError }: { j: Job; onError: (t: string) => void }) {
  const live = j.state === "running";
  const detail = live
    ? [j.item && `Item ${j.item}`, j.percent ? `${j.percent.toFixed(0)}%` : "", j.speed, j.eta && `${j.eta} left`].filter(Boolean).join(" · ")
    : "";
  const last = j.files[j.files.length - 1];
  return (
    <div className={`job ${j.state}`}>
      <span className={`kind ${j.req.kind}`} title={j.req.kind === "audio" ? "Music" : "Video"}>{j.req.kind === "audio" ? "♪" : "▶"}</span>
      <div className="job-main">
        <div className="job-title" title={j.req.url}>{j.title}</div>
        {(live || j.state === "waiting") && (
          <div className="progress"><span style={{ width: `${Math.max(live ? 2 : 0, Math.min(100, j.percent))}%` }} /></div>
        )}
        <div className={`small ${j.state === "failed" ? "error-text" : "muted"} job-text`}>
          {detail && <span className="mono">{detail}</span>}
          {detail && " · "}
          {live && j.item && j.current ? j.current : j.text}
          {j.state === "done" && j.files.length > 1 ? ` · ${j.files.length} files` : ""}
        </div>
      </div>
      <div className="job-actions">
        {j.state === "done" && last && (
          <button onClick={() => void api.reveal(last).catch((e) => onError(errorText(e)))}>Show in {fileManager}</button>
        )}
        {(live || j.state === "waiting") && <button onClick={() => cancel(j.key)}>Cancel</button>}
        {(j.state === "failed" || j.state === "cancelled") && <button onClick={() => retry(j.key)}>Retry</button>}
        {!live && j.state !== "waiting" && <button className="icon" title="Remove from list" onClick={() => remove(j.key)}>✕</button>}
      </div>
    </div>
  );
}
