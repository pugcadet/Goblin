import { useState } from "react";
import { api, errorText, fileManager, isMac, ToolState } from "./api";
import { getParallel, setParallel } from "./queue";

const BROWSERS: [string, string][] = [
  ["", "Off"],
  ["firefox", "Firefox"],
  ["chrome", "Chrome"],
  ["edge", "Edge"],
  ["brave", "Brave"],
  ["safari", "Safari"],
  ["chromium", "Chromium"],
  ["opera", "Opera"],
  ["vivaldi", "Vivaldi"],
];

export default function Settings({ tool, onChanged, onUpdate, updating }: {
  tool: ToolState | null;
  onChanged: () => void;
  onUpdate: () => void;
  updating: boolean;
}) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [parallel, setPar] = useState(getParallel());

  async function act(f: () => Promise<unknown>) {
    setMessage(null);
    try {
      await f();
      onChanged();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  const ok = (v: string | null | undefined) => (v ? <span className="okmark">✓</span> : <span className="error-text">missing</span>);

  return (
    <main className="page narrow">
      {message && <p className={message.error ? "error" : "note"}>{message.text}</p>}

      <section className="card form">
        <h2>Downloads</h2>
        <div className="setting">
          <div><div>Save to</div><div className="muted small mono path-text">{tool?.folder ?? "No folder chosen"}</div></div>
          <div className="row tight">
            <button onClick={() => void act(api.pickDownloadFolder)}>Choose…</button>
            <button disabled={!tool?.folder} onClick={() => void act(() => api.reveal(null))}>Open in {fileManager}</button>
          </div>
        </div>
        <div className="setting">
          <div><div>Downloads at once</div><div className="muted small">More links wait in the queue and start by themselves.</div></div>
          <select value={parallel} onChange={(e) => { setParallel(Number(e.target.value)); setPar(getParallel()); }}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </section>

      <section className="card form">
        <h2>YouTube sign-in</h2>
        <div className="setting">
          <div>
            <div>Use cookies from</div>
            <div className="muted small">
              Only needed when YouTube asks you to sign in (age-restricted videos, “confirm you're not a bot”). Sign in to YouTube in that browser first.
              {" "}{isMac ? "Safari needs Full Disk Access for Goblin." : "On Windows, Firefox works best; Chrome and Edge often block this."}
            </div>
          </div>
          <select value={tool?.cookies ?? ""} onChange={(e) => void act(() => api.setCookies(e.target.value || null))}>
            {BROWSERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </section>

      <section className="card form">
        <h2>Tools</h2>
        <div className="setting">
          <div>
            <div>yt-dlp {ok(tool?.version)}</div>
            <div className="muted small mono">{tool?.version ?? "Not installed"}{tool?.version && !tool.managed ? " · installed on this computer" : ""}</div>
            <div className="muted small">Goblin checks for a new version every few days. Downloads are checked against yt-dlp's published checksum.</div>
          </div>
          <button disabled={updating} onClick={onUpdate}>{updating ? "Updating…" : tool?.version ? "Update now" : "Install"}</button>
        </div>
        <div className="setting">
          <div><div>ffmpeg {ok(tool?.ffmpeg)}</div><div className="muted small">Joins video and sound, converts music. Comes with Goblin.</div></div>
        </div>
        <div className="setting">
          <div><div>deno {ok(tool?.deno)}</div><div className="muted small">Lets yt-dlp see every YouTube quality. Comes with Goblin.</div></div>
        </div>
      </section>

      <p className="muted small">Goblin 1.0 · everything runs on this computer: no account, no server, nothing in the background after you quit.</p>
    </main>
  );
}
