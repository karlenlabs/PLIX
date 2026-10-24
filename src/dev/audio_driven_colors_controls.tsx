import { defaultAudioColors } from "./audio_driven_colors";
import { defaultAudioComparison, type DiagnosticAudioColorSnapshot } from "./audio_color_diagnostics";

type Props = { snapshot?: DiagnosticAudioColorSnapshot; ready: boolean; command(action: string, values?: unknown): void };
export function AudioDrivenColorsControls({ snapshot, ready, command }: Props) {
  const settings = snapshot?.settings ?? defaultAudioColors(), state = snapshot?.state;
  const comparison = snapshot?.comparison ?? defaultAudioComparison(), diagnostic = state?.diagnostics;
  const change = (values: Partial<typeof settings>) => command("audio-driven-colors", { ...settings, ...values });
  const bands = (v: { bass: number; mid: number; treble: number }) =>
    `bass ${v.bass.toFixed(4)} · mid ${v.mid.toFixed(4)} · treble ${v.treble.toFixed(4)}`;
  return <fieldset disabled={!ready}>
    <legend>Hybrid Palette · этап 2 · Audio-driven Colors · DEV</legend>
    <label className="tuning-toggle"><span>Audio-driven Colors ON/OFF</span>
      <input type="checkbox" aria-label="Audio-driven Colors" checked={settings.enabled} disabled={comparison !== "live"} onChange={e => change({ enabled: e.currentTarget.checked })} />
    </label>
    <label className="tuning-field"><span>Интенсивность цветовой реакции<output>{settings.intensity}%</output></span>
      <input type="range" aria-label="Интенсивность Audio-driven Colors" min={0} max={100} step={1} value={settings.intensity} disabled={comparison !== "live"}
        onChange={e => change({ intensity: Number(e.currentTarget.value) })} />
    </label>
    <label className="tuning-select">Временное сравнение источника<select aria-label="Audio Colors · сравнение" value={comparison}
      onChange={e => command("audio-colors-comparison", e.currentTarget.value)}>
      <option value="live">Live FFT · обычные настройки</option>
      <option value="test-off">Audio Colors OFF · тест 1 / 1 / 1</option>
      <option value="test-on">Audio Colors ON · тест 1 / 1 / 1 · 100%</option>
    </select></label>
    <p className="tuning-help">Тест заменяет только вход цветового этапа постоянным bass/mid/treble = 1. Используются прежние attack/release, алгоритм и renderer. Геометрия продолжает получать реальный FFT. Это не измерение музыки. Live FFT возвращает обычные настройки.</p>
    <p className="tuning-help">Базовые цвета: текущая Smart Palette + Accent Recovery Contrast. Бас — насыщенность; mid — акценты; treble — короткий мягкий подъём светлоты. Оттенки сохраняются.</p>
    <div aria-label="Audio-driven Colors · live">{state ? <>
      <p aria-label="Audio Colors · FFT до обработки">FFT до цветовой обработки: {bands(diagnostic?.fft.raw ?? state.input)}.
        {diagnostic && <> Статус: {diagnostic.fft.status}; свежий: {diagnostic.fft.fresh ? "да" : "нет"}.</>}
        Это нормализованные low/mid/high существующего FFT, не PCM.</p>
      <p aria-label="Audio Colors · вход алгоритма">Вход цветового алгоритма: {bands(state.input)}.
        Источник: {diagnostic?.source === "fixed-test" ? "фиксированный тест" : "FFT"}.
        {diagnostic && <> Применено: {diagnostic.applied.enabled ? "ON" : "OFF"} / {diagnostic.applied.intensity}%.</>}</p>
      <p aria-label="Audio Colors · после сглаживания">После attack/release: {bands(state.envelope)}.</p>
      <p>Фактическая реакция · max ΔRGB: {state.reaction.toFixed(2)}% · {state.active ? "активна" : "базовая палитра"}</p>
      {state.base.map((c,i) => {
        const blob = diagnostic?.blobs[i];
        return <p key={i} aria-label={'Audio Colors · Blob ' + (i + 1)}>Blob {i + 1}: {c} → {state.final[i]}.
          {blob ? <> ΔE76: {blob.deltaE76.toFixed(3)}; max ΔRGB: {blob.maxDeltaRGB.toFixed(2)}%;
            ΔS: {blob.deltaS.toFixed(2)} п.п.; ΔL: {blob.deltaL.toFixed(2)} п.п.</> : " Ожидание численной диагностики renderer."}</p>;
      })}
    </> : "Ожидание renderer / аудиоданных"}</div>
    {state && <div className="tuning-swatches" aria-label="Audio-driven Colors · итог renderer">{state.final.map((c, i) => <span key={i} style={{ backgroundColor: c }} title={'Blob ' + (i + 1) + ': ' + state.base[i] + ' → ' + c}>{c}</span>)}</div>}
    <p className="tuning-help">ΔE76 — CIELAB D65, сравнение заливок до alpha, blur и наложения слоёв. Это не измерение готовых пикселей. Live snapshot обновляется существующим heartbeat примерно раз в секунду и может пропускать короткие всплески.</p>
    <p className="tuning-help">Только DEV; настройки и сравнение не сохраняются. Закрытие панели отключает эксперимент.</p>
  </fieldset>;
}
