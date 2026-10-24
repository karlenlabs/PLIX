export type ArtworkPalette = {
  dark: string;
  light: string;
  tint: string;
  ambient: [string, string, string];
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

// Run only when an artwork image loads, never during the media polling loop.
export function paletteFromPixels(pixels: ArrayLike<number>): ArtworkPalette {
  const buckets = Array.from({ length: 24 }, () => ({ weight: 0, x: 0, y: 0, saturation: 0 }));
  let opaque = 0, colorful = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (!Number.isFinite(alpha) || alpha < 224 || alpha > 255) continue;
    const r = pixels[index] / 255, g = pixels[index + 1] / 255, b = pixels[index + 2] / 255;
    if (![r, g, b].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) continue;
    opaque++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
    const lightness = (max + min) / 2;
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
  // Ignore tiny colored specks on otherwise neutral artwork.
  if (!opaque || colorful / opaque < .05) return NEUTRAL_PALETTE;
  const dominant = buckets.reduce((best, bucket) => bucket.weight > best.weight ? bucket : best);
  if (!dominant.weight) return NEUTRAL_PALETTE;
  const { hue, saturation } = bucketColor(dominant);
  return {
    dark: accessibleAccent(hue, saturation, true),
    light: accessibleAccent(hue, saturation, false),
    tint: hslToRgb(hue, saturation, .6).join(", "),
    ambient: ambientColors(buckets, dominant, opaque),
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
