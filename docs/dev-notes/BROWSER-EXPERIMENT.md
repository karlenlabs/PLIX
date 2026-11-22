# DEV browser media sessions

This experiment is available only in a debug backend with Vite's DEV frontend.
The production frontend omits the panel, and release Rust builds do not register
the DEV commands. Desktop is always the initial source; the choice is not saved.
No browser extension or new package dependency is used.

## Run and choose a session

In a normal interactive Windows PowerShell:

```powershell
Set-Location C:\projects\PLIX
npm run tauri dev
```

Close an older running PLIX instance before starting this build: the existing
single-instance policy otherwise activates the older process. If dependencies
are not installed in your checkout, install the existing lockfile with `npm ci`.

1. Start Yandex Music in Chrome, Edge or Yandex Browser and play a track.
2. Focus the PLIX player and press **Ctrl+Shift+B**. A separate native window,
   **PLIX · DEV media sources**, opens; the player layout is unchanged.
3. Choose **Browser**. No browser session is selected automatically.
4. Find the desired AUMID/metadata row and click **Выбрать эту сессию**.
   The player displays its real title, artist, artwork and timeline. Its existing
   buttons and seek slider follow the selected session's capabilities.
5. If the browser's AUMID is not recognized, explicitly enable the checkbox to
   show other applications. These are labeled as unrecognized; desktop Yandex
   Music remains excluded from the browser candidate list.
6. Choose **Desktop** to restore normal desktop selection and volume/mute.
   Closing the DEV panel keeps the current choice; restarting PLIX resets it.

The list refreshes every two seconds and can be refreshed manually. Expand a row
to inspect reported capabilities and raw timeline values (100 ns ticks).
Source/metadata getter failures do not prevent inspection of later sessions.
A failure of the session manager itself is shown as a list error; the independent
mode control still allows returning to Desktop.

Browser candidates are recognized only by application IDs, never by track titles
or inferred domains. GSMTC supplies neither a tab URL nor a trustworthy site
identity. The user is responsible for identifying the desired source. A browser
may expose only its current media source rather than one stable session per tab.
In that case the selected browser object may change content when another tab
starts playing; PLIX cannot pin an individual tab through GSMTC.

## Guards and limits

All reads and transport/seek commands use the selected session's canonical COM
identity on the existing MTA worker. Opaque IDs survive enumeration reorderings;
disappearance and worker recovery require a fresh manual selection in Browser.
Neither AUMID nor metadata serves as a unique session ID.

Every selection has a revision. Old transport, seek and volume requests are
rejected after a source/selection change, including Desktop → Browser → Desktop.
Changing sources while a native write is admitted is rejected as busy; retry
after completion. An already issued asynchronous Windows command can still
complete late after a timeout; it is never replayed or redirected to a new
session. This is an OS limitation, not per-tab command isolation.

Browser mode disables both the visible volume/mute controls and backend Core
Audio access. Queued desktop setters recheck source admission immediately before
calling Windows. Desktop's existing audio-session matching remains unchanged.
The existing button for opening Yandex Music still opens the desktop application.

## Acceptance experiment

For each browser, with the desktop app also available:

- In Desktop, verify the existing title/cover, Play/Pause, Next/Previous, seek and
  volume/mute. Open the DEV panel and check Desktop is still selected.
- Switch to Browser, explicitly choose a session, and verify title/cover, pause,
  resume, track changes and seek where capabilities allow. Volume and mute must
  be disabled; desktop volume must not change.
- Play a second media tab/source. Select between distinct exported sessions and
  check commands follow the chosen object. Do not interpret a changed track as
  proof that the same object still represents the original tab.
- Close the selected source. PLIX must clear it rather than switch to another
  browser or the desktop automatically. Reopen and choose the new session.
- Switch sources during a seek gesture; the old seek must be rejected. Return to
  Desktop and verify desktop controls and volume again.

Build and automated safety checks do not replace this live browser experiment.
The tool execution environment previously returned `0x80070424` from
SessionManager::RequestAsync; such an initialization error does not prove the
absence of browser sessions. Test in your normal Windows session.

## Validation commands

```powershell
npm run typecheck
node --test scripts/media-source-tests.mjs
npm run build
cargo test --manifest-path .\src-tauri\Cargo.toml --bin plix --locked --offline
cargo build --manifest-path .\src-tauri\Cargo.toml --bin plix --locked --offline
```

The earlier standalone `plix-gsmtc-diagnostics` observer remains independent;
see GSMTC-DIAGNOSTICS.md. Nothing enables its optional feature automatically.
