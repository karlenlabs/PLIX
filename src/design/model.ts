import { hex, rgb, validateColorTuning, type BlobColors, type ColorTuning } from "../visualizer/colors.ts";
import { cssParameters, type CSSPreset as Preset } from "./legacy.ts";

export type SurfaceTuning = {
  borderEnabled: boolean; borderWidth: number; borderColor: string; borderOpacity: number;
  topEnabled: boolean; topLineEnabled: boolean; topSoftEnabled: boolean; topIntensity: number;
  veilEnabled: boolean; veilIntensity: number;
  shadowEnabled: boolean; shadowIntensity: number;
  edgeEnabled: boolean; edgeIntensity: number;
  ambientEnabled: boolean; ambientIntensity: number;
  washEnabled: boolean; washIntensity: number;
  bottomShadeEnabled: boolean;
  baseColor: string; baseOpacity: number;
};
export type DesignSettings = { surface: SurfaceTuning | null; colors: ColorTuning; legacy: Partial<Preset>; blobHorizontalPosition: number };
export const surfaceFields = {
  borderWidth: [1, 4], borderOpacity: [0, 1], topIntensity: [0, 1], veilIntensity: [0, 1],
  shadowIntensity: [0, 1], edgeIntensity: [0, 1], ambientIntensity: [0, 1], washIntensity: [0, 1], baseOpacity: [0, 1],
} as const;
const toggles = ["borderEnabled", "topEnabled", "topLineEnabled", "topSoftEnabled", "veilEnabled", "shadowEnabled", "edgeEnabled", "ambientEnabled", "washEnabled", "bottomShadeEnabled"] as const;
export function validateSurface(input: unknown): SurfaceTuning {
  const value = input as SurfaceTuning;
  if (!value || toggles.some(k => typeof value[k] !== "boolean") ||
      Object.entries(surfaceFields).some(([k, [lo, hi]]) => {
        const n = value[k as keyof typeof surfaceFields]; return !Number.isFinite(n) || n < lo || n > hi;
      }) || ![value.borderColor, value.baseColor].every(c => typeof c === "string" && /^#[\da-f]{6}$/i.test(c)) ||
      Object.keys(value).length !== toggles.length + Object.keys(surfaceFields).length + 2) throw new Error("Invalid surface settings");
  if (!Number.isInteger(value.borderWidth)) throw new Error("Border width must use whole CSS pixels");
  return { ...value };
}
export function validateHorizontalPosition(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < -1 || input > 1) throw new Error("Invalid blob horizontal position");
  return input;
}
export function validateDesign(input: unknown): DesignSettings {
  const original = input as DesignSettings;
  const value = original && { ...original, blobHorizontalPosition: Object.hasOwn(original, "blobHorizontalPosition") ? original.blobHorizontalPosition : 0 };
  if (!value || !value.legacy || Object.keys(value).sort().join() !== "blobHorizontalPosition,colors,legacy,surface") throw new Error("Invalid visual design");
  const legacy: Partial<Preset> = {};
  for (const [name, n] of Object.entries(value.legacy)) {
    const parameter = cssParameters[name as keyof typeof cssParameters];
    if (!parameter || typeof n !== "number" || !Number.isFinite(n) || n < parameter[0] || n > parameter[1]) throw new Error("Invalid saved CSS parameter");
    legacy[name as keyof Preset] = n;
  }
  return { surface: value.surface === null ? null : validateSurface(value.surface), colors: validateColorTuning(value.colors), legacy, blobHorizontalPosition: validateHorizontalPosition(value.blobHorizontalPosition) };
}
export function readSurface(style: CSSStyleDeclaration): SurfaceTuning {
  const n = (name: string) => parseFloat(style.getPropertyValue(name));
  return {
    borderEnabled: true, borderWidth: 1, borderColor: hex(rgb(`rgb(${style.getPropertyValue("--player-highlight").trim()})`)), borderOpacity: n("--border-highlight-opacity"),
    topEnabled: true, topLineEnabled: true, topSoftEnabled: true, topIntensity: 1,
    veilEnabled: true, veilIntensity: n("--surface-tint-opacity"),
    shadowEnabled: true, shadowIntensity: n("--shadow-opacity"), edgeEnabled: true, edgeIntensity: 1,
    ambientEnabled: true, ambientIntensity: 1, washEnabled: true, washIntensity: 1, bottomShadeEnabled: true,
    baseColor: hex(rgb(`rgb(${style.getPropertyValue("--player-surface").trim()})`)), baseOpacity: n("--surface-base-opacity"),
  };
}
export function surfaceVariables(input: SurfaceTuning): Record<string, string> {
  const s = validateSurface(input), values: Record<string, string> = {};
  const put = (name: string, value: number | string) => { values[`--design-${name}`] = String(value); };
  put("border-rgb", rgb(s.borderColor).join(", ")); put("border-width", `${s.borderWidth - 1}px`);
  put("border-alpha", s.borderEnabled ? s.borderOpacity : 0);
  put("top-line", s.topEnabled && s.topLineEnabled ? s.topIntensity : 0);
  put("top-soft", s.topEnabled && s.topSoftEnabled ? s.topIntensity : 0);
  put("veil", s.veilEnabled ? s.veilIntensity : 0);
  put("shadow", s.shadowEnabled ? s.shadowIntensity : 0);
  put("edge", s.edgeEnabled ? s.edgeIntensity : 0);
  put("ambient", s.ambientEnabled ? s.ambientIntensity : 0);
  put("wash", s.washEnabled ? s.washIntensity : 0);
  put("bottom-shade", s.bottomShadeEnabled ? 1 : 0);
  put("base-color", s.baseColor); put("base-opacity", s.baseOpacity);
  return values;
}
