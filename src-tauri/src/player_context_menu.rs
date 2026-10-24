use crate::{appearance, lifecycle};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::Manager;

const APPEARANCE: &str = "player-context-appearance";
const TOPMOST: &str = "player-context-topmost";
const QUIT: &str = "player-context-quit";

struct PlayerContextMenu {
    menu: Menu<tauri::Wry>,
    topmost: CheckMenuItem<tauri::Wry>,
    opening: AtomicBool,
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let window = app.get_webview_window("main").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "Main window is missing")
    })?;
    let appearance = MenuItem::with_id(app, APPEARANCE, "Внешний вид", true, None::<&str>)?;
    let topmost = CheckMenuItem::with_id(
        app,
        TOPMOST,
        "Поверх всех окон",
        true,
        window.is_always_on_top()?,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT, "Выйти из PLIX", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&appearance, &topmost, &separator, &quit])?;
    app.manage(PlayerContextMenu {
        menu,
        topmost,
        opening: AtomicBool::new(false),
    });
    // One application-lifetime handler; opening a popup never installs handlers.
    app.on_menu_event(|app, event| {
        if !matches!(event.id.as_ref(), APPEARANCE | TOPMOST | QUIT) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = match event.id.as_ref() {
                APPEARANCE => appearance::open_appearance(app.clone()),
                TOPMOST => appearance::toggle_main_always_on_top(app.clone()).await,
                QUIT => lifecycle::request_quit(&app),
                _ => unreachable!(),
            };
            // Windows auto-toggles check items. Reconcile even after a failed action.
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(actual) = window.is_always_on_top() {
                    let _ = app.state::<PlayerContextMenu>().topmost.set_checked(actual);
                }
            }
            if let Err(error) = result {
                eprintln!("Player context menu action failed: {error}");
                let _ = appearance::open_appearance(app);
            }
        });
    });
    Ok(())
}

struct PopupGuard<'a>(&'a AtomicBool);

impl<'a> PopupGuard<'a> {
    fn acquire(opening: &'a AtomicBool) -> Option<Self> {
        opening
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(opening))
    }
}

impl Drop for PopupGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn show_player_context_menu(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Player context menu is only available in the main window".into());
    }
    // A Windows popup is modal: keep its wait off the async executor threads.
    tauri::async_runtime::spawn_blocking(move || popup(&window))
        .await
        .map_err(|error| error.to_string())?
}

fn popup(window: &tauri::WebviewWindow) -> Result<(), String> {
    let state = window.state::<PlayerContextMenu>();
    let Some(_guard) = PopupGuard::acquire(&state.opening) else {
        return Ok(());
    };
    state
        .topmost
        .set_checked(
            window
                .is_always_on_top()
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    // Tauri uses the Windows cursor position and native modal menu dismissal.
    window
        .popup_menu(&state.menu)
        .map_err(|error| error.to_string())
}

// Custom menu bridge: reuse the native popup action/lifecycle paths.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMenuState {
    always_on_top: bool,
    viewport: [u32; 2],
    work_area: [i64; 4],
}

#[tauri::command]
pub async fn player_context_menu_action(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<Option<PlayerMenuState>, String> {
    if window.label() != "main" {
        return Err("Player menu is only available in the main window".into());
    }
    if action == "state" {
        let origin = window.inner_position().map_err(|error| error.to_string())?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        let monitor = window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .ok_or("Player monitor is unavailable")?;
        let work = monitor.work_area();
        let left = i64::from(work.position.x) - i64::from(origin.x);
        let top = i64::from(work.position.y) - i64::from(origin.y);
        return Ok(Some(PlayerMenuState {
            always_on_top: window
                .is_always_on_top()
                .map_err(|error| error.to_string())?,
            viewport: [size.width, size.height],
            work_area: [
                left,
                top,
                left + i64::from(work.size.width),
                top + i64::from(work.size.height),
            ],
        }));
    }
    let app = window.app_handle().clone();
    let result = match action.as_str() {
        "appearance" => appearance::open_appearance(app.clone()),
        "topmost" => appearance::toggle_main_always_on_top(app.clone()).await,
        "quit" => lifecycle::request_quit(&app),
        _ => return Err("Unknown player menu action".into()),
    };
    if let Err(error) = result {
        let _ = appearance::open_appearance(app);
        return Err(error);
    }
    Ok(None)
}

