import approved from './defaults.json' with { type: 'json' };
import { cssParameters } from './legacy.ts';
import { surfaceVariables, validateDesign, type DesignSettings } from './model.ts';

// Compiled defaults are never read from or written into browser/user storage.
// Appearance (theme, topmost, selected preset and window position) remains native.
export function getProductionDesign(): DesignSettings {
  return validateDesign(structuredClone(approved));
}
export const productionLegacyCSS: Record<string, string> = Object.fromEntries(
  Object.entries(getProductionDesign().legacy).map(([name, value]) =>
    [name, `${value}${cssParameters[name as keyof typeof cssParameters][2]}`]),
);
export const productionStyle: Readonly<Record<string, string>> = Object.freeze({
  ...surfaceVariables(getProductionDesign().surface!), ...productionLegacyCSS,
});
