import { validateBlobDiagnostics, type BlobDiagnosticSnapshot } from "./blob_diagnostics_model";
import { parameters, sections, type Preset } from "./visual_tuning_model";
import { hybridPaletteSettings, defaultAudioComparison, validateAudioComparison, defaultAudioColors, validateAudioColors, defaultAccentComparison, validateAccentComparison, defaultSmartPalette, validateSmartPalette, defaultDesign, designStorageKey, diagnosticLayers, surfaceVariables, validateDesign, validateSurface, validateHorizontalPosition, type ColorState, type DesignSettings, type DesignSnapshot } from "./visual_design_model";
import { productionLegacyCSS } from "../design/runtime";
import { validateColorTuning } from "../visualizer/colors";
import "./visual_tuning_surface.css";

export function connectVisualDesign(player: HTMLElement) {
  let audioSettings = defaultAudioColors();
  let audioComparison = defaultAudioComparison();
  let audioState: import("./audio_color_diagnostics").DiagnosticAudioColorState | null = null;
  const sendAudioComparison = () => player.dispatchEvent(new CustomEvent("visualizer:audio-colors-comparison", { detail: audioComparison }));
  const sendAudio = () => {
    player.dispatchEvent(new CustomEvent("visualizer:audio-colors-settings", { detail: audioSettings }));
    sendAudioComparison();
  };
  const receiveAudio = (event: Event) => { audioState = (event as CustomEvent).detail; };
  player.addEventListener("visualizer:audio-colors-settings-request", sendAudio);
  player.addEventListener("visualizer:audio-colors-state", receiveAudio);
  sendAudio();
  let comparisonMode = defaultAccentComparison();
  let comparisonState: import("./accent_color_comparison").AccentComparisonState | null = null;
  const sendComparison = () => player.dispatchEvent(new CustomEvent("visualizer:accent-comparison-settings", { detail: comparisonMode }));
  const receiveComparison = (event: Event) => { comparisonState = (event as CustomEvent).detail; };
  player.addEventListener("visualizer:accent-comparison-request", sendComparison);
  player.addEventListener("visualizer:accent-comparison-state", receiveComparison);
  let smartSettings = defaultSmartPalette();
  let smartState: import("./smart_palette").SmartPaletteState | null = null;
  const sendSmart = () => player.dispatchEvent(new CustomEvent("visualizer:smart-palette-settings", { detail: smartSettings }));
  const receiveSmart = (event: Event) => { smartState = (event as CustomEvent).detail; };
  player.addEventListener("visualizer:smart-palette-request", sendSmart);
  player.addEventListener("visualizer:smart-palette-state", receiveSmart);
  let blobDiagnostics: BlobDiagnosticSnapshot | null = null;
  let pixiCanvasHidden = false;
  function hidePixiCanvas(hidden: boolean) {
    pixiCanvasHidden = hidden;
    if (hidden) player.dataset.devHidePixiCanvas = "true";
    else delete player.dataset.devHidePixiCanvas;
  }
  let cssHighlightsIsolated = false;
  function isolateCssHighlights(enabled: boolean) {
    cssHighlightsIsolated = enabled;
    if (enabled) player.dataset.devCssHighlights = "isolated";
    else delete player.dataset.devCssHighlights;
  }
  const diagnosticState = (event: Event) => { blobDiagnostics = (event as CustomEvent<BlobDiagnosticSnapshot>).detail; };
  player.addEventListener("blob-diagnostics:state", diagnosticState);
  let settings = defaultDesign(), colors: ColorState | null = null, storageError: string | null = null;
  function persist() {
    try { localStorage.setItem(designStorageKey, JSON.stringify(settings)); storageError = null; }
    catch (error) { storageError = `DEV settings were not saved: ${String(error)}`; }
  }
  function clearSurface() {
    delete player.dataset.surfaceTuning;
    Object.entries(surfaceVariables(defaultDesign().surface!)).forEach(([name,value]) => player.style.setProperty(name,value));
  }
  function applySurface() {
    clearSurface();
    player.dataset.playerDesign = "true";
    if (settings.surface) {
      Object.entries(surfaceVariables(settings.surface)).forEach(([name, value]) => player.style.setProperty(name, value));
      player.dataset.surfaceTuning = "true";
    }
  }
  function sendColors() { player.dispatchEvent(new CustomEvent("visualizer:color-settings", { detail: settings.colors })); }
  function sendPosition() { player.dispatchEvent(new CustomEvent("visualizer:position-settings", { detail: settings.blobHorizontalPosition })); }
  function rememberLegacy() {
    settings.legacy = Object.fromEntries(parameters.flatMap(([name]) => {
      const value = player.style.getPropertyValue(name); return value ? [[name, parseFloat(value)]] : [];
    })) as Partial<Preset>;
  }
  function restore(value: DesignSettings) {
    settings = value;
    parameters.forEach(([name, , , , , unit]) => {
      const n = settings.legacy[name];
      if (n === undefined) {
        if (productionLegacyCSS[name] !== undefined) player.style.setProperty(name, productionLegacyCSS[name]); else player.style.removeProperty(name);
      } else player.style.setProperty(name, `${n}${unit}`);
    });
    applySurface(); sendColors(); sendPosition();
  }
  const receiveColors = (event: Event) => {
    const state = (event as CustomEvent<ColorState>).detail;
    if (state && [state.current, state.target].every(a => Array.isArray(a) && a.length === 3 && a.every(c => /^#[\da-f]{6}$/i.test(c)))) colors = state;
  };
  player.addEventListener("visualizer:color-state", receiveColors);
  restore(settings);
  try { const saved = localStorage.getItem(designStorageKey); if (saved) restore(validateDesign(JSON.parse(saved))); }
  catch (error) { storageError = `Saved DEV settings ignored: ${String(error)}`; }
  function defaults() { return defaultDesign().surface!; }
  return {
    snapshot(): DesignSnapshot {
      player.dispatchEvent(new CustomEvent("visualizer:color-request"));
      player.dispatchEvent(new CustomEvent("visualizer:audio-colors-request"));
      player.dispatchEvent(new CustomEvent("blob-diagnostics:request"));
      return { settings: structuredClone(settings), surface: settings.surface ?? defaultDesign().surface!, defaults: defaults(),
        audioColors: { settings: { ...audioSettings }, comparison: audioComparison, state: audioState }, accentComparison: { mode: comparisonMode, state: comparisonState }, smartPalette: { settings: { ...smartSettings }, state: smartState }, pixiCanvasHidden, cssHighlightsIsolated, blobDiagnostics, colors, diagnostics: diagnosticLayers(player), storageError };
    },
    receive(message: { action?: unknown; values?: unknown }): boolean {
      if (message.action === "hybrid-palette") {
        const next = hybridPaletteSettings(message.values,smartSettings);
        smartSettings = next.smart;
        audioSettings = next.audio;
        audioComparison = next.audioComparison;
        comparisonMode = next.accentComparison;
        sendAudio(); sendComparison(); sendSmart();
        return true; // Unified DEV command, excluded from persisted DesignSettings.
      }
      if (message.action === "audio-colors-comparison") {
        audioComparison = validateAudioComparison(message.values);
        sendAudioComparison();
        return true; // Temporary source comparison, never persisted.
      }
      if (message.action === "audio-driven-colors") {
        audioSettings = validateAudioColors(message.values);
        sendAudio();
        return true; // Ephemeral: outside DesignSettings and SAVE DEV DESIGN.
      }
      if (message.action === "accent-recovery-comparison") {
        comparisonMode = validateAccentComparison(message.values);
        sendComparison();
        return true; // Temporary; excluded from persisted DesignSettings.
      }
      if (message.action === "smart-palette") {
        smartSettings = validateSmartPalette(message.values);
        sendSmart();
        return true; // Ephemeral; excluded from settings, storage and SAVE DEV DESIGN.
      }
      if (message.action === "hide-pixi-canvas") {
        if (typeof message.values !== "boolean") throw new Error("Invalid Pixi canvas visibility");
        hidePixiCanvas(message.values);
        return true; // DEV visibility only: renderer, capture and saved settings stay intact.
      }
      if (message.action === "css-highlights-isolation") {
        if (typeof message.values !== "boolean") throw new Error("Invalid CSS highlights isolation");
        isolateCssHighlights(message.values);
        return true; // DEV display only: no persistence, color/preset or capture commands.
      }
      if (message.action === "blob-diagnostics") {
        const values = message.values as { measure?: unknown };
        const command = values?.measure === true ? { measure: true } : validateBlobDiagnostics(message.values);
        player.dispatchEvent(new CustomEvent("blob-diagnostics:command", { detail: command }));
        return true; // Ephemeral: never persist diagnostic modes into user design.
      }
      switch (message.action) {
        case "surface": settings.surface = validateSurface(message.values); applySurface(); break;
        case "colors": settings.colors = validateColorTuning(message.values); sendColors(); break;
        case "position": settings.blobHorizontalPosition = validateHorizontalPosition(message.values); sendPosition(); break;
        case "reset-position": settings.blobHorizontalPosition = defaultDesign().blobHorizontalPosition; sendPosition(); break;
        case "reset-surface": {
          settings.surface = null; clearSurface();
          for (const fields of [sections.Surface, sections.Ambient, sections.Edges, sections.Shadow]) {
            fields.forEach(([name]) => {
              if (productionLegacyCSS[name] !== undefined) player.style.setProperty(name, productionLegacyCSS[name]); else player.style.removeProperty(name);
            });
          }
          rememberLegacy(); break;
        }
        case "reset-colors": settings.colors = validateColorTuning(defaultDesign().colors); sendColors(); break;
        case "load-design": restore(validateDesign(message.values)); break;
        default: return false;
      }
      persist(); return true;
    },
    legacyChanged() { rememberLegacy(); persist(); },
    stop() {
      audioSettings = defaultAudioColors();
      audioComparison = defaultAudioComparison();
      sendAudio();
      player.removeEventListener("visualizer:audio-colors-settings-request", sendAudio);
      player.removeEventListener("visualizer:audio-colors-state", receiveAudio);
      comparisonMode = defaultAccentComparison();
      sendComparison();
      player.removeEventListener("visualizer:accent-comparison-request", sendComparison);
      player.removeEventListener("visualizer:accent-comparison-state", receiveComparison);
      smartSettings = defaultSmartPalette();
      sendSmart();
      player.removeEventListener("visualizer:smart-palette-request", sendSmart);
      player.removeEventListener("visualizer:smart-palette-state", receiveSmart);
      hidePixiCanvas(false);
      isolateCssHighlights(false);
      player.removeEventListener("blob-diagnostics:state", diagnosticState);
      player.removeEventListener("visualizer:color-state", receiveColors);
      restore(defaultDesign());
      delete player.dataset.surfaceTuning;
    },
  };
}
