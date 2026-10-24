// The choices on the Download screen, remembered between starts and shared with Search.
import { useSyncExternalStore } from "react";
import { DlRequest, loadLocal, saveLocal } from "./api";

export interface Prefs {
  kind: "video" | "audio";
  maxHeight: number;
  videoFormat: "mp4" | "mkv";
  audioFormat: "m4a" | "mp3" | "opus" | "flac";
  subtitles: boolean;
  langs: string;
  sponsorblock: boolean;
  playlist: boolean;
  naming: "title" | "channel";
}

const DEFAULTS: Prefs = {
  kind: "video",
  maxHeight: 1080,
  videoFormat: "mp4",
  audioFormat: "m4a",
  subtitles: false,
  langs: "en",
  sponsorblock: false,
  playlist: true,
  naming: "title",
};

let prefs: Prefs = loadLocal("goblin-prefs", DEFAULTS);
const subs = new Set<() => void>();

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  saveLocal("goblin-prefs", prefs);
  subs.forEach((f) => f());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => prefs,
  );
}

/** A download request for `url` from the saved choices (optionally as video or music). */
export function requestFor(url: string, p: Prefs, kind: Prefs["kind"] = p.kind): DlRequest {
  return {
    url,
    kind,
    maxHeight: p.maxHeight,
    format: kind === "video" ? p.videoFormat : p.audioFormat,
    subtitles: kind === "video" && p.subtitles,
    subLangs: p.langs.split(/[\s,]+/).map((l) => l.trim().toLowerCase()).filter(Boolean),
    sponsorblock: p.sponsorblock,
    playlist: p.playlist,
    naming: p.naming,
    seriesName: null,
    season: null,
  };
}
