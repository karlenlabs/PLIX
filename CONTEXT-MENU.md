# PLIX context menu

The custom menu is enabled by default in development and production.
Right-click a free area of the player. Shift+right-click directly opens the
existing native menu. No environment flag or settings migration is needed.

The current 210px menu design, Dark / Warm Cream palettes, opaque surfaces,
Lucide icons and red Quit item are preserved. CSS retains its existing private
`data-plix-dev-menu` selectors so the approved stylesheet stays byte-for-byte
identical; they do not control feature availability.

Arrows, Home/End, Enter/Space, Escape and Tab are supported. The context key /
Shift+F10 opens the menu at the focused control. Outside clicks are consumed;
blur, resize and page exit dismiss the menu and remove temporary listeners.

HTML remains inside the WebView host window and can overlap the player.
Native physical client bounds and the monitor work area are converted into
CSS pixels before placement. If the menu cannot fit, overflows, cannot load,
or its native bridge is unavailable, PLIX uses the existing native fallback.

Actions use `appearance::open_appearance`,
`appearance::toggle_main_always_on_top` and `lifecycle::request_quit`.
Their saving, transaction and shutdown implementations remain unchanged.
The bridge is restricted to the main window and is registered in all profiles.

## Icon attribution

The Lucide icon paths retain their [ISC license](src/context_menu/context-menu-icons/LICENSE).
