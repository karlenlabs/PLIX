import type { MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

let opening = false;

// React owns this capture handler and removes it with the player. No global listeners.
export function showPlayerContextMenu(event: MouseEvent<HTMLElement>) {
  event.preventDefault(); // Suppress WebView2's menu, including over player controls.
  if (!(event.target instanceof Element)) return;
  const keyboardRequest = event.button === 0 && event.detail === 0;
  if (event.target.closest('button, input, select, option, label, [data-no-drag="true"]') && !keyboardRequest) return;
  if (opening) return;
  opening = true;
  const rect = keyboardRequest ? event.target.getBoundingClientRect() : null;
  const anchor = rect ? { x: rect.left + rect.width / 2, y: rect.bottom } : { x: event.clientX, y: event.clientY };
  void (async () => {
    if (!(event.shiftKey && event.button === 2)) {
      try {
        const { openCustomPlayerContextMenu } = await import("./context_menu/player_context_menu");
        if (await openCustomPlayerContextMenu(anchor)) return;
      } catch (cause) {
        console.error("Custom context menu unavailable; using native menu", cause);
      }
    }
    await invoke("show_player_context_menu");
  })().catch(cause => console.error("Failed to open player context menu", cause))
    .finally(() => { opening = false; });
}
