import type { DesignSnapshot } from "./visual_design_model";
// Base CSS lives in style.css; approved production overrides come from design/runtime.
export const sections = {
  Surface: [
    ["--surface-tint-opacity", "Tint opacity", 0, 1, .01, ""],
    ["--surface-base-opacity", "Base opacity", 0, 1, .01, ""],
    ["--surface-brightness", "Brightness", .2, 2, .01, ""],
    ["--surface-saturation", "Saturation", 0, 3, .01, ""],
    ["--player-radius", "Player radius", 0, 60, 1, "px"],
  ],
  Ambient: [
    ["--ambient-blur", "Blur", 0, 80, 1, "px"],
    ["--ambient-opacity", "Opacity", 0, 1, .01, ""],
    ["--ambient-saturation", "Saturation multiplier", 0, 3, .01, ""],
    ["--ambient-lightness", "Lightness multiplier", .2, 2, .01, ""],
    ["--ambient-scale", "Scale / spread", .5, 2, .01, ""],
    ["--ambient-top-right-intensity", "Top-right glow multiplier", 0, 3, .01, ""],
    ["--ambient-bottom-center-intensity", "Bottom-center glow multiplier", 0, 3, .01, ""],
    ["--ambient-left-intensity", "Left glow multiplier", 0, 3, .01, ""],
  ],
  Edges: [
    ["--top-edge-highlight-opacity", "Top highlight opacity", 0, 1, .01, ""],
    ["--top-edge-soft-highlight-opacity", "Top soft highlight opacity", 0, 1, .01, ""],
    ["--bottom-edge-glow-opacity", "Bottom glow opacity", 0, 1, .01, ""],
    ["--bottom-edge-soft-glow-opacity", "Bottom soft glow opacity", 0, 1, .01, ""],
    ["--left-edge-highlight-opacity", "Left highlight opacity", 0, 1, .01, ""],
    ["--border-highlight-opacity", "Border opacity", 0, 1, .01, ""],
  ],
  Controls: [
    ["--play-pause-glow-opacity", "Play/pause glow opacity", 0, 1, .01, ""],
    ["--play-pause-glow-blur", "Play/pause glow blur", 0, 60, 1, "px"],
    ["--control-background-opacity", "Control background opacity", 0, 1, .01, ""],
    ["--muted-control-opacity", "Muted / disabled opacity", 0, 1, .01, ""],
  ],
  Shadow: [
    ["--shadow-opacity", "Opacity", 0, 1, .01, ""],
    ["--shadow-blur", "Blur", 0, 40, 1, "px"],
    ["--shadow-spread", "Spread", -20, 20, 1, "px"],
    ["--shadow-offset-x", "Horizontal offset", -20, 20, 1, "px"],
    ["--shadow-offset-y", "Vertical offset", -20, 20, 1, "px"],
  ],
  Artwork: [
    ["--artwork-radius", "Radius", 0, 57, 1, "px"],
    ["--artwork-saturation", "Saturation", 0, 3, .01, ""],
    ["--artwork-brightness", "Brightness", .2, 2, .01, ""],
  ],
} as const;

export const parameters = Object.values(sections).flat();
export type Variable = typeof parameters[number][0];
// Preserve schema-v1 presets and approved legacy fields; Soft Raised has no glow.
export const retiredButtonVariables: ReadonlySet<string> = new Set(["--play-pause-glow-opacity", "--play-pause-glow-blur"]);
export type Preset = Record<Variable, number>;
export type PlayerSnapshot = { values: Preset; defaults: Preset; theme: string; commandId: string | null; design?: DesignSnapshot };
export const storageKey = "ympleer-v2:dev:visual-tuning:v1";

export function validatePreset(input: unknown): Preset {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid preset");
  const record = input as Record<string, unknown>;
  const result = {} as Preset;
  for (const [name, , min, max] of parameters) {
    const value = record[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Invalid value for ${name} (${min}…${max})`);
    }
    result[name] = value;
  }
  if (Object.keys(record).length !== parameters.length) throw new Error("Unknown preset variables");
  return result;
}

export function cssVars(preset: Preset): string {
  return parameters.map(([name, , , , , unit]) => `  ${name}: ${preset[name]}${unit};`).join("\n");
}
