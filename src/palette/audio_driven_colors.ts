import { relativeLuminance } from "../artwork_accent.ts";
import { rgb, type BlobColors } from "../visualizer/colors.ts";
import { paletteHSL } from "./smart_palette.ts";
import { accentColor } from "./accent_color_variants.ts";

export type AudioColorSettings = { enabled: boolean; intensity: number };
export type AudioColorBands = { bass: number; mid: number; treble: number };
export type AudioColorState = {
  active: boolean; input: AudioColorBands; envelope: AudioColorBands;
  base: BlobColors; final: BlobColors;
  reaction: number; // Actual maximum RGB-channel displacement, as percent of 255.
};
export type AudioColorSnapshot = { settings: AudioColorSettings; state: AudioColorState | null };
export const defaultAudioColors = (): AudioColorSettings => ({ enabled: false, intensity: 35 });
export function validateAudioColors(input: unknown): AudioColorSettings {
  const p = input as AudioColorSettings;
  if (!p || Object.keys(p).sort().join() !== "enabled,intensity" || typeof p.enabled !== "boolean" ||
      !Number.isFinite(p.intensity) || p.intensity < 0 || p.intensity > 100) throw new Error("Invalid audio-driven color settings");
  return { enabled: p.enabled, intensity: p.intensity };
}
const keys = ["bass", "mid", "treble"] as const;
const zero = (): AudioColorBands => ({ bass: 0, mid: 0, treble: 0 });
const level = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
const colorHex = (value: number) => "#" + value.toString(16).padStart(6, "0");

// Runs on the existing render ticker, after the ordinary palette transition.
// No hue drift, native capture, timers, or feedback into the artwork palette.
export function createAudioColors() {
  let settings = defaultAudioColors(), envelope = zero(), targetKey = "";
  let state: AudioColorState | null = null;
  function reset() { envelope = zero(); state = null; }
  return {
    configure(value: unknown) {
      const next = validateAudioColors(value);
      if (next.enabled !== settings.enabled || next.intensity === 0) reset();
      settings = next;
    },
    retarget(palette: string[]) {
      const key = palette.join().toLowerCase();
      if (key !== targetKey) { targetKey = key; reset(); }
    },
    step(base: number[], bands: number[], seconds: number): number[] {
      const input = { bass: level(bands[0]), mid: level(bands[1]), treble: level(bands[2]) };
      const enabled = settings.enabled && settings.intensity > 0;
      const dt = Number.isFinite(seconds) ? Math.max(0, Math.min(.05, seconds)) : 0;
      keys.forEach((key, i) => {
        const gated = enabled && input[key] > .005 ? input[key] : 0;
        // Color sensitivity: preserve the existing noise gate and both endpoints.
        const target = Math.sqrt(gated);
        const tau = target > envelope[key] ? [.065, .12, .035][i] : [.5, .35, .14][i];
        envelope[key] += (target - envelope[key]) * (1 - Math.exp(-dt / tau));
        if (!enabled || (target === 0 && envelope[key] < .0005)) envelope[key] = 0;
      });
      const amount = settings.intensity / 100;
      const active = enabled && keys.some(key => envelope[key] > 0);
      const baseHex = base.map(colorHex) as BlobColors;
      const final = active ? baseHex.map((color, index) => {
        const tone = paletteHSL(color);
        // Grey stays grey. Already saturated/light colors are preserved, never clamped down.
        const chroma = Math.min(1, tone.s / .12);
        const accent = [.15, .55, 1][index];
        const s = tone.s + Math.min(Math.max(0, .82 - tone.s),
          (.14 * envelope.bass + .07 * envelope.mid * accent) * amount * chroma);
        let l = tone.l + Math.min(Math.max(0, .76 - tone.l), .025 * envelope.treble * amount)
          - .008 * envelope.mid * accent * amount * chroma;
        l = Math.max(0, l);
        let candidate = accentColor(tone.h, s, l);
        // Limit linear luminance gain as well as HSL, including warm/yellow colors.
        const budget = relativeLuminance(rgb(color)) + .03 * amount;
        if (relativeLuminance(rgb(candidate)) > budget) {
          let lo = 0, hi = l;
          for (let i = 0; i < 12; i++) {
            const middle = (lo + hi) / 2;
            if (relativeLuminance(rgb(accentColor(tone.h, s, middle))) > budget) hi = middle;
            else lo = middle;
          }
          candidate = accentColor(tone.h, s, lo);
        }
        return candidate;
      }) as BlobColors : baseHex;
      const reaction = Math.max(...final.flatMap((color, i) => rgb(color).map((v, c) => Math.abs(v - rgb(baseHex[i])[c])))) / 255 * 100;
      state = { active: active && reaction > 0, input, envelope: { ...envelope }, base: baseHex, final, reaction };
      // Exact bypass: no HSL roundtrip or added transition when OFF / silent / zero intensity.
      return active ? final.map(color => parseInt(color.slice(1), 16)) : base;
    },
    current(): BlobColors | null { return state?.active ? [...state.final] : null; },
    snapshot(): AudioColorSnapshot { return { settings: { ...settings }, state: state ? structuredClone(state) : null }; },
  };
}
