import { contrastAccentVariant } from "./accent_color_variants.ts";
import { NEUTRAL_PALETTE, relativeLuminance, type ArtworkPalette } from "../artwork_accent.ts";
import { hex, rgb, type BlobColors } from "../visualizer/colors.ts";

export type SmartPaletteSettings = { enabled: boolean; strength: number };
export const defaultSmartPalette = (): SmartPaletteSettings => ({ enabled: false, strength: 50 });
export function validateSmartPalette(value: unknown): SmartPaletteSettings {
  const p = value as SmartPaletteSettings;
  if (!p || typeof p.enabled !== "boolean" || !Number.isFinite(p.strength) || p.strength < 0 || p.strength > 100 ||
      Object.keys(p).sort().join() !== "enabled,strength") throw new Error("Invalid Smart Palette settings");
  return { enabled: p.enabled, strength: p.strength };
}
type HSL = { h: number; s: number; l: number };
export function paletteHSL(color: string): HSL {
  const [r, g, b] = rgb(color).map(v => v / 255), hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  const c = hi - lo, l = (hi + lo) / 2;
  const segment = hi === r ? (g - b) / c : hi === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return { h: c ? (segment * 60 + 360) % 360 : 0, s: c ? c / (1 - Math.abs(2 * l - 1)) : 0, l };
}
function fromHSL({ h, s, l }: HSL): string {
  h = (h + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const channels = h < 60 ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x] : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
  return hex(channels.map(v => (v + m) * 255) as [number, number, number]);
}
// Local corrections preserve hue; Accent Recovery requires both global dullness and uniformity.
export const SMART_PALETTE_LIMITS = {
  saturationFull: .2, saturationSafe: .42,
  lightnessFullDark: .08, lightnessSafeDark: .22,
  lightnessSafeLight: .8, lightnessFullLight: .94,
  neutralSaturation: .12, chromaticSaturation: .3, hueDistance: 40,
  recoverySaturationFull: .36, recoverySaturationSafe: .5,
  recoverySpreadFull: 12, recoverySpreadSafe: 70, recoveryNeutralSafe: .24,
} as const;
function smoothstep(low: number, high: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}
const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
export function analyzePalette(palette: ArtworkPalette) {
  const limits = SMART_PALETTE_LIMITS, tones = palette.ambient.map(paletteHSL);
  // The extractor already replaces achromatic/missing/unreadable artwork with this fallback.
  const fallback = palette.ambient.every((c, i) => hex(rgb(c)) === hex(rgb(NEUTRAL_PALETTE.ambient[i])));
  const neutral = fallback || tones.every(t => t.s < limits.neutralSaturation);
  const saturation = tones.reduce((n, t) => n + t.s, 0) / 3;
  const lightness = tones.reduce((n, t) => n + t.l, 0) / 3;
  const acceptedHues: { color: number; hue: number }[] = [];
  const quality = tones.map((tone, i) => {
    if (tone.s >= limits.neutralSaturation && acceptedHues.every(other => distance(other.hue, tone.h) >= limits.hueDistance)) {
      acceptedHues.push({ color: i + 1, hue: tone.h });
    }
    const saturationNeed = 1 - smoothstep(limits.saturationFull, limits.saturationSafe, tone.s);
    const lightnessNeed = Math.max(1 - smoothstep(limits.lightnessFullDark, limits.lightnessSafeDark, tone.l),
      smoothstep(limits.lightnessSafeLight, limits.lightnessFullLight, tone.l));
    // The primary is protected. Local deficits never replace an expressive neighbor; global recovery is assessed separately.
    const need = i === 0 ? 0 : fallback ? 1 : Math.max(saturationNeed, lightnessNeed);
    return { ...tone, saturationNeed, lightnessNeed, need,
      colorConfidence: fallback ? 0 : smoothstep(limits.neutralSaturation, limits.chromaticSaturation, tone.s) };
  });
  // Continuous hue spread replaces the discrete hue-count gate. Near-gray hues
  // contribute only in proportion to their reliability, so random gray hue is irrelevant.
  let spread = 0;
  for (let i = 0; i < quality.length; i++) for (let j = i + 1; j < quality.length; j++) {
    spread = Math.max(spread, distance(quality[i].h, quality[j].h) * quality[i].colorConfidence * quality[j].colorConfidence);
  }
  const saturationNeed = fallback ? 1 : 1 - smoothstep(limits.recoverySaturationFull, limits.recoverySaturationSafe, saturation);
  const uniformity = fallback ? 1 : 1 - smoothstep(limits.recoverySpreadFull, limits.recoverySpreadSafe, spread);
  const recoveryNeed = saturationNeed * uniformity;
  const neutralNeed = fallback ? 1 : 1 - smoothstep(limits.neutralSaturation, limits.recoveryNeutralSafe, saturation);
  const x = quality.reduce((n, t) => n + Math.cos(t.h * Math.PI / 180) * t.s, 0);
  const y = quality.reduce((n, t) => n + Math.sin(t.h * Math.PI / 180) * t.s, 0);
  const hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  // One complementary accent for a dull monochrome palette; a second only near neutral.
  const slotNeeds: [number, number, number] = [0, recoveryNeed * neutralNeed, recoveryNeed];
  const recovery = { saturationNeed, uniformity, spread, neutralNeed, need: recoveryNeed, hue, slotNeeds };
  const need = Math.max(...quality.map(t => t.need), recoveryNeed);
  return { weak: need > 0, neutral, fallback, saturation, lightness, hueCount: acceptedHues.length, acceptedHues, quality, need, recovery };
}
export type SmartPaletteSnapshot = { settings: SmartPaletteSettings; state: SmartPaletteState | null };
export type SmartPaletteState = {
  artwork: BlobColors; original: BlobColors; final: BlobColors;
  analysis: ReturnType<typeof analyzePalette>; manual: boolean;
  accentRecovery: { algorithm: "contrast"; referenceTarget: string | null; targets: [null, string | null, string | null]; strengths: [number, number, number]; effectiveStrength: number };
  correction: { enabled: boolean; requestedStrength: number; effectiveStrength: number; strengths: [number, number, number] };
};

// Only two slots may change; preserve the primary source color exactly.
// Contrast refers to opaque RGB against the flat base, not blurred/composited pixels.
function contrastAccent(tone: HSL, background: string): string {
  const bg = relativeLuminance(rgb(background));
  const ratio = (color: string) => {
    const y = relativeLuminance(rgb(color));
    return (Math.max(y, bg) + .05) / (Math.min(y, bg) + .05);
  };
  let best = fromHSL(tone);
  for (let step = 0; step <= 60; step++) {
    const delta = step * .01;
    for (const l of [tone.l - delta, tone.l + delta]) {
      if (l < .12 || l > .74) continue;
      const candidate = fromHSL({ ...tone, l });
      if (ratio(candidate) > ratio(best)) best = candidate;
      if (ratio(candidate) >= 3) return candidate;
    }
  }
  return best;
}
export function smartPalette(palette: ArtworkPalette, original: BlobColors, settings: SmartPaletteSettings,
    background: string, manual = false): SmartPaletteState {
  const p = validateSmartPalette(settings), analysis = analyzePalette(palette);
  const state: SmartPaletteState = { artwork: palette.ambient.map(c => hex(rgb(c))) as BlobColors,
    original: [...original], final: [...original], analysis, manual,
    accentRecovery: { algorithm: "contrast", referenceTarget: null, targets: [null, null, null], strengths: [0, 0, 0], effectiveStrength: 0 },
    correction: { enabled: p.enabled, requestedStrength: p.strength, effectiveStrength: 0, strengths: [0, 0, 0] } };
  const fallbackTones: HSL[] = [{ h: 212, s: .28, l: .55 }, { h: 28, s: .3, l: .53 }];
  const recovery = analysis.recovery;
  if (recovery.slotNeeds[1] > 0) state.accentRecovery.targets[1] = contrastAccent(fallbackTones[0], background);
  if (recovery.slotNeeds[2] > 0) {
    const harmonic = rgb(fromHSL({ h: (recovery.hue + 180) % 360, s: .38, l: .56 }));
    const reserved = rgb(fromHSL(fallbackTones[1]));
    // Neutral hue is undefined: fade to the restrained warm reserve instead of saturating gray.
    const target = hex(harmonic.map((v, j) => v + (reserved[j] - v) * recovery.neutralNeed) as [number, number, number]);
    const reference = contrastAccent(paletteHSL(target), background);
    state.accentRecovery.referenceTarget = reference;
    state.accentRecovery.targets[2] = contrastAccentVariant(reference, background, paletteHSL(reference));
  }
  if (!p.enabled || p.strength === 0 || !analysis.weak || manual) return state;
  for (const i of [1, 2] as const) {
    const source = analysis.quality[i];
    const recoveryNeed = recovery.slotNeeds[i], need = Math.max(source.need, recoveryNeed);
    if (need === 0) continue;
    // New hues belong exclusively to palette-wide Accent Recovery. Local
    // correction keeps the source hue; an unreliable gray hue stays neutral.
    const target = fromHSL({ h: source.h,
      s: Math.min(.48, Math.max(.3, source.s)) * source.colorConfidence,
      l: i === 1 ? .5 : .6 });
    const from = rgb(original[i]);
    let to = rgb(contrastAccent(paletteHSL(target), background));
    const recovered = state.accentRecovery.targets[i];
    if (recovered && recoveryNeed > 0) {
      const accent = rgb(recovered), weight = recoveryNeed / need;
      to = to.map((v, j) => v + (accent[j] - v) * weight) as [number, number, number];
      state.accentRecovery.strengths[i] = p.strength * recoveryNeed;
    }
    // Scale the single combined correction by the slider, preserving a linear 0–100% blend.
    const strength = p.strength * need;
    state.correction.strengths[i] = strength;
    state.final[i] = hex(from.map((v, j) => v + (to[j] - v) * strength / 100) as [number, number, number]);
  }
  state.accentRecovery.effectiveStrength = Math.max(...state.accentRecovery.strengths);
  state.correction.effectiveStrength = Math.max(...state.correction.strengths);
  return state;
}
