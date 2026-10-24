import type { DiagnosticAudioColorSnapshot as AudioColorSnapshot } from "./audio_color_diagnostics";
import { defaultAccentComparison, type AccentComparisonSnapshot } from "./accent_color_comparison";
import type { BlobDiagnosticSnapshot } from "./blob_diagnostics_model";
import { describeSmartPalette } from "./smart_palette_diagnostics";
import { defaultSmartPalette, type SmartPaletteSnapshot } from "./smart_palette";

export function SmartPaletteControls({ snapshot, comparison, colors, blobDiagnostics, audioColors, ready, command }: {
  comparison?: AccentComparisonSnapshot;
  audioColors?: AudioColorSnapshot;
  colors?: { target: string[]; current: string[] } | null;
  blobDiagnostics?: Pick<BlobDiagnosticSnapshot, "active" | "blobs"> | null;
  snapshot?: SmartPaletteSnapshot; ready: boolean; command(action: string, values: unknown): void;
}) {
  const settings = snapshot?.settings ?? defaultSmartPalette(), state = snapshot?.state;
  const comparisonMode = comparison?.mode ?? defaultAccentComparison(), comparisonState = comparison?.state;
  const blob3 = blobDiagnostics?.blobs.find(blob => blob.index === 2);
  const rendererLive = ready && blobDiagnostics?.active === true && !!blob3;
  const accent3 = state?.accentRecovery.targets[2], final3 = state?.final[2];
  const sent3 = rendererLive ? colors?.target[2] : undefined;
  const current3 = rendererLive ? colors?.current[2] : undefined;
  const audioActive = (audioColors?.state?.diagnostics?.applied.enabled ?? audioColors?.settings.enabled) === true && audioColors?.state?.active === true;
  const matches = final3 && sent3 && current3 ? final3 === sent3 && sent3 === current3 : null;
  const diagnostics = state ? describeSmartPalette(state, settings) : null;
  const percent = (value: number) => `${Number((value * 100).toFixed(2))}%`;
  const swatches = (label: string, colors?: string[]) => <>
    <p className="tuning-help">{label}</p>
    <div className="tuning-swatches" aria-label={label}>{colors?.map((color, i) =>
      <span key={i} style={{ backgroundColor: color }} title={color}>{color}</span>)}</div>
  </>;
  return <fieldset disabled={!ready}>
    <legend>SMART PALETTE · ЭКСПЕРИМЕНТ · DEV</legend>
    <label className="tuning-toggle"><span>Smart Palette {settings.enabled ? "ON" : "OFF"}</span>
      <input type="checkbox" aria-label="Smart Palette" checked={settings.enabled}
        onChange={e => command("smart-palette", { ...settings, enabled: e.currentTarget.checked })} /></label>
    <label className="tuning-field"><span>Сила адаптации<output>{settings.strength}%</output></span>
      <input type="range" aria-label="Сила адаптации Smart Palette" min={0} max={100} step={1} value={settings.strength}
        onChange={e => command("smart-palette", { ...settings, strength: Number(e.currentTarget.value) })} /></label>
    <p className="tuning-help">{state ? state.manual ? "Ручные цвета: адаптация пропущена." :
      `${state.analysis.neutral ? "Нейтральная / резервная" : state.analysis.weak ? "Слабая" : "Выразительная"} палитра · насыщенность ${Math.round(state.analysis.saturation * 100)}% · светлота ${Math.round(state.analysis.lightness * 100)}% · оттенков ${state.analysis.hueCount}` : "Ожидание палитры плеера…"}</p>
    {swatches("Исходная палитра обложки", state?.artwork)}
    {swatches("До Smart Palette · текущая коррекция", state?.original)}
    {swatches("После Smart Palette · целевые цвета", state?.final)}
    <details open className="tuning-diagnostics" aria-label="Accent Recovery · сравнение цветов"><summary>Accent Recovery · сравнение цветов</summary>
      <label className="tuning-select">Вариант цвета Blob 3<select aria-label="Accent Recovery · вариант цвета" value={comparisonMode}
        disabled={!settings.enabled} onChange={event => command("accent-recovery-comparison", event.currentTarget.value)}>
        <option value="original">Original · прежний</option><option value="vibrant">Vibrant</option><option value="contrast">Contrast · основной DEV</option>
      </select></label>
      <p className="tuning-help" aria-label="Accent Recovery · выбранный HEX">Выбранный HEX: {comparisonState?.mode === comparisonMode ? comparisonState.selected : "ожидание данных плеера"}</p>
      {comparisonState && <>
        <p className="tuning-help">{comparisonState.reason ?? (comparisonState.active ? "Сравнение активно: изменён только итоговый цвет Blob 3." : "Contrast: основной вариант DEV Smart Palette.")}</p>
        {swatches("Original / Vibrant / Contrast", [comparisonState.variants.original, comparisonState.variants.vibrant, comparisonState.variants.contrast])}
      </>}
      <p className="tuning-help">Vibrant усиливает насыщенность текущего акцента. Contrast подбирает светлоту относительно фона. Варианты пересчитываются с обложкой и учитывают силу адаптации. При закрытии панели — Contrast; выбор не сохраняется.</p>
    </details>
    <details open className="tuning-diagnostics" aria-label="Blob 3 · путь цвета"><summary>Blob 3 · путь цвета · live</summary>
      <p className="tuning-help" aria-label="Blob 3 · акцент">Цель Accent Recovery: {accent3 ?? "акцент не выбран"}</p>
      <p className="tuning-help" aria-label="Blob 3 · после смешиваний">После всех смешиваний Smart Palette: {final3 ?? "нет данных"}</p>
      <p className="tuning-help" aria-label="Blob 3 · передан renderer">Передан renderer (setColors): {sent3 ?? "нет живых данных renderer"}</p>
      <p className="tuning-help" aria-label="Blob 3 · фактический цвет">Текущая заливка Blob 3 в renderer: {current3 ?? "нет живых данных renderer"}</p>
      <p className="tuning-help" aria-label="Blob 3 · alpha и blur">Alpha: {rendererLive ? Number(blob3!.alpha.toFixed(6)) : "нет данных"};
        blur: {rendererLive ? blob3!.blur : "нет данных"}; видимость: {rendererLive ? blob3!.visible ? "да" : "нет" : "нет данных"}.</p>
      <p className="tuning-help" aria-label="Blob 3 · совпадение">{matches === null ? "Нет актуального snapshot для сравнения." : audioActive ?
        "Audio-driven Colors активна: текущая заливка включает аудиомодуляцию базового цвета Smart Palette." : matches ?
        "Итог Smart Palette, переданный цвет и текущая заливка renderer совпадают." :
        "Цвета пока различаются: сравните итог и переданный цвет; текущая заливка может находиться в плавном переходе."}
        {matches !== null && accent3 && final3 ? accent3 === final3 ? " Цель Accent Recovery также совпадает с итогом." : " Цель Accent Recovery отличается от итога смешиваний." : ""}</p>
      <p className="tuning-help">Заливка до alpha, blur и наложения слоёв; это не цвет готового пикселя. Данные берутся из существующих color-state и blob-diagnostics.</p>
    </details>
    {diagnostics && <div className="tuning-diagnostics" aria-label="Диагностика Smart Palette">
      <p className="tuning-help" aria-label="Причина классификации">{diagnostics.reason}</p>
      <p className="tuning-help" aria-label="Итоговая сила коррекции">Выбрано: {settings.strength}%. Необходимость коррекции: {percent(diagnostics.need)}. Применённая сила смешивания (максимум): {percent(diagnostics.effectiveStrength / 100)}.
        {diagnostics.skipped ? ` Коррекция пропущена: ${diagnostics.skipped}.` : " Сила каждого цвета = выбранная сила × его необходимость коррекции."}</p>
      {diagnostics.pending && <p className="tuning-help">Ожидание применения новых настроек; диагностика показывает последний результат плеера.</p>}
      <details open aria-label="Accent Recovery"><summary>Accent Recovery · общая слабость палитры</summary>
        <p className="tuning-help" aria-label="Accent Recovery · базовый алгоритм">Базовый алгоритм Accent Recovery: Contrast · только DEV. Original и Vibrant — ручные варианты сравнения.</p>
        <p className="tuning-help" aria-label="Необходимость Accent Recovery">Необходимость Accent Recovery: {percent(diagnostics.accentRecovery.need)}.
          Итоговая сила Accent Recovery: {percent(diagnostics.accentRecovery.effectiveStrength / 100)}.</p>
        <p className="tuning-help">Средняя насыщенность всей палитры: {percent(diagnostics.criteria.saturation.value)}.
          Недостаток насыщенности для восстановления: {percent(diagnostics.accentRecovery.saturationNeed)};
          плавно от 100% при S ≤ {percent(diagnostics.accentRecovery.saturationFull)} до 0 при S ≥ {percent(diagnostics.accentRecovery.saturationSafe)}.</p>
        <p className="tuning-help">Общий разброс оттенков с учётом их достоверности: {Number(diagnostics.accentRecovery.spread.toFixed(2))}°.
          Однообразие: {percent(diagnostics.accentRecovery.uniformity)}; плавно от 100% при разбросе ≤ {diagnostics.accentRecovery.spreadFull}° до 0 при разбросе ≥ {diagnostics.accentRecovery.spreadSafe}°.
          Необходимость восстановления = недостаток насыщенности × однообразие. Один фактор без другого акцентов не добавляет.</p>
        <p className="tuning-help">Практическая нейтральность: {percent(diagnostics.accentRecovery.neutralNeed)};
          от 100% при S ≤ {percent(diagnostics.criteria.neutral.threshold)} до 0 при S ≥ {percent(diagnostics.accentRecovery.neutralSafe)}.
          Для нейтральной резервной палитры оценка восстановления равна 100%.</p>
        {diagnostics.accentRecovery.targets.length ? <>
          <div className="tuning-swatches" aria-label="Выбранные оттенки Accent Recovery">{diagnostics.accentRecovery.targets.map(target =>
            <span key={target.slot} style={{ backgroundColor: target.color }} title={`Цвет ${target.slot}: ${target.color}`}>{target.color}</span>)}</div>
          {diagnostics.accentRecovery.targets.map(target => <p key={target.slot} className="tuning-help">
            Цвет {target.slot}: дополнительный оттенок {target.color}, H {Number(target.hue.toFixed(2))}°;
            необходимость {percent(target.need)}, итоговая сила {percent(target.strength / 100)}.
          </p>)}
        </> : <p className="tuning-help">Дополнительный оттенок не выбран: сочетание факторов не требует восстановления.</p>}
        <p className="tuning-help">Один гармоничный акцент дополняет исходную цветовую семью. Для почти нейтральной палитры плавно допускается второй сдержанный акцент. Первый цвет сохраняется.</p>
      </details>
      <details open><summary>Критерии и пороги</summary>
        <p className="tuning-help">Насыщенность (средняя): {percent(diagnostics.criteria.saturation.value)}. Оценивается каждый цвет отдельно:
          при S ≥ {percent(diagnostics.criteria.saturation.threshold)} дефицит равен 0; при S ≤ {percent(diagnostics.criteria.saturation.full)} — 100%; между ними — плавный smoothstep. Дефицит у изменяемых цветов: {diagnostics.criteria.saturation.triggered ? "да" : "нет"}.</p>
        <p className="tuning-help">Различимых оттенков: {diagnostics.criteria.diversity.value}. Число оттенков не влияет на коррекцию само по себе; для Accent Recovery используется плавная оценка общего разброса.
          В порядке исходных цветов учитываются оттенки с S ≥ {percent(diagnostics.criteria.diversity.minimumSaturation)}, удалённые от каждого уже принятого минимум на {diagnostics.criteria.diversity.minimumDistanceDegrees}°.
          Приняты: {diagnostics.criteria.diversity.acceptedHues.map(t => `цвет ${t.color}: ${Number(t.hue.toFixed(2))}°`).join("; ") || "нет"}.</p>
        <p className="tuning-help">Светлота цветов 1 / 2 / 3: {diagnostics.criteria.lightness.values.map(percent).join(" / ")}; средняя: {percent(diagnostics.criteria.lightness.mean)}.
          При L от {percent(diagnostics.criteria.lightness.lower)} до {percent(diagnostics.criteria.lightness.upper)} дефицит равен 0; при L ≤ {percent(diagnostics.criteria.lightness.fullDark)} или L ≥ {percent(diagnostics.criteria.lightness.fullLight)} — 100%; между границами — плавный smoothstep.
          Дефицит у изменяемых цветов: {diagnostics.criteria.lightness.triggered ? "да" : "нет"}. Средняя светлота в решении не участвует.</p>
        <p className="tuning-help">Нейтральность: совпадение с резервной палитрой — {diagnostics.criteria.neutral.fallback ? "да" : "нет"};
          все три S &lt; {percent(diagnostics.criteria.neutral.threshold)} — {diagnostics.criteria.neutral.allBelowSaturation ? "да" : "нет"}.
          Резервная палитра допускает полную адаптацию. Новые оттенки добавляет только Accent Recovery; локальная коррекция не насыщает серый, а достоверность оттенка плавно растёт от S {percent(diagnostics.criteria.neutral.threshold)} до {percent(diagnostics.criteria.neutral.chromaticThreshold)}.</p>
        {diagnostics.criteria.colors.map((tone, i) => <p className="tuning-help" key={i}>Исходный цвет {i + 1} {tone.color}: H {Number(tone.h.toFixed(2))}°, S {percent(tone.s)}, L {percent(tone.l)}.
          Дефицит насыщенности {percent(tone.saturationNeed)}, светлоты {percent(tone.lightnessNeed)}; необходимость {percent(tone.need)}{i === 0 ? " · первый цвет защищён" : ""}.</p>)}
        <p className="tuning-help">Локальная необходимость — максимум двух дефицитов. Итоговая необходимость цвета — максимум локальной оценки и его Accent Recovery; для первого цвета всегда 0. Общая оценка учитывает всю палитру. 100% на слайдере разрешает полную адаптацию только там, где она необходима.</p>
        <p className="tuning-help">Это значения уже извлечённой палитры, не пикселей обложки. Резервная палитра также может означать отсутствие обложки или ошибку чтения; определить чёрно-белую обложку по ней однозначно нельзя.</p>
        <details><summary>Точные значения критериев · S/L в диапазоне 0–1</summary><pre>{JSON.stringify(diagnostics.criteria, null, 2)}</pre></details>
      </details>
      <details open><summary>Изменения цветов · до → после</summary>
        {diagnostics.replacements.map(color => <p className="tuning-help" key={color.color}>
          Цвет {color.color}: {color.from} → {color.to} · {color.changed ? "заменён" : "сохранён"}; необходимость {percent(color.need)}, сила смешивания {percent(color.strength / 100)}. {color.why}
        </p>)}
      </details>
    </div>}
    <p className="tuning-help">Первый цвет сохраняется. Выразительные палитры сохраняются; при необходимости корректируются до двух цветов с учётом состояния всей палитры. Настройки временные, не сохраняются; закрытие панели возвращает OFF / 50%.</p>
  </fieldset>;
}
