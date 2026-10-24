import { ColorMatrixFilter, Rectangle, type Application, type Graphics, type BlurFilter } from "pixi.js";
import { alphaProfile, defaultBlobDiagnostics, validateBlobDiagnostics, type BlobDiagnosticSnapshot } from "./blob_diagnostics_model";

import { SoftAlphaFilter } from "./soft_alpha_filter";
import { BlobCompositingFilter } from "./blob_compositing_filter";
import { readFlatPlayerSurface, watchFlatPlayerSurface } from "./blob_surface_color";
import type { RGB } from "./blob_compositing_model";

type Context = { host: HTMLElement; app: Application; blobs: { shape: Graphics; blur: BlurFilter }[];
  readSurface?: () => RGB; watchSurface?: (changed: () => void) => () => void };
export function attachBlobDiagnostics({ host, app, blobs, readSurface, watchSurface }: Context): () => void {
  const player = host.parentElement!;
  const savedFilters = app.stage.filters, stageFilters = savedFilters ? [...savedFilters] : savedFilters;
  const stageArea = app.stage.filterArea;
  let colorFilter: BlobCompositingFilter | undefined, stopWatching: (() => void) | undefined;
  let surface: RGB = [0,0,0], groupActive = false;
  const strengths = () => ({
    brightness: ["brightness","combined"].includes(settings.mode) ? settings.brightnessIntensity : 0,
    surfaceStrength: ["dark-surface","combined"].includes(settings.mode) ? settings.surfaceIntensity : 0,
  });
  const original = blobs.map(({ shape }) => ({ visible: shape.visible, filters: [...(shape.filters ?? [])] }));
  let settings = defaultBlobDiagnostics(), profiles: BlobDiagnosticSnapshot["profiles"], error: string | undefined;
  const softMasks: (SoftAlphaFilter | undefined)[] = [];
  let active = true, mask: ColorMatrixFilter | undefined;
  function restoreGroup() {
    app.stage.filters = stageFilters; app.stage.filterArea = stageArea; groupActive = false;
  }
  function applyGroup(alphaView = settings.alpha) {
    const {brightness,surfaceStrength} = strengths();
    restoreGroup();
    if (alphaView || (brightness === 0 && surfaceStrength === 0)) return;
    if (surfaceStrength > 0) {
      surface = readSurface ? readSurface() : readFlatPlayerSurface(player);
      if (!stopWatching) stopWatching = (watchSurface ?? (changed => watchFlatPlayerSurface(player,changed)))(() => {
        if (!active || settings.alpha || strengths().surfaceStrength === 0) return;
        try { applyGroup(); error = undefined; } catch (cause) { error = String(cause); }
        publish();
      });
    }
    colorFilter ??= new BlobCompositingFilter();
    colorFilter.update(brightness,surfaceStrength,surface);
    app.stage.filterArea = new Rectangle(0,0,app.screen.width,app.screen.height);
    app.stage.filters = [...(stageFilters ?? []),colorFilter]; groupActive = true;
  }
  function filtersFor(index: number, disableBlur = settings.disableBlur) {
    const filters = disableBlur ? [] : [...original[index].filters];
    if (settings.mode === "soft-alpha") {
      const filter = softMasks[index] ??= new SoftAlphaFilter(blobs[index].shape, settings.edgeSoftness);
      filter.softness = settings.edgeSoftness;
      filters.unshift(filter); // Mask each blob before its existing blur, before blobs merge.
    }
    return filters;
  }
  function apply() {
    if (settings.alpha && !mask) {
      mask = new ColorMatrixFilter();
      // White with the existing alpha: a diagnostic mask, never a new opacity curve.
      mask.matrix = [0,0,0,0,1, 0,0,0,0,1, 0,0,0,0,1, 0,0,0,1,0];
    }
    blobs.forEach(({ shape }, index) => {
      shape.visible = original[index].visible && (settings.solo === "all" || settings.solo === index);
      // Original takes the exact pre-experiment filter path (no identity shader).
      const filters = filtersFor(index);
      shape.filters = settings.alpha ? [...filters, mask!] : settings.mode === "original" && !settings.disableBlur ? original[index].filters : filters;
    });
    applyGroup();
  }
  function publish() {
    const snapshot: BlobDiagnosticSnapshot = {
      active, settings: { ...settings },
      blobs: blobs.map(({ shape, blur }, index) => ({
        index, visible: shape.visible, alpha: shape.alpha, blur: blur.strength, blendMode: shape.blendMode,
      })), profiles, error,
      compositing: { ...strengths(), surface: [...surface], active: groupActive },
    };
    player.dispatchEvent(new CustomEvent("blob-diagnostics:state", { detail: snapshot }));
  }
  function measure() {
    profiles = []; error = undefined;
    try {
      applyGroup(false); // Readback uses actual color output, not the white alpha view.
      for (const disableBlur of [false, true]) {
        blobs.forEach(({ shape }, index) => { shape.filters = filtersFor(index, disableBlur); });
        for (const target of [...blobs.map((_, index) => index), "all"] as const) {
          blobs.forEach(({ shape }, index) => { shape.visible = original[index].visible && (target === "all" || index === target); });
          const result = app.renderer.extract.pixels({ target: app.stage, resolution: 1,
            frame: new Rectangle(0, 0, app.screen.width, app.screen.height), clearColor: [0,0,0,0] });
          profiles.push({ mode: disableBlur ? "no-blur" : "blur", target: target === "all" ? "all" : "Blob " + (target + 1), profile: alphaProfile(result.pixels) });
        }
      }
    } catch (cause) { error = "GPU alpha readback: " + String(cause); }
    finally { apply(); }
  }
  function receive(event: Event) {
    try {
      const message = (event as CustomEvent).detail;
      if (message.measure === true) measure();
      else { settings = validateBlobDiagnostics(message); profiles = undefined; error = undefined; apply(); }
    } catch (cause) { error = String(cause); }
    publish();
  }
  const request = () => publish();
  player.addEventListener("blob-diagnostics:command", receive);
  player.addEventListener("blob-diagnostics:request", request);
  publish();
  return () => {
    if (!active) return;
    active = false;
    player.removeEventListener("blob-diagnostics:command", receive);
    player.removeEventListener("blob-diagnostics:request", request);
    blobs.forEach(({ shape }, index) => { shape.visible = original[index].visible; shape.filters = original[index].filters; });
    stopWatching?.(); restoreGroup();
    colorFilter?.destroy();
    mask?.destroy();
    softMasks.forEach(filter => filter?.destroy());
    profiles = undefined; publish();
  };
}
