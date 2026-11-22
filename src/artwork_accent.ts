export type ArtworkPalette = {
  dark: string;
  light: string;
  tint: string;
  ambient: [string, string, string];
  // Light range of colorless artwork (HSL lightness 0-1). Set only on the
  // neutral fallback, so Hybrid Palette can glow with the artwork's own light.
  tone?: { low: number; high: number };
  // A real second color of the artwork (e.g. orange hair on a pale-blue cover),
  // pooled across neighboring hue buckets so a spread-out color is not lost.
  accent?: { hue: number; saturation: number };
};
type RGB = [number, number, number];

export const NEUTRAL_PALETTE: ArtworkPalette = {
  dark: "#c4cbd4", light: "#495564", tint: "148, 156, 168",
  ambient: ["rgb(116, 139, 165)", "rgb(117, 120, 153)", "rgb(104, 140, 145)"],
};

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = lightness - chroma / 2;
  const channels = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] :
    hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] :
    hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return channels.map(value => Math.round((value + offset) * 255)) as RGB;
}

export function relativeLuminance(rgb: RGB): number {
  const linear = rgb.map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

function accessibleAccent(hue: number, saturation: number, dark: boolean): string {
  let lightness = dark ? .72 : .38;
  let rgb = hslToRgb(hue, saturation, lightness);
  // Keep the primary icon above 4.5:1 and the fill visible on the themed track.
  while (dark ? relativeLuminance(rgb) < .42 : relativeLuminance(rgb) > .13) {
    lightness += dark ? .01 : -.01;
    rgb = hslToRgb(hue, saturation, lightness);
  }
  return `rgb(${rgb.join(", ")})`;
}

type ColorBucket = { weight: number; x: number; y: number; saturation: number };

function bucketColor(bucket: ColorBucket) {
  return {
    hue: (Math.atan2(bucket.y, bucket.x) * 180 / Math.PI + 360) % 360,
    saturation: Math.min(.65, Math.max(.35, bucket.saturation / bucket.weight)),
  };
}

function ambientColors(buckets: ColorBucket[], dominant: ColorBucket, opaque: number): ArtworkPalette["ambient"] {
  const selected = [bucketColor(dominant)];
  const threshold = Math.max(opaque * .04, dominant.weight * .08);
  for (const bucket of [...buckets].sort((a, b) => b.weight - a.weight)) {
    if (selected.length === 3) break;
    if (bucket.weight < threshold) continue;
    const candidate = bucketColor(bucket);
    const distinct = selected.every(color => {
      const distance = Math.abs(color.hue - candidate.hue);
      return Math.min(distance, 360 - distance) >= 40;
    });
    if (distinct) selected.push(candidate);
  }
  // Monochrome artwork stays in its own hue family rather than adding unrelated colors.
  const tones = [.6, .54, .64];
  return tones.map((lightness, index) => {
    const color = selected[index] ?? selected[0];
    return `rgb(${hslToRgb(color.hue, color.saturation, lightness).join(", ")})`;
  }) as ArtworkPalette["ambient"];
}

function secondaryAccent(buckets: ColorBucket[], dominantHue: number, opaque: number) {
  let best: { hue: number; saturation: number; weight: number } | undefined;
  for (let i = 0; i < buckets.length; i++) {
    const pool = [buckets[(i + 23) % 24], buckets[i], buckets[(i + 1) % 24]];
    const weight = pool.reduce((n, b) => n + b.weight, 0);
    if (!weight || weight < opaque * .05) continue;
    const x = pool.reduce((n, b) => n + b.x, 0), y = pool.reduce((n, b) => n + b.y, 0);
    const hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const distance = Math.min(Math.abs(hue - dominantHue), 360 - Math.abs(hue - dominantHue));
    const saturation = pool.reduce((n, b) => n + b.saturation, 0) / weight;
    if (distance < 45 || saturation < .35) continue;
    if (!best || weight > best.weight) best = { hue, saturation, weight };
  }
  return best && { hue: best.hue, saturation: best.saturation };
}

// Run only when an artwork image loads, never during the media polling loop.
export function paletteFromPixels(pixels: ArrayLike<number>): ArtworkPalette {
  const buckets = Array.from({ length: 24 }, () => ({ weight: 0, x: 0, y: 0, saturation: 0 }));
  let opaque = 0, colorful = 0;
  const lightnesses: number[] = [];
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (!Number.isFinite(alpha) || alpha < 224 || alpha > 255) continue;
    const r = pixels[index] / 255, g = pixels[index + 1] / 255, b = pixels[index + 2] / 255;
    if (![r, g, b].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) continue;
    opaque++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
    const lightness = (max + min) / 2;
    lightnesses.push(lightness);
    if (chroma < .08 || lightness < .12 || lightness > .9) continue;
    const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
    if (saturation < .15) continue;
    colorful++;
    const segment = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    const hue = (segment * 60 + 360) % 360;
    const bucket = buckets[Math.floor(((hue + 7.5) % 360) / 15)];
    const weight = .75 + .25 * saturation;
    bucket.weight += weight;
    bucket.x += Math.cos(hue * Math.PI / 180) * weight;
    bucket.y += Math.sin(hue * Math.PI / 180) * weight;
    bucket.saturation += saturation * weight;
  }
  lightnesses.sort((a, b) => a - b);
  const at = (q: number) => lightnesses[Math.min(lightnesses.length - 1, Math.floor(q * lightnesses.length))];
  const neutral = (): ArtworkPalette => opaque ? { ...NEUTRAL_PALETTE, tone: { low: at(.15), high: at(.85) } } : NEUTRAL_PALETTE;
  // Ignore tiny colored specks on otherwise neutral artwork.
  if (!opaque || colorful / opaque < .05) return neutral();
  const dominant = buckets.reduce((best, bucket) => bucket.weight > best.weight ? bucket : best);
  if (!dominant.weight) return neutral();
  const { hue, saturation } = bucketColor(dominant);
  return {
    dark: accessibleAccent(hue, saturation, true),
    light: accessibleAccent(hue, saturation, false),
    tint: hslToRgb(hue, saturation, .6).join(", "),
    ambient: ambientColors(buckets, dominant, opaque),
    accent: secondaryAccent(buckets, hue, opaque),
  };
}

export function paletteFromArtwork(image: HTMLImageElement): ArtworkPalette {
  try {
    if (!image.naturalWidth || !image.naturalHeight) return NEUTRAL_PALETTE;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return NEUTRAL_PALETTE;
    context.drawImage(image, 0, 0, 32, 32);
    return paletteFromPixels(context.getImageData(0, 0, 32, 32).data);
  } catch {
    // Decode/CORS/canvas failures never interfere with artwork or playback.
    return NEUTRAL_PALETTE;
  }
}
