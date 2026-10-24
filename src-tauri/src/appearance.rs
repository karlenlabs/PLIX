use crate::window_position::MainWindowPosition;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

#[path = "appearance_storage.rs"]
mod storage;

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Visualization {
    Off,
    #[serde(rename = "Karlen Baseline")]
    Baseline,
    #[default]
    #[serde(rename = "Karlen Dense")]
    Dense,
    #[serde(rename = "Karlen 3")]
    Three,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
// Normalize legacy Off only in memory; saving uses one flag plus the selected preset.
#[serde(from = "StoredAppearance")]
pub struct Settings {
    pub theme: Theme,
    #[serde(default = "default_always_on_top", rename = "alwaysOnTop")]
    pub always_on_top: bool,
    #[serde(default)]
    pub visualization: Visualization,
    #[serde(rename = "visualEffectsEnabled")]
    pub visual_effects_enabled: bool,
    #[serde(rename = "ambientHazeEnabled")]
    pub ambient_haze_enabled: bool,
    #[serde(rename = "ambientHazeIntensity")]
    pub ambient_haze_intensity: f64,
    #[serde(rename = "hybridPaletteEnabled")]
    pub hybrid_palette_enabled: bool,
}

#[derive(serde::Deserialize)]
struct StoredAppearance {
    theme: Theme,
    #[serde(default = "default_always_on_top", rename = "alwaysOnTop")]
    always_on_top: bool,
    #[serde(default)]
    visualization: Visualization,
    #[serde(
        default,
        rename = "visualEffectsEnabled",
        deserialize_with = "optional_effects"
    )]
    visual_effects_enabled: Option<bool>,
    #[serde(default, rename = "ambientHazeEnabled")]
    ambient_haze_enabled: bool,
    #[serde(
        default = "default_haze_intensity",
        rename = "ambientHazeIntensity",
        deserialize_with = "haze_intensity"
    )]
    ambient_haze_intensity: f64,
    #[serde(
        default = "default_hybrid_palette_enabled",
        rename = "hybridPaletteEnabled"
    )]
    hybrid_palette_enabled: bool,
}

fn default_hybrid_palette_enabled() -> bool {
    true
}

fn default_haze_intensity() -> f64 {
    35.0
}

fn haze_intensity<'de, D: serde::Deserializer<'de>>(input: D) -> Result<f64, D::Error> {
    let value = <f64 as serde::Deserialize>::deserialize(input)?;
    if value.is_finite() && (0.0..=100.0).contains(&value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(
            "Ambient Haze intensity must be between 0 and 100",
        ))
    }
}

fn optional_effects<'de, D: serde::Deserializer<'de>>(input: D) -> Result<Option<bool>, D::Error> {
    <bool as serde::Deserialize>::deserialize(input).map(Some)
}

impl From<StoredAppearance> for Settings {
    fn from(stored: StoredAppearance) -> Self {
        Self {
            theme: stored.theme,
            always_on_top: stored.always_on_top,
            visualization: if stored.visualization == Visualization::Off {
                Visualization::default()
            } else {
                stored.visualization
            },
            visual_effects_enabled: stored
                .visual_effects_enabled
                .unwrap_or(stored.visualization != Visualization::Off),
            ambient_haze_enabled: stored.ambient_haze_enabled,
            ambient_haze_intensity: stored.ambient_haze_intensity,
            hybrid_palette_enabled: stored.hybrid_palette_enabled,
        }
    }
}

fn default_always_on_top() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            always_on_top: true,
            visualization: Visualization::default(),
            visual_effects_enabled: true,
            ambient_haze_enabled: false,
            ambient_haze_intensity: default_haze_intensity(),
            hybrid_palette_enabled: true,
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    settings: Settings,
    revision: u64,
    save_error: Option<String>,
    #[serde(skip)]
    main_window_position: Option<MainWindowPosition>,
    #[serde(skip)]
    storage: storage::Storage,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredSettings {
    #[serde(flatten)]
    settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    main_window_position: Option<MainWindowPosition>,
}

pub struct Appearance {
    path: PathBuf,
    // Backend settings writers only. UI callbacks and position persistence must
    // never acquire this lock: its owner may be waiting for the UI thread.
    change: Mutex<()>,
    shutdown_sealed: std::sync::atomic::AtomicBool,
    snapshot: Mutex<Snapshot>,
}

/// IPC-only field intent, merged under the existing settings transaction.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    #[serde(default, deserialize_with = "patch_value")]
    theme: Option<Theme>,
    #[serde(default, deserialize_with = "patch_value")]
    always_on_top: Option<bool>,
    #[serde(default, deserialize_with = "patch_value")]
    visualization: Option<Visualization>,
    #[serde(default, deserialize_with = "patch_value")]
    visual_effects_enabled: Option<bool>,
    #[serde(default, deserialize_with = "patch_value")]
    ambient_haze_enabled: Option<bool>,
    #[serde(default, deserialize_with = "patch_haze_intensity")]
    ambient_haze_intensity: Option<f64>,
    #[serde(default, deserialize_with = "patch_value")]
    hybrid_palette_enabled: Option<bool>,
}

fn patch_haze_intensity<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Option<f64>, D::Error> {
    haze_intensity(input).map(Some)
}

fn patch_value<'de, D, T>(input: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(input).map(Some)
}

impl SettingsPatch {
    fn apply(self, current: &Settings) -> Settings {
        Settings {
            theme: self.theme.unwrap_or(current.theme),
            always_on_top: self.always_on_top.unwrap_or(current.always_on_top),
            visualization: match self.visualization {
                Some(Visualization::Off) => Visualization::default(),
                value => value.unwrap_or(current.visualization),
            },
            visual_effects_enabled: self.visual_effects_enabled.unwrap_or_else(|| {
                if self.visualization == Some(Visualization::Off) {
                    false
                } else {
                    current.visual_effects_enabled
                }
            }),
            ambient_haze_enabled: self
                .ambient_haze_enabled
                .unwrap_or(current.ambient_haze_enabled),
            ambient_haze_intensity: self
                .ambient_haze_intensity
                .unwrap_or(current.ambient_haze_intensity),
            hybrid_palette_enabled: self
                .hybrid_palette_enabled
                .unwrap_or(current.hybrid_palette_enabled),
        }
    }
}

impl Appearance {
    pub fn load(path: PathBuf) -> Self {
        let (settings, main_window_position, storage) = storage::load(&path);
        let save_error = storage.require_writable().err();
        if let Some(error) = &save_error {
            eprintln!("{error}");
        }
        Self {
            path,
            change: Mutex::new(()),
            shutdown_sealed: std::sync::atomic::AtomicBool::new(false),
            snapshot: Mutex::new(Snapshot {
                settings,
                revision: 0,
                save_error,
                main_window_position,
                storage,
            }),
        }
    }

    pub fn apply_visualizer_request(
        &self,
        visualizer: &crate::visualizer::Visualizer,
        requested: bool,
    ) -> Result<(), String> {
        // Hold the same settings lock as set_appearance, so a late frontend
        // activation cannot race past disabling effects.
        let snapshot = self.snapshot.lock().map_err(|error| error.to_string())?;
        visualizer.set_enabled(
            requested
                && snapshot.settings.visual_effects_enabled
                && snapshot.settings.visualization != Visualization::Off,
        )
    }

    pub fn main_window_position(&self) -> Result<Option<MainWindowPosition>, String> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.main_window_position.clone())
            .map_err(|error| error.to_string())
    }

    pub fn update_main_window_position(&self, position: MainWindowPosition) -> Result<(), String> {
        self.snapshot
            .lock()
            .map(|mut snapshot| snapshot.main_window_position = Some(position))
            .map_err(|error| error.to_string())
    }

    pub fn save_main_window_position(&self) -> Result<(), String> {
        let snapshot = self.snapshot.lock().map_err(|error| error.to_string())?;
        // Move/Close is not consent to recover a protected document.
        if snapshot.storage.is_protected() {
            return Ok(());
        }
        save_snapshot(&self.path, &snapshot)
    }

    // Final shutdown persistence shares H01's backend-only gate. Wait for an
    // accepted settings transaction, then atomically save the latest native state.
    // Seal later settings writers only after successful persistence. Position
    // callbacks still use snapshot alone and cannot participate in a UI wait cycle.
    pub fn save_for_shutdown(&self) -> Result<(), String> {
        let _change = self.change.lock().map_err(|error| error.to_string())?;
        let snapshot = self.snapshot.lock().map_err(|error| error.to_string())?;
        // H02 can finish Quit with the protected document deliberately untouched.
        // Writable-file failures still use the existing H02 retry policy.
        if !snapshot.storage.is_protected() {
            save_snapshot(&self.path, &snapshot)?;
        }
        self.shutdown_sealed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    // Existing H01/H02 fixtures also exercise complete replacements. Production
    // commands use field intent through the same transaction below.

    fn change_settings_with(
        &self,
        settings: impl FnOnce(&Settings) -> Option<Settings>,
        read_topmost: impl FnOnce() -> Result<bool, String>,
        apply_topmost: impl FnOnce(bool) -> Result<(), String>,
        synchronize: impl FnOnce(&Settings) -> Result<(), String>,
        mut publish: impl FnMut(&Snapshot) -> Result<(), String>,
    ) -> Result<(), String> {
        // Serialize read/apply/commit/publish/save against other settings writers,
        // without making the UI wait for a lock held across a native UI request.
        let _change = self.change.lock().map_err(|error| error.to_string())?;
        if self
            .shutdown_sealed
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return Err("Application shutdown is already committed".into());
        }
        let mut next = self
            .snapshot
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        // Reject before native calls/commit; save_error is not the write gate.
        // Only explicit offline recovery followed by restart removes protection.
        next.storage.require_writable()?;
        // Resolve the request only after H01 has serialized writers and read the
        // newest snapshot; unrelated fields must never come from a stale draft.
        if let Some(settings) = settings(&next.settings) {
            update_settings(&mut next, settings, apply_topmost)?;
        } else {
            toggle_topmost(&mut next, read_topmost()?, apply_topmost)?;
        }
        let committed = {
            let mut snapshot = self.snapshot.lock().map_err(|error| error.to_string())?;
            // Only this gate's owner changes settings/revision after setup. Position
            // callbacks can run during native calls; retain their latest coordinates.
            snapshot.settings = next.settings;
            snapshot.revision = next.revision;
            snapshot.save_error = next.save_error;
            // Keep the existing visualizer activation ordering under snapshot.
            synchronize(&snapshot.settings)?;
            snapshot.clone()
        };
        // No UI dispatch (including event publication) while snapshot is locked.
        publish(&committed)?;
        let (result, persisted) = {
            let mut snapshot = self.snapshot.lock().map_err(|error| error.to_string())?;
            // Position saves use this same lock and file, so no stale snapshot can
            // overwrite a newer position or a committed Appearance update.
            let result = save_snapshot(&self.path, &snapshot);
            snapshot.save_error = result.as_ref().err().cloned();
            (result, snapshot.clone())
        };
        publish(&persisted)?;
        result
    }
}

fn save_snapshot(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    snapshot.storage.require_writable()?;
    save(
        path,
        &snapshot.settings,
        snapshot.main_window_position.clone(),
    )
}

fn save(
    path: &Path,
    settings: &Settings,
    main_window_position: Option<MainWindowPosition>,
) -> Result<(), String> {
    let directory = path.parent().ok_or("Settings directory is missing")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    // Same directory/volume, unique per process; never truncate the current settings.
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| {
        let stored = StoredSettings {
            settings: settings.clone(),
            main_window_position,
        };
        let bytes = serde_json::to_vec_pretty(&stored).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub fn get_appearance(state: tauri::State<'_, Appearance>) -> Result<Snapshot, String> {
    state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|error| error.to_string())
}

fn set_main_always_on_top(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("Main window is missing")?
        .set_always_on_top(enabled)
        .map_err(|error| format!("Failed to apply always on top: {error}"))
}

pub fn restore_main_always_on_top(app: &tauri::AppHandle) -> Result<(), String> {
    // Setup-only, before commands/callback persistence are registered. Even here,
    // release snapshot before native calls (including the failure-path getter).
    let state = app.state::<Appearance>();
    let enabled = state
        .snapshot
        .lock()
        .map_err(|error| error.to_string())?
        .settings
        .always_on_top;
    if let Err(error) = set_main_always_on_top(app, enabled) {
        // Keep the UI truthful if restoration failed; the configured default is true.
        let actual = app
            .get_webview_window("main")
            .and_then(|window| window.is_always_on_top().ok())
            .unwrap_or(true);
        let mut snapshot = state.snapshot.lock().map_err(|error| error.to_string())?;
        snapshot.settings.always_on_top = actual;
        snapshot.save_error = Some(error.clone());
        return Err(error);
    }
    Ok(())
}

fn update_settings(
    snapshot: &mut Snapshot,
    settings: Settings,
    apply_topmost: impl FnOnce(bool) -> Result<(), String>,
) -> Result<(), String> {
    if snapshot.settings.always_on_top != settings.always_on_top {
        // Do not publish or save the requested value until Tauri accepts it.
        apply_topmost(settings.always_on_top)?;
    }
    snapshot.settings = settings;
    snapshot.revision += 1;
    snapshot.save_error = None;
    Ok(())
}

#[tauri::command]
pub async fn set_appearance(app: tauri::AppHandle, settings: SettingsPatch) -> Result<(), String> {
    change_appearance(app, Some(settings)).await
}

pub async fn toggle_main_always_on_top(app: tauri::AppHandle) -> Result<(), String> {
    change_appearance(app, None).await
}

fn toggle_topmost(
    snapshot: &mut Snapshot,
    actual: bool,
    apply_topmost: impl FnOnce(bool) -> Result<(), String>,
) -> Result<(), String> {
    // Base the toggle on HWND state; commit only after the existing native setter succeeds.
    let mut next = snapshot.clone();
    next.settings.always_on_top = actual;
    let settings = Settings {
        always_on_top: !actual,
        ..snapshot.settings.clone()
    };
    update_settings(&mut next, settings, apply_topmost)?;
    *snapshot = next;
    Ok(())
}

async fn change_appearance(
    app: tauri::AppHandle,
    settings: Option<SettingsPatch>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Appearance>();
        state.change_settings_with(
            move |current| settings.map(|patch| patch.apply(current)),
            || {
                app.get_webview_window("main")
                    .ok_or("Main window is missing")?
                    .is_always_on_top()
                    .map_err(|error| error.to_string())
            },
            |enabled| set_main_always_on_top(&app, enabled),
            |settings| {
                if !settings.visual_effects_enabled {
                    app.state::<crate::visualizer::Visualizer>()
                        .set_enabled(false)?;
                }
                Ok(())
            },
            |snapshot| {
                app.emit("appearance-changed", snapshot)
                    .map_err(|error| error.to_string())
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_appearance(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("appearance")
        .ok_or("Appearance window is missing")?;
    crate::appearance_position::position(&app)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}







