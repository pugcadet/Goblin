// Text helpers: fuzzy matching, safe file names, name templates, formatting. Ported from the Mac app (Util.swift).

/** Lower-case, accents removed, "&" → "and", everything but letters/digits → single spaces. */
export function normalized(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Sørensen–Dice similarity on character bigrams of the normalized strings (0…1). */
export function similarity(x: string, y: string): number {
  const a = [...normalized(x).replace(/ /g, "")];
  const b = [...normalized(y).replace(/ /g, "")];
  if (!a.length || !b.length) return 0;
  if (a.join("") === b.join("")) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const k = a[i] + a[i + 1];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const k = b[i] + b[i + 1];
    const c = counts.get(k) ?? 0;
    if (c > 0) {
      hits++;
      counts.set(k, c - 1);
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

/** Safe as one file or folder name on Mac, Windows and NAS shares. */
export function fsSafe(s: string): string {
  let out = (s || "").replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, "-").replace(/ {2,}/g, " ").trim();
  out = out.replace(/[. ]+$/, "").replace(/^\.+/, "");
  if ([...out].length > 150) out = [...out].slice(0, 150).join("").trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = "_" + out;
  return out || "Untitled";
}

/** Fills "{artist} - {title}" style templates. Unknown fields vanish, separators left dangling are tidied. */
export function fill(template: string, values: Record<string, string>, fallback: string): string {
  const t = template.trim() ? template : fallback;
  let out = t;
  for (const [k, v] of Object.entries(values)) {
    const clean = (v ?? "").trim() ? fsSafe(v) : "";
    out = out.split(`{${k}}`).join(clean);
  }
  out = out
    .replace(/\{[a-zA-Z_]+\}/g, "")
    .replace(/\[\s*\]|\(\s*\)/g, "")
    .replace(/(\s*[-–·_]\s*){2,}/g, " - ")
    .replace(/^[\s\-–·_.]+|[\s\-–·_]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!out && t !== fallback && fallback) return fill(fallback, values, fallback);
  return fsSafe(out);
}

/** Folder pattern with "/" for sub-folders ("{albumartist}/{album} ({year})"); empty parts are skipped. */
export function folderParts(template: string, values: Record<string, string>, fallback: string): string[] {
  const t = template.trim() ? template : fallback;
  return t
    .split("/")
    .filter((p) => p.trim())
    .map((p) => fill(p, values, ""))
    .filter((p) => p && p !== "Untitled");
}

export function eta(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec) || sec < 0) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function bytes(b: number | null | undefined): string {
  if (b == null || !isFinite(b) || b <= 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function plays(n: number): string {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(Math.round(n));
}

/** "3:07" / "1:02:03" → seconds. */
export function seconds(t: string): number {
  return String(t || "")
    .split(":")
    .reduce((a, x) => a * 60 + (Number(x) || 0), 0);
}

export function isWebUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

/** Minimal shell-style splitting for option strings typed by you: --a 'b c' → ["--a", "b c"]. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (const c of s || "") {
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

export const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** "20240501" → "2024-05-01" */
export function ymd(d: string | undefined | null): string {
  return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : "";
}
