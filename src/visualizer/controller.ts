import type { BlobColors } from "./colors";
import presets from "./presets.json" with { type: "json" };

export type VisualPreset = "Off" | keyof typeof presets;
export type Options = (typeof presets)[keyof typeof presets];
export type AudioFrame = {
  status: string; fresh: boolean; low: number; mid: number; high: number;
  bands16: number[]; pid: number;
};
export type Renderer = {
  setPreset(options: Options): void;
  setColors(colors: BlobColors, duration: number): void;
  getColors(): BlobColors;
  setHybridPalette?(enabled: boolean): void;
  setHorizontalPosition(position: number): void;
  audio(frame: AudioFrame & { received: number }): void;
  destroy(): void;
};
type Dependencies = {
  create(host: HTMLElement, options: Options, failed: (error: unknown) => void): Promise<Renderer>;
  active(enabled: boolean): Promise<unknown>;
  read(): Promise<AudioFrame>;
  schedule(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
  failed(error: unknown): void;
};

// One owner, renderer, poll and ordered backend activation lane for the main window.
// Preset edits only replace renderer options; Off invalidates pending async work.
export function createVisualizerController(host: HTMLElement, dependencies: Dependencies) {
  let selected: VisualPreset = "Off", renderer: Renderer | undefined;
  let colorTarget: { colors: BlobColors; duration: number } | undefined;
  let horizontalPosition = 0;
  let hybridPalette = false;
  let creation = Promise.resolve();
  let starting = false, disposed = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lane = Promise.resolve<unknown>(undefined);
  const activate = (enabled: boolean) => {
    lane = lane.catch(() => {}).then(() => dependencies.active(enabled));
    return lane;
  };
  function stop() {
    generation++;
    starting = false;
    if (timer !== undefined) dependencies.cancel(timer);
    timer = undefined;
    try { renderer?.destroy(); } catch (error) { dependencies.failed(error); }
    renderer = undefined;
    void activate(false).catch(dependencies.failed);
  }
  function fail(error: unknown) {
    stop();
    dependencies.failed(error);
  }
  async function poll(token: number) {
    if (token !== generation || disposed || !renderer) return;
    try {
      const frame = await dependencies.read();
      if (token !== generation || disposed || !renderer) return;
      if (["CAPTURE_ERROR", "COM_ERROR", "WORKER_ERROR", "ACTIVATION_TIMEOUT"].includes(frame.status)) {
        fail(new Error("Visualizer: " + frame.status));
        return;
      }
      renderer.audio({ ...frame, status: frame.fresh ? "LIVE" : frame.status, received: Date.now() });
      timer = dependencies.schedule(() => { timer = undefined; void poll(token); }, 40);
    } catch (error) { if (token === generation && !disposed) fail(error); }
  }
  async function start(token: number) {
    let created: Renderer | undefined;
    const prior = creation;
    let release!: () => void;
    creation = new Promise<void>(resolve => { release = resolve; });
    try {
      await prior;
      if (token !== generation || disposed) return;
      const initial = selected as keyof typeof presets;
      created = await dependencies.create(host, presets[initial], error => {
        // Defer failure disposal until the ticker callback has returned.
        queueMicrotask(() => { if (token === generation && !disposed) fail(error); });
      });
      if (token !== generation || disposed || selected === "Off") { created.destroy(); return; }
      renderer = created;
      renderer.setHybridPalette?.(hybridPalette);
      renderer.setHorizontalPosition(horizontalPosition);
      if (colorTarget) renderer.setColors(colorTarget.colors, colorTarget.duration);
      renderer.setPreset(presets[selected]);
      await activate(true);
      if (token !== generation || disposed) return;
      starting = false;
      void poll(token);
    } catch (error) {
      if (token === generation && !disposed) fail(error);
      else created?.destroy();
    } finally { release(); }
  }
  return {
    setPreset(preset: VisualPreset) {
      if (disposed) return;
      selected = preset;
      if (preset === "Off") { stop(); return; }
      if (renderer) { try { renderer.setPreset(presets[preset]); } catch (error) { fail(error); } return; }
      if (!starting) { starting = true; void start(++generation); }
    },
    setColors(colors: BlobColors, duration: number) {
      colorTarget = { colors, duration };
      try { renderer?.setColors(colors, duration); } catch (error) { fail(error); }
    },
    setHorizontalPosition(position: number) {
      if (disposed) return;
      horizontalPosition = Number.isFinite(position) ? Math.max(-1, Math.min(1, position)) : 0;
      try { renderer?.setHorizontalPosition(horizontalPosition); } catch (error) { fail(error); }
    },
    setHybridPalette(enabled: boolean) {
      hybridPalette = enabled;
      renderer?.setHybridPalette?.(enabled);
    },
    getColors() { return renderer?.getColors() ?? colorTarget?.colors; },
    dispose() { if (!disposed) { disposed = true; stop(); } },
  };
}
