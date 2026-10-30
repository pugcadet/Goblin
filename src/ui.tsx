// Shared bits of the window: icons, modal, toasts, pictures, small controls, and hooks onto the engine.
import { ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { jobs } from "./engine/jobs";
import { store } from "./engine/store";
import { subs } from "./engine/subs";

// ------------------------------------------------------------------ hooks

export function useJobs() {
  return useSyncExternalStore((f) => jobs.subscribe(f), () => jobs.snapshot());
}

let storeVersion = 0;
store.subscribe(() => void storeVersion++);
export function useStore() {
  useSyncExternalStore((f) => store.subscribe(f), () => storeVersion);
  return store;
}

export function useSubs() {
  return useSyncExternalStore((f) => subs.subscribe(f), () => subs.list);
}

// ------------------------------------------------------------------ icons

const svg = (d: string, size = 15, sw = 2) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />
);
export const I = {
  down: svg('<path d="M12 4v12M6 11l6 6 6-6M5 20h14"/>', 15, 2.2),
  music: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  film: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  disc: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 14),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 14, 2.2),
  retry: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', 14),
  log: svg('<path d="M4 6h16M4 12h16M4 18h10"/>', 14),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', 15, 2.2),
  check: svg('<path d="M5 12l5 5 9-10"/>', 13, 2.4),
  warn: svg('<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>', 13),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 14),
  sliders: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>', 14),
  wand: svg('<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>', 14),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>', 14),
  play: svg('<path d="M7 4l13 8-13 8z"/>', 13),
  ext: svg('<path d="M14 3h7v7M10 14L21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>', 13),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 14),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 14, 2.2),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', 14),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>', 14),
};

// ------------------------------------------------------------------ pictures

/** A web picture, or a local one from Goblin's temporary folder (shown through a data: address). */
export function Pic({ src, className, fallback }: { src?: string | null; className?: string; fallback?: ReactNode }) {
  const [url, setUrl] = useState<string | null>(src && /^https?:|^data:/.test(src) ? src : null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setBad(false);
    if (!src) return setUrl(null);
    if (/^https?:|^data:/.test(src)) return setUrl(src);
    let live = true;
    void api.imageData(src).then((d) => live && setUrl(d)).catch(() => undefined);
    return () => void (live = false);
  }, [src]);
  return (
    <div className={`pic ${className ?? ""}`}>
      {url && !bad ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} /> : <span className="pic-fallback">{fallback ?? I.music}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ modal

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className={`card modal ${wide ? "wide" : ""}`} role="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} title="Close">{I.x}</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  title: string;
  sub?: string;
  action?: [string, () => void];
}
let toasts: Toast[] = [];
const toastSubs = new Set<() => void>();
let toastId = 0;
export function toast(title: string, sub?: string, action?: [string, () => void], ms = 4500) {
  const t = { id: ++toastId, title, sub, action };
  toasts = [...toasts, t].slice(-4);
  toastSubs.forEach((f) => f());
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastSubs.forEach((f) => f());
  }, ms);
}
export function Toasts() {
  const list = useSyncExternalStore((f) => (toastSubs.add(f), () => toastSubs.delete(f)), () => toasts);
  return (
    <div className="toasts">
      {list.map((t) => (
        <div className="toast" key={t.id}>
          <div className="strong">{t.title}</div>
          {t.sub && <div className="muted small">{t.sub}</div>}
          {t.action && <button className="link small" onClick={t.action[1]}>{t.action[0]}</button>}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ small controls

export function Seg<T extends string>({ value, options, onChange, className }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={`seg ${className ?? ""}`}>
      {options.map(([k, l]) => (
        <button key={k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="switch" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Select<T extends string | number>({ value, options, onChange, className, title }: { value: T; options: [T, string][]; onChange: (v: T) => void; className?: string; title?: string }) {
  return (
    <select className={className} value={String(value)} title={title} onChange={(e) => onChange((typeof value === "number" ? Number(e.target.value) : e.target.value) as T)}>
      {options.map(([k, l]) => <option key={String(k)} value={String(k)}>{l}</option>)}
    </select>
  );
}

/** A labelled row in a settings-style card. */
export function Row({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`setting ${wide ? "wide" : ""}`}>
      <div className="setting-label">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="setting-ctl">{children}</div>
    </div>
  );
}

/** A text box that saves when you leave it (or press Enter), not on every key. */
export function LazyInput({ value, onCommit, className, placeholder, type, mono }: { value: string; onCommit: (v: string) => void; className?: string; placeholder?: string; type?: string; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={`${className ?? ""} ${mono ? "mono" : ""}`}
      value={v}
      type={type}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export const tildify = (p: string, home: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);

export function ago(ms?: number): string {
  if (!ms) return "never";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
