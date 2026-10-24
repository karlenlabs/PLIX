import { compareAccent, defaultAccentComparison, validateAccentComparison } from "./accent_color_comparison.ts";
import type { ArtworkPalette } from "../artwork_accent.ts";
import { hex, type BlobColors } from "../visualizer/colors.ts";
import { readFlatPlayerSurface } from "./blob_surface_color.ts";
import { defaultSmartPalette, smartPalette, validateSmartPalette } from "./smart_palette.ts";

export function attachSmartPalette(player: HTMLElement, changed: () => void,
    readSurface = () => hex(readFlatPlayerSurface(player).map(v => v * 255) as [number, number, number])) {
  let settings = defaultSmartPalette(), comparison = defaultAccentComparison();
  const receiveComparison = (event: Event) => {
    try { comparison = validateAccentComparison((event as CustomEvent).detail); changed(); }
    catch (error) { console.warn("Invalid DEV accent comparison", error); }
  };
  player.addEventListener("visualizer:accent-comparison-settings", receiveComparison);
  const receive = (event: Event) => {
    try { settings = validateSmartPalette((event as CustomEvent).detail); changed(); }
    catch (error) { console.warn("Invalid DEV Smart Palette", error); }
  };
  player.addEventListener("visualizer:smart-palette-settings", receive);
  player.dispatchEvent(new CustomEvent("visualizer:smart-palette-request"));
  player.dispatchEvent(new CustomEvent("visualizer:accent-comparison-request"));
  return {
    resolve(palette: ArtworkPalette, original: BlobColors, manual: boolean) {
      let background = "#222831";
      if (settings.enabled && settings.strength > 0 && !manual) {
        try { background = readSurface(); } catch { /* Safe dark base until CSS surface is available. */ }
      }
      const state = smartPalette(palette, original, settings, background, manual);
      const result = compareAccent(state, comparison, background);
      player.dispatchEvent(new CustomEvent("visualizer:accent-comparison-state", { detail: result }));
      player.dispatchEvent(new CustomEvent("visualizer:smart-palette-state", { detail: { ...state, final: result.final } }));
      return result.final;
    },
    stop() {
      player.removeEventListener("visualizer:smart-palette-settings", receive);
      player.removeEventListener("visualizer:accent-comparison-settings", receiveComparison);
    },
  };
}
