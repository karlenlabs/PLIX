export type AmbientHazeSettings = { enabled: boolean; intensity: number };
export const defaultAmbientHaze = (): AmbientHazeSettings => ({ enabled: false, intensity: 35 });

export function validateAmbientHaze(input: unknown): AmbientHazeSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Ambient Haze settings");
  const value = input as Record<string, unknown>;
  if (typeof value.enabled !== "boolean" || typeof value.intensity !== "number"
    || !Number.isFinite(value.intensity) || value.intensity < 0 || value.intensity > 100) {
    throw new Error("Invalid Ambient Haze settings");
  }
  return { enabled: value.enabled, intensity: value.intensity };
}

// Sibling of the canvas. Palette variables are inherited from the player;
// Appearance owns persistence; this renderer only manages its single CSS layer.
export function createAmbientHaze(player: HTMLElement) {
  let settings = defaultAmbientHaze(), layer: HTMLDivElement | undefined;
  return {
    snapshot: (): AmbientHazeSettings => ({ ...settings }),
    apply(input: unknown) {
      const next = validateAmbientHaze(input);
      if (next.enabled && next.intensity > 0) {
        if (!layer) {
          layer = player.ownerDocument.createElement("div");
          layer.className = "ambient-haze";
          layer.setAttribute("aria-hidden", "true");
          player.appendChild(layer);
        }
        // 100% is a bounded 30% layer opacity; the CSS mask further protects content.
        layer.style.setProperty("--ambient-haze-opacity", String(next.intensity / 100 * .3));
      } else {
        layer?.remove();
        layer = undefined;
      }
      settings = next;
    },
    stop() {
      layer?.remove();
      layer = undefined;
      settings = defaultAmbientHaze();
    },
  };
}
