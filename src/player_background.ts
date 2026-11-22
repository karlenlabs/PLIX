import { NEUTRAL_PALETTE, type ArtworkPalette } from "./artwork_accent";
import { paletteHSL } from "./palette/smart_palette";
import type { PlayerBackground } from "./appearance";

// Fixed "Глубокий" background: deep teal.
export const DEEP_BACKGROUND = "#071317";

const hsl = (h: number, s: number, l: number) => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const v = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + v.map(n => Math.round((n + m) * 255).toString(16).padStart(2, "0")).join("");
};

// "Под обложку": the artwork's hue as a near-black surface (about 6% lightness,
// ~50% saturation), e.g. a blue cover -> rgb(6,11,20), teal -> rgb(7,19,23).
// Colorless artwork gets a neutral graphite of the same depth, never a fake hue.
// Returns undefined for the classic background.
export function playerBackgroundColor(mode: PlayerBackground, palette: ArtworkPalette): string | undefined {
  if (mode === "deep") return DEEP_BACKGROUND;
  if (mode !== "artwork") return undefined;
  if (palette.tone || palette.ambient.join() === NEUTRAL_PALETTE.ambient.join()) return hsl(220, .25, .065);
  return hsl(Math.round(paletteHSL(palette.ambient[0]).h), .5, .06);
}
