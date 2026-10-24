import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorText, ToolState } from "./api";
import { activeCount, cancelAll, useJobs } from "./queue";
import { askConfirm } from "./confirm";
import Download from "./Download";
import Search from "./Search";
import Settings from "./Settings";

type View = "download" | "search" | "settings";
const TABS: [View, string][] = [["download", "Download"], ["search", "Search"], ["settings", "Settings"]];

const UPDATE_KEY = "goblin-ytdlp-checked";
const UPDATE_EVERY = 3 * 24 * 3600 * 1000;

export default function App() {
  const [view, setView] = useState<View>("download");
  const [tool, setTool] = useState<ToolState | null>(null);
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const jobs = useJobs();
  const running = jobs.filter((j) => j.state === "running").length;
  const waiting = jobs.filter((j) => j.state === "waiting").length;

  const refresh = useCallback(async () => {
    try {
      const t = await api.ytdlpInfo();
      setTool(t);
      return t;
    } catch (e) {
      setNotice({ text: errorText(e), error: true });
      return null;
    }
  }, []);

  const install = useCallback(async (quiet: boolean) => {
    setUpdating(true);
    if (!quiet) setNotice({ text: "Getting the newest yt-dlp…", error: false });
    try {
      const v = await api.ytdlpInstall();
      try {
        localStorage.setItem(UPDATE_KEY, String(Date.now()));
      } catch {
        /* not essential */
      }
      if (!quiet) setNotice({ text: `yt-dlp ${v} is ready.`, error: false });
    } catch (e) {
      if (!quiet) setNotice({ text: `Could not get yt-dlp: ${errorText(e)}`, error: true });
    } finally {
      setUpdating(false);
      await refresh();
    }
  }, [refresh]);

  // First start: get yt-dlp. Later: quietly update it every few days (YouTube changes often).
  useEffect(() => {
    void (async () => {
      const t = await refresh();
      if (!t) return;
      if (!t.version) return void install(false);
      let last = 0;
      try {
        last = Number(localStorage.getItem(UPDATE_KEY) ?? 0);
      } catch {
        /* not essential */
      }
      if (t.managed && Date.now() - last > UPDATE_EVERY) void install(true);
      if (!t.managed && !last) {
        try {
          localStorage.setItem(UPDATE_KEY, String(Date.now()));
        } catch {
          /* not essential */
        }
      }
    })();
  }, [refresh, install]);

  // Closing the window quits Goblin; ask first when downloads are still busy.
  useEffect(() => {
    const w = getCurrentWindow();
    const off = w.onCloseRequested(async (e) => {
      if (activeCount() === 0) return;
      e.preventDefault();
      if (await askConfirm("Downloads are still busy. Quit Goblin and stop them? Half-finished downloads continue next time you add the same link.", { okLabel: "Quit", danger: true })) {
        cancelAll();
        await w.destroy();
      }
    });
    return () => void off.then((f) => f());
  }, []);

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo">↓</span>Goblin</div>
        <nav className="nav">
          {TABS.map(([id, label]) => (
            <button key={id} className={view === id ? "on" : ""} onClick={() => setView(id)}>
              {label}
              {id === "download" && running + waiting > 0 && <span className="count">{running + waiting}</span>}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {tool?.version && <span className="muted small mono">yt-dlp {tool.version}</span>}
      </header>
      {notice && (
        <div className={`notice ${notice.error ? "bad" : ""}`}>
          <span>{notice.text}</span>
          <button className="link" onClick={() => setNotice(null)}>Hide</button>
        </div>
      )}
      {tool && !tool.ffmpeg && (
        <div className="notice bad"><span>ffmpeg is missing, so video and sound can't be joined. Reinstall Goblin to get it back.</span></div>
      )}
      {view === "download" && <Download tool={tool} />}
      {view === "search" && <Search tool={tool} onQueued={() => undefined} />}
      {view === "settings" && <Settings tool={tool} onChanged={() => void refresh()} onUpdate={() => void install(false)} updating={updating} />}
    </div>
  );
}
