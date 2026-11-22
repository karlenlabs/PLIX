# Temporary DEV-only GSMTC observer

This standalone console binary never starts the PLIX application, UI, tray,
artwork cache, volume backend, or session selector. It has its own MTA and
SessionManager and only reads session information. No browser is added to the
production filter. It can run alongside the existing desktop PLIX instance.

## Run on Windows (PowerShell)

From `C:\projects\PLIX`:

```powershell
cargo run --manifest-path .\src-tauri\Cargo.toml --bin plix-gsmtc-diagnostics --features gsmtc-diagnostics --locked --offline -- --observe
```

Use the debug profile. Do not pass `--release`. This command needs the project's
existing Rust dependencies in the local Cargo cache; it does not install them.
No Vite server or frontend dependency installation is needed.

The same PowerShell window displays JSON lines on stdout. Instructions and Cargo
messages use stderr. No diagnostic log file is created automatically. Text is
JSON-escaped, including control characters in source IDs and track titles.
Metadata can contain private titles: keep any copied output local unless you
choose to share it.

The observer stops after 60 seconds. Press Enter for an early stop, or Ctrl+C to
terminate this standalone process. With no `--observe` argument it only prints
help and does not initialize WinRT. Session indices belong to one sample only;
they are not stable IDs. AUMID is an application identity, not a tab URL.

## Output and limitations

Each one-second tick requests a fresh, unfiltered `GetSessions()` enumeration.
`session` records contain SourceAppUserModelId, Title, Artist, AlbumTitle,
Subtitle, ThumbnailPresent, PlaybackStatus (name and raw value), nullable
PlaybackRate, all 15 capability flags, and all six timeline fields. TimeSpan
fields use 100 ns ticks; LastUpdatedTime uses Windows UTC ticks since 1601.
ThumbnailPresent checks only for a non-null stream reference: it does not open,
fetch, decode, or validate the image.

Individual getter failures are represented by `error` and `hresult`; a failed
metadata/playback/timeline group does not suppress the other groups or sessions.
A null rate is `value: null`; a null thumbnail reference is `value: false`.
The Windows projection reports null interface returns as E_POINTER.

The existing RecoveringWorker bounds native requests to five seconds, including
manager initialization. Metadata waits are additionally capped at 250 ms per
session. Windows can still block synchronous getters: a busy tick is explicitly
reported as `sample_skipped_busy`, never queued. A timed-out worker is retired
using the existing recovery policy. The console owner enforces its own 60-second
deadline without joining a blocked native thread. Results arriving after exit
are discarded. A blocking console/output pipe can itself delay writes; Ctrl+C
still terminates the process. The observer cannot promise a complete one-second
snapshot when Windows is unresponsive.

Initialization failures identify `RoInitialize` or the start/completion of
`SessionManager::RequestAsync`. A `sample_finished` error before any `sample`
event means enumeration did not run; it does **not** mean there are no sessions.
For example, `0x80070424` means Windows reported that the specified service is
not installed. Run the observer in your normal interactive Windows terminal to
check whether the same API failure occurs outside the tool execution environment.

## One experiment

Repeat the same 60-second run for Chrome, Edge, and Yandex Browser:

1. Play Yandex Music, pause/resume, change track and seek using the website.
2. Play a second media website in another tab, then switch playback between tabs.
3. Close the Yandex Music tab and inspect session disappearance/replacement.
4. Include the desktop Yandex Music app and PLIX in the run; verify PLIX continues
   displaying/controlling desktop playback as before. The observer sends no commands.

Compare source IDs, metadata, capabilities and timeline updates. Do not treat an
index, a browser AUMID, or matching track metadata as proof of a particular tab
or domain. This read-only experiment does not validate remote transport commands
or per-tab volume isolation.

## Disable and remove

Normal PLIX commands do not enable the `gsmtc-diagnostics` feature or run this
binary. The observer refuses release compilation even when explicitly enabled.
To remove it, delete `src-tauri/src/bin/gsmtc_diagnostics.rs` and this document,
then remove its `[[bin]]` entry and the `gsmtc-diagnostics` feature from
`src-tauri/Cargo.toml`. No production Rust/TS module needs reverting.
If a debug executable was built, also delete its
`src-tauri/target/debug/plix-gsmtc-diagnostics.exe` (or the equivalent path under
your custom Cargo target directory).
