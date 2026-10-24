import { relativeLuminance } from "../artwork_accent.ts";
import { rgb, hex } from "../visualizer/colors.ts";

// Shared by production and DEV comparisons; the Contrast calculation is unchanged.
export function accentColor(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const channels = h < 60 ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x] : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
  return hex(channels.map(v => (v + m) * 255) as [number, number, number]);
}
export function accentContrast(foreground: string, background: string) {
  const a = relativeLuminance(rgb(foreground)), b = relativeLuminance(rgb(background));
  return (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
}
export function contrastAccentVariant(source: string, background: string, tone: { h: number; s: number; l: number }): string {
  const saturation = Math.min(.68, Math.max(.5, tone.s + .12));
  const goal = accentContrast(source, background) + 1.5;
  let best = source, closest: string | undefined, closestDistance = Infinity;
  for (let step = 32; step <= 160; step++) {
    const l = step / 200, candidate = accentColor(tone.h, saturation, l);
    const ratio = accentContrast(candidate, background);
    if (ratio > accentContrast(best, background)) best = candidate;
    if (ratio >= goal && Math.abs(l - tone.l) < closestDistance) {
      closest = candidate; closestDistance = Math.abs(l - tone.l);
    }
  }
  return closest ?? best;
}

