use crate::appearance::Appearance;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MainWindowPosition {
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub monitor: Option<SavedMonitor>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SavedMonitor {
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
}

struct DesktopMonitor {
    saved: SavedMonitor,
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
}

impl From<tauri::Monitor> for DesktopMonitor {
    fn from(monitor: tauri::Monitor) -> Self {
        Self {
            saved: SavedMonitor {
                name: monitor.name().cloned(),
                x: monitor.position().x,
                y: monitor.position().y,
                scale_factor: monitor.scale_factor(),
            },
            work_position: monitor.work_area().position,
            work_size: monitor.work_area().size,
        }
    }
}

fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn clamp_to_monitor(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitor: &DesktopMonitor,
) -> PhysicalPosition<i32> {
    fn clamp_axis(value: i32, origin: i32, extent: u32, window_extent: u32) -> i32 {
        let start = i64::from(origin);
        // If the unchanged window is larger than the work area, keep its top-left accessible.
        let end = start + i64::from(extent.saturating_sub(window_extent));
        i64::from(value).clamp(start, end).min(i64::from(i32::MAX)) as i32
    }
    PhysicalPosition::new(
        clamp_axis(
            position.x,
            monitor.work_position.x,
            monitor.work_size.width,
            size.width,
        ),
        clamp_axis(
            position.y,
            monitor.work_position.y,
            monitor.work_size.height,
            size.height,
        ),
    )
}

fn target_position(
    saved: &MainWindowPosition,
    monitors: &[DesktopMonitor],
    current_size: PhysicalSize<u32>,
    current_scale: f64,
) -> Option<PhysicalPosition<i32>> {
    let size_on = |monitor: &DesktopMonitor| {
        // Predict the physical extent after a DPI change; never set the window size.
        let ratio = valid_scale(monitor.saved.scale_factor) / valid_scale(current_scale);
        PhysicalSize::new(
            (f64::from(current_size.width) * ratio).ceil() as u32,
            (f64::from(current_size.height) * ratio).ceil() as u32,
        )
    };
    let previous_monitor = saved.monitor.as_ref();
    if let Some((previous, monitor)) = previous_monitor.and_then(|previous| {
        monitors
            .iter()
            .find(|monitor| previous.name.is_some() && previous.name == monitor.saved.name)
            .map(|monitor| (previous, monitor))
    }) {
        // Preserve the monitor-local logical offset when the desktop origin/DPI changes.
        let ratio = valid_scale(monitor.saved.scale_factor) / valid_scale(previous.scale_factor);
        let position = PhysicalPosition::new(
            (f64::from(monitor.saved.x) + (f64::from(saved.x) - f64::from(previous.x)) * ratio)
                .round() as i32,
            (f64::from(monitor.saved.y) + (f64::from(saved.y) - f64::from(previous.y)) * ratio)
                .round() as i32,
        );
        return Some(clamp_to_monitor(position, size_on(monitor), monitor));
    }

    // No matching monitor: choose the closest fully visible placement on any current monitor.
    let original = PhysicalPosition::new(saved.x, saved.y);
    monitors
        .iter()
        .map(|monitor| clamp_to_monitor(original, size_on(monitor), monitor))
        .min_by_key(|position| {
            let dx = i128::from(position.x) - i128::from(saved.x);
            let dy = i128::from(position.y) - i128::from(saved.y);
            dx * dx + dy * dy
        })
}

pub fn restore(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(saved) = app.state::<Appearance>().main_window_position()? else {
        return Ok(());
    };
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is missing")?;
    let monitors: Vec<_> = window
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(DesktopMonitor::from)
        .filter(|monitor| monitor.work_size.width > 0 && monitor.work_size.height > 0)
        .collect();
    let position = target_position(
        &saved,
        &monitors,
        window.outer_size().map_err(|error| error.to_string())?,
        window.scale_factor().map_err(|error| error.to_string())?,
    )
    .ok_or("No available monitor for main window")?;
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    // A native cross-monitor DPI transition can adjust the suggested position/extent.
    // Reapply using the actual extent on the destination, without changing the size.
    let final_position = target_position(
        &saved,
        &monitors,
        window.outer_size().map_err(|error| error.to_string())?,
        window.scale_factor().map_err(|error| error.to_string())?,
    )
    .ok_or("No available monitor for main window")?;
    if window.outer_position().map_err(|error| error.to_string())? != final_position {
        window
            .set_position(final_position)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub struct PositionPersistence(Sender<()>);

impl PositionPersistence {
    pub fn start(app: tauri::AppHandle) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("main-window-position".into())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    // Coalesce drag events; flush the latest shared state after the drag pauses.
                    loop {
                        match receiver.recv_timeout(Duration::from_millis(300)) {
                            Ok(()) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    if let Err(error) = app.state::<Appearance>().save_main_window_position() {
                        eprintln!("Failed to save main window position: {error}");
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self(sender))
    }
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let Some(persistence) = window.app_handle().try_state::<PositionPersistence>() else {
        return; // Window creation/setup precedes restoration and persistence registration.
    };
    let close = matches!(event, tauri::WindowEvent::CloseRequested { .. });
    if !close && !matches!(event, tauri::WindowEvent::Moved(_)) {
        return;
    }
    let result = (|| {
        let state = window.app_handle().state::<Appearance>();
        if !window.is_minimized().map_err(|error| error.to_string())? {
            // Read the live position, not a queued startup Moved event's stale coordinates.
            let position = window.outer_position().map_err(|error| error.to_string())?;
            let monitor = window
                .current_monitor()
                .map_err(|error| error.to_string())?
                .map(|monitor| DesktopMonitor::from(monitor).saved);
            state.update_main_window_position(MainWindowPosition {
                x: position.x,
                y: position.y,
                monitor,
            })?;
        }
        if close {
            // Complete the final write before main closes, even with a pending debounce.
            state.save_main_window_position()
        } else {
            persistence.0.send(()).map_err(|error| error.to_string())
        }
    })();
    if let Err(error) = result {
        eprintln!("Failed to persist main window position: {error}");
    }
}

