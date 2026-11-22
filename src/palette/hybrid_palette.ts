import type { ArtworkPalette } from "../artwork_accent.ts";
import type { BlobColors } from "../visualizer/colors.ts";
import { analyzePalette, smartPalette } from "./smart_palette.ts";
import { relativeLuminance } from "../artwork_accent.ts";
import { hex, rgb } from "../visualizer/colors.ts";
import { createAudioColors } from "./audio_driven_colors.ts";

// Immutable production policy; no DEV commands or storage.
export const HYBRID_PALETTE = Object.freeze({ smartStrength: 75, audioIntensity: 100, accentRecovery: "contrast" });
const hslHex = (h: number, s: number, l: number) => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const v = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return hex(v.map(n => (n + m) * 255) as [number, number, number]);
};
// Colorless artwork (B&W, near-black): no invented hue. The blobs are clean
// light whose brightness follows the artwork: a bright cover glows almost white,
// a dark one stays dim. On a light surface the same idea becomes soft graphite.
export function luminousNeutral(tone: { low: number; high: number }, background: string): BlobColors {
  const lightSurface = relativeLuminance(rgb(background)) > .5;
  if (lightSurface) {
    const shade = .62 - .18 * (1 - tone.high);
    return [hslHex(210, .06, shade), hslHex(215, .05, Math.min(.8, .7 + .1 * tone.low)), hslHex(205, .08, shade - .06)];
  }
  const glow = .55 + .35 * tone.high;
  return [hslHex(210, .08, glow), hslHex(220, .06, .25 + .2 * tone.low), hslHex(205, .12, Math.min(.92, glow + .08))];
}
export function resolveHybridPalette(palette: ArtworkPalette, original: BlobColors,
    enabled: boolean, background: string, manual = false): BlobColors {
  if (!enabled) return original;
  if (!manual && palette.tone && analyzePalette(palette).fallback) return luminousNeutral(palette.tone, background);
  return smartPalette(palette, original, { enabled: true, strength: HYBRID_PALETTE.smartStrength }, background, manual).final;
}
// Uses the existing FFT and ticker. OFF does no color DSP.
export function createHybridAudioColors() {
  const colors = createAudioColors();
  let enabled = false;
  return {
    configure(value: boolean) {
      enabled = value;
      colors.configure({ enabled, intensity: HYBRID_PALETTE.audioIntensity });
    },
    retarget: colors.retarget,
    step(base: number[], bands: number[], seconds: number, fresh: boolean) {
      if (!enabled) return base;
      if (!fresh) {
        colors.configure({ enabled: false, intensity: HYBRID_PALETTE.audioIntensity });
        colors.configure({ enabled: true, intensity: HYBRID_PALETTE.audioIntensity });
        return base;
      }
      return colors.step(base, bands, seconds);
    },
    current: colors.current,
  };
}
