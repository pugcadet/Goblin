import { useEffect, useState } from "react";
import { api, CookieState, errorText, fileManager, isMac, ToolState } from "../api";
import { host } from "../engine/host";
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

const SECTIONS = [["library", "Library"], ["naming", "Names & folders"], ["downloads", "Downloads"], ["music", "Music"], ["subs", "Subscriptions"], ["ytdlp", "yt-dlp"], ["signin", "YouTube sign-in"], ["look", "Look"], ["updates", "Updates"]] as const;

export default function Settings({ tool, onRefresh, onUpdateYtDlp, updating }: { tool: ToolState | null; onRefresh: () => void; onUpdateYtDlp: () => void; updating: boolean }) {
  const st = useStore();
  const s = st.settings;
  const set = (patch: Partial<S>) => void store.saveSettings(patch);
  const home = st.info?.home ?? "";
  const [ck, setCk] = useState<CookieState | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => void api.cookiesInfo().then(setCk).catch(() => undefined), []);
  const bm = "javascript:location.href='goblin://add?url='+encodeURIComponent(location.href)";
  const sub = (k: "dirYoutube" | "dirMusic" | "dirPodcasts" | "dirOther", l: string) => <Row label={l}><LazyInput mono value={s[k]} onCommit={(v) => set({ [k]: v.trim() || ({ dirYoutube: "YouTube", dirMusic: "Music", dirPodcasts: "Podcasts", dirOther: "Other" } as const)[k] })} /></Row>;
  const shown = (id: string, words: string) => !q.trim() || (id + " " + words).toLowerCase().includes(q.toLowerCase());

  return (
    <main className="page split">
      <aside className="card side">
        <input className="side-search" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} />
        {SECTIONS.map(([id, l]) => <a key={id} className="side-item" href={`#s-${id}`}>{l}</a>)}
      </aside>
      <div className="settings-col grow">
        {shown("library", "folder ready nas copy sub-folder default preset") && (
          <section className="card form" id="s-library">
            <h2>Library</h2>
            <Row label="Library folder" hint="Everything lands here, organized. Copy or sync it to your NAS.">
              <span className="mono small path-text">{tool?.folder ? tildify(tool.folder, home) : "Not chosen"}</span>
              <button className="small-btn" onClick={() => void api.pickLibrary().then(() => { onRefresh(); void store.refreshInfo(); })}>{I.folder} Choose…</button>
              <button className="small-btn" onClick={() => void host().reveal(st.library).catch((e) => toast("Couldn't open it", errorText(e)))}>Open in {fileManager}</button>
            </Row>
            <Row label="Inside it" hint="Rename the sub-folders below if you like."><span className="mono small">{s.dirYoutube}/ · {s.dirMusic}/ · {s.dirPodcasts}/ · {s.dirOther}/</span></Row>
            {sub("dirYoutube", "Videos sub-folder")}
            {sub("dirMusic", "Music sub-folder")}
            {sub("dirPodcasts", "Podcasts sub-folder")}
            {sub("dirOther", "“Keep original title” sub-folder")}
            <Row label="Default preset"><Select value={s.defaultPresetId} options={st.presets.map((p) => [p.id, p.name])} onChange={(v) => set({ defaultPresetId: v })} /></Row>
          </section>
        )}
        {shown("naming", "names folders template file name pattern video song track yt-dlp") && (
          <section className="card form" id="s-naming">
            <h2>Names & folders</h2>
            <Row wide label="Video file name" hint="Videos with “Channel folder + name pattern” presets."><NamingInput kind="video" value={s.videoName} onChange={(v) => set({ videoName: v || "{title}" })} /></Row>
            <Row wide label="Video folders" hint={`Inside ${s.dirYoutube}. Use “/” for sub-folders.`}><NamingInput kind="ytfolder" value={s.youtubeFolder} onChange={(v) => set({ youtubeFolder: v })} /></Row>
            <Row wide label="Song file name" hint="Inside the album folder."><NamingInput kind="track" value={s.trackName} onChange={(v) => set({ trackName: v || "{title}" })} /></Row>
            <Row wide label="Music folders" hint={`Inside ${s.dirMusic}, for presets with Artist / Album folders.`}><NamingInput kind="musicfolder" value={s.musicFolder} onChange={(v) => set({ musicFolder: v })} /></Row>
            <div className="groupt">“Keep original title” templates (yt-dlp syntax)</div>
            <Row label="Single video"><LazyInput mono value={s.outputTemplate} placeholder="%(title)s [%(id)s].%(ext)s" onCommit={(v) => set({ outputTemplate: v })} /></Row>
            <Row label="Playlist item"><LazyInput mono value={s.outputTemplatePlaylist} placeholder="%(playlist_title)s/%(playlist_index)02d - %(title)s.%(ext)s" onCommit={(v) => set({ outputTemplatePlaylist: v })} /></Row>
            <Row label="Channel item"><LazyInput mono value={s.outputTemplateChannel} placeholder="%(channel)s/%(upload_date>%Y-%m-%d)s - %(title)s.%(ext)s" onCommit={(v) => set({ outputTemplateChannel: v })} /></Row>
            <Row label="Chapter file"><LazyInput mono value={s.outputTemplateChapter} placeholder="%(section_number)02d - %(section_title)s.%(ext)s" onCommit={(v) => set({ outputTemplateChapter: v })} /></Row>
          </section>
        )}
        {shown("downloads", "auto-detect preview parallel connections auto start playlist limit remember archive clear delete") && (
          <section className="card form" id="s-downloads">
            <h2>Downloads</h2>
            <Row label="Auto-detect" hint="Looks at what you paste and picks the right preset."><Select value={s.autoDetect} options={[["suggest", "Suggest a preset"], ["apply", "Apply automatically"], ["off", "Off"]]} onChange={(v) => set({ autoDetect: v })} /></Row>
            <Row label="Preview before downloading" hint="Shows qualities, size and subtitles first. Adds a second or two per link."><Switch checked={s.previewBeforeDownload} onChange={(v) => set({ previewBeforeDownload: v })} /></Row>
            <Row label="Downloads at once"><Select value={s.concurrency} options={[1, 2, 3, 4, 5, 6, 8].map((n) => [n, String(n)])} onChange={(v) => set({ concurrency: v })} /></Row>
            <Row label="Connections per download" hint="More = faster on streamed videos."><Select value={s.fragments} options={[1, 2, 4, 8, 12, 16].map((n) => [n, String(n)])} onChange={(v) => set({ fragments: v })} /></Row>
            <Row label="Start right away" hint="Off: new downloads wait as “pending” until you press Start."><Switch checked={s.autoStart} onChange={(v) => set({ autoStart: v })} /></Row>
            <Row label="Playlist item limit" hint="Default per download. 0 = all."><LazyInput type="number" className="num" value={String(s.playlistItemLimit)} onCommit={(v) => set({ playlistItemLimit: Number(v) || 0 })} /></Row>
            <Row label="Remember downloaded videos" hint="Never downloads the same video twice (per video id)."><Switch checked={s.useArchive} onChange={(v) => set({ useArchive: v })} /></Row>
            <Row label="Clear finished downloads"><Select value={s.clearCompletedAfter} options={[["0", "Never"], ["3600", "After 1 hour"], ["86400", "After 1 day"], ["604800", "After 1 week"]]} onChange={(v) => set({ clearCompletedAfter: v })} /></Row>
            <Row label="Removing from the list also deletes the file" hint={`Moves it to the ${isMac ? "Trash" : "Recycle Bin"}. Off: only clears the list.`}><Switch checked={s.deleteFileOnRemove} onChange={(v) => set({ deleteFileOnRemove: v })} /></Row>
          </section>
        )}
        {shown("music", "loudness replaygain lyrics musicbrainz contact unsure confidence") && (
          <section className="card form" id="s-music">
            <h2>Music</h2>
            <Row label="Loudness" hint="ReplayGain only adds tags; the audio stays untouched. Presets can override this."><Select value={s.loudness} options={OPTS.loudness} onChange={(v) => set({ loudness: v })} /></Row>
            <Row label="Synced lyrics" hint="Embedded in the song itself when LRCLIB has them."><Switch checked={s.lyrics} onChange={(v) => set({ lyrics: v })} /></Row>
            <Row label="Ask me when unsure" hint="Low-confidence MusicBrainz matches pause and show options."><Switch checked={s.askOnLowConfidence} onChange={(v) => set({ askOnLowConfidence: v })} /></Row>
            {s.askOnLowConfidence && <Row label="Confidence needed" hint="Higher = asks more often."><input type="range" min={0.5} max={0.95} step={0.01} value={s.reviewThreshold} onChange={(e) => set({ reviewThreshold: Number(e.target.value) })} /><span className="mono small">{Math.round(s.reviewThreshold * 100)}%</span></Row>}
            <Row label="MusicBrainz contact" hint="Optional e-mail sent along with lookups (MusicBrainz etiquette)."><LazyInput value={s.mbContact} placeholder="you@example.com" onCommit={(v) => set({ mbContact: v.trim() })} /></Row>
          </section>
        )}
        {shown("subs", "subscriptions interval check back-catalog newest") && (
          <section className="card form" id="s-subs">
            <h2>Subscriptions</h2>
            <Row label="Default check interval"><LazyInput type="number" className="num" value={String(s.subInterval)} onCommit={(v) => set({ subInterval: Math.max(5, Number(v) || 60) })} /><span className="muted small">minutes</span></Row>
            <Row label="Newest items per check" hint="How far back each check looks."><LazyInput type="number" className="num" value={String(s.subScanEnd)} onCommit={(v) => set({ subScanEnd: Math.max(1, Number(v) || 50) })} /></Row>
            <Row label="Download what's already there when subscribing" hint="Off: only uploads from now on."><Switch checked={s.subCatchUp} onChange={(v) => set({ subCatchUp: v })} /></Row>
          </section>
        )}
        {shown("ytdlp", "yt-dlp ffmpeg deno update version global options speed limit rate") && (
          <section className="card form" id="s-ytdlp">
            <h2>yt-dlp</h2>
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
        )}
        {shown("signin", "youtube sign-in cookies age-restricted members browser") && (
          <section className="card form" id="s-signin">
            <h2>YouTube sign-in</h2>
            <p className="muted small">Never used by default. Only when YouTube says a video is <b>age-restricted or members-only</b> is that one video retried signed in: one at a time, at least 30 s apart, with pauses between requests. Search, subscriptions, YouTube Music and normal videos never send your cookies. Tip: use a spare account.</p>
            <Row label="cookies.txt file" hint="Exported from your browser (Netscape format), for example with a “Get cookies.txt” extension. Goblin keeps its own copy.">
              <span className={`dot ${ck?.loaded ? "on" : ""}`} /><span className="muted small">{ck?.loaded ? ck.name : "None loaded"}</span>
              <button className="small-btn" onClick={() => void api.cookiesLoad().then((c) => { setCk(c); void store.refreshInfo(); }).catch((e) => toast("Couldn't load it", errorText(e)))}>Load…</button>
              {ck?.loaded && <button className="small-btn danger-outline" onClick={() => void api.cookiesDelete().then((c) => { setCk(c); void store.refreshInfo(); })}>Delete</button>}
            </Row>
            <Row label="Or read cookies from a browser" hint={`Used only when there is no cookies.txt. ${isMac ? "Safari needs Full Disk Access for Goblin; Chrome-based browsers ask for Keychain access." : "On Windows, Firefox works best; Chrome and Edge often block this."}`}>
              <Select value={tool?.cookies ?? ""} options={[["", "Off"], ["firefox", "Firefox"], ["chrome", "Chrome"], ["edge", "Edge"], ["brave", "Brave"], ["safari", "Safari"], ["chromium", "Chromium"], ["opera", "Opera"], ["vivaldi", "Vivaldi"]]} onChange={(v) => void api.setCookieBrowser(v || null).then(() => { onRefresh(); void store.refreshInfo(); })} />
            </Row>
            <Row label="Signed-in downloads per day" hint="A cap so a big queue can't hammer your account."><LazyInput type="number" className="num" value={String(s.cookieDailyMax)} onCommit={(v) => set({ cookieDailyMax: Math.max(1, Number(v) || 20) })} /></Row>
          </section>
        )}
        {shown("look", "compact group albums bookmarklet browser") && (
          <section className="card form" id="s-look">
            <h2>Look</h2>
            <Row label="Compact download list" hint="Smaller rows so more fit on screen."><Switch checked={s.compactList} onChange={(v) => set({ compactList: v })} /></Row>
            <Row label="Group albums and playlists" hint="Tracks from one album show as a single row you can open."><Switch checked={s.groupAlbums} onChange={(v) => set({ groupAlbums: v })} /></Row>
            <Row label="Bookmarklet" hint="Drag it to your browser's bookmarks bar. It sends the page you're on to Goblin through goblin:// (no server).">
              <a className="bookmarklet" href={bm} onClick={(e) => e.preventDefault()}>{I.down} Send to Goblin</a>
            </Row>
          </section>
        )}
        {shown("updates", "updates version goblin") && <div id="s-updates"><UpdateSettings /></div>}
        <p className="muted small">Everything runs on this computer: no account, no server, nothing in the background after you quit.</p>
      </div>
    </main>
  );
}
