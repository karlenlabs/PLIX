import type { ArtworkPalette } from "../artwork_accent.ts";
import type { BlobColors } from "../visualizer/colors.ts";
import { smartPalette } from "./smart_palette.ts";
import { createAudioColors } from "./audio_driven_colors.ts";

// Immutable production policy; no DEV commands or storage.
export const HYBRID_PALETTE = Object.freeze({ smartStrength: 75, audioIntensity: 100, accentRecovery: "contrast" });
export function resolveHybridPalette(palette: ArtworkPalette, original: BlobColors,
    enabled: boolean, background: string, manual = false): BlobColors {
  if (!enabled) return original;
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
