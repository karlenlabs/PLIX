import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";

export const APPEARANCE_BASE_HEIGHT = 437;

// Measure the children, not scrollHeight: the root fills the viewport, so using
// its own height would keep the previous oversized window and prevent shrinking.
export function appearanceContentHeight(root: HTMLElement): number {
  const top = root.getBoundingClientRect().top;
  const css = getComputedStyle(root);
  const bottom = Math.max(top, ...Array.from(root.children, child => child.getBoundingClientRect().bottom + root.scrollTop));
  return Math.max(APPEARANCE_BASE_HEIGHT,
    Math.ceil(bottom - top + parseFloat(css.paddingBottom) + parseFloat(css.borderBottomWidth)));
}

export async function resizeAppearanceHeight(height: number) {
  const panel = getCurrentWindow();
  const [size, position, monitor] = await Promise.all([panel.innerSize(), panel.outerPosition(), currentMonitor()]);
  if (!monitor || !Number.isFinite(height) || height < APPEARANCE_BASE_HEIGHT || window.innerWidth <= 0) return;
  // CSS-to-native conversion also accounts for WebView zoom and DPI. Retain the
  // exact physical width; this adjustment owns height only.
  const target = Math.min(monitor.workArea.size.height, Math.ceil(height * size.width / window.innerWidth));
  if (size.height !== target) await panel.setSize(new PhysicalSize(size.width, target));
  const y = Math.max(monitor.workArea.position.y,
    Math.min(position.y, monitor.workArea.position.y + monitor.workArea.size.height - target));
  if (y !== position.y) await panel.setPosition(new PhysicalPosition(position.x, y));
}

// Event-driven and serialized: no polling, animation loop or concurrent resize.
export function fitAppearanceHeight(root: HTMLElement, resize = resizeAppearanceHeight) {
  let stopped = false, writing = false, pending = false;
  let unlisten: (() => void) | undefined;
  async function request() {
    if (stopped) return;
    pending = true;
    if (writing) return;
    writing = true;
    try {
      while (pending && !stopped) {
        pending = false;
        await resize(appearanceContentHeight(root));
      }
    } catch (error) { console.warn("Appearance height could not be fitted", error); }
    finally { writing = false; }
  }
  const changed = () => { void request(); };
  const observer = new ResizeObserver(changed);
  observer.observe(root);
  for (const child of root.children) observer.observe(child);
  window.addEventListener("resize", changed);
  void getCurrentWindow().onScaleChanged(changed).then(stop => {
    if (stopped) stop(); else unlisten = stop;
  }).catch(error => console.warn("Appearance DPI listener unavailable", error));
  void document.fonts.ready.then(() => { if (!stopped) changed(); });
  changed();
  return () => {
    stopped = true;
    observer.disconnect();
    window.removeEventListener("resize", changed);
    unlisten?.();
  };
}
