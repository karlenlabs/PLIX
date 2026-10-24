import { accentColor } from "./accent_color_variants.ts";
export { accentContrast } from "./accent_color_variants.ts";
import { rgb, hex, type BlobColors } from "../visualizer/colors.ts";
import { paletteHSL, type SmartPaletteState } from "./smart_palette.ts";

export type AccentComparisonMode = "original" | "vibrant" | "contrast";
export const defaultAccentComparison = (): AccentComparisonMode => "contrast";
export function validateAccentComparison(value: unknown): AccentComparisonMode {
  if (value !== "original" && value !== "vibrant" && value !== "contrast") throw new Error("Invalid accent comparison mode");
  return value;
}
export type AccentComparisonState = {
  mode: AccentComparisonMode; available: boolean; active: boolean; sourceAccent: string | null;
  variants: Record<AccentComparisonMode, string>; selected: string; baseFinal: BlobColors; final: BlobColors;
  background: string; reason: string | null;
};
export type AccentComparisonSnapshot = { mode: AccentComparisonMode; state: AccentComparisonState | null };

// Manual DEV comparisons override the Contrast baseline without changing the core input state.
export function compareAccent(state: SmartPaletteState, requestedMode: AccentComparisonMode, background: string): AccentComparisonState {
  const mode = validateAccentComparison(requestedMode), source = state.accentRecovery.referenceTarget;
  const reason = !state.correction.enabled ? "Smart Palette OFF" : state.manual ? "Ручной режим цветов" :
    !source || state.accentRecovery.strengths[2] <= 0 ? "Нет применённого Accent Recovery для Blob 3" : null;
  const baseFinal = [...state.final] as BlobColors, current = baseFinal[2];
  const variants = { original: current, vibrant: current, contrast: current };
  if (!reason && source) {
    const tone = paletteHSL(source);
    const vibrant = accentColor(tone.h, Math.min(.72, Math.max(tone.s + .18, tone.s * 1.4)), Math.max(.3, Math.min(.72, tone.l)));
    const targets = { original: source, vibrant };
    const from = rgb(current), sourceRGB = rgb(state.accentRecovery.targets[2]!), strength = state.accentRecovery.strengths[2] / 100;
    // Replace only the recovery contribution in the final Blob 3 color. Preserve
    // the existing adaptation strength and all other mixing contributions.
    for (const key of ["original", "vibrant"] as const) {
      const target = rgb(targets[key]);
      variants[key] = hex(from.map((v, i) => v + (target[i] - sourceRGB[i]) * strength) as [number, number, number]);
    }
  }
  const final = [...baseFinal] as BlobColors;
  final[2] = variants[mode];
  return { mode, available: reason === null, active: reason === null && mode !== "contrast", sourceAccent: source,
    variants, selected: final[2], baseFinal, final, background, reason };
}
