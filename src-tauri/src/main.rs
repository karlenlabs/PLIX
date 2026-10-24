#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;
mod appearance_position;
mod lifecycle;
mod media_worker;
mod player_context_menu;
mod tray_playback;
mod visualizer;
mod volume;
mod volume_worker;
mod window_position;
mod yandex_app;


use appearance::{get_appearance, open_appearance, set_appearance, Appearance};
use base64::Engine;
use lifecycle::{finish_lifecycle, get_lifecycle_request};
use media_worker::RecoveringWorker;
use std::sync::mpsc::{self, Sender};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use volume::{AudioVolume, VolumeChange};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

// Only the wait policy changes; each operation still executes once on the MTA.
macro_rules! wait_winrt {
    ($operation:expr) => {{
        // Check before starting an operation, including any late continuation.
        let budget = media_worker::winrt_budget()?;
        let operation = $operation?;
        media_worker::wait_winrt(budget, operation)
    }};
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaState {
    source_id: String,
    title: Option<String>,
    artist: Option<String>,
    playback_state: &'static str,
    duration_ms: Option<i64>,
    position_ms: Option<i64>,
    can_play: bool,
    can_pause: bool,
    can_previous: bool,
    can_next: bool,
    can_seek: bool,
    seek_min_ms: Option<i64>,
    seek_max_ms: Option<i64>,
    track_key: Option<String>,
    artwork: Option<ArtworkUpdate>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtworkUpdate {
    data_url: Option<String>,
}

#[derive(Default)]
struct ArtworkCache {
    track_key: String,
    image: Option<(String, Vec<u8>)>,
}

enum MediaRequest {
    Seek(i64, String, Sender<Result<bool, String>>),
    Read(bool, Sender<Result<Option<MediaState>, String>>),
    Control(ControlAction, Sender<Result<bool, String>>),
}

#[derive(Clone, Copy)]
enum ControlAction {
    PlayPause,
    Previous,
    Next,
}

struct MediaWorker(Sender<MediaRequest>);

struct WinRtApartment;

impl WinRtApartment {
    fn new() -> windows::core::Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        Ok(Self)
    }
}

impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

// All Windows interfaces stay inside the lane. Drop the manager before its MTA.
struct MediaContext {
    manager: SessionManager,
    artwork_cache: ArtworkCache,
    _apartment: WinRtApartment,
}

impl MediaContext {
    fn new() -> windows::core::Result<Self> {
        let apartment = WinRtApartment::new()?;
        let manager = wait_winrt!(SessionManager::RequestAsync())?;
        Ok(Self {
            manager,
            artwork_cache: ArtworkCache::default(),
            _apartment: apartment,
        })
    }
}

impl MediaWorker {
    fn new() -> Self {
        let (requests, replies) = mpsc::channel::<MediaRequest>();
        std::thread::spawn(move || {
            let mut worker =
                RecoveringWorker::new(|| MediaContext::new().map_err(|error| error.to_string()));
            for request in replies {
                match request {
                    MediaRequest::Seek(position, key, reply) => {
                        let result = worker.execute(move |state| {
                            seek_media(&state.manager, position, &key)
                                .map_err(|error| error.to_string())
                        });
                        let _ = reply.send(result);
                    }
                    MediaRequest::Read(reset_artwork, reply) => {
                        let result = worker.execute(move |state| {
                            if reset_artwork {
                                state.artwork_cache = ArtworkCache::default();
                            }
                            read_media_state(&state.manager, &mut state.artwork_cache)
                                .map_err(|error| error.to_string())
                        });
                        let _ = reply.send(result);
                    }
                    MediaRequest::Control(action, reply) => {
                        let result = worker.execute(move |state| {
                            control_media(&state.manager, action).map_err(|error| error.to_string())
                        });
                        let _ = reply.send(result);
                    }
                }
            }
        });
        Self(requests)
    }
}

#[tauri::command]
async fn get_media_state(
    app: tauri::AppHandle,
    worker: State<'_, MediaWorker>,
    reset_artwork: bool,
) -> Result<Option<MediaState>, String> {
    let requests = worker.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let read = (|| {
            let (reply, result) = mpsc::channel();
            requests
                .send(MediaRequest::Read(reset_artwork, reply))
                .map_err(|_| "Media worker stopped".to_string())?;
            result
                .recv()
                .map_err(|_| "Media worker stopped".to_string())?
        })();
        tray_playback::sync(&app, &read);
        read
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn send_volume(
    worker: State<'_, volume_worker::VolumeWorker>,
    target: Option<(String, VolumeChange)>,
) -> Result<Option<AudioVolume>, String> {
    volume_worker::send_volume(&worker, target).await
}

#[tauri::command]
async fn get_volume(
    worker: State<'_, volume_worker::VolumeWorker>,
) -> Result<Option<AudioVolume>, String> {
    send_volume(worker, None).await
}

#[tauri::command]
async fn set_volume(
    worker: State<'_, volume_worker::VolumeWorker>,
    session_id: String,
    level: f32,
) -> Result<Option<AudioVolume>, String> {
    if !level.is_finite() || !(0.0..=1.0).contains(&level) {
        return Err("Volume must be between 0 and 1".to_string());
    }
    send_volume(worker, Some((session_id, VolumeChange::Level(level)))).await
}

#[tauri::command]
async fn set_mute(
    worker: State<'_, volume_worker::VolumeWorker>,
    session_id: String,
    muted: bool,
) -> Result<Option<AudioVolume>, String> {
    send_volume(worker, Some((session_id, VolumeChange::Mute(muted)))).await
}

async fn send_control(
    worker: State<'_, MediaWorker>,
    action: ControlAction,
) -> Result<bool, String> {
    let requests = worker.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, result) = mpsc::channel();
        requests
            .send(MediaRequest::Control(action, reply))
            .map_err(|_| "Media worker stopped".to_string())?;
        result
            .recv()
            .map_err(|_| "Media worker stopped".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn play_pause(worker: State<'_, MediaWorker>) -> Result<bool, String> {
    send_control(worker, ControlAction::PlayPause).await
}

#[tauri::command]
async fn previous_track(worker: State<'_, MediaWorker>) -> Result<bool, String> {
    send_control(worker, ControlAction::Previous).await
}

#[tauri::command]
async fn next_track(worker: State<'_, MediaWorker>) -> Result<bool, String> {
    send_control(worker, ControlAction::Next).await
}

#[tauri::command]
async fn seek_to(
    worker: State<'_, MediaWorker>,
    position_ms: i64,
    track_key: String,
) -> Result<bool, String> {
    let requests = worker.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, result) = mpsc::channel();
        requests
            .send(MediaRequest::Seek(position_ms, track_key, reply))
            .map_err(|_| "Media worker stopped".to_string())?;
        result
            .recv()
            .map_err(|_| "Media worker stopped".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

fn track_key(source: &str, title: &str, artist: &str, album: &str) -> String {
    format!("{source}\u{0}{title}\u{0}{artist}\u{0}{album}")
}

#[derive(Default)]
struct MetadataRead {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
}

#[derive(Default)]
struct TransportCapabilities {
    play: bool,
    pause: bool,
    previous: bool,
    next: bool,
    seek: bool,
}

impl TransportCapabilities {
    fn from_results(flags: [windows::core::Result<bool>; 5]) -> Self {
        let [play, pause, previous, next, seek] = flags.map(|flag| flag.unwrap_or(false));
        Self {
            play,
            pause,
            previous,
            next,
            seek,
        }
    }
}

#[derive(Default)]
struct TimelineRead {
    start: Option<i64>,
    end: Option<i64>,
    min_seek: Option<i64>,
    max_seek: Option<i64>,
    position: Option<i64>,
    updated: Option<i64>,
}

fn read_timeline(
    timeline: windows::core::Result<
        windows::Media::Control::GlobalSystemMediaTransportControlsSessionTimelineProperties,
    >,
) -> TimelineRead {
    let Ok(timeline) = timeline else {
        return TimelineRead::default();
    };
    TimelineRead {
        start: timeline.StartTime().ok().map(|value| value.Duration),
        end: timeline.EndTime().ok().map(|value| value.Duration),
        min_seek: timeline.MinSeekTime().ok().map(|value| value.Duration),
        max_seek: timeline.MaxSeekTime().ok().map(|value| value.Duration),
        position: timeline.Position().ok().map(|value| value.Duration),
        updated: timeline
            .LastUpdatedTime()
            .ok()
            .map(|value| value.UniversalTime),
    }
}

impl TimelineRead {
    fn duration(&self) -> Option<i64> {
        self.end?
            .checked_sub(self.start?)
            .filter(|duration| *duration > 0)
    }

    fn seek_range(&self) -> Option<(i64, i64)> {
        self.duration()?;
        let min = self.start?.max(self.min_seek.unwrap_or(self.start?));
        let max = self.end?.min(self.max_seek.unwrap_or(self.end?));
        (min <= max).then_some((min, max))
    }

    fn seek_range_ms(&self) -> Option<(i64, i64)> {
        let (min, max) = self.seek_range()?;
        let min = min.checked_sub(self.start?)?;
        let max = max.checked_sub(self.start?)?;
        // Round inward so integer milliseconds never exceed Windows' tick bounds.
        let min = min / 10_000 + i64::from(min % 10_000 != 0);
        let max = max / 10_000;
        (min <= max).then_some((min, max))
    }

    fn seek_target(&self, position_ms: i64) -> Option<i64> {
        let (min, max) = self.seek_range()?;
        Some(
            self.start?
                .saturating_add(position_ms.max(0).saturating_mul(10_000))
                .clamp(min, max),
        )
    }

    fn relative_position(&self, playing: bool, now: Option<i128>) -> Option<i64> {
        let elapsed = if playing {
            self.updated
                .filter(|updated| *updated > 0)
                .zip(now)
                .map(|(updated, now)| {
                    (now - i128::from(updated)).clamp(0, i128::from(i64::MAX)) as i64
                })
                .unwrap_or(0)
        } else {
            0
        };
        let position = self
            .position?
            .saturating_add(elapsed)
            .checked_sub(self.start?)?
            .max(0);
        Some(
            self.duration()
                .map_or(position, |duration| position.min(duration))
                / 10_000,
        )
    }
}

impl MediaState {
    fn from_parts(
        source: String,
        metadata: MetadataRead,
        playback: Option<PlaybackStatus>,
        capabilities: TransportCapabilities,
        timeline: TimelineRead,
        now: Option<i128>,
    ) -> Self {
        let key = metadata
            .title
            .as_deref()
            .zip(metadata.artist.as_deref())
            .zip(metadata.album.as_deref())
            .map(|((title, artist), album)| track_key(&source, title, artist, album));
        let bounds = timeline.seek_range_ms();
        Self {
            source_id: source,
            title: metadata.title,
            artist: metadata.artist,
            playback_state: match playback {
                Some(PlaybackStatus::Playing) => "playing",
                Some(PlaybackStatus::Paused) => "paused",
                Some(PlaybackStatus::Stopped) => "stopped",
                Some(PlaybackStatus::Opened) => "opened",
                Some(PlaybackStatus::Closed) => "closed",
                Some(PlaybackStatus::Changing) => "changing",
                _ => "unknown",
            },
            can_play: capabilities.play,
            can_pause: capabilities.pause,
            can_previous: capabilities.previous,
            can_next: capabilities.next,
            can_seek: capabilities.seek && bounds.is_some() && key.is_some(),
            seek_min_ms: bounds.map(|(min, _)| min),
            seek_max_ms: bounds.map(|(_, max)| max),
            duration_ms: timeline.duration().map(|ticks| ticks / 10_000),
            position_ms: timeline.relative_position(playback == Some(PlaybackStatus::Playing), now),
            track_key: key,
            artwork: None,
        }
    }
}
fn seek_media(
    manager: &SessionManager,
    position_ms: i64,
    expected_track: &str,
) -> windows::core::Result<bool> {
    let sessions = manager.GetSessions()?;
    for index in 0..sessions.Size()? {
        let session = sessions.GetAt(index)?;
        let source = session.SourceAppUserModelId()?.to_string();
        if !is_yandex_music(&source) {
            continue;
        }
        if !session
            .GetPlaybackInfo()?
            .Controls()?
            .IsPlaybackPositionEnabled()?
        {
            return Ok(false);
        }
        let media = wait_winrt!(session.TryGetMediaPropertiesAsync())?;
        if track_key(
            &source,
            &media.Title()?.to_string(),
            &media.Artist()?.to_string(),
            &media.AlbumTitle()?.to_string(),
        ) != expected_track
        {
            return Ok(false);
        }
        let timeline = read_timeline(session.GetTimelineProperties());
        let Some(target) = timeline.seek_target(position_ms) else {
            return Ok(false);
        };
        return wait_winrt!(session.TryChangePlaybackPositionAsync(target));
    }
    Ok(false)
}

fn read_artwork(
    media: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> windows::core::Result<Option<(String, Vec<u8>)>> {
    let thumbnail = match media.Thumbnail() {
        Ok(thumbnail) => thumbnail,
        Err(_) => return Ok(None),
    };
    let stream = wait_winrt!(thumbnail.OpenReadAsync())?;
    let size = stream.Size()?;
    if size == 0 || size > 8 * 1024 * 1024 {
        return Ok(None);
    }
    let mime = stream.ContentType()?.to_string();
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    let loaded = wait_winrt!(reader.LoadAsync(size as u32))?;
    let mut bytes = vec![0; loaded as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(Some((mime, bytes)))
}

fn is_yandex_music(source_id: &str) -> bool {
    let id = source_id.to_ascii_lowercase();
    id == "ru.yandex.desktop.music"
        || id == "yandexmusic.exe"
        || id == "yandexmusic"
        || id.starts_with("yandex.music_")
        || id.starts_with("yandex.music!")
        || id == "yandex.music"
}

fn control_media(manager: &SessionManager, action: ControlAction) -> windows::core::Result<bool> {
    let sessions = manager.GetSessions()?;
    for index in 0..sessions.Size()? {
        let session = sessions.GetAt(index)?;
        if !is_yandex_music(&session.SourceAppUserModelId()?.to_string()) {
            continue;
        }

        let playback = session.GetPlaybackInfo()?;
        let controls = playback.Controls()?;
        return match action {
            ControlAction::PlayPause if playback.PlaybackStatus()? == PlaybackStatus::Playing => {
                if controls.IsPauseEnabled()? {
                    wait_winrt!(session.TryPauseAsync())
                } else {
                    Ok(false)
                }
            }
            ControlAction::PlayPause => {
                if controls.IsPlayEnabled()? {
                    wait_winrt!(session.TryPlayAsync())
                } else {
                    Ok(false)
                }
            }
            ControlAction::Previous => {
                if controls.IsPreviousEnabled()? {
                    wait_winrt!(session.TrySkipPreviousAsync())
                } else {
                    Ok(false)
                }
            }
            ControlAction::Next => {
                if controls.IsNextEnabled()? {
                    wait_winrt!(session.TrySkipNextAsync())
                } else {
                    Ok(false)
                }
            }
        };
    }
    Ok(false)
}

fn read_media_state(
    manager: &SessionManager,
    cache: &mut ArtworkCache,
) -> windows::core::Result<Option<MediaState>> {
    let sessions = manager.GetSessions()?;
    for index in 0..sessions.Size()? {
        let session = sessions.GetAt(index)?;
        let source = session.SourceAppUserModelId()?.to_string();
        if !is_yandex_music(&source) {
            continue;
        }

        // A matched session remains present even when one group of getters fails.
        // The wait macro uses ?, including when starting the operation fails.
        // Keep those early returns inside this optional metadata read.
        let media = (|| wait_winrt!(session.TryGetMediaPropertiesAsync()))().ok();
        let metadata = media
            .as_ref()
            .map(|media| MetadataRead {
                title: media.Title().ok().map(|value| value.to_string()),
                artist: media.Artist().ok().map(|value| value.to_string()),
                album: media.AlbumTitle().ok().map(|value| value.to_string()),
            })
            .unwrap_or_default();
        let playback = session.GetPlaybackInfo().ok();
        let status = playback
            .as_ref()
            .and_then(|value| value.PlaybackStatus().ok());
        let controls = playback.as_ref().and_then(|value| value.Controls().ok());
        let capabilities = controls
            .as_ref()
            .map(|controls| {
                TransportCapabilities::from_results([
                    controls.IsPlayEnabled(),
                    controls.IsPauseEnabled(),
                    controls.IsPreviousEnabled(),
                    controls.IsNextEnabled(),
                    controls.IsPlaybackPositionEnabled(),
                ])
            })
            .unwrap_or_default();
        let timeline = read_timeline(session.GetTimelineProperties());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|now| 116_444_736_000_000_000_i128 + (now.as_nanos() / 100) as i128);
        let mut state =
            MediaState::from_parts(source, metadata, status, capabilities, timeline, now);
        // No fabricated identity or cache writes when track getters are unavailable.
        if let (Some(media), Some(key)) = (media.as_ref(), state.track_key.clone()) {
            let changed_track = cache.track_key != key;
            // Compare locally; only changed images cross IPC. Retry transient read errors.
            let artwork = match read_artwork(&media) {
                Ok(image) if changed_track || cache.image != image => {
                    let data_url = image.as_ref().map(|(mime, bytes)| {
                        format!(
                            "data:{};base64,{}",
                            if mime.starts_with("image/") {
                                mime.as_str()
                            } else {
                                "image/jpeg"
                            },
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        )
                    });
                    cache.image = image;
                    Some(ArtworkUpdate { data_url })
                }
                Err(_) if changed_track => {
                    cache.image = None;
                    Some(ArtworkUpdate { data_url: None })
                }
                _ => None,
            };
            cache.track_key = key.clone();
            state.artwork = artwork;
        }
        return Ok(Some(state));
    }
    *cache = ArtworkCache::default();
    Ok(None)
}

fn application_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        // Must initialize before windows, tray, settings or any media/capture worker.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            lifecycle::on_second_instance(app);
        }))
        // The first plugin already elected the owner. Initialize backend state
        // before Tauri creates WebViews, preserving the previous startup ordering.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("plix-workers")
                .setup(|app, _api| {
                    app.manage(MediaWorker::new());
                    app.manage(volume_worker::VolumeWorker::new());
                    app.manage(visualizer::Visualizer::new());
                    Ok(())
                })
                .build(),
        )
        .manage(lifecycle::Lifecycle::default())
        .setup(|app| {
            #[cfg(not(test))]
            let path = app.path().app_config_dir()?.join("appearance.json");
            app.manage(Appearance::load(path));
            if let Err(error) = appearance::restore_main_always_on_top(app.handle()) {
                eprintln!("Failed to restore always on top: {error}");
            }
            if let Err(error) = window_position::restore(app.handle()) {
                eprintln!("Failed to restore main window position: {error}");
            }
            app.manage(window_position::PositionPersistence::start(
                app.handle().clone(),
            )?);
            lifecycle::setup(app)?;
            player_context_menu::setup(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            window_position::on_window_event(window, event);
            lifecycle::on_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            get_media_state,
            yandex_app::open_yandex_music,
            play_pause,
            previous_track,
            next_track,
            seek_to,
            get_volume,
            set_volume,
            set_mute,
            get_appearance,
            set_appearance,
            open_appearance,
            player_context_menu::show_player_context_menu,
            player_context_menu::player_context_menu_action,
            get_lifecycle_request,
            finish_lifecycle,
            visualizer::set_visualizer_active,
            visualizer::get_visualizer_frame
        ])
}

fn main() {
    application_builder()
        .build(tauri::generate_context!())
        .expect("failed to build PLIX")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<visualizer::Visualizer>().shutdown();
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                lifecycle::on_exit_requested(app, &api);
            }
        });
}
