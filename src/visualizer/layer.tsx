import { resolveHybridPalette } from "../palette/hybrid_palette";
import { readFlatPlayerSurface } from "../palette/blob_surface_color";
import { hex } from "./colors";
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ArtworkPalette } from "../artwork_accent";
import { createVisualizerController, type AudioFrame, type VisualPreset } from "./controller";
import { getProductionDesign } from "../design/runtime";
import { resolveBlobColors, validateColorTuning, type ColorTuning } from "./colors";

export function VisualizerLayer({ preset, palette, hybridPaletteEnabled = true }: { preset: VisualPreset; palette: ArtworkPalette; hybridPaletteEnabled?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createVisualizerController> | null>(null);
  const artwork = useRef(palette);
  const tuning = useRef<ColorTuning>(getProductionDesign().colors);
  const refresh = useRef<() => void>(() => {});
  const hybrid = useRef(hybridPaletteEnabled);
  hybrid.current = hybridPaletteEnabled;
  artwork.current = palette;
  useEffect(() => {
    if (!host.current) return;
    const player = host.current.parentElement!;
    const owner = createVisualizerController(host.current, {
      create: async (...args) => (await import("./renderer.js")).createBlobRenderer(...args),
      active: enabled => invoke("set_visualizer_active", { enabled }),
      read: () => invoke<AudioFrame>("get_visualizer_frame"),
      schedule: (callback, delay) => setTimeout(callback, delay),
      cancel: timer => window.clearTimeout(timer),
      failed: error => console.warn("Visualizer disabled", error),
    });
    controller.current = owner;
    owner.setHybridPalette(hybrid.current);
    owner.setHorizontalPosition(getProductionDesign().blobHorizontalPosition);
    let smart: ReturnType<typeof import("../dev/smart_palette_player").attachSmartPalette> | undefined;
    let lastHybrid = hybrid.current;
    const update = () => {
      const primary = player.querySelector(".primary-control");
      const accent = primary ? getComputedStyle(primary).backgroundColor :
        (document.documentElement.dataset.theme === "light" ? artwork.current.light : artwork.current.dark);
      let target = resolveBlobColors(artwork.current, accent, tuning.current);
      // DEV diagnostics resolve independently; their switches never choose production colors.
      if (import.meta.env.DEV && smart) smart.resolve(artwork.current, target, tuning.current.mode === "manual");
      let background = "#222831";
      if (hybrid.current) {
        try { background = hex(readFlatPlayerSurface(player).map(v => v * 255) as [number, number, number]); } catch { /* Safe surface fallback. */ }
      }
      target = resolveHybridPalette(artwork.current, target, hybrid.current, background, tuning.current.mode === "manual");
      owner.setColors(target, lastHybrid === hybrid.current ? tuning.current.transitionMs : 0);
      lastHybrid = hybrid.current;
      if (import.meta.env.DEV) player.dispatchEvent(new CustomEvent("visualizer:color-state", {
        detail: { target, current: owner.getColors() ?? target },
      }));
    };
    refresh.current = update;
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    observer.observe(player, { attributes: true, attributeFilter: ["style"] });
    let disconnectDev = () => {};
    if (import.meta.env.DEV) {
      let disposed = false;
      void import("../dev/smart_palette_player").then(({ attachSmartPalette }) => {
        if (disposed) return;
        smart = attachSmartPalette(player, update);
        update();
      }).catch(error => console.warn("DEV Smart Palette unavailable", error));
      const receive = (event: Event) => {
        try { tuning.current = validateColorTuning((event as CustomEvent).detail); update(); }
        catch (error) { console.warn("Invalid DEV palette", error); }
      };
      const receivePosition = (event: Event) => {
        const value = (event as CustomEvent).detail;
        if (typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1) owner.setHorizontalPosition(value);
      };
      player.addEventListener("visualizer:position-settings", receivePosition);
      player.addEventListener("visualizer:color-settings", receive);
      player.addEventListener("visualizer:color-request", update);
      disconnectDev = () => {
        disposed = true;
        smart?.stop();
        player.removeEventListener("visualizer:position-settings", receivePosition);
        player.removeEventListener("visualizer:color-settings", receive);
        player.removeEventListener("visualizer:color-request", update);
      };
    }
    update();
    return () => { disconnectDev(); observer.disconnect(); refresh.current = () => {}; owner.dispose(); controller.current = null; };
  }, []);
  useEffect(() => { controller.current?.setPreset(preset); }, [preset]);
  useEffect(() => {
    controller.current?.setHybridPalette(hybridPaletteEnabled);
    refresh.current();
  }, [palette, hybridPaletteEnabled]);
  return <div ref={host} className="visualizer-layer" aria-hidden="true" />;
}
