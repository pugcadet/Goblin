import { useEffect, useState } from "react";
import { api, errorText, isMac } from "../api";
import { fixer, FixItem, missing, MissingAlbum } from "../engine/fix";
import { Candidate } from "../engine/model";
import { Album, AlbumCard, search } from "../engine/search";
import { store } from "../engine/store";
import { seconds, similarity } from "../engine/text";
import { AlbumModal } from "./Search";
import { I, Modal, Pic, Seg, Select, toast, useStore } from "../ui";
import { OPTS } from "./Downloads";
import { NamingInput } from "./Settings";

const S: { files: FixItem[]; sel: Set<number> } = { files: [], sel: new Set() };

export default function FixMusic() {
  const st = useStore();
  const [files, setFilesState] = useState<FixItem[]>(S.files);
  const [sel, setSelState] = useState<Set<number>>(S.sel);
  const setFiles = (f: FixItem[]) => setFilesState((S.files = f));
  const setSel = (s: Set<number>) => setSelState((S.sel = s));
  const [busy, setBusy] = useState<{ text: string; done: number; total: number } | null>(null);
  const [mode, setMode] = useState<"ready" | "inplace">("ready");
  const [loud, setLoud] = useState(st.settings.loudness);
  const [name, setName] = useState(st.settings.trackName === "{title}" ? "{track} - {title}" : st.settings.trackName);
  const [folders, setFolders] = useState<"album" | "keep">("album");
  const [other, setOther] = useState<number | null>(null);
  const [setAlbum, setSetAlbum] = useState(false);
  const [missingOpen, setMissingOpen] = useState<string | null>(null);

  async function scan(kind: "audio" | "folders") {
    const paths = await api.pickPaths(kind).catch(() => [] as string[]);
    if (!paths.length) return;
    setBusy({ text: "Reading files…", done: 0, total: 0 });
    try {
      const found = await fixer.scan(paths, (done, total) => setBusy({ text: "Matching on MusicBrainz…", done, total }));
      const merged = [...files.filter((f) => !found.some((x) => x.path === f.path)), ...found];
      setFiles(merged);
      setSel(new Set(merged.map((_, i) => i)));
    } catch (e) {
      toast("Couldn't read those files", errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    const items = [...sel].map((i) => files[i]).filter((f) => f?.candidate);
    if (!items.length) return;
    setBusy({ text: "Fixing…", done: 0, total: items.length });
    try {
      const r = await fixer.apply(items, mode, loud, name, folders, (done, total) => setBusy({ text: "Fixing…", done, total }));
      toast(`Fixed ${r.fixed} file${r.fixed === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}`, r.errors.slice(0, 2).join(" · ") || (mode === "ready" ? "Copies are in your library's Music folder" : "Originals are in the Trash"));
      const done = new Set(items.map((x) => x.path));
      setFiles(files.filter((f) => !done.has(f.path)));
      setSel(new Set());
    } finally {
      setBusy(null);
    }
  }

  const ready = [...sel].filter((i) => files[i]?.candidate).length;
  return (
    <main className="page">
      <section className="card dropcard">
        <div className="dicon">{I.music}</div>
        <div className="grow-text">
          <b>Fix music files</b>
          <div className="muted small">MP3, M4A, FLAC, Opus. Goblin matches each on MusicBrainz and fixes tags, cover, loudness and file names. Audio is copied, not re-encoded.</div>
        </div>
        <button className="small-btn" onClick={() => void scan("audio")}>{I.music} Choose files…</button>
        <button className="small-btn" onClick={() => void scan("folders")}>{I.folder} Choose folders…</button>
      </section>
      <section className="card dropcard slim">
        <div className="dicon">{I.disc}</div>
        <div className="grow-text">
          <b>Find missing tracks</b>
          <div className="muted small">Checks every album in a music folder against YouTube Music and lists the tracks you don't have yet. Nothing downloads until you pick.</div>
        </div>
        <button className="small-btn soft" onClick={() => setMissingOpen(st.dir(st.settings.dirMusic))}>{I.search} Scan library Music</button>
        <button className="small-btn" onClick={async () => { const [p] = await api.pickPaths("folder").catch(() => [] as string[]); if (p) setMissingOpen(p); }}>{I.folder} Other folder…</button>
      </section>

      {busy && (
        <div className="card busybar">
          <div className="progress grow"><span style={{ width: `${busy.total ? (busy.done / busy.total) * 100 : 3}%` }} /></div>
          <span className="muted small">{busy.text}{busy.total ? ` ${busy.done}/${busy.total}` : ""}</span>
          <button className="small-btn" onClick={() => { fixer.cancelled = true; }}>{I.x} Stop</button>
        </div>
      )}

      {files.length > 0 ? (
        <section className="card list">
          <div className="row list-head">
            <input type="checkbox" checked={sel.size === files.length} onChange={(e) => setSel(e.target.checked ? new Set(files.map((_, i) => i)) : new Set())} />
            <h2>Files</h2>
            <span className="badge">{files.length}</span>
            <button className="link" onClick={() => { setFiles([]); setSel(new Set()); }}>Clear list</button>
            <div className="spacer" />
            <Seg value={mode} onChange={setMode} options={[["ready", "Copy into library"], ["inplace", "Fix in place"]]} />
            <Select value={loud} options={OPTS.loudness} onChange={setLoud} />
          </div>
          <div className="fixname">
            <div className="setting"><div className="setting-label">Rename to<div className="muted small">Empty = keep the current file names.</div></div>
              <div className="setting-ctl"><NamingInput value={name} kind="track" onChange={setName} allowEmpty /></div></div>
            <div className="setting"><div className="setting-label">Folders</div>
              <div className="setting-ctl"><Seg value={folders} onChange={setFolders} options={[["album", "Artist / Album (Year)"], ["keep", mode === "inplace" ? "Leave where they are" : "Straight into Music"]]} /></div></div>
          </div>
          {files.map((f, i) => (
            <div className={`job fixrow ${sel.has(i) ? "sel" : ""}`} key={f.path}>
              <input type="checkbox" checked={sel.has(i)} onChange={() => { const n = new Set(sel); n.has(i) ? n.delete(i) : n.add(i); setSel(n); }} />
              <Pic src={f.oldArt} className="square" />
              <div className="job-main"><div className="job-title" title={f.path}>{f.file}</div><div className="muted small job-text">{f.old}</div></div>
              <span className="arrow">→</span>
              <Pic src={f.newArt} className="square" />
              <div className="job-main">
                <div className={`job-title ${f.candidate ? "okmark" : "muted"}`}>{f.newName}</div>
                <div className="muted small job-text">{f.new}</div>
                <div className="pills">{f.changes.map((c) => <span key={c} className="pill">{c}</span>)}</div>
              </div>
              {f.candidate && <span className={`score ${f.score >= 0.8 ? "good" : f.score >= 0.6 ? "fair" : "poor"}`}>{Math.round(f.score * 100)}</span>}
              <div className="job-actions">
                <button className="small-btn" onClick={() => setOther(i)}>Other match…</button>
                <button className="icon" title="Remove from the list (the file isn't touched)" onClick={() => { setFiles(files.filter((_, k) => k !== i)); setSel(new Set([...sel].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k)))); }}>{I.x}</button>
              </div>
            </div>
          ))}
          <div className="row list-foot">
            <span className="muted small">{mode === "ready" ? "Originals are never touched: fixed copies go into your library's Music folder." : `Originals are replaced (the old files go to the ${isMac ? "Trash" : "Recycle Bin"}).`}</span>
            <div className="spacer" />
            <button className="small-btn" disabled={!sel.size} onClick={() => setSetAlbum(true)}>{I.disc} Set album for {sel.size} selected…</button>
            <button className="primary" disabled={!ready || !!busy} onClick={() => void apply()}>{I.wand} Fix {ready} file{ready === 1 ? "" : "s"}</button>
          </div>
        </section>
      ) : (
        !busy && <div className="empty-big"><b>Nothing here yet</b><span className="muted">Old downloads with wrong tags, “Track 01.mp3”, missing covers: choose them above.</span></div>
      )}

      {other != null && files[other] && <OtherMatch item={files[other]} onClose={() => setOther(null)} onPick={(c) => {
        const n = [...files];
        n[other] = { ...n[other], candidate: c, newName: c.title, new: c.subtitle, newArt: c.image ?? "", score: c.score };
        setFiles(n);
        setOther(null);
      }} />}
      {setAlbum && <SetAlbum files={[...sel].sort((a, b) => a - b).map((k) => ({ k, f: files[k] }))} onClose={() => setSetAlbum(false)} onApply={(updates) => {
        const n = [...files];
        for (const [k, f] of updates) n[k] = f;
        setFiles(n);
        setSetAlbum(false);
      }} />}
      {missingOpen && <MissingModal root={missingOpen} onClose={() => setMissingOpen(null)} />}
    </main>
  );
}

function OtherMatch({ item, onClose, onPick }: { item: FixItem; onClose: () => void; onPick: (c: Candidate) => void }) {
  const [q, setQ] = useState(item.ttl);
  const [list, setList] = useState<Candidate[] | null>(null);
  const load = async (query?: string) => {
    setList(null);
    setList(query ? await search_(query) : await fixer.candidates(item.path));
  };
  const search_ = async (query: string) => {
    const { MusicBrainz } = await import("../engine/services");
    const { parseSong } = await import("../engine/parse");
    const p = parseSong(query);
    return MusicBrainz.search(p.artist, p.title, item.dur || undefined).catch(() => []);
  };
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={`Match: ${item.file}`} onClose={onClose} wide>
      <div className="row tight"><input className="grow" value={q} placeholder="Artist - Title" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load(q)} /><button className="small-btn" onClick={() => void load(q)}>{I.search} Search</button></div>
      {!list && <p className="muted">Searching MusicBrainz…</p>}
      {list?.map((c) => (
        <button key={c.id} className="cand" onClick={() => onPick(c)}>
          <Pic src={c.image} className="square small" />
          <span className="cand-text"><span className="strong">{c.title}</span><span className="muted small">{c.subtitle}</span></span>
          <span className={`score ${c.score >= 0.8 ? "good" : c.score >= 0.6 ? "fair" : "poor"}`}>{Math.round(c.score * 100)}</span>
        </button>
      ))}
      {list && !list.length && <p className="muted">Nothing found.</p>}
    </Modal>
  );
}

/** Pick one album; the selected files are lined up with its tracks (by title, length and old track number). */
function SetAlbum({ files, onClose, onApply }: { files: { k: number; f: FixItem }[]; onClose: () => void; onApply: (u: [number, FixItem][]) => void }) {
  const [q, setQ] = useState(files.map(({ f }) => f.old.split(" · ")[1]).find(Boolean) ?? "");
  const [res, setRes] = useState<AlbumCard[] | null>(null);
  const [card, setCard] = useState<AlbumCard | null>(null);
  const [album, setAlbum] = useState<{ a: Album; cover: string } | null>(null);
  const [map, setMap] = useState<Record<number, number>>({});
  const find = async () => {
    setRes(null);
    setRes((await search.search("albums", q).catch(() => [])) as AlbumCard[]);
  };
  const use = (a: Album, cover: string) => {
    setCard(null);
    setAlbum({ a, cover: cover || a.cover });
    const pairs: [number, number, number][] = [];
    for (const { k, f } of files)
      for (const t of a.tracks) {
        let sc = similarity(f.ttl || f.file, t.title);
        const d = Math.abs((f.dur || 0) - (t.lenSec || seconds(t.len)));
        if (f.dur && (t.lenSec || t.len)) sc += d <= 3 ? 0.35 : d <= 10 ? 0.1 : -0.2;
        const no = f.trackNo || Number((f.file.match(/(?:^|\D)(\d{1,2})(?:\D|$)/) ?? [])[1] ?? 0);
        if (no && no === t.n) sc += 0.4;
        pairs.push([sc, k, t.n]);
      }
    const m: Record<number, number> = {};
    const used = new Set<number>();
    for (const [sc, k, n] of pairs.sort((x, y) => y[0] - x[0])) if (sc >= 0.35 && m[k] === undefined && !used.has(n)) { m[k] = n; used.add(n); }
    setMap(m);
  };
  return (
    <Modal title={`Set album for ${files.length} file${files.length === 1 ? "" : "s"}`} onClose={onClose} wide footer={<>
      <span className="muted small spacer">{album && `→ ${album.a.artist} / ${album.a.title}${album.a.year ? ` (${album.a.year})` : ""}`}</span>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!album || !Object.keys(map).length} onClick={() => {
        if (!album) return;
        const a = album.a;
        const total = a.trackTotal ?? a.tracks.length;
        const out: [number, FixItem][] = [];
        for (const { k, f } of files) {
          const t = a.tracks.find((x) => x.n === map[k]);
          if (!t) continue;
          const tags = { title: t.title, artist: t.artist || a.artist, album: a.title, albumArtist: a.artist, date: a.year, track: String(t.pos ?? t.n), trackTotal: String(total), cover: album.cover };
          const cand: Candidate & { tags: Record<string, string> } = { id: `album:${a.id}:${t.n}`, title: `${tags.artist} – ${t.title}`, subtitle: `${a.title} · ${a.year} · track ${t.n}`, image: album.cover, kind: "album", score: 1, meta: {}, tags };
          out.push([k, { ...f, candidate: cand, newName: cand.title, new: cand.subtitle, newArt: album.cover, score: 1, changes: ["Tags", "Album + year", "Cover", "Renamed"] }]);
        }
        onApply(out);
      }}>{I.check} Use this album</button>
    </>}>
      {!album ? (
        <>
          <div className="row tight"><input className="grow" value={q} placeholder="Album or artist, e.g. Meteora" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void find()} /><button className="small-btn" onClick={() => void find()}>{I.search} Search</button></div>
          {res === null && q && <p className="muted">Search the album these files belong to.</p>}
          <div className="agrid small">
            {res?.slice(0, 18).map((x) => (
              <div className="acard" key={x.id} onClick={() => setCard(x)}>
                <Pic src={x.art} className="cover" fallback={I.disc} />
                <b>{x.title}</b><span className="muted small">{x.artist}</span><span className="muted small">{[x.year, x.type].filter(Boolean).join(" · ")}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="muted small">{Object.keys(map).length} of {files.length} files matched to a track. Check the list and change any row.</p>
          {files.map(({ k, f }) => (
            <div className="job" key={k}>
              <div className="job-main"><div className="job-title">{f.file}</div><div className="muted small">{f.old}</div></div>
              <Select value={map[k] ?? 0} options={[[0, "— skip —"] as [number, string], ...album.a.tracks.map((t) => [t.n, `${t.n}. ${t.title}${t.len ? ` · ${t.len}` : ""}`] as [number, string])]} onChange={(n) => setMap((m) => { const c = { ...m }; if (n) c[k] = n; else delete c[k]; return c; })} />
            </div>
          ))}
          <button className="link small" onClick={() => setAlbum(null)}>← Another album</button>
        </>
      )}
      {card && <AlbumModal card={card} onClose={() => setCard(null)} onUse={use} useLabel="Line my files up with this album" />}
    </Modal>
  );
}

function MissingModal({ root, onClose }: { root: string; onClose: () => void }) {
  const [prog, setProg] = useState<{ stage: string; done: number; total: number }>({ stage: "Starting…", done: 0, total: 0 });
  const [albums, setAlbums] = useState<MissingAlbum[] | null>(null);
  const [filter, setFilter] = useState<"missing" | "notfound" | "complete" | "all">("missing");
  const [off, setOff] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState(() => store.presets.find((p) => p.kind === "music" && !p.podcast)?.id ?? "music");
  useEffect(() => {
    void missing.scan(root, (stage, done, total) => setProg({ stage, done, total })).then(setAlbums).catch((e) => { setAlbums([]); toast("Scan failed", errorText(e)); });
    return () => void (missing.cancelled = true);
  }, [root]);
  const count = (k: string) => (albums ?? []).filter((a) => a.status === k).length;
  const picked = (albums ?? []).flatMap((a, ai) => (a.status === "missing" ? a.missing.filter((t) => !off.has(`${ai}:${t.n}`)).map((t) => ({ ai, n: t.n })) : []));
  const shown = (albums ?? []).map((a, ai) => ({ a, ai })).filter(({ a }) => filter === "all" || a.status === filter);
  return (
    <Modal title="Find missing tracks" onClose={() => { missing.cancelled = true; onClose(); }} wide footer={<>
      <span className="muted small spacer">{albums && `${albums.length} albums checked · ${count("missing")} with gaps · ${count("notfound")} not found`}</span>
      <Select value={preset} options={store.presets.filter((p) => p.kind === "music" && !p.podcast).map((p) => [p.id, p.name])} onChange={setPreset} />
      <button className="primary" disabled={!picked.length} onClick={() => {
        const by = new Map<number, number[]>();
        for (const { ai, n } of picked) by.set(ai, [...(by.get(ai) ?? []), n]);
        const items = [...by].map(([ai, ns]) => ({ release: albums![ai].release!, ns, album: albums![ai].album, artist: albums![ai].artist, year: albums![ai].year }));
        const q = missing.download(items, preset);
        toast(`Queued ${q} missing tracks`, `${items.length} album${items.length > 1 ? "s" : ""}`);
        onClose();
      }}>{I.down} Download {picked.length || ""} missing track{picked.length === 1 ? "" : "s"}</button>
    </>}>
      {!albums && (
        <div className="busybar">
          <div className="progress grow"><span style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 3}%` }} /></div>
          <span className="muted small">{prog.stage}{prog.total ? ` ${prog.done}/${prog.total}` : ""}</span>
          <button className="small-btn" onClick={() => { missing.cancelled = true; }}>{I.x} Stop</button>
        </div>
      )}
      {albums && !albums.length && <p className="muted">No tagged albums found in that folder.</p>}
      {albums && albums.length > 0 && (
        <>
          <Seg value={filter} onChange={setFilter} options={(["missing", "notfound", "complete", "all"] as const).map((k) => [k, `${{ missing: "Missing tracks", notfound: "Not on YouTube Music", complete: "Complete", all: "All" }[k]} (${k === "all" ? albums.length : count(k)})`])} />
          {shown.map(({ a, ai }) => (
            <div className={`job msalbum ${a.status}`} key={ai}>
              <Pic src={a.cover} className="square" fallback={I.disc} />
              <div className="job-main">
                <div className="job-title">{a.artist} – {a.album}{a.year && <span className="muted"> ({a.year})</span>}</div>
                <div className="muted small">You have {a.have}{a.total ? ` of ${a.total}` : ""}{a.status === "complete" ? " · complete" : a.missing.length ? ` · ${a.missing.length} missing` : ""}{a.note ? ` · ${a.note}` : ""}</div>
                {a.missing.length > 0 && (
                  <div className="mstracks">
                    {a.missing.map((t) => (
                      <label className="check small" key={t.n}>
                        <input type="checkbox" disabled={a.status !== "missing"} checked={a.status === "missing" && !off.has(`${ai}:${t.n}`)} onChange={() => setOff((o) => { const n = new Set(o); const key = `${ai}:${t.n}`; n.has(key) ? n.delete(key) : n.add(key); return n; })} />
                        <span className="muted">{t.n}.</span> {t.title} <span className="muted">{t.len}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
