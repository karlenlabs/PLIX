export type MenuBounds = { left: number; top: number; right: number; bottom: number };
export type PlayerMenuState = { alwaysOnTop: boolean; viewport: [number, number]; workArea: [number, number, number, number] };

// Native monitor/work-area coordinates arrive in physical pixels relative to
// the WebView client origin. Derive CSS ratios from its actual physical size,
// so DPI, browser zoom, taskbars and negative monitor origins share one space.
export function visibleMenuBounds(state: PlayerMenuState, width: number, height: number): MenuBounds | null {
  if (!state || typeof state.alwaysOnTop !== "boolean" || !Array.isArray(state.viewport) || !Array.isArray(state.workArea)) return null;
  const values = [width, height, ...state.viewport, ...state.workArea];
  if (values.some(value => !Number.isFinite(value)) || state.viewport.length !== 2 || state.workArea.length !== 4
    || Math.min(width, height, ...state.viewport) <= 0) return null;
  const sx = width / state.viewport[0], sy = height / state.viewport[1];
  const bounds = {
    left: Math.max(0, state.workArea[0] * sx), top: Math.max(0, state.workArea[1] * sy),
    right: Math.min(width, state.workArea[2] * sx), bottom: Math.min(height, state.workArea[3] * sy),
  };
  return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
}

export function fitMenu(x: number, y: number, width: number, height: number, bounds: MenuBounds | null): { x: number; y: number } | null {
  if (!bounds || [x, y, width, height, ...Object.values(bounds)].some(value => !Number.isFinite(value)) || width <= 0 || height <= 0) return null;
  const left = bounds.left + 4, top = bounds.top + 4;
  const maxX = bounds.right - width - 4, maxY = bounds.bottom - height - 4;
  if (maxX < left || maxY < top) return null;
  const preferredX = x + width + 2 <= bounds.right - 4 ? x + 2 : x - width - 2;
  const preferredY = y + height + 2 <= bounds.bottom - 4 ? y + 2 : y - height - 2;
  return { x: Math.max(left, Math.min(preferredX, maxX)), y: Math.max(top, Math.min(preferredY, maxY)) };
}
