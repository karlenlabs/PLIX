export { hybridPaletteSettings, validateHybridPalette } from "./hybrid_palette.ts";
import type { DiagnosticAudioColorSnapshot as AudioColorSnapshot } from "./audio_color_diagnostics";
export { defaultAudioComparison, validateAudioComparison } from "./audio_color_diagnostics.ts";
export { defaultAudioColors, validateAudioColors } from "./audio_driven_colors.ts";
import type { AccentComparisonSnapshot } from "./accent_color_comparison";
export { defaultAccentComparison, validateAccentComparison } from "./accent_color_comparison.ts";
import type { SmartPaletteSnapshot } from "./smart_palette";
export { defaultSmartPalette, validateSmartPalette } from "./smart_palette.ts";
import type { BlobDiagnosticSnapshot } from "./blob_diagnostics_model";
import type { BlobColors } from "../visualizer/colors.ts";
import type { SurfaceTuning, DesignSettings } from "../design/model.ts";
export * from "../design/model.ts";
export { getProductionDesign as defaultDesign } from "../design/runtime.ts";

export type ColorState = { target: BlobColors; current: BlobColors };
export type LayerDiagnostic = { element: string; rect: { x: number; y: number; width: number; height: number }; mixBlendMode: string; background: string; backgroundColor: string; border: string; shadow: string; opacity: string; filter: string; zIndex: string; pointerEvents: string; backdropFilter: string };
export type DesignSnapshot = { audioColors?: AudioColorSnapshot; accentComparison?: AccentComparisonSnapshot; smartPalette?: SmartPaletteSnapshot; pixiCanvasHidden?: boolean; cssHighlightsIsolated?: boolean; blobDiagnostics?: BlobDiagnosticSnapshot | null; settings: DesignSettings; surface: SurfaceTuning; defaults: SurfaceTuning; colors: ColorState | null; diagnostics: LayerDiagnostic[]; storageError: string | null };
export const designStorageKey = "ympleer-v2:dev:visual-design:v1";

export function diagnosticLayers(player: HTMLElement): LayerDiagnostic[] {
  const entries: [Element, string | null, string][] = [[player, null, ".player"], [player, "::before", ".player::before"], [player, "::after", ".player::after"]];
  for (const selector of [".visualizer-layer", ".visualizer-layer canvas", ".primary-control"]) {
    const element = player.querySelector(selector);
    if (element) entries.push([element, null, selector]);
  }
  return entries.map(([element, pseudo, label]) => {
    const s = getComputedStyle(element, pseudo), r = element.getBoundingClientRect();
    return { element: label, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, mixBlendMode: s.mixBlendMode,
      background: s.backgroundImage, backgroundColor: s.backgroundColor,
      border: s.border, shadow: s.boxShadow, opacity: s.opacity, filter: s.filter,
      zIndex: s.zIndex, pointerEvents: s.pointerEvents, backdropFilter: s.backdropFilter };
  });
}
