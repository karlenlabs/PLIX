import { invoke } from "@tauri-apps/api/core";
import { fitMenu, visibleMenuBounds, type PlayerMenuState } from "./context_menu_geometry";
import { menuIcon } from "./context_menu_icons";
import "./player_context_menu.css";

let dismissActive: (() => void) | undefined;

// true means handled (including cancellation); false requests the native popup.
// The caller keeps its opening guard until this promise resolves on dismissal.
export async function openCustomPlayerContextMenu(anchor: { x: number; y: number }): Promise<boolean> {
  dismissActive?.();
  const inactive = () => !document.hasFocus() || document.visibilityState === "hidden";
  if (inactive()) return true;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  window.addEventListener("blur", cancel);
  window.addEventListener("pagehide", cancel);
  let state: PlayerMenuState;
  try {
    state = await invoke<PlayerMenuState>("player_context_menu_action", { action: "state" });
  } catch {
    return !document.hasFocus() || cancelled;
  } finally {
    window.removeEventListener("blur", cancel);
    window.removeEventListener("pagehide", cancel);
  }
  if (cancelled || inactive()) return true;
  const bounds = visibleMenuBounds(state, window.innerWidth, window.innerHeight);
  if (!bounds) return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const layer = document.createElement("div");
  layer.setAttribute("data-plix-dev-menu-layer", "");
  const menu = document.createElement("div");
  menu.setAttribute("data-plix-dev-menu", "");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Меню PLIX");
  menu.style.visibility = "hidden";
  const items = [
    { action: "appearance", text: "Внешний вид", icon: "sliders" },
    { action: "topmost", text: "Поверх всех окон", icon: "pin" },
    { action: "quit", text: "Выйти из PLIX", icon: "power" },
  ] as const;
  const buttons = items.map((item, index) => {
    if (index === 2) {
      const separator = document.createElement("div");
      separator.setAttribute("role", "separator"); menu.appendChild(separator);
    }
    const button = document.createElement("button");
    button.type = "button"; button.tabIndex = index === 0 ? 0 : -1;
    button.dataset.action = item.action;
    button.setAttribute("role", item.action === "topmost" ? "menuitemcheckbox" : "menuitem");
    button.appendChild(menuIcon(item.icon));
    const label = document.createElement("span"); label.textContent = item.text; button.appendChild(label);
    if (item.action === "topmost") {
      button.setAttribute("aria-checked", String(state.alwaysOnTop));
      if (state.alwaysOnTop) button.appendChild(menuIcon("check"));
    }
    menu.appendChild(button); return button;
  });
  layer.appendChild(menu); document.body.appendChild(layer);
  try {
    const rect = menu.getBoundingClientRect();
    const position = fitMenu(anchor.x, anchor.y, rect.width, rect.height, bounds);
    if (!position || menu.scrollWidth > menu.clientWidth || menu.scrollHeight > menu.clientHeight) {
      layer.remove(); return false;
    }
    menu.style.left = `${position.x}px`; menu.style.top = `${position.y}px`;
    menu.style.visibility = "visible";
  } catch (cause) {
    layer.remove(); throw cause;
  }
  return new Promise<boolean>(resolve => {
    let closed = false, selected = 0;
    function close(restoreFocus = true, handled = true) {
      if (closed) return;
      closed = true;
      window.removeEventListener("blur", blurred);
      window.removeEventListener("resize", blurred);
      window.removeEventListener("pagehide", blurred);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("focusin", focusChanged);
      layer.remove(); dismissActive = undefined;
      resolve(handled);
      if (restoreFocus && previousFocus?.isConnected && document.hasFocus()) {
        try { previousFocus.focus({ preventScroll: true }); }
        catch (cause) { console.error("Failed to restore focus after player menu", cause); }
      }
    }
    const blurred = () => close(false);
    const visibility = () => { if (document.visibilityState === "hidden") close(false); };
    const focusChanged = (event: FocusEvent) => { if (event.target instanceof Node && !menu.contains(event.target)) close(false); };
    const select = (index: number) => {
      selected = (index + buttons.length) % buttons.length;
      buttons.forEach((button, i) => { button.tabIndex = i === selected ? 0 : -1; });
      buttons[selected].focus({ preventScroll: true });
    };
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Tab") { close(); return; }
      if (!["Escape", "ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") close();
      else if (event.key === "ArrowDown") select(selected + 1);
      else if (event.key === "ArrowUp") select(selected - 1);
      else if (event.key === "Home") select(0);
      else if (event.key === "End") select(buttons.length - 1);
      else if (!event.repeat) buttons[selected].click();
    }
    buttons.forEach((button, index) => {
      button.addEventListener("pointermove", () => { if (selected !== index) select(index); });
      button.addEventListener("click", () => {
        if (closed) return;
        close();
        void invoke("player_context_menu_action", { action: items[index].action })
          .catch(cause => console.error("Player menu action failed", cause));
      });
    });
    // A viewport-sized backdrop consumes the dismissing click, so it cannot
    // accidentally play/pause, seek or drag the underlying player.
    layer.addEventListener("pointerdown", event => { if (event.target === layer) event.preventDefault(); });
    layer.addEventListener("click", event => { if (event.target === layer) { event.preventDefault(); event.stopPropagation(); close(false); } });
    layer.addEventListener("contextmenu", event => { event.preventDefault(); close(); });
    window.addEventListener("blur", blurred);
    window.addEventListener("resize", blurred);
    window.addEventListener("pagehide", blurred);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("keydown", keyboard, true);
    document.addEventListener("focusin", focusChanged);
    dismissActive = () => close();
    try { select(0); } catch { close(false, false); }
  });
}
