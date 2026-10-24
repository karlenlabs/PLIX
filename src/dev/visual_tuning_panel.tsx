import { BlobDiagnosticsControls } from "./blob_diagnostics_controls";
import { VisualDesignControls } from "./visual_design_controls";
import { hybridPaletteSettings } from "./hybrid_palette";
import { designStorageKey, validateDesign, validateSurface } from "./visual_design_model";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { cssVars, sections, retiredButtonVariables, storageKey, validatePreset, type PlayerSnapshot, type Preset } from "./visual_tuning_model";
import "./visual_tuning.css";

function VisualTuningPanel() {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [output, setOutput] = useState("");
  const lastSeen = useRef(0);
  const awaiting = useRef<string | null>(null);

  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    function receive(input: PlayerSnapshot) {
      try {
        const values = validatePreset(input.values), defaults = validatePreset(input.defaults);
        lastSeen.current = Date.now();
        setConnected(true);
        // Don't roll a moving slider back when an older acknowledgement arrives.
        const accepted = !awaiting.current || input.commandId === awaiting.current;
        if (accepted) {
          awaiting.current = null;
          setSnapshot({ values, defaults, theme: input.theme, commandId: input.commandId,
            design: input.design ? { ...input.design, settings: validateDesign(input.design.settings), surface: validateSurface(input.design.surface), defaults: validateSurface(input.design.defaults) } : undefined });
          setPending(false);
        }
      } catch { setMessage("Player sent an invalid preset."); }
    }
    function disconnected() { lastSeen.current = 0; awaiting.current = null; setPending(false); setConnected(false); }
    function request() { hot!.send("visual-tuning:command", { action: "request" }); }
    const releaseDiagnostics = () => hot.send("visual-tuning:command", { action: "blob-diagnostics-release" });
    window.addEventListener("pagehide", releaseDiagnostics);
    hot.on("visual-tuning:state", receive);
    hot.on("vite:ws:disconnect", disconnected);
    hot.on("vite:ws:connect", request);
    request();
    const timer = window.setInterval(() => {
      if (Date.now() - lastSeen.current > 3500) {
        setConnected(false);
        awaiting.current = null;
        setPending(false);
        request();
      }
    }, 1000);
    return () => {
      releaseDiagnostics();
      window.removeEventListener("pagehide", releaseDiagnostics);
      window.clearInterval(timer);
      hot.off("visual-tuning:state", receive);
      hot.off("vite:ws:disconnect", disconnected);
      hot.off("vite:ws:connect", request);
    };
  }, []);

  function apply(values: Preset) {
    const preset = validatePreset(values);
    const commandId = crypto.randomUUID();
    awaiting.current = commandId;
    setSnapshot(previous => previous ? { ...previous, values: preset } : previous);
    setPending(true);
    import.meta.hot?.send("visual-tuning:command", { action: "apply", values: preset, commandId });
  }
  function designCommand(action: string, values?: unknown) {
    const commandId = crypto.randomUUID();
    awaiting.current = commandId;
    setPending(true);
    setSnapshot(previous => {
      if (!previous?.design) return previous;
      if (action === "hybrid-palette") {
        const next = hybridPaletteSettings(values,previous.design.smartPalette?.settings ?? { enabled: false, strength: 50 });
        return { ...previous, design: { ...previous.design,
          smartPalette: { settings: next.smart, state: previous.design.smartPalette?.state ?? null },
          audioColors: { settings: next.audio, comparison: next.audioComparison, state: previous.design.audioColors?.state ?? null },
          accentComparison: { mode: next.accentComparison, state: previous.design.accentComparison?.state ?? null },
        } };
      }
      if (action === "audio-colors-comparison") return { ...previous, design: { ...previous.design, audioColors: { settings: previous.design.audioColors?.settings ?? { enabled: false, intensity: 35 }, comparison: values as import("./audio_color_diagnostics").AudioColorComparison, state: previous.design.audioColors?.state ?? null } } };
      if (action === "audio-driven-colors") return { ...previous, design: { ...previous.design, audioColors: { comparison: previous.design.audioColors?.comparison, settings: values as import("./audio_driven_colors").AudioColorSettings, state: previous.design.audioColors?.state ?? null } } };
      if (action === "accent-recovery-comparison") return { ...previous, design: { ...previous.design, accentComparison: { mode: values as import("./accent_color_comparison").AccentComparisonMode, state: previous.design.accentComparison?.state ?? null } } };
      if (action === "smart-palette") return { ...previous, design: { ...previous.design, smartPalette: { settings: values as import("./smart_palette").SmartPaletteSettings, state: previous.design.smartPalette?.state ?? null } } };
      if (action === "surface") return { ...previous, design: { ...previous.design, surface: validateSurface(values), settings: { ...previous.design.settings, surface: validateSurface(values) } } };
      if (action === "position") return { ...previous, design: { ...previous.design, settings: { ...previous.design.settings, blobHorizontalPosition: values as number } } };
      if (action === "colors") return { ...previous, design: { ...previous.design, settings: { ...previous.design.settings, colors: (values as typeof previous.design.settings.colors) } } };
      return previous;
    });
    import.meta.hot?.send("visual-tuning:command", { action, values, commandId });
  }
  async function copy(text: string) {
    setOutput(text);
    try { await navigator.clipboard.writeText(text); setMessage("Copied."); }
    catch { setMessage("Clipboard unavailable. Select and copy the text below."); }
  }
  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(validatePreset(snapshot!.values)));
      setMessage("Saved locally for dev. Use LOAD PRESET to apply it.");
    } catch (error) { setMessage(`Save failed: ${String(error)}`); }
  }
  function load() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) { setMessage("No saved dev preset."); return; }
      apply(validatePreset(JSON.parse(saved)));
      setMessage("Loaded dev preset.");
    } catch (error) { setMessage(`Load failed: ${String(error)}`); }
  }
  const ready = connected && snapshot !== null;
  const confirmed = ready && !pending;
  return <main className="visual-tuning-panel">
    <header><strong>Visual Tuning</strong><span>DEV ONLY</span></header>
    <button className="tuning-popout" onClick={() => {
      const popup = window.open(window.location.href, "ympleer-visual-tuning", "popup,width=320,height=820,resizable=yes,scrollbars=yes");
      if (!popup) setMessage("Allow popups for this local dev page, or use this tab.");
    }}>OPEN FLOATING WINDOW ↗</button>
    <div className="tuning-status" role="status">{connected ? `${snapshot?.theme ?? ""} · ${pending ? "Applying…" : "Live main player connected"}` : "Waiting for PLIX: npm run tauri dev"}</div>
    <div className="tuning-actions">
      <button disabled={!ready} onClick={() => {
        const commandId = crypto.randomUUID();
        awaiting.current = commandId;
        setPending(true);
        import.meta.hot?.send("visual-tuning:command", { action: "reset", commandId });
        setMessage("Reset to current production CSS.");
      }}>RESET</button>
      <button disabled={!confirmed} onClick={() => void copy(JSON.stringify(snapshot!.values, null, 2))}>COPY PRESET</button>
      <button disabled={!confirmed} onClick={() => void copy(`.player {\n${cssVars(snapshot!.values)}\n}`)}>COPY CSS VARS</button>
      <button disabled={!confirmed} onClick={save}>SAVE CSS PRESET</button>
      <button disabled={!ready} onClick={load}>LOAD CSS PRESET</button>
      <button disabled={!confirmed} onClick={() => void copy(JSON.stringify(snapshot!.values, null, 2))}>LOCK CURRENT</button>
    </div>
    <div className="tuning-message" role="status">{message || "DEV-оформление сохраняется в main player. Production defaults не меняются."}</div>
    <div className="tuning-actions">
      <button disabled={!confirmed || !snapshot?.design} onClick={() => {
        try { localStorage.setItem(designStorageKey, JSON.stringify(snapshot!.design!.settings)); setMessage("DEV-оформление и цвета сохранены в браузере. Main player также сохраняет изменения автоматически."); }
        catch (error) { setMessage(String(error)); }
      }}>SAVE DEV DESIGN</button>
      <button disabled={!ready} onClick={() => {
        try { const text = localStorage.getItem(designStorageKey); if (!text) throw new Error("Нет сохранённого DEV-оформления"); designCommand("load-design", validateDesign(JSON.parse(text))); }
        catch (error) { setMessage(String(error)); }
      }}>LOAD DEV DESIGN</button>
      <button disabled={!confirmed || !snapshot?.design} onClick={() => void copy(JSON.stringify(snapshot!.design, null, 2))}>COPY DIAGNOSTICS</button>
    </div>
    <label className="tuning-toggle"><span>Изолировать CSS-подсветки</span>
      <input type="checkbox" aria-label="Изолировать CSS-подсветки" checked={snapshot?.design?.cssHighlightsIsolated ?? false}
        disabled={!ready || !snapshot?.design}
        onChange={event => designCommand("css-highlights-isolation", event.currentTarget.checked)} />
    </label>
    <label className="tuning-toggle"><span>Скрыть PixiJS canvas</span>
      <input type="checkbox" aria-label="Скрыть PixiJS canvas" checked={snapshot?.design?.pixiCanvasHidden ?? false}
        disabled={!ready || !snapshot?.design}
        onChange={event => designCommand("hide-pixi-canvas", event.currentTarget.checked)} />
    </label>
    <BlobDiagnosticsControls snapshot={snapshot?.design?.blobDiagnostics} ready={ready} command={designCommand} />
    {snapshot?.design && <VisualDesignControls snapshot={snapshot.design} ready={ready} command={designCommand} />}
    <details><summary>Прежние CSS-параметры · дополнительно</summary><p className="tuning-help">DEV-оформление выше имеет приоритет. RESET SURFACE возвращает исходные слои текущей темы.</p>
    {Object.entries(sections).map(([section, fields]) => <fieldset key={section} disabled={!ready}>
      <legend>{section}</legend>
      {fields.filter(([name]) => !retiredButtonVariables.has(name)).map(([name, label, min, max, step, unit]) => <label className="tuning-field" key={name}>
        <span>{label}<output>{snapshot ? `${snapshot.values[name]}${unit}` : "—"}</output></span>
        <input type="range" min={min} max={max} step={step} value={snapshot?.values[name] ?? min}
          aria-label={label} title={`${name} · ${min}…${max}${unit}`}
          onChange={event => apply({ ...snapshot!.values, [name]: Number(event.currentTarget.value) })} />
      </label>)}
    </fieldset>)}
    </details>
    {output && <label className="tuning-export">Export snapshot<textarea readOnly value={output} aria-label="Exported snapshot" onFocus={event => event.currentTarget.select()} /></label>}
  </main>;
}

// Both the entry and rendering are gated, so the panel and its CSS are absent from dist.
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<VisualTuningPanel />);
