import { useEffect, useRef, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./appearance.css";
import { fitAppearanceHeight } from "./appearance_height";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { VisualPreset } from "./visualizer/controller";
import { installAppearanceLifecycle, type FlushRequest } from "./appearance_lifecycle";

type Settings = { theme: "system" | "dark" | "light"; alwaysOnTop: boolean; visualization: VisualPreset; visualEffectsEnabled: boolean; ambientHazeEnabled: boolean; ambientHazeIntensity: number; hybridPaletteEnabled: boolean };
type SettingsPatch = Partial<Settings>;
type AppearanceSnapshot = { settings: Settings; revision: number; saveError: string | null };
const defaults: Settings = { theme: "system", alwaysOnTop: true, visualization: "Karlen Dense", visualEffectsEnabled: true, ambientHazeEnabled: false, ambientHazeIntensity: 35, hybridPaletteEnabled: true };

export function startWindowDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest('button, input, select, option, label, [data-no-drag="true"]')) return;
  void getCurrentWindow().startDragging().catch(cause => console.error("Failed to drag window", cause));
}

export function useAppearance() {
  const [snapshot, setSnapshot] = useState<AppearanceSnapshot>({ settings: defaults, revision: -1, saveError: null });
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    let revision = -1;
    let unlisten: UnlistenFn | undefined;
    function accept(value: AppearanceSnapshot) {
      if (!active || value.revision < revision) return;
      revision = value.revision;
      setSnapshot(value);
      setReady(true);
    }
    async function initialize() {
      try {
        const stop = await listen<AppearanceSnapshot>("appearance-changed", event => accept(event.payload));
        if (!active) { stop(); return; }
        unlisten = stop;
        accept(await invoke<AppearanceSnapshot>("get_appearance"));
      } catch (cause) {
        console.error("Failed to load appearance", cause);
        if (active) setLoadError("Не удалось загрузить настройки. Перезапустите PLIX.");
      }
    }
    void initialize();
    return () => { active = false; unlisten?.(); };
  }, []);

  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      document.documentElement.dataset.theme = snapshot.settings.theme === "system"
        ? (system.matches ? "dark" : "light") : snapshot.settings.theme;
    }
    applyTheme();
    system.addEventListener("change", applyTheme);
    return () => system.removeEventListener("change", applyTheme);
  }, [snapshot.settings.theme]);

  return { snapshot, ready, loadError };
}

export function AppearanceWindow() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".appearance");
    if (root) return fitAppearanceHeight(root);
  }, []);
  const { snapshot, ready, loadError } = useAppearance();
  const [draft, setDraft] = useState(defaults);
  const [topmost, setTopmost] = useState(defaults.alwaysOnTop);
  const confirmedTopmost = useRef(defaults.alwaysOnTop);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<SettingsPatch | null>(null);
  const inFlight = useRef<SettingsPatch | null>(null);
  const writing = useRef(false);
  const draining = useRef<Promise<void> | null>(null);
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    // Rebase untouched fields on native/menu changes while keeping local intent.
    setDraft({ ...snapshot.settings, ...inFlight.current, ...pending.current });
  }, [snapshot.settings]);

  useEffect(() => {
    confirmedTopmost.current = snapshot.settings.alwaysOnTop;
    setTopmost(snapshot.settings.alwaysOnTop);
  }, [snapshot.settings.alwaysOnTop]);

  function drain(): Promise<void> {
    if (draining.current) return draining.current;
    writing.current = true;
    setSaving(true);
    draining.current = (async () => {
      while (pending.current) {
        const settings = pending.current;
        pending.current = null;
        inFlight.current = settings;
        try {
          await invoke("set_appearance", { settings });
          setError("");
        } catch (cause) {
          // Retain the latest unsaved draft; retry only on an edit or close/quit.
          // Keep every failed field, with newer queued edits taking precedence.
          // Topmost is reconciled, never blindly replayed after a native/disk error.
          const { alwaysOnTop, ...retry } = settings;
          pending.current = { ...retry, ...(pending.current as SettingsPatch | null) };
          if (alwaysOnTop !== undefined) {
            let actual = confirmedTopmost.current;
            try {
              actual = (await invoke<AppearanceSnapshot>("get_appearance")).settings.alwaysOnTop;
            } catch (readError) {
              console.error("Failed to reconcile always on top", readError);
            }
            confirmedTopmost.current = actual;
            setTopmost(actual);
            setDraft(previous => ({ ...previous, alwaysOnTop: pending.current?.alwaysOnTop ?? actual }));
          }
          console.error("Failed to save appearance", cause);
          setError("Не удалось сохранить настройки. Измените значение для повторной попытки.");
          throw cause;
        }
      }
    })().finally(() => { inFlight.current = null; writing.current = false; draining.current = null; setSaving(false); });
    return draining.current;
  }

  async function flushPending() {
    // Also cover a newer draft queued while a completed write is clearing its promise.
    do { await drain(); } while (pending.current || writing.current);
  }

  function update(patch: SettingsPatch) {
    if (closingRef.current) return;
    setDraft(previous => ({ ...previous, ...patch }));
    pending.current = { ...pending.current, ...patch };
    void drain().catch(() => {});
  }

  function close() {
    void getCurrentWindow().close().catch(cause => {
      console.error("Failed to close Appearance", cause);
      setError("Не удалось закрыть окно.");
    });
  }

  useEffect(() => {
    const stop = installAppearanceLifecycle({
      subscribe: receive => listen<FlushRequest>("lifecycle-flush-appearance", event => receive(event.payload)),
      pending: () => invoke<FlushRequest | null>("get_lifecycle_request"),
      flush: flushPending,
      acknowledge: (id, error) => invoke("finish_lifecycle", { id, error }),
      closing: value => { closingRef.current = value; setClosing(value); },
      error: cause => {
        console.error("Failed to flush Appearance before closing", cause);
        setError("Не удалось сохранить настройки перед закрытием. Повторите попытку.");
      },
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.repeat) { event.preventDefault(); close(); }
    };
    document.addEventListener("keydown", escape);
    return () => { stop(); document.removeEventListener("keydown", escape); };
  }, []);

  const message = loadError || error || (snapshot.saveError ? "Настройки не сохранены: проверьте доступ к файлу." : "");
  return (
    <main className="appearance" aria-label="Внешний вид" onMouseDown={startWindowDrag}>
      <header className="appearance-header">
        <h1>Внешний вид</h1>
        <button className="close-button" aria-label="Закрыть настройки" title="Закрыть"
          onClick={close}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <fieldset className="theme-field" disabled={!ready || closing}>
        <legend>Тема оформления</legend>
        <div className="theme-options">
          {(["system", "dark", "light"] as const).map(theme => (
            <label key={theme}>
              <input type="radio" name="theme" value={theme} checked={draft.theme === theme}
                onChange={() => update({ theme })} />
              <span>{{ system: "Система", dark: "Тёмная", light: "Светлая" }[theme]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="always-on-top-field">
        <span className="appearance-copy"><strong>Поверх всех окон</strong><span>Закрепить плеер поверх приложений</span></span>
        <input type="checkbox" role="switch" aria-label="Поверх всех окон" checked={topmost} disabled={!ready || closing || saving}
          onChange={event => update({ alwaysOnTop: event.currentTarget.checked })} />
      </label>
      <label className="effects-field">
        <span className="appearance-copy"><strong>Визуальные эффекты</strong><span>Анимация и декоративные подсветки</span></span>
        <input type="checkbox" role="switch" aria-label="Визуальные эффекты"
          checked={draft.visualEffectsEnabled} disabled={!ready || closing}
          onChange={event => update({ visualEffectsEnabled: event.currentTarget.checked })} />
      </label>
      <label className="visualization-field">
        <span>Стиль визуализации</span>
        <select aria-label="Стиль визуализации" value={draft.visualization} disabled={!ready || closing || !draft.visualEffectsEnabled}
          onChange={event => update({ visualization: event.currentTarget.value as VisualPreset })}>
          <option value="Karlen Baseline">Flow</option>
          <option value="Karlen Dense">Pulse</option>
          <option value="Karlen 3">Flux</option>
        </select>
      </label>
      <label className="hybrid-palette-field">
        <span className="appearance-copy"><strong>Hybrid Palette</strong><span>Цвета адаптируются к обложке и музыке.</span></span>
        <input type="checkbox" role="switch" aria-label="Hybrid Palette"
          checked={draft.hybridPaletteEnabled} disabled={!ready || closing}
          onChange={event => update({ hybridPaletteEnabled: event.currentTarget.checked })} />
      </label>
      <label className="ambient-haze-field">
        <span className="appearance-copy"><strong>Ambient Haze</strong><span>Цветная дымка из палитры обложки</span></span>
        <input type="checkbox" role="switch" aria-label="Ambient Haze"
          checked={draft.ambientHazeEnabled} disabled={!ready || closing || !draft.visualEffectsEnabled}
          onChange={event => update({ ambientHazeEnabled: event.currentTarget.checked })} />
      </label>
      <div className="appearance-message" role="status" title={snapshot.saveError || message}>{message}</div>
    </main>
  );
}

