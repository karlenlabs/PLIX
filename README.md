# PLIX

PLIX is a compact desktop mini-player for Yandex Music on Windows.
Built with React, Vite, Tauri 2 and Rust, it controls playback through the Windows system media session.

![PLIX mini-player for Yandex Music on Windows](assets/readme/plix-hero.jpg)

## Features

- Compact mini-player for Windows.
- Yandex Music playback controls: play, pause, previous and next track.
- Track artwork, title, playback progress and seeking.
- Volume control and mute for the Yandex Music app.
- Light and dark themes.
- Visual effects and FFT-based audio-reactive visualization.
- Hybrid Palette: colors adapt to artwork and music.
- Tray integration and context menu.
- Always on top.
- Saved appearance settings.

The Yandex Music desktop app must be running separately. Available playback
commands depend on its active media session. Audio capture for visualization
requires Windows process-loopback support.

## Requirements

- Windows 11 is the primary target platform.
- Yandex Music desktop app and Microsoft Edge WebView2 Runtime.
- Node.js 20.19+ or 22.12+ with npm, compatible with Vite 7.
- Rust with the MSVC toolchain, Visual Studio Build Tools with C++ and the Windows SDK.

Run all commands below from the project root.

## Installation / Run

```powershell
npm ci
npm run tauri -- dev
```

Use `npm run dev` to run the frontend in a browser. Native media commands
require the Tauri app. You can also use `start-dev.bat`, which launches the app
from the directory containing the BAT file.

## Verification / Build

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

The first command builds the production frontend in `dist/`; the second checks
the Rust code. These commands do not produce a release EXE. Build the production
desktop executable with the Tauri CLI, which enables the production protocol
and embeds the frontend:

```powershell
npm run tauri -- build --no-bundle --features tauri/custom-protocol
```

Always use the Tauri CLI for release builds. A plain `cargo build --release`
does not replace this step; `src-tauri/build.rs` enforces the production protocol
requirement.

## DEV tools

`npm run dev:tuning` launches the development player and the Visual Tuning panel
for adjusting surfaces, colors and visual layer diagnostics. Diagnostic modes
are available in development builds.

The full `src/dev/` directory is required: its validators are also used by the
development bridge in the Vite configuration. Production palette algorithms
live in `src/palette/`, and appearance code lives in `src/design/`. Saved
development settings are stored in the browser's local storage.

## Structure

- `src/` — UI, appearance, visualization and development tools.
- `src-tauri/` — Windows integration, audio, settings storage and app resources.
- `scripts/` — development panel launcher, icon preparation and explicit settings recovery.
- `assets/branding/plix/` — branding source images and previews.
- `assets/readme/` — screenshots for this README.
- [Context menu](CONTEXT-MENU.md) — behavior and keyboard controls.

Dependencies are pinned in `package-lock.json` and `src-tauri/Cargo.lock`.
Legacy Ympleer configuration identifiers are retained for settings and Windows
integration compatibility. Historical test suites, prototypes, local data and
build outputs are excluded from this public repository.

## Third-party code

- Lucide: [ISC license](src/context_menu/context-menu-icons/LICENSE).
- Local Windows adaptation of the Tauri single-instance plugin:
  [MIT license](src-tauri/vendor/tauri-plugin-single-instance/LICENSE-MIT)
  and [upstream notes](src-tauri/vendor/tauri-plugin-single-instance/UPSTREAM.md).
- npm and Cargo dependencies retain their respective licenses.
