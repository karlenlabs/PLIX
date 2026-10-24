//! M01: only the existing unversioned schema is writable.
//! Unknown data is a safe refusal, not evidence of semantic compatibility.
use super::{MainWindowPosition, Settings, StoredSettings};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Problem {
    Corrupt,
    Unsupported,
    ReadError,
}

#[derive(Clone, Debug)]
pub(super) enum Storage {
    Missing,
    Loaded,
    Protected(Arc<Protection>),
}

#[derive(Debug)]
pub(super) struct Protection {
    pub(super) problem: Problem,
    // Keep exact bytes in memory even if writing the copy fails.
    pub(super) original: Option<Vec<u8>>,
    pub(super) backup: Result<PathBuf, String>,
    detail: String,
}

impl Storage {
    pub(super) fn is_protected(&self) -> bool {
        matches!(self, Self::Protected(_))
    }

    pub(super) fn require_writable(&self) -> Result<(), String> {
        match self {
            Self::Missing | Self::Loaded => Ok(()),
            Self::Protected(protection) => Err(format!(
                "Settings protected ({:?}): {}. Original bytes: {}. Backup: {}. \
                 Automatic writes disabled; stop PLIX, explicitly restore a known-good \
                 file with scripts/restore-appearance.ps1, then restart.",
                protection.problem,
                protection.detail,
                protection.original.as_ref().map_or_else(
                    || "unavailable (read failed)".into(),
                    |bytes| bytes.len().to_string()
                ),
                protection.backup.as_ref().map_or_else(
                    |error| format!("unavailable ({error}); original path is untouched"),
                    |path| path.display().to_string()
                ),
            )),
        }
    }
}

fn unknown_key(value: &Value, allowed: &[&str], scope: &str) -> Option<String> {
    value.as_object()?.keys().find_map(|key| {
        (!allowed.contains(&key.as_str())).then(|| format!("unknown field {scope}.{key}"))
    })
}

fn decode(bytes: &[u8]) -> Result<StoredSettings, (Problem, String)> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|error| (Problem::Corrupt, error.to_string()))?;
    // Known removed legacy fields keep their historical ignore/drop migration.
    let unsupported = unknown_key(
        &value,
        &[
            "theme",
            "alwaysOnTop",
            "visualization",
            "visualEffectsEnabled",
            "ambientHazeEnabled",
            "ambientHazeIntensity",
            "hybridPaletteEnabled",
            "main_window_position",
            "opacity",
            "blurPx",
        ],
        "appearance",
    )
    .or_else(|| {
        unknown_key(
            &value["main_window_position"],
            &["x", "y", "monitor"],
            "position",
        )
    })
    .or_else(|| {
        unknown_key(
            &value["main_window_position"]["monitor"],
            &["name", "x", "y", "scale_factor"],
            "monitor",
        )
    })
    .or_else(|| {
        [
            ("theme", &["system", "dark", "light"][..]),
            (
                "visualization",
                &["Off", "Karlen Baseline", "Karlen Dense", "Karlen 3"][..],
            ),
        ]
        .into_iter()
        .find_map(|(key, allowed)| {
            value[key].as_str().and_then(|text| {
                (!allowed.contains(&text)).then(|| format!("unknown {key} value {text:?}"))
            })
        })
    });
    if let Some(reason) = unsupported {
        return Err((Problem::Unsupported, reason));
    }
    // Use original bytes, retaining Serde's field validation and migrations.
    serde_json::from_slice(bytes).map_err(|error| (Problem::Corrupt, error.to_string()))
}

fn backup(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(
        ".protected-{stamp}-{}-{}.bak",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let copy = PathBuf::from(name);
    // Never rename/delete the source or overwrite an earlier backup.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&copy)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if fs::read(&copy).map_err(|error| error.to_string())? != bytes {
        return Err("backup verification failed".into());
    }
    Ok(copy)
}

pub(super) fn load(path: &Path) -> (Settings, Option<MainWindowPosition>, Storage) {
    let (problem, detail, original) = match fs::read(path) {
        Ok(bytes) => match decode(&bytes) {
            Ok(stored) => {
                return (
                    stored.settings,
                    stored.main_window_position,
                    Storage::Loaded,
                )
            }
            Err((problem, detail)) => (problem, detail, Some(bytes)),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Settings::default(), None, Storage::Missing);
        }
        Err(error) => (Problem::ReadError, error.to_string(), None),
    };
    let backup = original.as_ref().map_or_else(
        || Err("source bytes could not be read".into()),
        |bytes| backup(path, bytes),
    );
    (
        Settings::default(),
        None,
        Storage::Protected(Arc::new(Protection {
            problem,
            original,
            backup,
            detail,
        })),
    )
}
