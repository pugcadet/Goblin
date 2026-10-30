// Settings and presets, kept as small JSON files in Goblin's data folder.
import { host, HostInfo, join } from "./host";
import { BUILT_IN, merged, Preset, PRESET_DEFAULTS, Settings, SETTINGS_DEFAULTS } from "./model";

type Listener = () => void;

class Store {
  settings: Settings = { ...SETTINGS_DEFAULTS };
  presets: Preset[] = BUILT_IN.map((p) => ({ ...p }));
  info: HostInfo | null = null;
  firstRun = false;
  private listeners = new Set<Listener>();

  async load() {
    const h = host();
    this.info = await h.info();
    const s = await h.read("app-settings.json");
    if (s) {
      try {
        this.settings = merged(SETTINGS_DEFAULTS, JSON.parse(s));
      } catch {
        /* a damaged file: start from defaults */
      }
    } else this.firstRun = true;
    const p = await h.read("presets.json");
    if (p) {
      try {
        const list = (JSON.parse(p) as unknown[]).map((x) => merged(PRESET_DEFAULTS, x)).filter((x) => x.id && (x.kind === "video" || x.kind === "music"));
        if (list.length) this.presets = list;
      } catch {
        /* keep the built-in ones */
      }
    }
    this.emit();
  }

  async refreshInfo() {
    this.info = await host().info();
    this.emit();
  }

  /** The library ("Ready") folder: where everything lands, organized. */
  get library(): string {
    return this.info?.library ?? join(this.info?.home ?? "", "Downloads", "Goblin");
  }

  dir(sub: string): string {
    return join(this.library, sub);
  }

  preset(id: string | undefined): Preset {
    return this.presets.find((p) => p.id === id) ?? this.presets.find((p) => p.id === this.settings.defaultPresetId) ?? this.presets[0] ?? BUILT_IN[0];
  }

  async saveSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    await host().write("app-settings.json", JSON.stringify(this.settings, null, 1));
    this.emit();
  }

  async savePreset(p: Preset): Promise<Preset> {
    const clean = merged(PRESET_DEFAULTS, p);
    if (!clean.id) clean.id = "p" + Date.now().toString(36);
    const i = this.presets.findIndex((x) => x.id === clean.id);
    if (i >= 0) this.presets[i] = clean;
    else this.presets.push(clean);
    this.presets = [...this.presets];
    await this.writePresets();
    return clean;
  }

  async deletePreset(id: string) {
    if (this.presets.length <= 1) return;
    this.presets = this.presets.filter((p) => p.id !== id);
    if (this.settings.defaultPresetId === id) await this.saveSettings({ defaultPresetId: this.presets[0].id });
    await this.writePresets();
  }

  async resetPresets() {
    this.presets = BUILT_IN.map((p) => ({ ...p }));
    await this.writePresets();
  }

  private async writePresets() {
    await host().write("presets.json", JSON.stringify(this.presets, null, 1));
    this.emit();
  }

  subscribe(f: Listener) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  emit() {
    this.listeners.forEach((f) => f());
  }
}

export const store = new Store();

/** Signed-in downloads today (the daily cap protects your account). */
export async function countCookieUse(): Promise<{ ok: boolean; cap: number }> {
  const d = new Date();
  const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const s = store.settings;
  const cap = Math.max(1, s.cookieDailyMax);
  const count = s.cookieDay === day ? s.cookieCount : 0;
  if (count >= cap) return { ok: false, cap };
  await store.saveSettings({ cookieDay: day, cookieCount: count + 1 });
  return { ok: true, cap };
}
