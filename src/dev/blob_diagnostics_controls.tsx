import { defaultBlobDiagnostics, type BlobDiagnosticSnapshot, type BlobDiagnosticSettings } from "./blob_diagnostics_model";
type Props = { snapshot?: BlobDiagnosticSnapshot | null; ready: boolean; command(action: string, values?: unknown): void };
export function BlobDiagnosticsControls({ snapshot, ready, command }: Props) {
  const settings = snapshot?.settings ?? defaultBlobDiagnostics();
  const update = (patch: Partial<BlobDiagnosticSettings>) => command("blob-diagnostics", { ...settings, ...patch });
  const view = settings.mode !== "original" || settings.alpha || settings.solo === "none" || (settings.disableBlur && settings.solo !== "all")
    ? "custom" : settings.disableBlur ? "no-blur" : settings.solo === "all" ? "original" : "solo";
  const selectView = (value: string) => command("blob-diagnostics", {
    ...defaultBlobDiagnostics(),
    disableBlur: value === "no-blur",
    solo: value === "solo" ? (typeof settings.solo === "number" ? settings.solo : 0) : "all",
  });
  return <fieldset disabled={!ready || !snapshot?.active}>
    <legend>ДИАГНОСТИКА BLOBS · ВРЕМЕННО · DEV</legend>
    <label className="tuning-select">Режим диагностики PixiJS<select aria-label="Режим диагностики PixiJS" value={view}
      onChange={event => selectView(event.currentTarget.value)}>
      <option value="original">Original</option><option value="no-blur">No Blur</option><option value="solo">Solo</option>
      {view === "custom" && <option value="custom" disabled>Расширенная диагностика</option>}
    </select></label>
    <label className="tuning-select">Blob в Solo<select aria-label="Blob в Solo" disabled={view !== "solo"}
      value={typeof settings.solo === "number" ? settings.solo : 0}
      onChange={event => update({ solo: Number(event.currentTarget.value) as 0 | 1 | 2 })}>
      <option value={0}>1</option><option value={1}>2</option><option value={2}>3</option>
    </select></label>
    <p className="tuning-help">Original — текущая production-визуализация. No Blur — все blobs без BlurFilter. Solo — один blob с исходным blur. Цвета, alpha и геометрия не меняются. Закрытие панели возвращает Original.</p>
    <details><summary>Прежние эксперименты и GPU alpha · дополнительно</summary>
    <label className="tuning-select">Rendering · DEV-эксперименты<select aria-label="Режим rendering blobs" value={settings.mode}
      onChange={event => update({ mode: event.currentTarget.value as BlobDiagnosticSettings["mode"] })}>
      <option value="original">Original</option><option value="brightness">A · Brightness compensation</option>
      <option value="dark-surface">B · Dark-surface compositing</option><option value="combined">A + B</option>
      <option value="soft-alpha">Soft Alpha · прежний эксперимент</option>
    </select></label>
    {([ ["brightnessIntensity", "Интенсивность A", ["brightness","combined"]],
      ["surfaceIntensity", "Интенсивность B", ["dark-surface","combined"]] ] as const).map(([key,label,modes]) =>
      <label className="tuning-field" key={key}><span>{label}<output>{Math.round(settings[key]*100)}%</output></span>
        <input type="range" aria-label={label} min={0} max={100} step={1} value={Math.round(settings[key]*100)}
          disabled={!(modes as readonly string[]).includes(settings.mode)} onChange={event=>update({[key]:Number(event.currentTarget.value)/100})} />
      </label>)}
    <p className="tuning-help">A ограничивает светлоту OKLab после слияния blobs. B смешивает цвет в пределах яркости базовой поверхности. При 0% фильтр исключён. Original отключает оба подхода и Soft Alpha.</p>
    {snapshot?.compositing && <p className="tuning-help">Цветовой проход: {snapshot.compositing.active ? "включён" : "выключен"}{snapshot.compositing.surfaceStrength > 0 && <> · база B: {snapshot.compositing.surface.map(v=>Math.round(v*255)).join(", ")}</>}</p>}
    <label className="tuning-field"><span>Мягкость краёв<output>{Math.round(settings.edgeSoftness * 100)}%</output></span>
      <input type="range" aria-label="Мягкость краёв" min={10} max={100} step={1} value={Math.round(settings.edgeSoftness * 100)}
        disabled={settings.mode !== "soft-alpha"} onChange={event => update({ edgeSoftness: Number(event.currentTarget.value) / 100 })} />
    </label>
    <p className="tuning-help">Soft Alpha — прежняя маска до blur. Все эксперименты сбрасываются в Original при OFF/ON и перезапуске; параметры не сохраняются.</p>
    <label className="tuning-select">Изолировать слой<select aria-label="Изолировать blob" value={settings.solo}
      onChange={event => update({ solo: (["all", "none"].includes(event.currentTarget.value)
        ? event.currentTarget.value : Number(event.currentTarget.value)) as BlobDiagnosticSettings["solo"] })}>
      <option value="all">Все blobs</option><option value={0}>Только Blob 1</option>
      <option value={1}>Только Blob 2</option><option value={2}>Только Blob 3</option>
      <option value="none">Без blobs · проверить CSS</option>
    </select></label>
    <label className="tuning-toggle"><span>Alpha-маска · белый = плотная область</span><input type="checkbox" aria-label="Показать alpha blobs" checked={settings.alpha}
      onChange={event => update({ alpha: event.currentTarget.checked })} /></label>
    <label className="tuning-toggle"><span>Отключить blur · только диагностика</span><input type="checkbox" aria-label="Отключить blur для диагностики" checked={settings.disableBlur}
      onChange={event => update({ disableBlur: event.currentTarget.checked })} /></label>
    <p className="tuning-help">Не сохраняется. Alpha-маска специально белая; цветовые A/B в этом просмотре обходятся (alpha не меняется). Базовая поверхность, настройки и audio capture не меняются.</p>
    {snapshot?.blobs.map(blob => <p className="tuning-help" key={blob.index}>Blob {blob.index + 1}: alpha {blob.alpha.toFixed(4)} · blur {blob.blur} · {blob.visible ? "видим" : "скрыт"}</p>)}
    <button type="button" className="tuning-reset" onClick={() => command("blob-diagnostics", { measure: true })}>СНЯТЬ GPU ALPHA · С BLUR / БЕЗ BLUR</button>
    <button type="button" className="tuning-reset" onClick={() => command("blob-diagnostics", defaultBlobDiagnostics())}>СБРОС ДИАГНОСТИКИ</button>
    {snapshot?.profiles && <pre>{JSON.stringify(snapshot.profiles, null, 2)}</pre>}
    {snapshot?.error && <p role="status" className="tuning-help">{snapshot.error}</p>}
    </details>
  </fieldset>;
}
