import { defaultAudioColors } from "./audio_driven_colors";
import { defaultAudioComparison } from "./audio_color_diagnostics";
import { defaultAccentComparison } from "./accent_color_comparison";
import { defaultSmartPalette } from "./smart_palette";
import { hybridPaletteState } from "./hybrid_palette";
import type { DesignSnapshot } from "./visual_design_model";

type Props = { snapshot: Pick<DesignSnapshot, "smartPalette" | "audioColors" | "accentComparison">;
  ready: boolean; command(action: string, values?: unknown): void };
export function HybridPaletteControls({ snapshot, ready, command }: Props) {
  const smart = snapshot.smartPalette?.settings ?? defaultSmartPalette();
  const audio = snapshot.audioColors?.settings ?? defaultAudioColors();
  const state = hybridPaletteState(smart,audio,snapshot.audioColors?.comparison ?? defaultAudioComparison(),
    snapshot.accentComparison?.mode ?? defaultAccentComparison());
  return <fieldset disabled={!ready}>
    <legend>HYBRID PALETTE · DEV</legend>
    <label className="tuning-toggle"><span>Hybrid Palette {state.enabled ? "ON" : "OFF"}</span>
      <input type="checkbox" aria-label="Hybrid Palette" checked={state.enabled}
        onChange={e => command("hybrid-palette",e.currentTarget.checked)} />
    </label>
    <p className="tuning-help">ON: Smart Palette + Accent Recovery Contrast → Audio-driven Colors 100% с реальным FFT.
      Сила Smart Palette сохраняется: {smart.strength}%. OFF возвращает обычную палитру.</p>
    <p className="tuning-help" aria-label="Hybrid Palette · состояние">{state.separate ?
      "Раздельная диагностика: параметры этапов изменены вручную. Hybrid OFF отключит оба этапа и тестовый сигнал." :
      state.combined ? "Оба этапа активны: Contrast + Audio-driven Colors 100%." : "Обычная палитра: оба этапа отключены."}</p>
    <p className="tuning-help">Только DEV, без сохранения. Закрытие панели отключает эксперимент.</p>
  </fieldset>;
}
