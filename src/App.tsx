import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorText, ToolState } from "./api";
import { askConfirm } from "./confirm";
import { setHost } from "./engine/host";
import { jobs } from "./engine/jobs";
import { store } from "./engine/store";
import { subs } from "./engine/subs";
import { tauriHost } from "./engine/tauri";
import { UpdateToast } from "./Updates";
import { I, toast, Toasts, useJobs, useStore, useSubs } from "./ui";
import Downloads from "./screens/Downloads";
import Search from "./screens/Search";
import Subscriptions from "./screens/Subscriptions";
import FixMusic from "./screens/FixMusic";
import Presets from "./screens/Presets";
import Settings from "./screens/Settings";

type View = "downloads" | "search" | "subs" | "fix" | "presets" | "settings";
const TABS: [View, string][] = [["downloads", "Downloads"], ["search", "Search"], ["subs", "Subscriptions"], ["fix", "Fix music"], ["presets", "Presets"], ["settings", "Settings"]];
const UPDATE_KEY = "goblin-ytdlp-checked";
const UPDATE_EVERY = 3 * 24 * 3600 * 1000;

setHost(tauriHost);

/** Links that arrived through goblin:// (the bookmarklet) go straight into the queue. */
async function takeLinks() {
  for (const raw of await api.linksTake().catch(() => [] as string[])) {
    try {
      const { url, preset } = JSON.parse(raw) as { url: string; preset: string };
      const p = preset || (url.includes("music.youtube.com") ? store.presets.find((x) => x.kind === "music" && !x.podcast)?.id ?? "" : store.settings.defaultPresetId);
      const added = jobs.add(url, { presetId: p });
      toast(added.length ? "Added from your browser" : "Already in the queue", added[0]?.title ?? url);
    } catch {
      /* not a link */
    }
  }
}

export default function App() {
  const [view, setView] = useState<View>("downloads");
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolState | null>(null);
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const st = useStore();
  const list = useJobs();
  const subList = useSubs();
  const active = list.filter((j) => ["working", "downloading", "review", "queued"].includes(j.status)).length;
  const review = list.filter((j) => j.status === "review").length;

  const refresh = useCallback(async () => {
    try {
      const t = await api.ytdlpInfo();
      setTool(t);
      await store.refreshInfo();
      jobs.setReady(!!t.version);
      return t;
    } catch (e) {
      setNotice({ text: errorText(e), bad: true });
      return null;
    }
  }, []);

  const install = useCallback(async (quiet: boolean) => {
    setUpdating(true);
    if (!quiet) setNotice({ text: "Getting the newest yt-dlp…", bad: false });
    try {
      const v = await api.ytdlpInstall();
      try {
        localStorage.setItem(UPDATE_KEY, String(Date.now()));
      } catch {
        /* not essential */
      }
      if (!quiet) setNotice({ text: `yt-dlp ${v} is ready.`, bad: false });
    } catch (e) {
      if (!quiet) setNotice({ text: `Couldn't get yt-dlp: ${errorText(e)}`, bad: true });
    } finally {
      setUpdating(false);
      await refresh();
    }
  }, [refresh]);

  // Start-up: settings and presets, the download history, subscriptions, yt-dlp.
  useEffect(() => {
    void (async () => {
      try {
        await store.load();
        await jobs.load();
        await subs.load();
      } catch (e) {
        setFatal(errorText(e));
        return;
      }
      setReady(true);
      const t = await refresh();
      subs.start();
      void takeLinks();
      if (!t) return;
      if (!t.version) return void install(false);
      let last = 0;
      try {
        last = Number(localStorage.getItem(UPDATE_KEY) ?? 0);
      } catch {
        /* not essential */
      }
      // YouTube changes often: a fresh yt-dlp every few days keeps downloads working.
      if (t.managed && store.settings.autoUpdate && Date.now() - last > UPDATE_EVERY && jobs.activeCount() === 0) void install(true);
    })();
    const offLink = listen("goblin-link", () => void takeLinks());
    const clear = setInterval(() => jobs.autoClear(), 60_000);
    return () => {
      void offLink.then((f) => f());
      clearInterval(clear);
    };
  }, [refresh, install]);

  // Closing the window quits Goblin; ask first when downloads are busy.
  useEffect(() => {
    const w = getCurrentWindow();
    const off = w.onCloseRequested(async (e) => {
      await jobs.saveNow();
      if (jobs.activeCount() === 0) return;
      e.preventDefault();
      if (await askConfirm("Downloads are still busy. Quit Goblin and stop them? They're kept in the list; Retry continues them next time.", { okLabel: "Quit", danger: true })) {
        jobs.cancelAll();
        await jobs.saveNow();
        await w.destroy();
      }
    });
    return () => void off.then((f) => f());
  }, []);

  if (fatal) return <div className="center"><p className="error">{fatal}</p></div>;
  if (!ready) return <div className="center"><p className="muted">Starting…</p></div>;
  const overall = jobs.overall();
  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo">{I.down}</span>Goblin</div>
        <nav className="nav">
          {TABS.map(([id, label]) => (
            <button key={id} className={view === id ? "on" : ""} onClick={() => setView(id)}>
              {label}
              {id === "downloads" && active > 0 && <span className="count">{active}</span>}
              {id === "downloads" && review > 0 && <span className="count warn" title="Waiting for you">{review}</span>}
              {id === "subs" && subList.length > 0 && <span className="count grey">{subList.length}</span>}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {overall != null && <span className="muted small mono">{Math.round(overall * 100)}%</span>}
        {tool?.version && <span className="muted small mono" title="yt-dlp version">yt-dlp {tool.version}</span>}
      </header>
      {notice && (
        <div className={`notice ${notice.bad ? "bad" : ""}`}>
          <span>{notice.text}</span>
          <button className="link" onClick={() => setNotice(null)}>Hide</button>
        </div>
      )}
      {tool && !tool.ffmpeg && <div className="notice bad"><span>ffmpeg is missing, so video and sound can't be joined. Reinstall Goblin to get it back.</span></div>}
      {st.info && !st.info.library && <div className="notice"><span>Choose where Goblin saves everything.</span><button className="link" onClick={() => setView("settings")}>Settings → Library</button></div>}
      {view === "downloads" && <Downloads />}
      {view === "search" && <Search />}
      {view === "subs" && <Subscriptions />}
      {view === "fix" && <FixMusic />}
      {view === "presets" && <Presets />}
      {view === "settings" && <Settings tool={tool} onRefresh={() => void refresh()} onUpdateYtDlp={() => void install(false)} updating={updating} />}
      <UpdateToast />
      <Toasts />
    </div>
  );
}
