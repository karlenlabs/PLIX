import type { SmartPaletteSettings } from "./smart_palette";
import type { AudioColorSettings } from "./audio_driven_colors";
import type { AudioColorComparison } from "./audio_color_diagnostics";
import type { AccentComparisonMode } from "./accent_color_comparison";

export function validateHybridPalette(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid Hybrid Palette switch");
  return value;
}
// Orchestration only. Both existing algorithms and the Smart strength are retained.
export function hybridPaletteSettings(value: unknown, smart: SmartPaletteSettings) {
  const enabled = validateHybridPalette(value);
  return {
    smart: { ...smart, enabled }, audio: { enabled, intensity: 100 },
    audioComparison: "live" as const, accentComparison: "contrast" as const,
  };
}
export function hybridPaletteState(smart: SmartPaletteSettings, audio: AudioColorSettings,
    audioComparison: AudioColorComparison, accentComparison: AccentComparisonMode) {
  // Separate diagnostic controls remain usable. The master stays ON while either
  // stage can alter the palette, so OFF always disables every palette experiment.
  const enabled = smart.enabled || audio.enabled || audioComparison === "test-on";
  const combined = enabled && smart.enabled && audio.enabled && audio.intensity === 100 &&
    audioComparison === "live" && accentComparison === "contrast";
  return { enabled, combined, separate: enabled && !combined };
}
