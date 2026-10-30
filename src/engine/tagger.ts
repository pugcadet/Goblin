// ffmpeg: covers, loudness, one encode-and-tag pass per file (Media.swift → Tagger).
import { host, uid } from "./host";
import type { TrackMeta } from "./model";
import { GoblinError } from "./ytdlp";

/** Any picture → JPEG (centre-cropped square if asked), at most 1200 px. */
export async function prepareCover(src: string, square: boolean, out: string): Promise<string | null> {
  const vf = square ? "crop='min(iw,ih)':'min(iw,ih)',scale='min(1200,iw)':-2" : "scale='min(1200,iw)':-2";
  const r = await host().run({ id: uid("c"), tool: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vf", vf, "-frames:v", "1", "-q:v", "2", out], timeoutSec: 120 });
  return r.code === 0 ? out : null;
}

/** Integrated loudness (LUFS) and true peak (dBFS) via EBU R128. */
export async function measure(file: string, start?: number, end?: number): Promise<{ lufs: number; peak: number } | null> {
  const args = ["-hide_banner", "-nostats"];
  if (start != null) args.push("-ss", String(start));
  if (end != null) args.push("-to", String(end));
  args.push("-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-");
  const r = await host().run({ id: uid("m"), tool: "ffmpeg", args, timeoutSec: 900 });
  return parseLoudness(r.stderr);
}

export function parseLoudness(stderr: string): { lufs: number; peak: number } | null {
  const tail = stderr.split("Integrated loudness:").pop() ?? "";
  const i = tail.match(/I:\s+(-?[\d.]+)\s+LUFS/);
  if (!i || !stderr.includes("Integrated loudness:")) return null;
  const p = tail.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
  const peak = p && p[1] !== "-inf" ? Number(p[1]) : 0;
  return { lufs: Number(i[1]), peak };
}

export function replayGainTags(m: { lufs: number; peak: number }): Record<string, string> {
  const gain = -18 - m.lufs; // ReplayGain 2.0 reference level
  const peak = Math.pow(10, m.peak / 20);
  return { REPLAYGAIN_TRACK_GAIN: `${gain.toFixed(2)} dB`, REPLAYGAIN_TRACK_PEAK: peak.toFixed(6) };
}

export async function probeCodec(file: string): Promise<string> {
  const r = await host().run({ id: uid("q"), tool: "ffprobe", args: ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", file], timeoutSec: 60 });
  return r.stdout.trim();
}

export const extFor = (format: string) => ({ mp3: "mp3", m4a: "m4a", opus: "opus", flac: "flac", wav: "wav" } as Record<string, string>)[format] ?? "mp3";

export interface EncodeOpts {
  input: string;
  output: string;
  format: string;
  quality: string; // "copy" = keep the audio stream untouched when possible
  normalize: boolean;
  meta: TrackMeta;
  extraTags?: Record<string, string>;
  cover?: string | null;
  start?: number;
  end?: number;
  keepChapters?: boolean;
  id3?: string;
  procId?: string;
}

/** The ffmpeg arguments for one pass: (cut) → (normalize) → encode/copy → fresh tags → cover. Pure, tested. */
export function encodeArgs(o: EncodeOpts, srcCodec: string): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (o.start != null) args.push("-ss", String(o.start));
  if (o.end != null) args.push("-to", String(o.end));
  args.push("-i", o.input);
  const canCover = ["mp3", "m4a", "flac"].includes(o.format);
  if (o.cover && canCover) args.push("-i", o.cover);
  args.push("-map", "0:a:0");
  if (o.cover && canCover) args.push("-map", "1:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic");
  if (o.normalize) args.push("-af", "loudnorm=I=-14:TP=-1.0:LRA=11");
  const cut = o.start != null || o.end != null;
  const pristine = !o.normalize && !cut;
  if (o.quality === "copy" && pristine) args.push("-c:a", "copy");
  else
    switch (o.format) {
      case "m4a":
        args.push(...(srcCodec === "aac" && pristine ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "256k"]));
        break;
      case "opus":
        args.push(...(srcCodec === "opus" && pristine ? ["-c:a", "copy"] : ["-c:a", "libopus", "-b:a", "160k"]));
        break;
      case "flac":
        args.push("-c:a", "flac");
        break;
      case "wav":
        args.push("-c:a", "pcm_s16le");
        break;
      default:
        args.push("-c:a", "libmp3lame");
        args.push(...({ V2: ["-q:a", "2"], "192": ["-b:a", "192k"], "128": ["-b:a", "128k"] } as Record<string, string[]>)[o.quality] ?? ["-b:a", "320k"]);
    }
  args.push("-map_metadata", "-1", "-map_chapters", o.keepChapters && !cut ? "0" : "-1");
  const m = o.meta;
  const tags: [string, string | undefined][] = [
    ["title", m.title],
    ["artist", m.artist],
    ["album", m.album],
    ["album_artist", m.albumArtist ?? m.artist], // "" = turned off in the preset
    ["date", m.date],
    ["genre", m.genre],
    ["publisher", m.label],
    ["track", m.track != null ? (m.trackTotal ? `${m.track}/${m.trackTotal}` : `${m.track}`) : undefined],
    ["disc", m.disc != null ? (m.discTotal ? `${m.disc}/${m.discTotal}` : `${m.disc}`) : undefined],
  ];
  if (m.isrc) tags.push(["TSRC", m.isrc]);
  for (const [k, v] of Object.entries(m.ids)) tags.push([k, v]);
  for (const [k, v] of Object.entries(o.extraTags ?? {})) tags.push([k, v]);
  for (const [k, v] of tags) if (v) args.push("-metadata", `${k}=${v}`);
  if (o.format === "mp3") {
    args.push("-id3v2_version", o.id3 === "2.4" ? "4" : "3", "-write_id3v1", "1");
    if (o.cover) args.push("-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)");
  } else if (o.format === "m4a") args.push("-movflags", "+use_metadata_tags+faststart");
  args.push(o.output);
  return args;
}

export async function encode(o: EncodeOpts): Promise<void> {
  const src = await probeCodec(o.input);
  const r = await host().run({ id: o.procId ?? uid("e"), tool: "ffmpeg", args: encodeArgs(o, src), timeoutSec: 1800 });
  if (r.killed) throw new GoblinError("Canceled");
  if (r.code !== 0) throw new GoblinError("Audio encode failed: " + r.stderr.trim().slice(-240));
}
