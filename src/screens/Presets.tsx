import { useState } from "react";
import { api } from "../api";
import { askConfirm } from "../confirm";
import { Preset, PRESET_DEFAULTS } from "../engine/model";
import { store } from "../engine/store";
import { ReactNode } from "react";
import { I, LazyInput, Row, Seg, Select, Switch, tildify, useStore } from "../ui";
import { OPTS } from "./Downloads";

type Field = { g: string } | { k: keyof Preset; t: "text" | "select" | "switch" | "folder"; l: string; d?: string; o?: [string, string][]; mono?: boolean; ph?: string; show?: (p: Preset) => boolean };

const VIDEO: Field[] = [
  { g: "Quality" },
  { k: "quality", t: "select", l: "Max resolution", o: OPTS.quality },
  { k: "container", t: "select", l: "Format", d: "MKV holds every track. MP4 plays everywhere.", o: OPTS.container },
  { k: "codec", t: "select", l: "Preferred codec", d: "H.264 avoids transcoding on most TVs.", o: OPTS.codec },
  { g: "Names" },
  { k: "metaMode", t: "select", l: "Save as", d: "Decides the folder and file name.", o: [["youtube", "Channel folder + name pattern (Settings)"], ["none", "Keep the original title"]] },
  { k: "fileTemplate", t: "text", l: "Filename template", mono: true, d: "yt-dlp syntax. Empty = the template from Settings.", ph: "%(title)s [%(id)s].%(ext)s", show: (p) => p.metaMode === "none" },
  { g: "Subtitles" },
  { k: "subtitles", t: "switch", l: "Download subtitles", d: "Always embedded in the video. No separate .srt files." },
  { k: "subLangs", t: "text", l: "Languages", mono: true, d: "Comma separated. The default asks only for en, en-US and en-GB; “en.*” means every English variant, which costs more requests and can hit YouTube's limit.", show: (p) => p.subtitles },
  { k: "capSource", t: "select", l: "Source", o: OPTS.capSource, show: (p) => p.subtitles },
  { g: "Extras" },
  { k: "embedChapters", t: "switch", l: "Embed chapters" },
  { k: "splitChapters", t: "switch", l: "Split by chapters", d: "One file per chapter." },
  { k: "sponsorBlock", t: "switch", l: "Cut sponsor segments", d: "Uses SponsorBlock." },
  { k: "sponsorCats", t: "text", l: "Segments to cut", mono: true, d: "sponsor, selfpromo, interaction, intro, outro, preview, filler, music_offtopic", show: (p) => p.sponsorBlock },
];

const MUSIC: Field[] = [
  { g: "Audio" },
  { k: "audioFormat", t: "select", l: "Format", d: "M4A and Opus keep the original stream (no re-encode).", o: OPTS.audioFormat },
  { k: "audioQuality", t: "select", l: "Quality", o: OPTS.audioQuality, show: (p) => p.audioFormat === "mp3" },
  { k: "preferOfficialAudio", t: "switch", l: "Prefer official audio", d: "Typed “Artist - Song” and album tracks use the studio track on YouTube Music (matched on length), not a music video. Pasted links are downloaded as they are." },
  { g: "Tags & art" },
  { k: "musicbrainz", t: "switch", l: "Match on MusicBrainz", d: "Artist, album, year, track/disc numbers, genre, label, MusicBrainz IDs." },
  { k: "embedCover", t: "switch", l: "Embed album art", d: "Cover Art Archive (up to 1200 px). Falls back to a square crop of the thumbnail." },
  { k: "lyrics", t: "switch", l: "Synced lyrics", d: "Embedded in the song when LRCLIB has them. No .lrc files." },
  { k: "loudness", t: "select", l: "Loudness", d: "ReplayGain adds volume tags; normalize re-encodes once.", o: OPTS.loudness },
  { k: "podcast", t: "switch", l: "Podcast mode", d: "Podcasts/Show/2024-05-01 - Episode.mp3 with chapters and episode art. No MusicBrainz." },
  { k: "albumFolders", t: "switch", l: "Artist / Album folders", d: "Artist/Album (Year)/Title.mp3 (patterns in Settings)." },
  { g: "Tags" },
  { k: "tagCleanTitle", t: "switch", l: "Clean up titles", d: "Removes “(Official Audio)”, “[Explicit]”, “- Remastered 2011” and similar.", show: (p) => !p.podcast },
  { k: "tagFeat", t: "select", l: "Featured artists", o: [["keep", "Leave as they come"], ["title", "In the title: Song (feat. X)"], ["artist", "In the artist: Artist, X"]], show: (p) => !p.podcast },
  { k: "tagArtistSep", t: "select", l: "Between artists", o: [[", ", "Artist A, Artist B"], ["; ", "Artist A; Artist B"], [" & ", "Artist A & Artist B"], [" / ", "Artist A / Artist B"]] },
  { k: "tagAlbumArtist", t: "switch", l: "Album artist", d: "Keeps an album together in Jellyfin even when tracks have guests." },
  { k: "tagYear", t: "switch", l: "Year" },
  { k: "tagGenre", t: "switch", l: "Genre" },
  { k: "tagComment", t: "text", l: "Comment", ph: "Optional, written into every file" },
  { k: "tagId3", t: "select", l: "MP3 tag version", d: "2.3 works everywhere (Windows, car stereos). 2.4 handles several artists better.", o: [["2.3", "ID3v2.3"], ["2.4", "ID3v2.4"]], show: (p) => p.audioFormat === "mp3" },
  { k: "splitChapters", t: "switch", l: "Split by chapters", d: "Turns a full-album upload into separate tracks." },
];

const TAIL: Field[] = [
  { g: "Input & location" },
  { k: "allowPlaylists", t: "switch", l: "Allow playlists & channels", d: "Splits them into one download per item." },
  { k: "outputDir", t: "folder", l: "Save to", d: "Empty = the library folder from Settings." },
  { k: "ytdlpArgs", t: "text", l: "Extra yt-dlp options", mono: true, d: "Added to every download with this preset.", ph: "--embed-info-json" },
];

export default function Presets() {
  const st = useStore();
  const [id, setId] = useState(st.settings.defaultPresetId);
  const p = st.presets.find((x) => x.id === id) ?? st.presets[0];
  const set = (patch: Partial<Preset>) => void store.savePreset({ ...p, ...patch });
  const fields = [...(p.kind === "music" ? MUSIC : VIDEO), ...TAIL];
  return (
    <main className="page split">
      <aside className="card side">
        {st.presets.map((x) => (
          <button key={x.id} className={`side-item ${x.id === p.id ? "on" : ""}`} onClick={() => setId(x.id)}>
            {x.kind === "music" ? I.music : I.film}<span className="ell">{x.name}</span>{x.id === st.settings.defaultPresetId && <span className="muted small">default</span>}
          </button>
        ))}
        <button className="side-item add" onClick={async () => { const n = await store.savePreset({ ...PRESET_DEFAULTS, id: "", name: "New preset" }); setId(n.id); }}>{I.plus} New preset</button>
        <button className="link small" onClick={async () => (await askConfirm("Put the built-in presets back? Your own presets are removed.", { okLabel: "Reset presets", danger: true })) && void store.resetPresets()}>Reset to built-in presets</button>
      </aside>
      <section className="card form grow">
        <div className="row tight">
          <LazyInput className="grow title-input" value={p.name} onCommit={(v) => set({ name: v || "Preset" })} />
          <button className="small-btn" disabled={st.settings.defaultPresetId === p.id} onClick={() => void store.saveSettings({ defaultPresetId: p.id })}>{st.settings.defaultPresetId === p.id ? <>{I.check} Default</> : "Make default"}</button>
          <button className="small-btn" onClick={async () => { const n = await store.savePreset({ ...p, id: "", name: `${p.name} copy` }); setId(n.id); }}>{I.copy} Duplicate</button>
          <button className="icon" title="Delete" disabled={st.presets.length <= 1} onClick={async () => (await askConfirm(`Delete the preset “${p.name}”?`, { okLabel: "Delete", danger: true })) && void store.deletePreset(p.id)}>{I.trash}</button>
        </div>
        <Row label="Type"><Seg value={p.kind} onChange={(k) => set({ kind: k })} options={[["video", <>{I.film} Video</>], ["music", <>{I.music} Audio</>]]} /></Row>
        {fields.map((f, i) => {
          if ("g" in f) return <div className="groupt" key={`g${i}`}>{f.g}</div>;
          if (f.show && !f.show(p)) return null;
          const v = p[f.k];
          let ctl: ReactNode = null;
          if (f.t === "switch") ctl = <Switch checked={!!v} onChange={(x) => set({ [f.k]: x } as Partial<Preset>)} />;
          else if (f.t === "select") ctl = <Select value={String(v)} options={f.o!} onChange={(x) => set({ [f.k]: x } as Partial<Preset>)} />;
          else if (f.t === "text") ctl = <LazyInput mono={f.mono} value={String(v ?? "")} placeholder={f.ph} onCommit={(x) => set({ [f.k]: x } as Partial<Preset>)} />;
          else if (f.t === "folder")
            ctl = (
              <>
                <span className="mono small path-text">{v ? tildify(String(v), st.info?.home ?? "") : "Library default"}</span>
                <button className="small-btn" onClick={async () => { const [d] = await api.pickPaths("folder").catch(() => [] as string[]); if (d) set({ outputDir: d }); }}>{I.folder} Choose…</button>
                {v && <button className="icon" title="Back to the library default" onClick={() => set({ outputDir: "" })}>{I.x}</button>}
              </>
            );
          return <Row key={`${f.k}${i}`} label={f.l} hint={f.d}>{ctl}</Row>;
        })}
        <p className="muted small">Changes are saved right away. Per-download changes (Downloads → the bar under the links) don't change the preset.</p>
      </section>
    </main>
  );
}
