import { useState } from "react";
import { api, duration, errorText, Hit, ToolState } from "./api";
import { enqueue } from "./queue";
import { requestFor, usePrefs } from "./prefs";

type Kind = "songs" | "videos";

// Results stay while you switch tabs.
let lastQuery = "";
let lastKind: Kind = "songs";
let lastHits: Hit[] = [];

export default function Search({ tool, onQueued }: { tool: ToolState | null; onQueued: () => void }) {
  const p = usePrefs();
  const [query, setQuery] = useState(lastQuery);
  const [kind, setKind] = useState<Kind>(lastKind);
  const [hits, setHits] = useState<Hit[]>(lastHits);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, string>>({});

  async function run(k: Kind = kind) {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.search(query, k);
      setHits(r);
      lastHits = r;
      lastQuery = query;
      lastKind = k;
      if (!r.length) setError("Nothing found.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function get(h: Hit, as: "video" | "audio") {
    enqueue([requestFor(h.url, { ...p, playlist: false }, as)], h.title);
    setAdded((a) => ({ ...a, [h.url + as]: "added" }));
  }

  return (
    <main className="page">
      <section className="card form">
        <div className="row search-row">
          <input
            className="grow"
            value={query}
            autoFocus
            placeholder={kind === "songs" ? "Search YouTube Music: song or artist" : "Search YouTube videos"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
          />
          <div className="seg">
            {(["songs", "videos"] as Kind[]).map((k) => (
              <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); if (query.trim()) void run(k); }}>
                {k === "songs" ? "Songs" : "Videos"}
              </button>
            ))}
          </div>
          <button className="primary" disabled={busy || !query.trim() || !tool?.version} onClick={() => void run()}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {hits.length > 0 && (
        <section className="card list">
          {hits.map((h) => (
            <div className="hit" key={h.url}>
              <div className={`thumb ${kind === "songs" ? "square" : ""}`}>
                {h.thumbnail ? <img src={h.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
              </div>
              <div className="job-main">
                <div className="job-title">{h.title}</div>
                <div className="muted small">{[h.channel, duration(h.duration)].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="job-actions">
                {(["audio", "video"] as const).map((as) => {
                  const done = added[h.url + as];
                  return (
                    <button key={as} className={done ? "added" : as === (kind === "songs" ? "audio" : "video") ? "soft" : ""} disabled={!!done || !tool?.folder}
                      onClick={() => { get(h, as); onQueued(); }}>
                      {done ? "✓ In queue" : as === "audio" ? "↓ Music" : "↓ Video"}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
