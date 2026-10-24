import { productionLegacyCSS } from "../design/runtime";
import { connectVisualDesign } from "./visual_design_player";
import { parameters, validatePreset, type Preset, type PlayerSnapshot } from "./visual_tuning_model";

export function connectVisualTuning(player: HTMLElement): () => void {
  const hot = import.meta.hot;
  if (!hot) return () => {};

  let commandId: string | null = null;
  const design = connectVisualDesign(player);

  function read(): Preset {
    const style = getComputedStyle(player);
    return validatePreset(Object.fromEntries(parameters.map(([name]) => [name, parseFloat(style.getPropertyValue(name))])));
  }
  // Read the themed production declarations without a second defaults table.
  function defaults(): Preset {
    const overrides = parameters.map(([name]) => [name, player.style.getPropertyValue(name)] as const);
    overrides.forEach(([name]) => player.style.removeProperty(name));
    Object.entries(productionLegacyCSS).forEach(([name,value]) => player.style.setProperty(name,value));
    try { return read(); }
    finally { parameters.forEach(([name]) => player.style.removeProperty(name)); overrides.forEach(([name, value]) => { if (value) player.style.setProperty(name, value); }); }
  }
  function publish() {
    const snapshot: PlayerSnapshot = { values: read(), defaults: defaults(), theme: document.documentElement.dataset.theme ?? "dark", commandId, design: design.snapshot() };
    hot!.send("visual-tuning:state", snapshot);
  }
  function receive(command: unknown) {
    if (!command || typeof command !== "object") return;
    const message = command as { action?: unknown; values?: unknown; commandId?: unknown };
    try {
      if (design.receive(message)) { /* isolated surface/color command */ }
      else if (message.action === "reset") {
        parameters.forEach(([name]) => player.style.removeProperty(name));
        Object.entries(productionLegacyCSS).forEach(([name,value]) => player.style.setProperty(name,value));
        design.legacyChanged();
      }
      else if (message.action === "apply") {
        const values = validatePreset(message.values);
        parameters.forEach(([name, , , , , unit]) => player.style.setProperty(name, `${values[name]}${unit}`));
        design.legacyChanged();
      } else if (message.action !== "request") return;
      if (typeof message.commandId === "string") commandId = message.commandId;
      publish();
    } catch (error) { console.error("Visual tuning rejected preset", error); }
  }
  const disconnectSmartPalette = () => {
    design.receive({ action: "hybrid-palette", values: false });
    design.receive({ action: "audio-colors-comparison", values: "live" });
    design.receive({ action: "audio-driven-colors", values: { enabled: false, intensity: 35 } });
    design.receive({ action: "accent-recovery-comparison", values: "contrast" });
    design.receive({ action: "smart-palette", values: { enabled: false, strength: 50 } });
  };
  hot.on("vite:ws:disconnect", disconnectSmartPalette);
  hot.on("visual-tuning:command", receive);
  hot.on("vite:ws:connect", publish);
  // Heartbeat covers theme changes, reconnects and a newly opened panel.
  const timer = window.setInterval(publish, 1000);
  publish();
  const stop = () => {
    window.clearInterval(timer);
    hot.off("vite:ws:disconnect", disconnectSmartPalette);
    hot.off("visual-tuning:command", receive);
    hot.off("vite:ws:connect", publish);
    parameters.forEach(([name]) => player.style.removeProperty(name));
    design.stop();
  };
  hot.dispose(stop);
  return stop;
}
