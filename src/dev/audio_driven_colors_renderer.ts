import { createAudioColors, defaultAudioColors, validateAudioColors } from "./audio_driven_colors.ts";
import { AUDIO_COLOR_TEST_SIGNAL, audioColorBands, defaultAudioComparison, diagnoseAudioColors, validateAudioComparison, type FFTColorSource, type AudioColorComparison } from "./audio_color_diagnostics.ts";

// The renderer supplies its existing fresh FFT bands and dt; this adapter never polls audio.
export function attachAudioDrivenColors(player: HTMLElement) {
  const colors = createAudioColors();
  let settings = defaultAudioColors(), comparison = defaultAudioComparison();
  let rendered: { fft: FFTColorSource; comparison: AudioColorComparison; applied: { enabled: boolean; intensity: number } } | null = null;
  const applied = () => comparison === "test-on" ? { enabled: true, intensity: 100 } :
    comparison === "test-off" ? { enabled: false, intensity: 100 } : settings;
  const receive = (event: Event) => {
    try { settings = validateAudioColors((event as CustomEvent).detail); colors.configure(applied()); }
    catch (error) { console.warn("Invalid DEV audio-driven colors", error); }
  };
  const receiveComparison = (event: Event) => {
    try {
      const next = validateAudioComparison((event as CustomEvent).detail);
      if (next === comparison) return;
      // Each comparison starts with the same zero envelope. Ordinary slider values are retained.
      colors.configure(defaultAudioColors());
      comparison = next;
      colors.configure(applied());
    } catch (error) { console.warn("Invalid DEV audio color comparison", error); }
  };
  const publish = () => {
    const state = colors.snapshot().state;
    player.dispatchEvent(new CustomEvent("visualizer:audio-colors-state", {
      detail: state && rendered ? { ...state, diagnostics: diagnoseAudioColors(state,rendered.fft,rendered.comparison,rendered.applied) } : null,
    }));
  };
  player.addEventListener("visualizer:audio-colors-settings", receive);
  player.addEventListener("visualizer:audio-colors-comparison", receiveComparison);
  player.addEventListener("visualizer:audio-colors-request", publish);
  // Works regardless of initialization order of the renderer and DEV bridge.
  player.dispatchEvent(new CustomEvent("visualizer:audio-colors-settings-request"));
  return {
    enabled: () => applied().enabled && applied().intensity > 0,
    step(base: number[], bands: number[], seconds: number, source?: FFTColorSource) {
      rendered = { fft: source ?? { raw: audioColorBands(bands), fresh: true, status: "LIVE" }, comparison, applied: { ...applied() } };
      return colors.step(base, comparison === "live" ? bands : [...AUDIO_COLOR_TEST_SIGNAL], seconds);
    },
    retarget: colors.retarget, current: colors.current,
    stop() {
      player.removeEventListener("visualizer:audio-colors-settings", receive);
      player.removeEventListener("visualizer:audio-colors-comparison", receiveComparison);
      player.removeEventListener("visualizer:audio-colors-request", publish);
      colors.configure(defaultAudioColors());
      publish(); // Clear cached live telemetry when the visualizer is stopped.
    },
  };
}
