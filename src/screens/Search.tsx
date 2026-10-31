import { ReactNode, useEffect, useState } from "react";
import { api, errorText, loadLocal, saveLocal } from "../api";
import { jobs } from "../engine/jobs";
import { Album, AlbumCard, PodcastRow, search, SongRow, VideoRow } from "../engine/search";
import { store } from "../engine/store";
import { subs } from "../engine/subs";
import { plays } from "../engine/text";
import { I, Modal, Pic, Seg, Select, tildify, toast, useStore, useSubs } from "../ui";

type Mode = "songs" | "albums" | "videos" | "podcasts";
interface Filters {
  hideJunk: boolean;
  minPlays: number;
  sort: "yt" | "plays";
  deluxe: boolean;
  type: "all" | "Album" | "other";
}

// Results stay while you switch tabs.
const S: { mode: Mode; q: string; results: unknown[] | null; done: boolean; artist: string } = { mode: "songs", q: "", results: null, done: false, artist: "" };

const musicPresets = () => store.presets.filter((p) => p.kind === "music" && !p.podcast);

export default function Search() {
  const st = useStore();
  const [mode, setMode] = useState<Mode>(S.mode);
  const [q, setQ] = useState(S.q);
  const [results, setResults] = useState<unknown[] | null>(S.results);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [done, setDone] = useState(S.done);
  const [f, setF] = useState<Filters>(() => loadLocal("goblin-search-filters", { hideJunk: true, minPlays: 0, sort: "yt", deluxe: false, type: "all" } as Filters));
  const [artist, setArtist] = useState(S.artist);
  const [album, setAlbum] = useState<AlbumCard | null>(null);
  const [disco, setDisco] = useState(false);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState(() => musicPresets()[0]?.id ?? "music");
  const [vPreset, setVPreset] = useState(() => st.presets.find((p) => p.kind === "video")?.id ?? "youtube");
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => saveLocal("goblin-search-filters", f), [f]);
  useEffect(() => {
    Object.assign(S, { mode, q, results, done, artist });
  }, [mode, q, results, done, artist]);

  async function run(m: Mode = mode) {
    if (!q.trim()) return;
    setBusy(true);
    setResults(null);
    setDone(false);
    setPick(new Set());
    try {
      const r = await search.search(m, q);
      setResults(r);
      // "Linkin Park" → show only that artist's rows at first.
      const first = (r as SongRow[]).map((x) => (x.artist ?? "").split(/,\s*|\s+&\s+/)[0]).find((a) => a && a.toLowerCase() === q.trim().toLowerCase());
      setArtist(first ?? "");
    } catch (e) {
      setResults([]);
      toast("Search failed", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    setMore(true);
    try {
      const r = await search.more(mode, q);
      if (!r.length) setDone(true);
      setResults((x) => [...(x ?? []), ...r]);
    } catch (e) {
      toast("Couldn't load more", errorText(e));
    } finally {
      setMore(false);
    }
  }

  const queue = (url: string, presetId: string, extra: Parameters<typeof jobs.add>[2] = {}) => {
    jobs.add(url, { presetId }, extra);
    setAdded((a) => new Set(a).add(url + presetId));
  };

  const placeholder = { songs: "Song, artist or album, e.g. Linkin Park Numb", albums: "Album or artist, e.g. Meteora or Linkin Park", videos: "Search YouTube", podcasts: "Podcast name" }[mode];
  const hint = { songs: "Official audio from YouTube Music, with full tags.", albums: "Whole albums, matched with MusicBrainz.", videos: "Anything on YouTube.", podcasts: "The Apple Podcasts directory (RSS feeds)." }[mode];

  return (
    <main className={`page ${pick.size ? "with-tray" : ""}`}>
      <header className="page-head">
        <h1>Search</h1>
        <span className="muted">{hint}</span>
      </header>
      <div className="searchbox">
        <span className="searchbox-icon">{I.search}</span>
        <input aria-label="Search" value={q} autoFocus placeholder={placeholder} spellCheck={false} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} />
        <button className="primary" disabled={busy || !q.trim() || !st.info?.ytdlp} onClick={() => void run()}>{busy ? "Searching…" : "Search"}</button>
      </div>
      <div className="tabs" role="tablist">
        {([["songs", "Songs", I.music], ["albums", "Albums", I.disc], ["videos", "Videos", I.film], ["podcasts", "Podcasts", I.mic]] as [Mode, string, ReactNode][]).map(([m, l, ic]) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`tab ${mode === m ? "on" : ""}`} onClick={() => { setMode(m); setResults(null); setPick(new Set()); if (q.trim()) void run(m); }}>{ic} {l}</button>
        ))}
        <span className="tabs-sep" />
        <button className="tab" disabled={!q.trim()} onClick={() => setDisco(true)} title="Every album by an artist">{I.user} Artist discography…</button>
      </div>

      {busy && <p className="muted center-text">Searching…</p>}
      {!busy && results === null && (
        <div className="empty-big"><span className="dicon">{I.search}</span><b>Find a song, album, video or podcast</b><span className="muted small">Tick what you want and download it all at once, or open an album to check every track first.</span></div>
      )}
      {!busy && results && !results.length && <p className="muted center-text">Nothing found.</p>}
      {!busy && results && results.length > 0 && (
        <>
          {mode === "songs" && <Songs rows={results as SongRow[]} f={f} setF={setF} artist={artist} setArtist={setArtist} preset={preset} setPreset={setPreset} added={added} pick={pick} setPick={setPick} onGet={(r) => queue(r.url, preset, { titleHint: `${r.artist} – ${r.title}`, thumb: r.art, tags: r.tags })} onAlbum={(r) => setAlbum({ id: r.albumId, title: r.album, artist: r.artist.split(", ")[0], year: r.year, type: "Album", art: r.art })} />}
          {mode === "albums" && <Albums rows={results as AlbumCard[]} f={f} setF={setF} artist={artist} setArtist={setArtist} pick={pick} setPick={setPick} preset={preset} setPreset={setPreset} onOpen={setAlbum} />}
          {mode === "videos" && <Videos rows={results as VideoRow[]} vPreset={vPreset} setVPreset={setVPreset} added={added} pick={pick} setPick={setPick} onGet={(r, p) => queue(r.url, p, { titleHint: r.title, thumb: r.art })} />}
          {mode === "podcasts" && <Podcasts rows={results as PodcastRow[]} />}
          {mode !== "podcasts" && !done && <div className="center-text"><button disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load more"}</button></div>}
        </>
      )}
      {album && <AlbumModal card={album} onClose={() => setAlbum(null)} />}
      {disco && <DiscoModal q={q} onClose={() => setDisco(false)} onOpen={(a) => setAlbum(a)} />}
    </main>
  );
}

function FilterBar({ rows, f, setF, artist, setArtist, albums }: { rows: { artist: string; junk?: boolean }[]; f: Filters; setF: (f: Filters) => void; artist: string; setArtist: (a: string) => void; albums?: boolean }) {
  const counts = new Map<string, number>();
  for (const x of rows) {
    const a = (x.artist ?? "").split(/,\s*|\s+&\s+/)[0];
    if (a && (!f.hideJunk || !x.junk)) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  let top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (artist && !top.some(([a]) => a === artist)) top = [[artist, counts.get(artist) ?? 0], ...top.slice(0, 5)];
  return (
    <div className="filterbar">
      <button className={`chip ${f.hideJunk ? "on" : ""}`} aria-pressed={f.hideJunk} onClick={() => setF({ ...f, hideJunk: !f.hideJunk })}>{f.hideJunk && I.check} Hide covers & karaoke</button>
      <Select className="small" value={f.minPlays} options={[[0, "Any plays"], [1e5, "100K+ plays"], [1e6, "1M+ plays"], [1e7, "10M+ plays"], [1e8, "100M+ plays"]]} onChange={(v) => setF({ ...f, minPlays: v })} />
      <Select className="small" value={f.sort} options={[["yt", "YouTube Music order"], ["plays", "Most played first"]]} onChange={(v) => setF({ ...f, sort: v })} />
      {albums && <button className={`chip ${f.deluxe ? "on" : ""}`} aria-pressed={f.deluxe} onClick={() => setF({ ...f, deluxe: !f.deluxe })}>{f.deluxe && I.check} Prefer deluxe editions</button>}
      {albums && <Seg className="small" value={f.type} onChange={(t) => setF({ ...f, type: t })} options={[["all", "All"], ["Album", "Albums"], ["other", "Singles & EPs"]]} />}
      {(top.length > 1 || artist) && (
        <div className="chips">
          <span className="tabs-sep" />
          <button className={`chip ${!artist ? "on" : ""}`} onClick={() => setArtist("")}>All artists</button>
          {top.map(([a, n]) => <button key={a} className={`chip ${artist === a ? "on" : ""}`} onClick={() => setArtist(a)}>{a} <span className="muted">{n}</span></button>)}
        </div>
      )}
    </div>
  );
}

function filtered<T extends { artist: string; junk?: boolean; plays?: number; title: string; type?: string }>(rows: T[], f: Filters, artist: string, albums: boolean): T[] {
  let v = rows;
  if (f.hideJunk) v = v.filter((x) => !x.junk);
  if (artist) v = v.filter((x) => (x.artist ?? "").toLowerCase().split(/,\s*|\s+&\s+/).includes(artist.toLowerCase()) || x.artist.toLowerCase() === artist.toLowerCase());
  if (f.minPlays) v = v.filter((x) => (x.plays ?? 0) >= f.minPlays);
  if (albums && f.deluxe) {
    // When an album also exists as a deluxe/expanded/anniversary edition, hide the plain one.
    const ed = /\s*[([][^)\]]*\b(deluxe|expanded|anniversary|special|bonus|complete|super)\b[^)\]]*[)\]]|\s*-\s*(deluxe|expanded).*$/i;
    const base = (x: T) => x.title.replace(ed, "").replace(/\s*[([](explicit|clean)[)\]]/i, "").trim().toLowerCase() + "|" + x.artist.split(/,\s*/)[0].toLowerCase();
    const has = new Set(v.filter((x) => ed.test(x.title)).map(base));
    v = v.filter((x) => ed.test(x.title) || !has.has(base(x)));
  }
  if (albums && f.type !== "all") v = v.filter((x) => (f.type === "Album" ? x.type === "Album" : x.type !== "Album"));
  if (f.sort === "plays") v = [...v].sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0));
  return v;
}

function Songs({ rows, f, setF, artist, setArtist, preset, setPreset, added, pick, setPick, onGet, onAlbum }: { rows: SongRow[]; f: Filters; setF: (f: Filters) => void; artist: string; setArtist: (a: string) => void; preset: string; setPreset: (p: string) => void; added: Set<string>; pick: Set<string>; setPick: (s: Set<string>) => void; onGet: (r: SongRow) => void; onAlbum: (r: SongRow) => void }) {
  const view = filtered(rows, f, artist, false);
  const picked = view.filter((r) => pick.has(r.url));
  const all = view.length > 0 && view.every((r) => pick.has(r.url));
  const flip = (u: string) => { const n = new Set(pick); n.has(u) ? n.delete(u) : n.add(u); setPick(n); };
  return (
    <>
      <FilterBar rows={rows} f={f} setF={setF} artist={artist} setArtist={setArtist} />
      <section className="card list">
        <div className="song-row head">
          <input type="checkbox" aria-label="Select all" checked={all} onChange={() => setPick(all ? new Set() : new Set(view.map((r) => r.url)))} />
          <span />
          <span className="muted small">{view.length} of {rows.length} songs</span>
          <span className="muted small">Plays</span>
          <span className="muted small">Length</span>
          <span />
        </div>
        {view.map((r) => {
          const inQ = added.has(r.url + preset);
          return (
            <div className={`song-row ${pick.has(r.url) ? "sel" : ""}`} key={r.url}>
              <input type="checkbox" aria-label={`Select ${r.title}`} checked={pick.has(r.url)} onChange={() => flip(r.url)} />
              <Pic src={r.art} className="square small" />
              <div className="qmain">
                <div className="job-title">{r.title}</div>
                <div className="muted small job-text">
                  {r.artist}
                  {r.album && <> · {r.albumId ? <button className="link small" onClick={() => onAlbum(r)} title="Open the whole album">{r.album}</button> : r.album}</>}
                  {r.year && ` · ${r.year}`}
                </div>
              </div>
              <span className="muted small">{r.plays > 0 ? plays(r.plays) : ""}</span>
              <span className="muted small mono">{r.dur}</span>
              <div className="job-actions">
                {r.albumId && <button className="icon" aria-label="Open album" title="Open the whole album" onClick={() => onAlbum(r)}>{I.disc}</button>}
                <button className={`icon ${inQ ? "okmark" : ""}`} aria-label={inQ ? "In the queue" : "Download now"} title={inQ ? "In the queue" : "Download now"} disabled={inQ} onClick={() => onGet(r)}>{inQ ? I.check : I.down}</button>
              </div>
            </div>
          );
        })}
        {!view.length && <p className="muted empty">Everything was filtered out. Loosen the filters above.</p>}
      </section>
      <Tray n={picked.length} what="song" preset={preset} setPreset={setPreset} onClear={() => setPick(new Set())} onGo={() => { picked.forEach(onGet); setPick(new Set()); toast(`Queued ${picked.length} song${picked.length > 1 ? "s" : ""}`); }} />
    </>
  );
}

/** The bar at the bottom while things are ticked: "3 songs selected · as Music → Download 3". */
function Tray({ n, what, preset, setPreset, onClear, onGo, presets }: { n: number; what: string; preset: string; setPreset: (p: string) => void; onClear: () => void; onGo: () => void; presets?: [string, string][] }) {
  const st = useStore();
  if (!n) return null;
  const p = store.preset(preset);
  const dest = p.outputDir || st.dir(p.kind === "music" ? (p.podcast ? st.settings.dirPodcasts : st.settings.dirMusic) : p.metaMode === "youtube" ? st.settings.dirYoutube : st.settings.dirOther);
  return (
    <div className="tray" role="region" aria-label="Selection">
      <b>{n} {what}{n > 1 ? "s" : ""} selected</b>
      <button className="small-btn" onClick={onClear}>Clear</button>
      <div className="spacer" />
      <span className="muted small">as</span>
      <Select value={preset} options={presets ?? musicPresets().map((x) => [x.id, x.name])} onChange={setPreset} />
      <span className="muted small mono ell tray-dest" title={dest}>→ {tildify(dest, st.info?.home ?? "")}</span>
      <button className="primary" onClick={onGo}>{I.down} Download {n}</button>
    </div>
  );
}

function BulkBar({ list, pick, setPick, preset, setPreset }: { list: AlbumCard[]; pick: Set<string>; setPick: (s: Set<string>) => void; preset: string; setPreset: (p: string) => void }) {
  const picked = list.filter((a) => pick.has(a.id));
  const all = list.length > 0 && list.every((a) => pick.has(a.id));
  return (
    <>
      <div className="bulkbar">
        <label className="check small"><input type="checkbox" checked={all} onChange={() => setPick(all ? new Set([...pick].filter((id) => !list.some((a) => a.id === id))) : new Set([...pick, ...list.map((a) => a.id)]))} /> Select all</label>
        <span className="muted small">Hover a cover to get the whole album, or click it to check the tracks first.</span>
      </div>
      <Tray n={picked.length} what="album" preset={preset} setPreset={setPreset} onClear={() => setPick(new Set())} onGo={() => {
        toast(`Queueing ${picked.length} album${picked.length > 1 ? "s" : ""}…`, "One after another, in the background");
        void search.queueAlbums(picked, preset, (t, s) => toast(t, s));
        setPick(new Set());
      }} />
    </>
  );
}

function AlbumGrid({ list, pick, setPick, onOpen, preset }: { list: AlbumCard[]; pick: Set<string>; setPick: (s: Set<string>) => void; onOpen: (a: AlbumCard) => void; preset?: string }) {
  const [got, setGot] = useState<Set<string>>(new Set());
  return (
    <div className="agrid">
      {list.map((a) => (
        <div className={`acard ${pick.has(a.id) ? "picked" : ""}`} key={a.id} onClick={() => onOpen(a)}>
          <div className="acover">
            <Pic src={a.art} className="cover" fallback={I.disc} />
            <label className="apick" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${a.title}`} checked={pick.has(a.id)} onChange={() => { const n = new Set(pick); n.has(a.id) ? n.delete(a.id) : n.add(a.id); setPick(n); }} /></label>
            {preset && (
              <button className={`aget ${got.has(a.id) ? "done" : ""}`} disabled={got.has(a.id)} onClick={(e) => {
                e.stopPropagation();
                setGot((g) => new Set(g).add(a.id));
                toast(`Getting “${a.title}”…`, "Matching the tracks, then queueing them");
                void search.queueAlbums([a], preset, (t, s) => toast(t, s));
              }}>{got.has(a.id) ? <>{I.check} Queued</> : <>{I.down} Get album</>}</button>
            )}
          </div>
          <b>{a.title}</b>
          {a.artist && <span className="muted small">{a.artist}</span>}
          <span className="muted small">{[a.year, a.type !== "Album" ? a.type : "", a.tracks ? `${a.tracks} song${a.tracks === 1 ? "" : "s"}` : "", a.plays ? `${plays(a.plays)} plays` : "", a.fans ? `${plays(a.fans)} fans` : ""].filter(Boolean).join(" · ")}</span>
        </div>
      ))}
    </div>
  );
}

function Albums({ rows, f, setF, artist, setArtist, pick, setPick, preset, setPreset, onOpen }: { rows: AlbumCard[]; f: Filters; setF: (f: Filters) => void; artist: string; setArtist: (a: string) => void; pick: Set<string>; setPick: (s: Set<string>) => void; preset: string; setPreset: (p: string) => void; onOpen: (a: AlbumCard) => void }) {
  const view = filtered(rows, f, artist, true);
  return (
    <>
      <FilterBar rows={rows} f={f} setF={setF} artist={artist} setArtist={setArtist} albums />
      <BulkBar list={view} pick={pick} setPick={setPick} preset={preset} setPreset={setPreset} />
      {view.length ? <AlbumGrid list={view} pick={pick} setPick={setPick} onOpen={onOpen} preset={preset} /> : <p className="muted center-text">Everything was filtered out. Loosen the filters above.</p>}
    </>
  );
}

function Videos({ rows, vPreset, setVPreset, added, pick, setPick, onGet }: { rows: VideoRow[]; vPreset: string; setVPreset: (p: string) => void; added: Set<string>; pick: Set<string>; setPick: (s: Set<string>) => void; onGet: (r: VideoRow, preset: string) => void }) {
  const st = useStore();
  const subList = useSubs();
  const subbed = (u: string) => subList.some((s) => s.url.replace(/\/(videos|streams|shorts|featured)?\/?$/, "") === u.replace(/\/$/, ""));
  const picked = rows.filter((r) => pick.has(r.url));
  return (
    <>
      <div className="bulkbar">
        <label className="check small"><input type="checkbox" checked={rows.every((r) => pick.has(r.url))} onChange={(e) => setPick(e.target.checked ? new Set(rows.map((r) => r.url)) : new Set())} /> Select all</label>
        <span className="spacer" />
        <span className="muted small">Download as</span>
        <Select className="small" value={vPreset} options={st.presets.map((p) => [p.id, `${p.kind === "music" ? "♪ " : ""}${p.name}`])} onChange={setVPreset} />
      </div>
      <Tray n={picked.length} what="video" preset={vPreset} setPreset={setVPreset} presets={st.presets.map((p) => [p.id, `${p.kind === "music" ? "♪ " : ""}${p.name}`])} onClear={() => setPick(new Set())} onGo={() => { picked.forEach((r) => onGet(r, vPreset)); setPick(new Set()); toast(`Queued ${picked.length}`); }} />
      <div className="vgrid">
        {rows.map((r) => (
          <div className={`vcard ${pick.has(r.url) ? "picked" : ""}`} key={r.url}>
            <div className="vthumb">
              <Pic src={r.art} className="wide" fallback={I.film} />
              <label className="apick"><input type="checkbox" checked={pick.has(r.url)} onChange={() => { const n = new Set(pick); n.has(r.url) ? n.delete(r.url) : n.add(r.url); setPick(n); }} /></label>
              {r.dur && <span className="vdur">{r.dur}</span>}
            </div>
            <div className="job-title two-lines" title={r.title}>{r.title}</div>
            <div className="muted small">{[r.channel, r.views].filter(Boolean).join(" · ")}</div>
            <div className="row tight">
              <button className={`small-btn ${added.has(r.url + vPreset) ? "added" : "soft"}`} disabled={added.has(r.url + vPreset)} onClick={() => onGet(r, vPreset)}>{added.has(r.url + vPreset) ? <>{I.check} In queue</> : <>{I.down} Download</>}</button>
              {r.channelUrl && (subbed(r.channelUrl) ? <span className="muted small">{I.check} Subscribed</span> : <button className="small-btn" onClick={() => void subs.add(r.channelUrl, { presetId: vPreset }).then((a) => toast(a.length ? `Subscribed to ${a[0].name}` : "Already subscribed"))}>{I.bell} Subscribe</button>)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Podcasts({ rows }: { rows: PodcastRow[] }) {
  const subList = useSubs();
  const podcast = store.presets.find((p) => p.podcast)?.id ?? "podcast";
  return (
    <div className="agrid">
      {rows.map((r) => {
        const on = subList.some((s) => s.url === r.url);
        return (
          <div className="acard" key={r.url}>
            <Pic src={r.art} className="cover" fallback={I.mic} />
            <b>{r.title}</b>
            <span className="muted small">{r.author}</span>
            <span className="muted small">{r.episodes} episodes · {r.freq}</span>
            {on ? <span className="muted small">{I.check} Subscribed</span> : <button className="small-btn soft" onClick={() => void subs.add(r.url, { presetId: podcast }).then(() => toast(`Subscribed to ${r.title}`, "New episodes download while Goblin is open"))}>{I.bell} Subscribe</button>}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ album finder

export function AlbumModal({ card, onClose, onUse, useLabel }: { card: AlbumCard; onClose: () => void; onUse?: (a: Album, cover: string) => void; useLabel?: string }) {
  const st = useStore();
  const [a, setA] = useState<Album | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [picks, setPicks] = useState<Record<number, { url: string; label: string }>>({});
  const [cover, setCover] = useState("");
  const [covers, setCovers] = useState<{ url: string; label: string }[] | null>(null);
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [preset, setPreset] = useState(() => musicPresets()[0]?.id ?? "music");

  async function open(release?: string) {
    setA(null);
    setErr(null);
    try {
      const x = await search.albumMatch(card.id, release, card.artist, card.title, card.art);
      setA(x);
      if (x.pending) {
        const tracks = await search.albumYT(x);
        setA((cur) => (cur && cur.id === x.id ? { ...cur, tracks, pending: false } : cur));
      }
    } catch (e) {
      setErr(errorText(e));
    }
  }
  useEffect(() => void open(), [card.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const usable = a ? a.tracks.filter((t) => !skip.has(t.n) && (picks[t.n] || (t.url && t.status !== "missing"))) : [];
  const counts = a ? { ok: a.tracks.filter((t) => t.status === "ok" || picks[t.n]).length, missing: a.tracks.filter((t) => t.status === "missing" && !picks[t.n]).length } : { ok: 0, missing: 0 };
  return (
    <Modal title={a ? a.title : card.title} onClose={onClose} wide footer={<>
      <span className="muted small spacer">{a && `→ ${tildify(a.dest, st.info?.home ?? "")}`}</span>
      {!onUse && <Select value={preset} options={musicPresets().map((p) => [p.id, p.name])} onChange={setPreset} />}
      <button className="primary" disabled={!a || a.pending || !usable.length} onClick={() => {
        if (!a) return;
        if (onUse) return onUse({ ...a, tracks: a.tracks.filter((t) => !skip.has(t.n)) }, cover);
        const p: Record<number, string> = {};
        for (const [k, v] of Object.entries(picks)) p[Number(k)] = v.url;
        const added = search.download({ ...a, trackTotal: a.trackTotal ?? a.tracks.length }, preset, p, cover, skip);
        toast(`Queued ${added.length} tracks`, `${a.artist} – ${a.title}`);
        onClose();
      }}>{onUse ? useLabel ?? "Use this album" : <>{I.down} Download {usable.length} track{usable.length === 1 ? "" : "s"}</>}</button>
    </>}>
      {err && <p className="error">{err}</p>}
      {!a && !err && <p className="muted">Opening “{card.title}”…</p>}
      {a && (
        <>
          <div className="ahero">
            <div className="ahero-cover">
              <Pic src={cover || a.cover} className="cover big" fallback={I.disc} />
              <button className="small-btn" onClick={async () => { setCovers([]); setCovers(await search.covers(a)); }}>{I.image} Choose cover</button>
            </div>
            <div>
              <div className="muted small">{[a.type, a.year, a.label].filter(Boolean).join(" · ")}</div>
              <h2 className="big">{a.title}</h2>
              <div className="strong">{a.artist}</div>
              {a.editions.length > 1 && <div className="row tight"><span className="muted small">Edition</span><Select value={a.id} options={a.editions.map((e) => [e.id, e.label])} onChange={(id) => void open(id)} /></div>}
              <div className="pills">
                {a.pending && <span className="pill">Finding tracks on YouTube Music…</span>}
                {a.source === "ytmusic" ? <span className="pill">{a.tracks.length} tracks · from YouTube Music</span> : !a.pending && <span className="pill ok">{I.check} {counts.ok} of {a.tracks.length} matched</span>}
                {!a.pending && a.tracks.length - counts.ok - counts.missing > 0 && <span className="pill warn">{I.warn} {a.tracks.length - counts.ok - counts.missing} to check</span>}
                {counts.missing > 0 && <span className="pill bad">{counts.missing} not found (skipped)</span>}
              </div>
            </div>
          </div>
          <div className="tracks">
            <div className="track head">
              <input type="checkbox" checked={!skip.size} onChange={(e) => setSkip(e.target.checked ? new Set() : new Set(a.tracks.map((t) => t.n)))} />
              <span>#</span><span>Track</span><span>Length</span>{a.source !== "ytmusic" && <><span>On YouTube Music</span><span /></>}
            </div>
            {a.tracks.map((t) => {
              const p = picks[t.n];
              const icon = t.status === "searching" && !p ? "…" : p || t.status === "ok" ? <span className="okmark">{I.check}</span> : t.status === "warn" ? <span className="warnmark">{I.warn}</span> : <span className="error-text">{I.x}</span>;
              return (
                <div className={`track ${skip.has(t.n) ? "off" : ""} ${a.source !== "ytmusic" ? "matched" : ""}`} key={t.n}>
                  <input type="checkbox" checked={!skip.has(t.n)} onChange={() => setSkip((s) => { const n = new Set(s); n.has(t.n) ? n.delete(t.n) : n.add(t.n); return n; })} />
                  <span className="muted">{t.n}</span>
                  <span className="strong ell">{t.title}{t.artist && t.artist !== a.artist && <span className="muted"> · {t.artist}</span>}</span>
                  <span className="muted mono">{t.len}</span>
                  {a.source !== "ytmusic" && <>
                    <span className="ell small">{icon} {p ? p.label : t.yt}{!p && t.ytLen ? ` · ${t.ytLen}` : ""}</span>
                    <button className="small-btn" onClick={() => setPickFor(t.n)}>{t.status === "ok" && !p ? "Change" : "Pick…"}</button>
                  </>}
                </div>
              );
            })}
          </div>
        </>
      )}
      {covers && <CoverPicker list={covers} onClose={() => setCovers(null)} onPick={(u) => { setCover(u); setCovers(null); }} />}
      {pickFor != null && a && <TrackPicker q={`${a.artist} ${a.tracks.find((t) => t.n === pickFor)?.title ?? ""}`} title={a.tracks.find((t) => t.n === pickFor)?.title ?? ""} onClose={() => setPickFor(null)} onPick={(r) => { setPicks((x) => ({ ...x, [pickFor]: { url: r.url, label: `${r.title} · ${r.dur}` } })); setPickFor(null); }} />}
    </Modal>
  );
}

function TrackPicker({ q, title, onClose, onPick }: { q: string; title: string; onClose: () => void; onPick: (r: SongRow) => void }) {
  const [rows, setRows] = useState<SongRow[] | null>(null);
  useEffect(() => void search.search("songs", q).then((r) => setRows((r as SongRow[]).slice(0, 10))).catch(() => setRows([])), [q]);
  return (
    <Modal title={`Pick: ${title}`} onClose={onClose}>
      {!rows && <p className="muted">Searching…</p>}
      {rows?.map((r) => (
        <div className="hit" key={r.url}>
          <Pic src={r.art} className="square small" />
          <div className="job-main"><div className="job-title">{r.title}</div><div className="muted small">{r.artist}</div></div>
          <span className="muted small mono">{r.dur}</span>
          <button className="small-btn" onClick={() => onPick(r)}>Use</button>
        </div>
      ))}
      {rows && !rows.length && <p className="muted">Nothing found.</p>}
    </Modal>
  );
}

export function CoverPicker({ list, onClose, onPick }: { list: { url: string; label: string }[]; onClose: () => void; onPick: (url: string) => void }) {
  const [i, setI] = useState(0);
  const [link, setLink] = useState("");
  return (
    <Modal title="Choose cover" onClose={onClose} wide footer={<>
      <button onClick={async () => { const p = await api.pickImage(); if (p) onPick(p); }}>Use my own…</button>
      <input value={link} placeholder="…or paste an image link (https)" onChange={(e) => setLink(e.target.value)} />
      <span className="spacer" />
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!list.length && !/^https:\/\//.test(link)} onClick={() => onPick(/^https:\/\//.test(link) ? link : list[i].url)}>Use this</button>
    </>}>
      {!list.length && <p className="muted">Finding covers (YouTube Music, Apple Music, Deezer, Cover Art Archive)…</p>}
      <div className="covers">
        {list.map((c, k) => (
          <button key={c.url} className={`cov ${k === i ? "on" : ""}`} onClick={() => setI(k)}>
            <Pic src={c.url} className="cover" fallback={I.image} />
            <span className="muted small ell">{c.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function DiscoModal({ q, onClose, onOpen }: { q: string; onClose: () => void; onOpen: (a: AlbumCard) => void }) {
  const [artists, setArtists] = useState<{ id: string; title: string; albums: number; fans: number; art: string }[] | null>(null);
  const [who, setWho] = useState<{ id: string; title: string } | null>(null);
  const [list, setList] = useState<AlbumCard[] | null>(null);
  const [filter, setFilter] = useState<"Album" | "Single" | "Compilation" | "all">("Album");
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState(() => musicPresets()[0]?.id ?? "music");
  useEffect(() => void search.artists(q).then(setArtists).catch((e) => { setArtists([]); toast("Artist search failed", errorText(e)); }), [q]);
  useEffect(() => {
    if (!who) return;
    setList(null);
    void search.artistAlbums(who.id).then((l) => setList(l.map((a) => ({ ...a, artist: who.title })))).catch((e) => { setList([]); toast("Couldn't load albums", errorText(e)); });
  }, [who]);
  const shown = (list ?? []).filter((a) => filter === "all" || a.type === filter || (filter === "Single" && a.type === "EP"));
  const count = (k: typeof filter) => (list ?? []).filter((a) => k === "all" || a.type === k || (k === "Single" && a.type === "EP")).length;
  const body: ReactNode = !who ? (
    <>
      {!artists && <p className="muted">Searching artists…</p>}
      <div className="agrid">
        {artists?.map((x) => (
          <div className="acard" key={x.id} onClick={() => setWho(x)}>
            <Pic src={x.art} className="cover round" fallback={I.user} />
            <b>{x.title}</b>
            <span className="muted small">{[x.albums ? `${x.albums} albums` : "", x.fans ? `${plays(x.fans)} fans` : ""].filter(Boolean).join(" · ")}</span>
          </div>
        ))}
      </div>
    </>
  ) : (
    <>
      <div className="row tight">
        <button className="small-btn" onClick={() => setWho(null)}>← Artists</button>
        <Seg value={filter} onChange={setFilter} options={(["Album", "Single", "Compilation", "all"] as const).map((k) => [k, `${{ Album: "Albums", Single: "Singles & EPs", Compilation: "Compilations", all: "Everything" }[k]} (${count(k)})`])} />
      </div>
      {!list && <p className="muted">Loading albums…</p>}
      <BulkBar list={shown} pick={pick} setPick={setPick} preset={preset} setPreset={setPreset} />
      <AlbumGrid list={shown} pick={pick} setPick={setPick} onOpen={onOpen} />
    </>
  );
  return <Modal title={who ? who.title : `Artists for “${q}”`} onClose={onClose} wide>{body}</Modal>;
}

