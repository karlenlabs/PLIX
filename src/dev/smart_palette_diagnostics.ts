import { hex, rgb } from "../visualizer/colors.ts";
import { paletteHSL, SMART_PALETTE_LIMITS, type SmartPaletteSettings, type SmartPaletteState } from "./smart_palette.ts";

// DEV presentation only. Read the actual assessment and applied strengths so
// diagnostics share the algorithm's inputs without another classifier.
export function describeSmartPalette(state: SmartPaletteState, settings: SmartPaletteSettings) {
  const analysis = state.analysis, limits = SMART_PALETTE_LIMITS, quality = analysis.quality;
  const criteria = {
    saturation: { value: analysis.saturation, values: quality.map(t => t.s), threshold: limits.saturationSafe,
      full: limits.saturationFull, triggered: quality.some(t => t.need > 0 && t.saturationNeed > 0) },
    diversity: { value: analysis.hueCount, minimumSaturation: limits.neutralSaturation, minimumDistanceDegrees: limits.hueDistance,
      acceptedHues: analysis.acceptedHues, affectsCorrection: false },
    lightness: { mean: analysis.lightness, values: quality.map(t => t.l), lower: limits.lightnessSafeDark,
      upper: limits.lightnessSafeLight, fullDark: limits.lightnessFullDark, fullLight: limits.lightnessFullLight,
      triggered: quality.some(t => t.need > 0 && t.lightnessNeed > 0) },
    neutral: { fallback: analysis.fallback, allBelowSaturation: quality.every(t => t.s < limits.neutralSaturation),
      threshold: limits.neutralSaturation, chromaticThreshold: limits.chromaticSaturation, triggered: analysis.neutral },
    colors: state.artwork.map((color, i) => ({ color, ...quality[i] })),
  };
  const accentRecovery = {
    ...analysis.recovery, algorithm: state.accentRecovery.algorithm, referenceTarget: state.accentRecovery.referenceTarget, effectiveStrength: state.accentRecovery.effectiveStrength,
    saturationFull: limits.recoverySaturationFull, saturationSafe: limits.recoverySaturationSafe,
    spreadFull: limits.recoverySpreadFull, spreadSafe: limits.recoverySpreadSafe,
    neutralSafe: limits.recoveryNeutralSafe,
    targets: state.accentRecovery.targets.flatMap((color, i) => color ? [{
      color, slot: i + 1, hue: paletteHSL(color).h, need: analysis.recovery.slotNeeds[i], strength: state.accentRecovery.strengths[i],
    }] : []),
  };
  const factors = [
    ...(accentRecovery.need > 0 ? ["Accent Recovery: палитра одновременно недостаточно насыщенная и однообразная"] : []),
    ...(criteria.saturation.triggered ? ["низкая насыщенность"] : []),
    ...(criteria.lightness.triggered ? ["крайняя светлота"] : []),
    ...(analysis.neutral ? [analysis.fallback ? "нейтральная резервная палитра" : "все цвета почти серые"] : []),
  ];
  const reason = !analysis.weak ? "Коррекция не требуется: выразительные цвета сохраняются независимо от числа оттенков." :
    factors.length > 1 ? `Комбинация факторов: ${factors.join("; ")}.` : `Причина: ${factors.join("; ")}.`;
  const applied = state.correction;
  const skipped = !applied.enabled ? "Smart Palette OFF" : applied.requestedStrength === 0 ? "выбрана сила 0%" :
    !analysis.weak ? "коррекция не требуется" : state.manual ? "ручной режим цветов" : null;
  const pending = applied.enabled !== settings.enabled || applied.requestedStrength !== settings.strength;
  const effectiveStrength = applied.effectiveStrength;
  const replacements = state.original.map((from, i) => {
    const to = state.final[i], changed = hex(rgb(from)) !== hex(rgb(to)), tone = quality[i];
    const recoveryNeed = analysis.recovery.slotNeeds[i], need = Math.max(tone.need, recoveryNeed);
    const deficit = [tone.saturationNeed > 0 ? "низкая насыщенность" : "", tone.lightnessNeed > 0 ? "крайняя светлота" : ""].filter(Boolean).join("; ");
    const target = tone.colorConfidence === 0 ? "нейтральная коррекция светлоты без дополнительного оттенка; серый не насыщается" :
      tone.colorConfidence < 1 ? "исходный оттенок сохранён с насыщенностью по его достоверности" : "исходный оттенок сохранён";
    const recoveredTarget = analysis.recovery.neutralNeed === 1 ?
      `${i === 1 ? "приглушённый синий" : "тёплый"} резервный акцент; серый не насыщается` : "Гармоничный акцент дополняет исходную цветовую семью";
    const why = i === 0 ? "Первый исходный цвет всегда сохраняется." : need === 0 ?
      "Выразительный цвет: собственных причин для замены нет; число оттенков само по себе не влияет." : skipped ? `Коррекция пропущена: ${skipped}.` :
      !changed ? "После смешивания и округления RGB цвет совпадает с исходным." : recoveryNeed > 0 ?
      `Accent Recovery · Contrast: слабость всей палитры допускает дополнительный оттенок. ${recoveredTarget}; цель ${state.accentRecovery.targets[i]}, сила восстановления ${Number(state.accentRecovery.strengths[i].toFixed(2))}%.` :
      `${analysis.fallback ? "Нейтральная резервная палитра" : deficit}: ${target}. Смешивание по индивидуальной необходимости; подбор светлоты целевого акцента с целью контраста 3:1 к подложке.`;
    return { color: i + 1, from, to, changed, need, individualNeed: tone.need, recoveryNeed, strength: applied.strengths[i], why };
  });
  return { criteria: { ...criteria, accentRecovery }, accentRecovery, factors, reason, need: analysis.need, effectiveStrength, skipped, pending, replacements };
}
