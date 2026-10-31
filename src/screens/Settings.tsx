import { ReactNode, useEffect, useState } from "react";
import { api, CookieState, errorText, isMac, ToolState } from "../api";
import { host, isAbsolute } from "../engine/host";
import { Settings as S } from "../engine/model";
import { store } from "../engine/store";
import { fill, folderParts } from "../engine/text";
import { UpdateSettings } from "../Updates";
import { I, LazyInput, Row, Select, Switch, tildify, toast, useStore } from "../ui";
import { OPTS } from "./Downloads";

// Fields you can click into a name pattern, per kind, with an example value.
const NAMING: Record<string, [string, string, string][]> = {
  video: [["{title}", "Title", "How It's Made"], ["{channel}", "Channel", "Veritasium"], ["{date}", "Date", "2024-05-01"], ["{year}", "Year", "2024"], ["{id}", "Video id", "dQw4w9WgXcQ"], ["{playlist}", "Playlist", "Best of"], ["{index}", "Number in playlist", "03"]],
  track: [["{track}", "Track #", "08"], ["{title}", "Title", "Get Lucky"], ["{artist}", "Artist", "Daft Punk"], ["{album}", "Album", "Random Access Memories"], ["{year}", "Year", "2013"], ["{disc}", "Disc", "1"]],
  ytfolder: [["{channel}", "Channel", "Veritasium"], ["{year}", "Year", "2024"], ["{playlist}", "Playlist", "Best of"], ["{uploader}", "Uploader", "Veritasium"]],
  musicfolder: [["{albumartist}", "Album artist", "Daft Punk"], ["{artist}", "Artist", "Daft Punk"], ["{album}", "Album", "Random Access Memories"], ["{year}", "Year", "2013"], ["{genre}", "Genre", "Electronic"]],
};

function example(t: string, kind: string): string {
  const vals = Object.fromEntries(NAMING[kind].map(([k, , ex]) => [k.slice(1, -1), ex]));
  if (kind.endsWith("folder")) return folderParts(t, vals, "{x}").join(" / ") + " /";
  return fill(t, vals, "{title}") + (kind === "track" ? ".mp3" : ".mp4");
}

/** A name pattern with click-to-add fields and a live example (Settings → Library & naming, Fix music). */
export function NamingInput({ value, kind, onChange, allowEmpty }: { value: string; kind: "video" | "track" | "ytfolder" | "musicfolder"; onChange: (v: string) => void; allowEmpty?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = (x: string) => {
    setV(x);
    onChange(x);
  };
  const folder = kind.endsWith("folder");
  return (
    <div className="naming">
      <input className="mono" value={v} spellCheck={false} placeholder={allowEmpty ? "(keep current names)" : undefined} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v)} />
      <div className="chips">
        {NAMING[kind].map(([k, l]) => <button key={k} className="chip" onClick={() => commit((v + (v && !/[\s/-]$/.test(v) ? " " : "") + k).trim())}>+ {l}</button>)}
        <button className="chip" onClick={() => commit(v + " - ")}>+ “ - ”</button>
        {folder && <button className="chip" onClick={() => commit(v.replace(/\s+$/, "") + "/")}>+ “/” sub-folder</button>}
        <button className="chip" onClick={() => commit(allowEmpty ? "" : folder ? "" : "{title}")}>{allowEmpty ? "Keep names" : "Clear"}</button>
      </div>
      <div className="muted small">Example: <span className="mono example">{v.trim() || !allowEmpty ? example(v, kind) : "(unchanged)"}</span></div>
    </div>
  );
}

type Page = "folders" | "downloads" | "music" | "subs" | "account" | "look" | "advanced" | "updates";
const PAGES: [Page, string, string][] = [
  ["folders", "Folders & names", "library folder nas sub-folder type videos music podcasts names pattern file name template default preset"],
  ["downloads", "Downloads", "auto-detect preview parallel connections at once auto start playlist limit remember archive clear delete bookmarklet browser"],
  ["music", "Music", "loudness replaygain lyrics musicbrainz contact unsure confidence"],
  ["subs", "Subscriptions", "subscriptions interval check back-catalog newest"],
  ["account", "YouTube account", "youtube sign-in sign out cookies age-restricted members browser"],
  ["look", "Appearance", "compact group albums list look"],
  ["advanced", "Advanced", "yt-dlp ffmpeg deno update version global options speed limit rate templates original title"],
  ["updates", "Updates", "updates version goblin"],
];
let lastPage: Page = "folders";
/** Opens Settings on a given page next time it shows (the side menu's status box). */
export const settingsPage = (p: Page) => void (lastPage = p);

export default function Settings({ tool, onRefresh, onUpdateYtDlp, updating }: { tool: ToolState | null; onRefresh: () => void; onUpdateYtDlp: () => void; updating: boolean }) {
  const st = useStore();
  const s = st.settings;
  const set = (patch: Partial<S>) => void store.saveSettings(patch);
  const [ck, setCk] = useState<CookieState | null>(null);
  const [signing, setSigning] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPageState] = useState<Page>(lastPage);
  const setPage = (p: Page) => { lastPage = p; setPageState(p); setQ(""); };
  useEffect(() => void api.cookiesInfo().then(setCk).catch(() => undefined), []);
  const bm = "javascript:location.href='goblin://add?url='+encodeURIComponent(location.href)";
  // While searching, every page whose words match is shown at once.
  const shown = (id: Page) => (q.trim() ? PAGES.some(([p, l, w]) => p === id && (l + " " + w).toLowerCase().includes(q.trim().toLowerCase())) : page === id);
  const none = q.trim() && !PAGES.some(([p]) => shown(p));

  return (
    <main className="settings-page">
      <nav className="settings-nav" aria-label="Settings sections">
        <h1>Settings</h1>
        <input className="side-search" aria-label="Search settings" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} />
        {PAGES.map(([id, l]) => <button key={id} className={`sn ${!q.trim() && page === id ? "on" : ""}`} aria-current={!q.trim() && page === id ? "page" : undefined} onClick={() => setPage(id)}>{l}</button>)}
        <p className="muted small sn-note">Everything runs on this computer: no account, no server, nothing in the background after you quit.</p>
      </nav>
      <div className="settings-col">
        {none && <p className="muted">No setting matches “{q}”.</p>}
        {shown("folders") && <Folders tool={tool} onRefresh={onRefresh} />}
        {shown("downloads") && (
          <section className="card form">
            <h2>Downloads</h2>
            <Row label="Auto-detect" hint="Looks at what you paste and picks the right preset."><Select value={s.autoDetect} options={[["suggest", "Suggest a preset"], ["apply", "Apply automatically"], ["off", "Off"]]} onChange={(v) => set({ autoDetect: v })} /></Row>
            <Row label="Default preset" hint="What the Download screen starts with."><Select value={s.defaultPresetId} options={st.presets.map((p) => [p.id, p.name])} onChange={(v) => set({ defaultPresetId: v })} /></Row>
            <Row label="Preview before downloading" hint="Shows qualities, size and subtitles first. Adds a second or two per link."><Switch checked={s.previewBeforeDownload} onChange={(v) => set({ previewBeforeDownload: v })} /></Row>
            <Row label="Downloads at once"><Select value={s.concurrency} options={[1, 2, 3, 4, 5, 6, 8].map((n) => [n, String(n)])} onChange={(v) => set({ concurrency: v })} /></Row>
            <Row label="Connections per download" hint="More = faster on streamed videos."><Select value={s.fragments} options={[1, 2, 4, 8, 12, 16].map((n) => [n, String(n)])} onChange={(v) => set({ fragments: v })} /></Row>
            <Row label="Start right away" hint="Off: new downloads wait in the queue until you press Start."><Switch checked={s.autoStart} onChange={(v) => set({ autoStart: v })} /></Row>
            <Row label="Playlist item limit" hint="Default per download. 0 = all."><LazyInput type="number" className="num" value={String(s.playlistItemLimit)} onCommit={(v) => set({ playlistItemLimit: Number(v) || 0 })} /></Row>
            <Row label="Remember downloaded videos" hint="Never downloads the same video twice (per video id)."><Switch checked={s.useArchive} onChange={(v) => set({ useArchive: v })} /></Row>
            <Row label="Clear finished downloads"><Select value={s.clearCompletedAfter} options={[["0", "Never"], ["3600", "After 1 hour"], ["86400", "After 1 day"], ["604800", "After 1 week"]]} onChange={(v) => set({ clearCompletedAfter: v })} /></Row>
            <Row label="Removing from the list also deletes the file" hint={`Moves it to the ${isMac ? "Trash" : "Recycle Bin"}. Off: only clears the list.`}><Switch checked={s.deleteFileOnRemove} onChange={(v) => set({ deleteFileOnRemove: v })} /></Row>
            <Row label="Browser button" hint="Drag it to your browser's bookmarks bar. It sends the page you're on to Goblin through goblin:// (no server).">
              <a className="bookmarklet" href={bm} onClick={(e) => e.preventDefault()}>{I.down} Send to Goblin</a>
            </Row>
          </section>
        )}
        {shown("music") && (
          <section className="card form">
            <h2>Music</h2>
            <Row label="Loudness" hint="ReplayGain only adds tags; the audio stays untouched. Presets can override this."><Select value={s.loudness} options={OPTS.loudness} onChange={(v) => set({ loudness: v })} /></Row>
            <Row label="Synced lyrics" hint="Embedded in the song itself when LRCLIB has them."><Switch checked={s.lyrics} onChange={(v) => set({ lyrics: v })} /></Row>
            <Row label="Ask me when unsure" hint="Low-confidence MusicBrainz matches pause in the queue under “Needs you”."><Switch checked={s.askOnLowConfidence} onChange={(v) => set({ askOnLowConfidence: v })} /></Row>
            {s.askOnLowConfidence && <Row label="Confidence needed" hint="Higher = asks more often."><input type="range" min={0.5} max={0.95} step={0.01} value={s.reviewThreshold} onChange={(e) => set({ reviewThreshold: Number(e.target.value) })} /><span className="mono small">{Math.round(s.reviewThreshold * 100)}%</span></Row>}
            <Row label="MusicBrainz contact" hint="Optional e-mail sent along with lookups (MusicBrainz etiquette)."><LazyInput value={s.mbContact} placeholder="you@example.com" onCommit={(v) => set({ mbContact: v.trim() })} /></Row>
          </section>
        )}
        {shown("subs") && (
          <section className="card form">
            <h2>Subscriptions</h2>
            <Row label="Default check interval"><LazyInput type="number" className="num" value={String(s.subInterval)} onCommit={(v) => set({ subInterval: Math.max(5, Number(v) || 60) })} /><span className="muted small">minutes</span></Row>
            <Row label="Newest items per check" hint="How far back each check looks."><LazyInput type="number" className="num" value={String(s.subScanEnd)} onCommit={(v) => set({ subScanEnd: Math.max(1, Number(v) || 50) })} /></Row>
            <Row label="Download what's already there when subscribing" hint="Off: only uploads from now on. You can always pick older ones under Subscriptions → Older videos."><Switch checked={s.subCatchUp} onChange={(v) => set({ subCatchUp: v })} /></Row>
          </section>
        )}
        {shown("account") && (
          <section className="card form">
            <h2>YouTube account</h2>
            <div className={`account ${ck?.loaded ? "on" : ""}`}>
              <span className={`dot ${ck?.loaded ? "on" : ""}`} />
              <div className="qmain">
                <b>{ck?.loaded ? (ck.name === "YouTube sign-in" ? "Signed in" : `Using ${ck.name}`) : "Not signed in"}</b>
                <span className="muted small">{ck?.loaded ? "Only the youtube.com cookies are kept, in Goblin's own folder (readable only by you)." : "Needed only for age-restricted and members-only videos."}</span>
              </div>
              <button className={ck?.loaded ? "small-btn" : "primary"} disabled={signing} onClick={() => {
                setSigning(true);
                void api.youtubeSignIn()
                  .then((c) => { setCk(c); void store.refreshInfo(); toast("Signed in to YouTube", "Used only for age-restricted and members-only videos."); })
                  .catch((e) => { const t = errorText(e); if (!/cancelled/i.test(t)) toast("Sign-in didn't finish", t); })
                  .finally(() => setSigning(false));
              }}>{I.user} {signing ? "Waiting for sign-in…" : ck?.loaded ? "Sign in again…" : "Sign in to YouTube…"}</button>
              {ck?.loaded && <button className="small-btn danger-outline" onClick={() => void api.cookiesDelete().then((c) => { setCk(c); void store.refreshInfo(); toast("Signed out", "Goblin's copy of the cookies is deleted."); })}>Sign out</button>}
            </div>
            <p className="muted small">“Sign in” opens Google's own page in a private window. Goblin never sees your password and keeps only the youtube.com cookies; the window's session is thrown away. They're used only when YouTube says a video is <b>age-restricted or members-only</b>: that one video, one at a time, at least 30 s apart. Search, subscriptions, YouTube Music and normal videos never send them. Tip: use a spare account.</p>
            <Row label="Signed-in downloads per day" hint="A cap so a big queue can't hammer your account."><LazyInput type="number" className="num" value={String(s.cookieDailyMax)} onCommit={(v) => set({ cookieDailyMax: Math.max(1, Number(v) || 20) })} /></Row>
            <details className="more">
              <summary className="muted small">Other ways: a cookies.txt file, or cookies from a browser</summary>
              <Row label="cookies.txt file" hint="Exported from your browser (Netscape format). Goblin keeps its own copy, replacing the sign-in.">
                <button className="small-btn" onClick={() => void api.cookiesLoad().then((c) => { setCk(c); void store.refreshInfo(); }).catch((e) => toast("Couldn't load it", errorText(e)))}>Load…</button>
              </Row>
              <Row label="Read cookies from a browser" hint={`Used only when you're not signed in above. ${isMac ? "Safari needs Full Disk Access for Goblin; Chrome-based browsers ask for Keychain access." : "On Windows, Firefox works best; Chrome and Edge often block this."}`}>
                <Select value={tool?.cookies ?? ""} options={[["", "Off"], ["firefox", "Firefox"], ["chrome", "Chrome"], ["edge", "Edge"], ["brave", "Brave"], ["safari", "Safari"], ["chromium", "Chromium"], ["opera", "Opera"], ["vivaldi", "Vivaldi"]]} onChange={(v) => void api.setCookieBrowser(v || null).then(() => { onRefresh(); void store.refreshInfo(); })} />
              </Row>
            </details>
          </section>
        )}
        {shown("look") && (
          <section className="card form">
            <h2>Appearance</h2>
            <Row label="Compact queue" hint="Smaller rows without pictures, so more fit on screen."><Switch checked={s.compactList} onChange={(v) => set({ compactList: v })} /></Row>
            <Row label="Group albums and playlists" hint="Finished tracks from one album show as a single row you can open."><Switch checked={s.groupAlbums} onChange={(v) => set({ groupAlbums: v })} /></Row>
          </section>
        )}
        {shown("advanced") && (
          <>
            <section className="card form">
              <h2>yt-dlp and helpers</h2>
              <Row label={<>yt-dlp {tool?.version ? <span className="okmark">{I.check}</span> : <span className="error-text">missing</span>}</>} hint={`${tool?.version ?? "Not installed"}${tool?.version && !tool.managed ? " · installed on this computer" : ""}. Downloads of yt-dlp are checked against its published checksum.`}>
                <button className="small-btn" disabled={updating} onClick={onUpdateYtDlp}>{updating ? "Updating…" : tool?.version ? "Update now" : "Install"}</button>
              </Row>
              <Row label="Update yt-dlp automatically" hint="Every few days, while Goblin is open."><Switch checked={s.autoUpdate} onChange={(v) => set({ autoUpdate: v })} /></Row>
              <Row label={<>ffmpeg {tool?.ffmpeg ? <span className="okmark">{I.check}</span> : <span className="error-text">missing</span>}</>} hint="Joins video and sound, converts and tags music. Comes with Goblin."><span /></Row>
              <Row label={<>deno {tool?.deno ? <span className="okmark">{I.check}</span> : <span className="error-text">missing</span>}</>} hint="Lets yt-dlp see every YouTube quality. Comes with Goblin."><span /></Row>
              <Row wide label="Global options" hint="Added to every download, one per line. Options that run programs or read other files are refused.">
                <textarea className="mono" rows={3} defaultValue={s.ytdlpGlobal} placeholder={"--embed-info-json\n--xattrs"} onBlur={(e) => e.target.value !== s.ytdlpGlobal && set({ ytdlpGlobal: e.target.value })} />
              </Row>
              <Row label="Speed limit" hint="e.g. 5M. Empty = unlimited."><LazyInput className="num" value={s.limitRate} placeholder="unlimited" onCommit={(v) => set({ limitRate: v.trim() })} /></Row>
            </section>
            <section className="card form">
              <h2>“Keep original title” names</h2>
              <p className="muted small">For presets that keep YouTube's own title. yt-dlp template syntax.</p>
              <Row label="Single video"><LazyInput mono value={s.outputTemplate} placeholder="%(title)s [%(id)s].%(ext)s" onCommit={(v) => set({ outputTemplate: v })} /></Row>
              <Row label="Playlist item"><LazyInput mono value={s.outputTemplatePlaylist} placeholder="%(playlist_title)s/%(playlist_index)02d - %(title)s.%(ext)s" onCommit={(v) => set({ outputTemplatePlaylist: v })} /></Row>
              <Row label="Channel item"><LazyInput mono value={s.outputTemplateChannel} placeholder="%(channel)s/%(upload_date>%Y-%m-%d)s - %(title)s.%(ext)s" onCommit={(v) => set({ outputTemplateChannel: v })} /></Row>
              <Row label="Chapter file"><LazyInput mono value={s.outputTemplateChapter} placeholder="%(section_number)02d - %(section_title)s.%(ext)s" onCommit={(v) => set({ outputTemplateChapter: v })} /></Row>
            </section>
          </>
        )}
        {shown("updates") && <UpdateSettings />}
      </div>
    </main>
  );
}

const DEF = { dirYoutube: "YouTube", dirMusic: "Music", dirPodcasts: "Podcasts", dirOther: "Other" } as const;
type DirKey = keyof typeof DEF;

/** Settings → Folders & names: the library, one row per type (folder + name pattern), and live examples. */
function Folders({ tool, onRefresh }: { tool: ToolState | null; onRefresh: () => void }) {
  const st = useStore();
  const s = st.settings;
  const set = (patch: Partial<S>) => void store.saveSettings(patch);
  const home = st.info?.home ?? "";
  const [open, setOpen] = useState<DirKey | null>(null);
  const root = (k: DirKey) => tildify(st.dir(s[k]), home);
  const rows: [DirKey, string, ReactNode, string, ReactNode][] = [
    ["dirYoutube", "Videos", I.film, `${s.youtubeFolder ? s.youtubeFolder + "/" : ""}${s.videoName}`, <>
      <Row wide label="Folders inside it" hint="Use “/” for sub-folders."><NamingInput kind="ytfolder" value={s.youtubeFolder} onChange={(v) => set({ youtubeFolder: v })} /></Row>
      <Row wide label="File name" hint="Videos with “Channel folder + name pattern” presets."><NamingInput kind="video" value={s.videoName} onChange={(v) => set({ videoName: v || "{title}" })} /></Row>
    </>],
    ["dirMusic", "Music", I.music, `${s.musicFolder ? s.musicFolder + "/" : ""}${s.trackName}`, <>
      <Row wide label="Folders inside it" hint="For presets with Artist / Album folders."><NamingInput kind="musicfolder" value={s.musicFolder} onChange={(v) => set({ musicFolder: v })} /></Row>
      <Row wide label="Song file name"><NamingInput kind="track" value={s.trackName} onChange={(v) => set({ trackName: v || "{title}" })} /></Row>
    </>],
    ["dirPodcasts", "Podcasts", I.mic, "{show}/{date} - {episode}", null],
    ["dirOther", "Original title", I.file, s.outputTemplate || "%(title)s [%(id)s].%(ext)s", <p className="muted small">The file names for these are yt-dlp templates, under Advanced.</p>],
  ];
  const ex = (kind: "video" | "track", folderKind: "ytfolder" | "musicfolder", folderT: string, nameT: string, k: DirKey) => {
    const f = folderT ? example(folderT, folderKind).replace(/ \/ /g, "/").replace(/ \/$/, "/") : "";
    return `${root(k)}/${f}${example(nameT, kind)}`;
  };
  return (
    <>
      <section className="card form">
        <h2>Where each type goes</h2>
        <div className="type-row lib">
          <span className="type-icon">{I.folder}</span>
          <b>Library</b>
          <span className="mono small ell" title={tool?.folder ?? ""}>{tool?.folder ? tildify(tool.folder, home) : "Not chosen"}</span>
          <div className="row tight">
            <button className="small-btn" onClick={() => void api.pickLibrary().then(() => { onRefresh(); void store.refreshInfo(); })}>Change…</button>
            <button className="small-btn" onClick={() => void host().reveal(st.library).catch((e) => toast("Couldn't open it", errorText(e)))}>Open</button>
          </div>
        </div>
        {rows.map(([k, label, icon, pattern, editor]) => (
          <div key={k} className={`type-block ${open === k ? "open" : ""}`}>
            <div className="type-row">
              <span className="type-icon">{icon}</span>
              <span>{label}{isAbsolute(s[k]) && <span className="tag own">own folder</span>}</span>
              <span className="mono small ell" title={`${st.dir(s[k])}/${pattern}`}><span className="muted">{isAbsolute(s[k]) ? tildify(s[k], home) : `Library/${s[k]}`}/</span>{pattern}</span>
              <button className="small-btn" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>{open === k ? "Done" : "Change…"}</button>
            </div>
            {open === k && (
              <div className="type-edit">
                <Row label="Folder" hint={isAbsolute(s[k]) ? "Its own folder, anywhere (for example on your NAS)." : "A sub-folder of the library, or choose any folder."}>
                  {isAbsolute(s[k]) ? <span className="mono small path-text" title={s[k]}>{tildify(s[k], home)}</span> : <LazyInput mono value={s[k]} onCommit={(v) => set({ [k]: v.trim() || DEF[k] })} />}
                  <button className="small-btn" onClick={async () => { const [d] = await api.pickPaths("folder").catch(() => [] as string[]); if (d) set({ [k]: d }); }}>{I.folder} Choose…</button>
                  {isAbsolute(s[k]) && <button className="icon" aria-label="Back inside the library" title={`Back to ${DEF[k]}/ inside the library`} onClick={() => set({ [k]: DEF[k] })}>{I.x}</button>}
                </Row>
                {editor}
              </div>
            )}
          </div>
        ))}
        <p className="muted small">A preset's own “Save to” folder, or a folder picked for one download, still comes first.</p>
      </section>
      <section className="card form">
        <h2>What a download will look like</h2>
        <div className="examples">
          <div><span className="muted small">Video</span><span className="mono small">{ex("video", "ytfolder", s.youtubeFolder, s.videoName, "dirYoutube")}</span></div>
          <div><span className="muted small">Song</span><span className="mono small">{ex("track", "musicfolder", s.musicFolder, s.trackName, "dirMusic")}</span></div>
        </div>
      </section>
    </>
  );
}
