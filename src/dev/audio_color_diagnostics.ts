import type { AudioColorBands, AudioColorSettings, AudioColorSnapshot, AudioColorState } from "./audio_driven_colors.ts";
import { rgb } from "../visualizer/colors.ts";
import { paletteHSL } from "./smart_palette.ts";

export type AudioColorComparison = "live" | "test-off" | "test-on";
export const defaultAudioComparison = (): AudioColorComparison => "live";
export function validateAudioComparison(value: unknown): AudioColorComparison {
  if (value !== "live" && value !== "test-off" && value !== "test-on") throw new Error("Invalid audio color comparison");
  return value;
}
// A constant maximum input, not a playback measurement. It replaces ONLY the color-stage input.
export const AUDIO_COLOR_TEST_SIGNAL = [1, 1, 1] as const;
export type FFTColorSource = { raw: AudioColorBands; fresh: boolean; status: string };
export type AudioColorDiagnostics = {
  source: "fft" | "fixed-test"; comparison: AudioColorComparison; fft: FFTColorSource;
  applied: AudioColorSettings;
  blobs: { index: number; base: string; final: string; deltaE76: number; maxDeltaRGB: number; deltaS: number; deltaL: number }[];
};
export type DiagnosticAudioColorState = AudioColorState & { diagnostics?: AudioColorDiagnostics };
export type DiagnosticAudioColorSnapshot = Omit<AudioColorSnapshot, "state"> & {
  comparison?: AudioColorComparison; state: DiagnosticAudioColorState | null;
};
export const audioColorBands = (bands: readonly number[]): AudioColorBands => ({ bass: bands[0], mid: bands[1], treble: bands[2] });

// sRGB -> linear RGB -> XYZ D65 -> CIELAB. Delta E 1976; no perception threshold claim.
function lab(color: string) {
  const [r,g,b] = rgb(color).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  const xyz = [(r * .4124564 + g * .3575761 + b * .1804375) / .95047,
    r * .2126729 + g * .7151522 + b * .072175,
    (r * .0193339 + g * .119192 + b * .9503041) / 1.08883];
  const [x,y,z] = xyz.map(v => v > (6/29) ** 3 ? Math.cbrt(v) : v / (3 * (6/29) ** 2) + 4/29);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function deltaE76(first: string, second: string): number {
  const a = lab(first), b = lab(second);
  return Math.hypot(...a.map((v,i) => v - b[i]));
}
export function diagnoseAudioColors(state: AudioColorState, fft: FFTColorSource, comparison: AudioColorComparison, applied: AudioColorSettings): AudioColorDiagnostics {
  return {
    source: comparison === "live" ? "fft" : "fixed-test", comparison, fft: structuredClone(fft), applied: { ...applied },
    blobs: state.base.map((base,index) => {
      const final = state.final[index], a = paletteHSL(base), b = paletteHSL(final), original = rgb(base);
      return { index, base, final, deltaE76: deltaE76(base,final),
        maxDeltaRGB: Math.max(...rgb(final).map((v,i) => Math.abs(v - original[i]))) / 255 * 100,
        deltaS: (b.s - a.s) * 100, deltaL: (b.l - a.l) * 100 };
    }),
  };
}
