//! Compiled and registered only with debug assertions. No persisted settings.
use crate::media_source::{browser_source, SourceGate, SourceMode, SourceView};
use crate::{is_yandex_music, MediaContext, MediaRequest, MediaWorker};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    id: String,
    source_id: String,
    recognized_browser: bool,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    subtitle: Option<String>,
    error: Option<String>,
    capabilities: serde_json::Value,
    timeline: serde_json::Value,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionList {
    source: SourceView,
    sessions: Vec<Candidate>,
}

fn allowed(source: &str, include_unknown: bool) -> bool {
    !is_yandex_music(source) && (browser_source(source) || include_unknown)
}

pub(crate) fn list(
    context: &mut MediaContext,
    include_unknown: bool,
) -> Result<SessionList, String> {
    context.refresh_sessions().map_err(|e| e.to_string())?;
    let mut sessions = Vec::new();
    for entry in &context.sessions.entries {
        if !allowed(&entry.source, include_unknown) {
            continue;
        }
        let session = &entry.value.session;
        let metadata = (|| {
            let budget = crate::media_worker::winrt_budget()?.min(Duration::from_millis(150));
            crate::media_worker::wait_winrt(budget, session.TryGetMediaPropertiesAsync()?)
        })();
        let error = metadata.as_ref().err().map(|e| e.to_string());
        let media = metadata.ok();
        let controls = session
            .GetPlaybackInfo()
            .ok()
            .and_then(|p| p.Controls().ok());
        let capabilities = controls.map(|c| serde_json::json!({
            "play": c.IsPlayEnabled().ok(), "pause": c.IsPauseEnabled().ok(),
            "toggle": c.IsPlayPauseToggleEnabled().ok(), "next": c.IsNextEnabled().ok(),
            "previous": c.IsPreviousEnabled().ok(), "seek": c.IsPlaybackPositionEnabled().ok(),
        })).unwrap_or(serde_json::Value::Null);
        let timeline = session
            .GetTimelineProperties()
            .ok()
            .map(|t| {
                serde_json::json!({
                    "startTicks": t.StartTime().ok().map(|v| v.Duration),
                    "endTicks": t.EndTime().ok().map(|v| v.Duration),
                    "positionTicks": t.Position().ok().map(|v| v.Duration),
                    "minSeekTicks": t.MinSeekTime().ok().map(|v| v.Duration),
                    "maxSeekTicks": t.MaxSeekTime().ok().map(|v| v.Duration),
                    "lastUpdatedUtcTicks": t.LastUpdatedTime().ok().map(|v| v.UniversalTime),
                })
            })
            .unwrap_or(serde_json::Value::Null);
        sessions.push(Candidate {
            id: entry.id.clone(),
            source_id: entry.source.clone(),
            recognized_browser: browser_source(&entry.source),
            title: media
                .as_ref()
                .and_then(|m| m.Title().ok())
                .map(|v| v.to_string()),
            artist: media
                .as_ref()
                .and_then(|m| m.Artist().ok())
                .map(|v| v.to_string()),
            album: media
                .as_ref()
                .and_then(|m| m.AlbumTitle().ok())
                .map(|v| v.to_string()),
            subtitle: media
                .as_ref()
                .and_then(|m| m.Subtitle().ok())
                .map(|v| v.to_string()),
            error,
            capabilities,
            timeline,
        });
    }
    Ok(SessionList {
        source: context.source_gate.view()?,
        sessions,
    })
}

pub(crate) fn select(
    context: &mut MediaContext,
    id: &str,
    revision: &str,
    include_unknown: bool,
) -> Result<SourceView, String> {
    context.source_gate.check(revision, false)?;
    if context.source_gate.view()?.mode != SourceMode::Browser {
        return Err("Switch to Browser first".into());
    }
    context.refresh_sessions().map_err(|e| e.to_string())?;
    let entry = context
        .sessions
        .find(id)
        .ok_or("Session disappeared; refresh and choose again")?;
    if !allowed(&entry.source, include_unknown) {
        return Err("Not an eligible browser candidate".into());
    }
    context
        .source_gate
        .change(revision, SourceMode::Browser, Some(id.into()))
}

#[tauri::command]
pub(crate) async fn dev_list_media_sources(
    worker: State<'_, MediaWorker>,
    include_unknown: bool,
) -> Result<SessionList, String> {
    let requests = worker.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, result) = mpsc::channel();
        requests
            .send(MediaRequest::List(include_unknown, reply))
            .map_err(|e| e.to_string())?;
        result.recv().map_err(|e| e.to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn dev_get_media_source(source: State<'_, SourceGate>) -> Result<SourceView, String> {
    source.view()
}

#[tauri::command]
pub(crate) fn dev_set_media_mode(
    app: tauri::AppHandle,
    source: State<'_, SourceGate>,
    mode: SourceMode,
    revision: String,
) -> Result<SourceView, String> {
    let view = source.change(&revision, mode, None)?;
    let _ = app.emit_to("main", "plix:media-source-changed", &view);
    Ok(view)
}

#[tauri::command]
pub(crate) async fn dev_select_media_session(
    app: tauri::AppHandle,
    worker: State<'_, MediaWorker>,
    id: String,
    revision: String,
    include_unknown: bool,
) -> Result<SourceView, String> {
    let requests = worker.0.clone();
    let view = tauri::async_runtime::spawn_blocking(move || {
        let (reply, result) = mpsc::channel();
        requests
            .send(MediaRequest::Select(id, revision, include_unknown, reply))
            .map_err(|e| e.to_string())?;
        result.recv().map_err(|e| e.to_string())?
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit_to("main", "plix:media-source-changed", &view);
    Ok(view)
}

#[tauri::command]
pub(crate) async fn dev_open_media_sources(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("media-sources") {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "media-sources",
        tauri::WebviewUrl::App("index.html?window=media-sources".into()),
    )
    .title("PLIX · DEV media sources")
    .inner_size(720.0, 650.0)
    .decorations(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
