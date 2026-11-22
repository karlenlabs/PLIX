//! Session identity and command admission, shared by GSMTC and Core Audio.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SourceMode {
    #[default]
    Desktop,
    Browser,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceView {
    pub mode: SourceMode,
    pub revision: String,
    pub selected_id: Option<String>,
}

struct State {
    view: SourceView,
    writes: usize,
}

#[derive(Clone)]
pub(crate) struct SourceGate(Arc<Mutex<State>>);

impl Default for SourceGate {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(State {
            view: SourceView {
                mode: SourceMode::Desktop,
                revision: "1".into(),
                selected_id: None,
            },
            writes: 0,
        })))
    }
}

impl SourceGate {
    pub fn view(&self) -> Result<SourceView, String> {
        self.0
            .lock()
            .map(|s| s.view.clone())
            .map_err(|_| "Source lock poisoned".into())
    }

    pub fn check(&self, revision: &str, desktop_only: bool) -> Result<(), String> {
        let view = self.view()?;
        if view.revision != revision || (desktop_only && view.mode != SourceMode::Desktop) {
            return Err("Source changed; stale request rejected".into());
        }
        Ok(())
    }

    pub fn change(
        &self,
        expected: &str,
        mode: SourceMode,
        selected_id: Option<String>,
    ) -> Result<SourceView, String> {
        let mut state = self
            .0
            .try_lock()
            .map_err(|_| "Source is busy; retry".to_string())?;
        if state.view.revision != expected {
            return Err("Source changed; refresh the selection".into());
        }
        if state.view.mode == mode && state.view.selected_id == selected_id {
            return Ok(state.view.clone());
        }
        if state.writes != 0 {
            return Err("A playback/volume command is in flight; retry after it finishes".into());
        }
        let revision = state
            .view
            .revision
            .parse::<u64>()
            .unwrap()
            .checked_add(1)
            .ok_or("Source revision exhausted")?;
        state.view = SourceView {
            mode,
            revision: revision.to_string(),
            selected_id,
        };
        Ok(state.view.clone())
    }

    // Admission and source changes share one lock. Never hold it across Windows calls.
    pub fn admit(&self, revision: &str, desktop_only: bool) -> Result<WritePermit, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Source lock poisoned".to_string())?;
        if state.view.revision != revision
            || (desktop_only && state.view.mode != SourceMode::Desktop)
        {
            return Err("Source changed; stale command rejected".into());
        }
        state.writes += 1;
        Ok(WritePermit(self.clone()))
    }
}

pub(crate) struct WritePermit(SourceGate);
impl Drop for WritePermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.writes -= 1;
        }
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct Entry<T> {
    pub id: String,
    pub identity: usize,
    pub source: String,
    pub value: T,
}

pub(crate) struct Registry<T> {
    pub entries: Vec<Entry<T>>,
}

impl<T> Default for Registry<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<T> Registry<T> {
    // The caller retains the canonical IUnknown with the value. Neither index,
    // AUMID nor track metadata is used as a session identity.
    pub fn refresh(&mut self, values: Vec<(usize, String, T)>) {
        let old = std::mem::take(&mut self.entries);
        self.entries = values
            .into_iter()
            .map(|(identity, source, value)| {
                let id = old
                    .iter()
                    .find(|entry| entry.identity == identity && entry.source == source)
                    .map(|entry| entry.id.clone())
                    .unwrap_or_else(|| {
                        format!("session-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
                    });
                Entry {
                    id,
                    identity,
                    source,
                    value,
                }
            })
            .collect();
    }
    pub fn find(&self, id: &str) -> Option<&Entry<T>> {
        self.entries.iter().find(|entry| entry.id == id)
    }
}

#[cfg(debug_assertions)]
pub(crate) fn browser_source(source: &str) -> bool {
    let source = source.to_ascii_lowercase();
    matches!(
        source.as_str(),
        "chrome" | "chrome.exe" | "msedge" | "msedge.exe" | "browser.exe" | "yandexbrowser"
    ) || [
        "chrome.",
        "msedge.",
        "yandex.",
        "yandexbrowser.",
        "microsoft.microsoftedge_",
    ]
    .iter()
    .any(|prefix| source.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_identity_survives_reordering_but_not_disappearance_or_recovery() {
        let mut registry = Registry::default();
        registry.refresh(vec![(10, "Chrome".into(), ()), (20, "Chrome".into(), ())]);
        let first = registry.entries[0].id.clone();
        let second = registry.entries[1].id.clone();
        assert_ne!(first, second); // Same app, even same track, different objects.
        registry.refresh(vec![(20, "Chrome".into(), ()), (10, "Chrome".into(), ())]);
        assert_eq!(registry.entries[0].id, second);
        assert_eq!(registry.entries[1].id, first);
        registry.refresh(vec![]);
        registry.refresh(vec![(10, "Chrome".into(), ())]);
        assert_ne!(registry.entries[0].id, first);
        let mut recovered = Registry::default();
        recovered.refresh(vec![(10, "Chrome".into(), ())]);
        assert_ne!(recovered.entries[0].id, registry.entries[0].id);
    }

    #[test]
    fn old_commands_cannot_cross_browser_desktop_round_trip() {
        let gate = SourceGate::default();
        let desktop = gate.view().unwrap();
        let browser = gate
            .change(&desktop.revision, SourceMode::Browser, None)
            .unwrap();
        assert!(gate.admit(&desktop.revision, false).is_err());
        assert!(gate.admit(&browser.revision, true).is_err());
        let desktop2 = gate
            .change(&browser.revision, SourceMode::Desktop, None)
            .unwrap();
        assert!(gate.admit(&desktop.revision, true).is_err());
        assert!(gate.admit(&desktop2.revision, true).is_ok());
    }

    #[test]
    fn selection_changes_are_rejected_while_a_native_write_is_admitted() {
        let gate = SourceGate::default();
        let original = gate.view().unwrap();
        let permit = gate.admit(&original.revision, true).unwrap();
        assert!(gate
            .change(&original.revision, SourceMode::Browser, None)
            .is_err());
        drop(permit);
        let changed = gate
            .change(
                &original.revision,
                SourceMode::Browser,
                Some("session-a".into()),
            )
            .unwrap();
        assert!(gate
            .change(&original.revision, SourceMode::Desktop, None)
            .is_err());
        let next = gate
            .change(
                &changed.revision,
                SourceMode::Browser,
                Some("session-b".into()),
            )
            .unwrap();
        assert!(gate.admit(&changed.revision, false).is_err());
        assert!(gate.admit(&next.revision, false).is_ok());
    }
}
