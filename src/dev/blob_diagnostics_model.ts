export type BlobDiagnosticSettings = { solo: "all" | "none" | 0 | 1 | 2; alpha: boolean; disableBlur: boolean; mode: "original" | "soft-alpha" | "brightness" | "dark-surface" | "combined"; edgeSoftness: number; brightnessIntensity: number; surfaceIntensity: number };
export const defaultBlobDiagnostics = (): BlobDiagnosticSettings => ({ solo: "all", alpha: false, disableBlur: false, mode: "original", edgeSoftness: .65, brightnessIntensity: .5, surfaceIntensity: .5 });
export function validateBlobDiagnostics(input: unknown): BlobDiagnosticSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid blob diagnostics");
  const value = input as Record<string, unknown>;
  if (!["all", "none", 0, 1, 2].includes(value.solo as string | number)
    || typeof value.alpha !== "boolean" || typeof value.disableBlur !== "boolean") throw new Error("Invalid blob diagnostics");
  // Old diagnostic commands remain valid; experiments never become production settings.
  const mode = value.mode ?? "original", edgeSoftness = value.edgeSoftness ?? .65;
  if (!["original", "soft-alpha", "brightness", "dark-surface", "combined"].includes(mode as string) || typeof edgeSoftness !== "number"
    || !Number.isFinite(edgeSoftness) || edgeSoftness < .1 || edgeSoftness > 1) throw new Error("Invalid blob diagnostics");
  const brightnessIntensity = value.brightnessIntensity ?? .5, surfaceIntensity = value.surfaceIntensity ?? .5;
  if (![brightnessIntensity,surfaceIntensity].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error("Invalid blob diagnostics");
  return { solo: value.solo as BlobDiagnosticSettings["solo"], alpha: value.alpha, disableBlur: value.disableBlur,
    mode: mode as BlobDiagnosticSettings["mode"], edgeSoftness, brightnessIntensity: brightnessIntensity as number, surfaceIntensity: surfaceIntensity as number };
}
export type AlphaProfile = { pixels: number; meanAlpha: number; maxAlpha: number; weak: number; medium: number; core: number; coverage: number };
export function alphaProfile(pixels: ArrayLike<number>): AlphaProfile {
  const count = pixels.length / 4;
  if (!Number.isInteger(count) || count === 0) throw new Error("Invalid RGBA pixels");
  let sum = 0, max = 0, weak = 0, medium = 0, core = 0, coverage = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    const a = pixels[i] / 255; sum += a; max = Math.max(max, a);
    if (a > .01) { coverage++; if (a <= .25) weak++; else if (a <= .75) medium++; else core++; }
  }
  return { pixels: count, meanAlpha: sum / count, maxAlpha: max, weak: weak / count, medium: medium / count, core: core / count, coverage: coverage / count };
}
export type BlobDiagnosticSnapshot = {
  active: boolean; settings: BlobDiagnosticSettings;
  blobs: { index: number; visible: boolean; alpha: number; blur: number; blendMode: string }[];
  profiles?: { mode: "blur" | "no-blur"; target: string; profile: AlphaProfile }[];
  compositing?: { brightness: number; surfaceStrength: number; surface: [number, number, number]; active: boolean };
  error?: string;
};
