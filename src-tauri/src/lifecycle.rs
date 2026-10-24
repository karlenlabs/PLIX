use crate::appearance::{self, Appearance};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

const FLUSH_EVENT: &str = "lifecycle-flush-appearance";
// Allow normal queued IPC/disk flushes ample time, but bound a missing renderer.
// This bounds acknowledgement waiting, not Windows filesystem or H03 teardown.
const APPEARANCE_ACK_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct FlushRequest {
    id: u64,
    quit: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Waiting,
    Saving,
}

#[derive(Clone, Copy)]
struct Pending {
    request: FlushRequest,
    deadline: Option<Instant>,
    phase: Phase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SaveReason {
    Acknowledged,
    Deadline,
    DeliveryFailed,
}

// Deliberately not Clone/Copy: one successful claim owns the final write.
struct SaveJob {
    request: FlushRequest,
    reason: SaveReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShutdownOutcome {
    Flushed,
    NativeOnly,
}

enum Acknowledgement {
    Ignored,
    Hidden,
    Failed(String),
    Save(SaveJob),
}

struct Begin {
    request: FlushRequest,
    notify_renderer: bool,
}

#[derive(Default)]
struct CloseState {
    next_id: u64,
    pending: Option<Pending>,
    exit_ready: bool,
    outcome: Option<ShutdownOutcome>,
}

impl CloseState {
    fn begin(&mut self, quit: bool, now: Instant) -> Option<Begin> {
        if self.exit_ready {
            return None;
        }
        if let Some(pending) = self.pending.filter(|pending| pending.request.quit) {
            return Some(Begin {
                request: pending.request,
                notify_renderer: pending.phase == Phase::Waiting,
            });
        }
        self.next_id += 1;
        let request = FlushRequest {
            id: self.next_id,
            quit,
        };
        self.pending = Some(Pending {
            request,
            deadline: quit.then_some(now + APPEARANCE_ACK_DEADLINE),
            phase: Phase::Waiting,
        });
        Some(Begin {
            request,
            notify_renderer: true,
        })
    }

    fn claim_save(&mut self, id: u64, reason: SaveReason) -> Option<SaveJob> {
        let pending = self.pending.as_mut().filter(|pending| {
            pending.request.id == id && pending.request.quit && pending.phase == Phase::Waiting
        })?;
        pending.phase = Phase::Saving;
        Some(SaveJob {
            request: pending.request,
            reason,
        })
    }

    fn fallback(&mut self, id: u64, reason: SaveReason, now: Instant) -> Option<SaveJob> {
        if reason == SaveReason::Deadline
            && !self
                .pending
                .is_some_and(|pending| pending.deadline.is_some_and(|deadline| now >= deadline))
        {
            return None;
        }
        self.claim_save(id, reason)
    }

    fn acknowledge(&mut self, id: u64, error: Option<String>, now: Instant) -> Acknowledgement {
        let Some(pending) = self
            .pending
            .filter(|pending| pending.request.id == id && pending.phase == Phase::Waiting)
        else {
            return Acknowledgement::Ignored;
        };
        // The deadline is absolute even if the timer thread was scheduled late.
        if pending.deadline.is_some_and(|deadline| now >= deadline) {
            return Acknowledgement::Save(self.claim_save(id, SaveReason::Deadline).unwrap());
        }
        if let Some(error) = error {
            self.pending = None;
            return Acknowledgement::Failed(error);
        }
        if pending.request.quit {
            Acknowledgement::Save(self.claim_save(id, SaveReason::Acknowledged).unwrap())
        } else {
            self.pending = None;
            Acknowledgement::Hidden
        }
    }

    fn finish_save(
        &mut self,
        job: &SaveJob,
        result: Result<(), String>,
    ) -> Result<Option<ShutdownOutcome>, String> {
        if !self.pending.is_some_and(|pending| {
            pending.request.id == job.request.id && pending.phase == Phase::Saving
        }) {
            return Ok(None);
        }
        self.pending = None;
        result?; // Persistence failure cancels Quit, as in the original protocol.
        let outcome = if job.reason == SaveReason::Acknowledged {
            ShutdownOutcome::Flushed
        } else {
            ShutdownOutcome::NativeOnly
        };
        self.outcome = Some(outcome);
        self.exit_ready = true;
        Ok(Some(outcome))
    }
}

#[derive(Default)]
pub struct Lifecycle(Mutex<CloseState>, Condvar);

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show-player", "Show player", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide-player", "Hide player", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти из PLIX", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
    let icon = crate::tray_playback::neutral_image();
    TrayIconBuilder::with_id("ympleer")
        .icon(icon.clone())
        .tooltip("PLIX")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "show-player" => show_player(app),
                "hide-player" => hide_player(app),
                "quit" => request_quit(app),
                _ => Ok(()),
            };
            if let Err(error) = result {
                eprintln!("Window lifecycle failed: {error}");
            }
        })
        .build(app)?;
    crate::tray_playback::setup(app, icon.to_owned());
    // One native watchdog for the application lifetime; no timer depends on JS.
    let handle = app.handle().clone();
    std::thread::Builder::new()
        .name("appearance-quit-watchdog".into())
        .spawn(move || {
            if let Err(error) = watch_quit_deadline(&handle) {
                eprintln!("Quit watchdog failed: {error}");
            }
        })?;
    Ok(())
}

fn show_player(app: &tauri::AppHandle) -> Result<(), String> {
    let lifecycle = app.state::<Lifecycle>();
    if lifecycle
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .pending
        .is_some_and(|pending| pending.request.quit)
    {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is missing")?;
    window.unminimize().map_err(|error| error.to_string())?;
    crate::window_position::restore(app)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn hide_player(app: &tauri::AppHandle) -> Result<(), String> {
    // Reuse the same CloseRequested/position flush path as X and Alt+F4.
    app.get_webview_window("main")
        .ok_or("Main window is missing")?
        .close()
        .map_err(|error| error.to_string())
}

pub fn request_quit(app: &tauri::AppHandle) -> Result<(), String> {
    request_flush(app, true)
}

fn request_flush(app: &tauri::AppHandle, quit: bool) -> Result<(), String> {
    let lifecycle = app.state::<Lifecycle>();
    let begin = lifecycle
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .begin(quit, Instant::now());
    lifecycle.1.notify_all();
    let Some(begin) = begin else {
        return Ok(());
    };
    if !begin.notify_renderer {
        return Ok(());
    }
    // Query-after-subscribe recovery remains available for an early Quit.
    if let Err(error) = app.emit_to("appearance", FLUSH_EVENT, begin.request) {
        if !quit {
            return Err(error.to_string());
        }
        eprintln!("Appearance flush delivery failed; saving native snapshot: {error}");
        let job = lifecycle
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .fallback(begin.request.id, SaveReason::DeliveryFailed, Instant::now());
        lifecycle.1.notify_all();
        if let Some(job) = job {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = persist_quit(&handle, job) {
                    eprintln!("Fallback Quit failed: {error}");
                }
            });
        }
    }
    Ok(())
}

fn watch_quit_deadline(app: &tauri::AppHandle) -> Result<(), String> {
    loop {
        let job = {
            let lifecycle = app.state::<Lifecycle>();
            let mut state = lifecycle.0.lock().map_err(|error| error.to_string())?;
            loop {
                if state.exit_ready {
                    return Ok(());
                }
                let waiting = state
                    .pending
                    .filter(|pending| pending.phase == Phase::Waiting);
                if let Some((request, deadline)) = waiting.and_then(|pending| {
                    pending.deadline.map(|deadline| (pending.request, deadline))
                }) {
                    let now = Instant::now();
                    if now >= deadline {
                        break state
                            .fallback(request.id, SaveReason::Deadline, now)
                            .unwrap();
                    }
                    state = lifecycle
                        .1
                        .wait_timeout(state, deadline - now)
                        .map_err(|error| error.to_string())?
                        .0;
                } else {
                    state = lifecycle.1.wait(state).map_err(|error| error.to_string())?;
                }
            }
        };
        if let Err(error) = persist_quit(app, job) {
            // A disk error leaves the app alive and the watchdog available for retry.
            eprintln!("Fallback Quit failed: {error}");
        }
    }
}

fn report_flush_failure(app: &tauri::AppHandle) {
    // Keep the application and its pending draft alive on failed persistence.
    let _ = show_player(app);
    let _ = appearance::open_appearance(app.clone());
}

fn persist_quit(app: &tauri::AppHandle, job: SaveJob) -> Result<(), String> {
    // Called only on the watchdog or spawn_blocking, never on the UI thread.
    // No lifecycle mutex is held while waiting for Appearance's backend gate/disk.
    let result = app.state::<Appearance>().save_for_shutdown();
    complete_quit(app, job, result)
}

fn complete_quit(
    app: &tauri::AppHandle,
    job: SaveJob,
    result: Result<(), String>,
) -> Result<(), String> {
    let lifecycle = app.state::<Lifecycle>();
    let outcome = lifecycle
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .finish_save(&job, result);
    lifecycle.1.notify_all();
    match outcome {
        Ok(Some(outcome)) => {
            if outcome == ShutdownOutcome::NativeOnly {
                eprintln!("Quit fallback ({:?}): native snapshot saved; Appearance draft was not acknowledged", job.reason);
            }
            // finish_save grants exit once. Late acknowledgements and repeated Quit
            // cannot start another save or dispatch another exit.
            app.exit(0);
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(error) => {
            report_flush_failure(app);
            Err(error)
        }
    }
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if !matches!(window.label(), "main" | "appearance") {
            return;
        }
        api.prevent_close();
        let result = (|| {
            window.hide().map_err(|error| error.to_string())?;
            if window.label() == "main" {
                if let Some(appearance) = window.app_handle().get_webview_window("appearance") {
                    appearance.hide().map_err(|error| error.to_string())?;
                }
            }
            request_flush(window.app_handle(), false)
        })();
        if let Err(error) = result {
            eprintln!("Failed to hide window: {error}");
        }
    }
}

pub fn on_exit_requested(app: &tauri::AppHandle, api: &tauri::ExitRequestApi) -> bool {
    let ready = app
        .state::<Lifecycle>()
        .0
        .lock()
        .map(|state| state.exit_ready)
        .unwrap_or(false);
    if !ready {
        api.prevent_exit();
        if let Err(error) = request_flush(app, true) {
            eprintln!("Failed to request graceful quit: {error}");
        }
    }
    ready
}

#[tauri::command]
pub fn get_lifecycle_request(window: tauri::WebviewWindow) -> Result<Option<FlushRequest>, String> {
    if window.label() != "appearance" {
        return Err("Only Appearance can flush settings".into());
    }
    let state = window.state::<Lifecycle>();
    let pending = state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .pending
        .filter(|pending| pending.phase == Phase::Waiting)
        .map(|pending| pending.request);
    Ok(pending)
}

#[tauri::command]
pub async fn finish_lifecycle(
    window: tauri::WebviewWindow,
    id: u64,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != "appearance" {
        return Err("Only Appearance can flush settings".into());
    }
    let app = window.app_handle().clone();
    let lifecycle = app.state::<Lifecycle>();
    let action = lifecycle
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .acknowledge(id, error, Instant::now());
    lifecycle.1.notify_all();
    match action {
        Acknowledgement::Ignored | Acknowledgement::Hidden => Ok(()),
        Acknowledgement::Failed(error) => {
            report_flush_failure(&app);
            Err(error)
        }
        Acknowledgement::Save(job) => {
            let handle = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                handle.state::<Appearance>().save_for_shutdown()
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
            // A blocking-task failure must cancel Saving as well, preserving the
            // previous retry/error behavior rather than leaving a pending Quit.
            complete_quit(&app, job, result)
        }
    }
}


// Secondary launches never restore from disk, mutate settings or request Quit.
// Queue UI work out of the plugin's synchronous WM_COPYDATA callback.
pub fn on_second_instance(app: &tauri::AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = activate_existing(&handle) {
            eprintln!("Could not activate existing PLIX window: {error}");
        }
    }) {
        eprintln!("Could not queue PLIX activation: {error}");
    }
}

fn accepts_second_launch(state: &CloseState) -> bool {
    !state.exit_ready && !state.pending.is_some_and(|pending| pending.request.quit)
}

fn activate_existing(app: &tauri::AppHandle) -> Result<(), String> {
    let lifecycle = app.state::<Lifecycle>();
    let allowed = {
        let state = lifecycle.0.lock().map_err(|error| error.to_string())?;
        accepts_second_launch(&state)
    };
    if !allowed {
        return Ok(());
    }
    #[cfg(not(test))]
    let window = app.get_webview_window("main");
    let Some(window) = window else {
        return Ok(()); // An early launch must not create a window ahead of setup.
    };
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

