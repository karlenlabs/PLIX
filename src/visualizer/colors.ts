import { NEUTRAL_PALETTE, type ArtworkPalette } from "../artwork_accent.ts";

import { adaptiveBlobColors } from "./adaptive_color_contrast.ts";
import { contrastBlobColors } from "./color_contrast.ts";

export type BlobColors = [string, string, string];
export type ColorTuning = {
  mode: "artwork" | "artwork-accent" | "manual";
  manual: BlobColors;
  saturation: number;
  brightness: number;
  artworkInfluence: number;
  transitionMs: number;
  blobColorContrast: number;
  blobColorAlgorithm: "current" | "adaptive";
};
export const DEFAULT_COLOR_TUNING: ColorTuning = {
  mode: "artwork", manual: ["#748ba5", "#757899", "#688c91"],
  saturation: 1, brightness: 1, artworkInfluence: 1, transitionMs: 700, blobColorContrast: 0, blobColorAlgorithm: "current",
};
type RGB = [number, number, number];
export function rgb(color: string): RGB {
  if (/^#[\da-f]{6}$/i.test(color)) return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) as RGB;
  const match = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color);
  if (match && match.slice(1).every(v => Number(v) <= 255)) return match.slice(1).map(Number) as RGB;
  throw new Error("Invalid RGB color");
}
export const hex = (value: RGB) => "#" + value.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
const mix = (a: RGB, b: RGB, amount: number) => a.map((v, i) => v + (b[i] - v) * amount) as RGB;
export function validateColorTuning(input: unknown): ColorTuning {
  const original = input as ColorTuning;
  const p = original && { ...original, blobColorAlgorithm: Object.hasOwn(original, "blobColorAlgorithm") ? original.blobColorAlgorithm : "current", blobColorContrast: Object.hasOwn(original, "blobColorContrast") ? original.blobColorContrast : 0 };
  if (!p || !["current", "adaptive"].includes(p.blobColorAlgorithm) || !["artwork", "artwork-accent", "manual"].includes(p.mode) || !Array.isArray(p.manual) || p.manual.length !== 3 ||
      !p.manual.every(c => typeof c === "string" && /^#[\da-f]{6}$/i.test(c)) ||
      ![[p.saturation, 0, 2], [p.brightness, .2, 1.5], [p.artworkInfluence, 0, 1], [p.transitionMs, 100, 3000], [p.blobColorContrast, 0, 1]]
        .every(([v, lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi)) throw new Error("Invalid color tuning");
  if (Object.keys(p).sort().join() !== Object.keys(DEFAULT_COLOR_TUNING).sort().join()) throw new Error("Unknown color settings");
  return { ...p, manual: p.manual.map(c => c.toLowerCase()) as BlobColors };
}
function adjust(color: RGB, saturation: number, brightness: number): RGB {
  const normalized = color.map(v => v / 255);
  const max = Math.max(...normalized), min = Math.min(...normalized), chroma = max - min;
  const light = (max + min) / 2;
  const newLight = Math.min(1, light * brightness);
  const oldSat = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * light - 1));
  const newChroma = (1 - Math.abs(2 * newLight - 1)) * Math.min(1, oldSat * saturation);
  return normalized.map(v => 255 * (newLight + (chroma ? (v - light) / chroma * newChroma : 0))) as RGB;
}
// Reuse the existing artwork extractor's three ambient colors. No image reads here.
export function resolveBlobColors(palette: ArtworkPalette, accent: string, tuning = DEFAULT_COLOR_TUNING): BlobColors {
  const p = validateColorTuning(tuning);
  const neutral = NEUTRAL_PALETTE.ambient.map(rgb);
  const automatic = palette.ambient.map(rgb);
  const final = automatic.map((color, i) => {
    let chosen = p.mode === "manual" ? rgb(p.manual[i]) : mix(neutral[i], color, p.artworkInfluence);
    if (p.mode === "artwork-accent") chosen = mix(chosen, rgb(accent), [.18, .32, .12][i] * p.artworkInfluence);
    return hex(adjust(chosen, p.saturation, p.brightness));
  }) as BlobColors;
  return p.blobColorAlgorithm === "adaptive"
    ? adaptiveBlobColors(final, p.blobColorContrast)
    : contrastBlobColors(final, p.blobColorContrast);
}
// Color state alone: never touches geometry, alpha, smoothing, blur or the ticker.
export function createColorTransition(initial: number[]) {
  const decode = (value: number): RGB => [value >> 16 & 255, value >> 8 & 255, value & 255];
  let current = initial.map(decode), from = current.map(c => [...c] as RGB), target = current.map(c => [...c] as RGB);
  let elapsed = 0, duration = 700;
  return {
    target(colors: BlobColors, milliseconds: number) {
      const next = colors.map(rgb);
      if (next.every((c, i) => c.every((v, j) => v === target[i][j]))) return;
      from = current.map(c => [...c] as RGB); target = next; elapsed = 0;
      duration = Math.min(3000, Math.max(100, milliseconds));
    },
    step(milliseconds: number) {
      elapsed = Math.min(duration, elapsed + Math.max(0, milliseconds));
      const t = elapsed / duration, eased = t * t * (3 - 2 * t);
      current = from.map((c, i) => mix(c, target[i], eased));
      return current.map(c => (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]));
    },
    current: () => current.map(hex) as BlobColors,
  };
}
