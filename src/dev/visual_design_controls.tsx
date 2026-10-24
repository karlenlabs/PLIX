import { HybridPaletteControls } from "./hybrid_palette_controls";
import { AudioDrivenColorsControls } from "./audio_driven_colors_controls";
import { SmartPaletteControls } from "./smart_palette_controls";
import type { ColorTuning } from "../visualizer/colors";
import type { DesignSnapshot, SurfaceTuning } from "./visual_design_model";

type Props = { snapshot: DesignSnapshot; ready: boolean; command(action: string, values?: unknown): void };
export function VisualDesignControls({ snapshot, ready, command }: Props) {
  const surface = snapshot.surface, color = snapshot.settings.colors;
  const changeSurface = (key: keyof SurfaceTuning, value: boolean | string | number) => command("surface", { ...surface, [key]: value });
  const changeColor = (key: keyof ColorTuning, value: unknown) => command("colors", { ...color, [key]: value });
  const toggle = (key: keyof SurfaceTuning, label: string) => <label className="tuning-toggle"><span>{label}</span>
    <input type="checkbox" checked={surface[key] as boolean} onChange={e => changeSurface(key, e.currentTarget.checked)} /></label>;
  const surfaceRange = (key: keyof SurfaceTuning, label: string, maximum = 1, step = .01) => <label className="tuning-field">
    <span>{label}<output>{maximum === 1 ? `${Math.round((surface[key] as number) * 100)}%` : `${surface[key]}px`}</output></span>
    <input type="range" aria-label={label} min={maximum === 1 ? 0 : 1} max={maximum} step={step} value={surface[key] as number}
      onChange={e => changeSurface(key, Number(e.currentTarget.value))} /></label>;
  const surfaceColor = (key: "borderColor" | "baseColor", label: string) => <label className="tuning-color"><span>{label}</span>
    <input type="color" aria-label={label} value={surface[key]} onChange={e => changeSurface(key, e.currentTarget.value)} /></label>;
  const colorRange = (key: "saturation" | "brightness" | "artworkInfluence" | "transitionMs" | "blobColorContrast", label: string, min: number, max: number, step: number) => <label className="tuning-field">
    <span>{label}<output>{key === "transitionMs" ? `${color[key]} мс` : `${Math.round(color[key] * 100)}%`}</output></span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={color[key]} onChange={e => changeColor(key, Number(e.currentTarget.value))} /></label>;
  return <>
    <fieldset disabled={!ready}>
      <legend>ОФОРМЛЕНИЕ ПЛЕЕРА</legend>
      {toggle("borderEnabled", "Обводка")}
      {surfaceRange("borderWidth", "Толщина обводки", 4, 1)}
      {surfaceColor("borderColor", "Цвет обводки")}
      {surfaceRange("borderOpacity", "Непрозрачность обводки")}
      {toggle("topEnabled", "Верхняя подсветка")}
      {surfaceRange("topIntensity", "Интенсивность верхней подсветки")}
      {toggle("topLineEnabled", "Тонкая верхняя линия")}
      {toggle("topSoftEnabled", "Мягкая верхняя подсветка")}
      {toggle("veilEnabled", "Светлая вуаль · диагональный градиент")}
      {surfaceRange("veilIntensity", "Интенсивность вуали")}
      {toggle("shadowEnabled", "Внешняя тень")}
      {surfaceRange("shadowIntensity", "Интенсивность тени")}
      {toggle("edgeEnabled", "Edge glow")}
      {surfaceRange("edgeIntensity", "Интенсивность Edge glow")}
      {toggle("ambientEnabled", "Размытый ambient · ::before")}
      {surfaceRange("ambientIntensity", "Интенсивность ::before")}
      {toggle("washEnabled", "Цветной overlay · ::after")}
      {surfaceRange("washIntensity", "Интенсивность ::after")}
      {toggle("bottomShadeEnabled", "Нижняя тёмная линия")}
      {surfaceColor("baseColor", "Основная подложка")}
      {surfaceRange("baseOpacity", "Визуальная непрозрачность подложки")}
      <p className="tuning-help">Под фоновым слоем остаётся непрозрачная основа. Текст, controls и системная прозрачность не фильтруются.</p>
      <button type="button" className="tuning-reset" onClick={() => command("reset-surface")}>RESET SURFACE</button>
    </fieldset>
    <fieldset disabled={!ready}>
      <legend>ЦВЕТА ВИЗУАЛИЗАЦИИ</legend>
      <label className="tuning-select">Режим палитры<select aria-label="Режим палитры" value={color.mode} onChange={e => changeColor("mode", e.currentTarget.value)}>
        <option value="artwork">Цвета обложки</option><option value="artwork-accent">Обложка + акцент Play/Pause</option><option value="manual">Ручные цвета</option>
      </select></label>
      {color.manual.map((value, i) => <label key={i} className="tuning-color"><span>Цвет Blob {i + 1}</span>
        <input type="color" aria-label={`Цвет Blob ${i + 1}`} disabled={color.mode !== "manual"} value={color.mode === "manual" ? value : snapshot.colors?.target[i] ?? value}
          onChange={e => changeColor("manual", color.manual.map((c, index) => index === i ? e.currentTarget.value : c))} />
      </label>)}
      {colorRange("saturation", "Насыщенность", 0, 2, .01)}
      {colorRange("brightness", "Яркость", .2, 1.5, .01)}
      {colorRange("artworkInfluence", "Сила влияния обложки", 0, 1, .01)}
      <label className="tuning-select">Алгоритм разделения цветов<select aria-label="Алгоритм разделения цветов" value={color.blobColorAlgorithm} onChange={e => changeColor("blobColorAlgorithm", e.currentTarget.value)}>
        <option value="current">Текущий</option><option value="adaptive">Адаптивный (экспериментальный)</option>
      </select></label>
      {colorRange("blobColorContrast", "Контраст между блобами", 0, 1, .01)}
      {colorRange("transitionMs", "Длительность перехода", 100, 3000, 50)}
      <p className="tuning-help">Итоговые цвета после коррекции</p>
      <div className="tuning-swatches" aria-label="Итоговые цвета">{snapshot.colors?.target.map((c, i) => <span key={i} style={{ backgroundColor: c }}>{c}</span>)}</div>
      <div className="tuning-swatches" aria-label="Текущие цвета renderer">{snapshot.colors?.current.map((c, i) => <span key={i} title={`Blob ${i + 1}: ${c}`} style={{ backgroundColor: c }}>{c}</span>)}</div>
      <p className="tuning-help">В автоматических режимах color inputs показывают выбранные целевые цвета; swatches — текущие цвета плавного перехода.</p>
      <button type="button" className="tuning-reset" onClick={() => command("reset-colors")}>RESET COLORS</button>
    </fieldset>
    <HybridPaletteControls snapshot={snapshot} ready={ready} command={command} />
    <details className="tuning-diagnostics"><summary>Раздельная диагностика · Smart Palette / Audio-driven Colors</summary>
    <SmartPaletteControls comparison={snapshot.accentComparison} snapshot={snapshot.smartPalette} colors={snapshot.colors} blobDiagnostics={snapshot.blobDiagnostics} audioColors={snapshot.audioColors} ready={ready} command={command} />
    <AudioDrivenColorsControls snapshot={snapshot.audioColors} ready={ready} command={command} />
    </details>
    <fieldset disabled={!ready}>
      <legend>КОМПОЗИЦИЯ ВИЗУАЛИЗАЦИИ</legend>
      <label className="tuning-field"><span>Горизонтальное положение blobs<output>{snapshot.settings.blobHorizontalPosition > 0 ? "+" : ""}{Math.round(snapshot.settings.blobHorizontalPosition * 100)}%</output></span>
        <input type="range" aria-label="Горизонтальное положение blobs" min={-1} max={1} step={.01} value={snapshot.settings.blobHorizontalPosition}
          onChange={e => command("position", Number(e.currentTarget.value))} />
      </label>
      <p className="tuning-help">−100% / +100% сдвигают всю группу на четверть ширины поверхности. 0% — исходная композиция.</p>
      <button type="button" className="tuning-reset" onClick={() => command("reset-position")}>RESET POSITION</button>
    </fieldset>
    <details className="tuning-diagnostics"><summary>Computed styles · источники слоёв</summary>
      <p>Pixi blobs используют обычное alpha-смешивание в отдельном прозрачном canvas. Для сравнения с одной CSS-поверхностью выберите «Выкл.» в Appearance.</p>
      <pre>{JSON.stringify(snapshot.diagnostics, null, 2)}</pre>
    </details>
    {snapshot.storageError && <p role="status" className="tuning-help">{snapshot.storageError}</p>}
  </>;
}
