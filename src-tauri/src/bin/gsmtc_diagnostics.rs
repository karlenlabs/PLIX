// Temporary, standalone observer. Never linked into the PLIX application.
#[cfg(not(debug_assertions))]
compile_error!("GSMTC diagnostics are DEV-only; use the debug profile, never --release.");

#[allow(dead_code)]
#[path = "../media_worker.rs"]
mod media_worker;

use media_worker::RecoveringWorker;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Win32::Foundation::E_POINTER;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

const OBSERVATION_TIME: Duration = Duration::from_secs(60);
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const METADATA_TIMEOUT: Duration = Duration::from_millis(250);

struct Apartment;

impl Apartment {
    fn new() -> windows::core::Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

// Field order releases this observer's manager before uninitializing its MTA.
struct Observer {
    manager: SessionManager,
    _apartment: Apartment,
}

impl Observer {
    fn new() -> Result<Self, String> {
        let apartment = Apartment::new().map_err(|error| format!("RoInitialize: {error}"))?;
        let budget = media_worker::winrt_budget().map_err(|error| error.to_string())?;
        let operation = SessionManager::RequestAsync()
            .map_err(|error| format!("SessionManager::RequestAsync start: {error}"))?;
        let manager = media_worker::wait_winrt(budget, operation)
            .map_err(|error| format!("SessionManager::RequestAsync completion: {error}"))?;
        Ok(Self {
            manager,
            _apartment: apartment,
        })
    }

    fn sample(&self, sample: u64, records: &mpsc::Sender<Value>, stop: &AtomicBool) {
        let sessions = match self.manager.GetSessions() {
            Ok(sessions) => sessions,
            Err(error) => {
                let _ = records.send(json!({"event": "enumeration_error", "sample": sample,
                    "field": "GetSessions", "error": error.to_string()}));
                return;
            }
        };
        let count = match sessions.Size() {
            Ok(count) => count,
            Err(error) => {
                let _ = records.send(json!({"event": "enumeration_error", "sample": sample,
                    "field": "Size", "error": error.to_string()}));
                return;
            }
        };
        let _ = records.send(json!({"event": "sample", "sample": sample, "session_count": count}));
        for index in 0..count {
            if stop.load(Ordering::Relaxed) || media_worker::winrt_budget().is_err() {
                let _ = records.send(json!({"event": "enumeration_incomplete", "sample": sample,
                    "inspected": index, "session_count": count, "reason": "stopped or request deadline reached"}));
                break;
            }
            let record = match sessions.GetAt(index) {
                Ok(session) => inspect(&session),
                Err(error) => json!({"error": error.to_string()}),
            };
            if records
                .send(json!({"event": "session", "sample": sample,
                "index": index, "observed_unix_ms": unix_ms(), "data": record}))
                .is_err()
            {
                break;
            }
        }
    }
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

// Preserve missing values and getter failures instead of fabricating defaults.
fn field<T: Serialize>(result: windows::core::Result<T>) -> Value {
    match result {
        Ok(value) => json!({"value": value}),
        Err(error) => {
            json!({"error": error.to_string(), "hresult": format!("0x{:08X}", error.code().0 as u32)})
        }
    }
}

// windows-rs projects a successful null interface return as E_POINTER.
fn nullable<T>(result: windows::core::Result<T>) -> windows::core::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == E_POINTER => Ok(None),
        Err(error) => Err(error),
    }
}

fn inspect(session: &Session) -> Value {
    let source = field(
        session
            .SourceAppUserModelId()
            .map(|value| value.to_string()),
    );
    let metadata = (|| {
        let budget = media_worker::winrt_budget()?.min(METADATA_TIMEOUT);
        media_worker::wait_winrt(budget, session.TryGetMediaPropertiesAsync()?)
    })();
    let metadata = match metadata {
        Ok(media) => json!({
            "Title": field(media.Title().map(|v| v.to_string())),
            "Artist": field(media.Artist().map(|v| v.to_string())),
            "AlbumTitle": field(media.AlbumTitle().map(|v| v.to_string())),
            "Subtitle": field(media.Subtitle().map(|v| v.to_string())),
            // Only inspect the reference. Do not open/download/decode the image.
            "ThumbnailPresent": field(nullable(media.Thumbnail()).map(|v| v.is_some())),
        }),
        Err(error) => field::<()>(Err(error)),
    };
    let playback = match session.GetPlaybackInfo() {
        Ok(info) => {
            let capabilities = match info.Controls() {
                Ok(c) => json!({
                    "IsPlayEnabled": field(c.IsPlayEnabled()),
                    "IsPauseEnabled": field(c.IsPauseEnabled()),
                    "IsPlayPauseToggleEnabled": field(c.IsPlayPauseToggleEnabled()),
                    "IsNextEnabled": field(c.IsNextEnabled()),
                    "IsPreviousEnabled": field(c.IsPreviousEnabled()),
                    "IsPlaybackPositionEnabled": field(c.IsPlaybackPositionEnabled()),
                    "IsPlaybackRateEnabled": field(c.IsPlaybackRateEnabled()),
                    "IsStopEnabled": field(c.IsStopEnabled()),
                    "IsRecordEnabled": field(c.IsRecordEnabled()),
                    "IsFastForwardEnabled": field(c.IsFastForwardEnabled()),
                    "IsRewindEnabled": field(c.IsRewindEnabled()),
                    "IsChannelUpEnabled": field(c.IsChannelUpEnabled()),
                    "IsChannelDownEnabled": field(c.IsChannelDownEnabled()),
                    "IsShuffleEnabled": field(c.IsShuffleEnabled()),
                    "IsRepeatEnabled": field(c.IsRepeatEnabled()),
                }),
                Err(error) => field::<()>(Err(error)),
            };
            json!({
                "PlaybackStatus": field(info.PlaybackStatus().map(|status| {
                    let name = match status {
                        PlaybackStatus::Closed => "Closed",
                        PlaybackStatus::Opened => "Opened",
                        PlaybackStatus::Changing => "Changing",
                        PlaybackStatus::Stopped => "Stopped",
                        PlaybackStatus::Playing => "Playing",
                        PlaybackStatus::Paused => "Paused",
                        _ => "Unknown",
                    };
                    json!({"name": name, "raw": status.0})
                })),
                "PlaybackRate": field(nullable(info.PlaybackRate()).and_then(|rate| {
                    rate.map(|rate| rate.Value()).transpose()
                })),
                "capabilities": capabilities,
            })
        }
        Err(error) => field::<()>(Err(error)),
    };
    let timeline = match session.GetTimelineProperties() {
        Ok(t) => json!({
            "StartTime": field(t.StartTime().map(|v| v.Duration)),
            "EndTime": field(t.EndTime().map(|v| v.Duration)),
            "Position": field(t.Position().map(|v| v.Duration)),
            "MinSeekTime": field(t.MinSeekTime().map(|v| v.Duration)),
            "MaxSeekTime": field(t.MaxSeekTime().map(|v| v.Duration)),
            "LastUpdatedTime": field(t.LastUpdatedTime().map(|v| v.UniversalTime)),
        }),
        Err(error) => field::<()>(Err(error)),
    };
    json!({"SourceAppUserModelId": source, "metadata": metadata,
        "playback": playback, "timeline": timeline})
}

// Only owned JSON crosses threads. The manager and every session stay on the
// RecoveringWorker's MTA lane, independent of every running PLIX instance.
fn start_worker(
    stop: Arc<AtomicBool>,
) -> io::Result<(mpsc::SyncSender<u64>, mpsc::Receiver<Value>)> {
    let (requests, samples) = mpsc::sync_channel(1);
    let (records, output) = mpsc::channel();
    thread::Builder::new()
        .name("gsmtc-diagnostics".into())
        .spawn(move || {
            let mut worker = RecoveringWorker::new(Observer::new);
            for sample in samples {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let sender = records.clone();
                let cancelled = Arc::clone(&stop);
                let result = worker.execute(move |observer| {
                    observer.sample(sample, &sender, &cancelled);
                    Ok(())
                });
                if records
                    .send(json!({"event": "sample_finished", "sample": sample,
                "error": result.err()}))
                    .is_err()
                {
                    break;
                }
            }
        })?;
    Ok((requests, output))
}

// The console owner never waits for a native thread to join. Its own deadline
// ends the standalone process even if Windows blocks a synchronous getter.
fn observe(
    requests: mpsc::SyncSender<u64>,
    records: mpsc::Receiver<Value>,
    stop: &AtomicBool,
    duration: Duration,
    interval: Duration,
    mut output: impl Write,
) -> io::Result<()> {
    let start = Instant::now();
    let deadline = start + duration;
    let mut next = start;
    let mut sample = 0;
    let mut busy = false;
    loop {
        let now = Instant::now();
        if now >= deadline || stop.load(Ordering::Relaxed) {
            break;
        }
        if now >= next {
            let event = if busy {
                "sample_skipped_busy"
            } else {
                match requests.try_send(sample) {
                    Ok(()) => {
                        busy = true;
                        "sample_requested"
                    }
                    Err(mpsc::TrySendError::Full(_)) => "sample_skipped_busy",
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        return Err(io::Error::other("Diagnostic worker stopped"));
                    }
                }
            };
            writeln!(
                output,
                "{}",
                json!({"event": event, "sample": sample, "elapsed_ms": start.elapsed().as_millis()})
            )?;
            sample += 1;
            // Skip missed ticks rather than queueing a burst of stale samples.
            next += interval;
            while next <= Instant::now() {
                next += interval;
            }
        }
        let wait = next
            .min(deadline)
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(50));
        match records.recv_timeout(wait) {
            Ok(record) => {
                if record["event"] == "sample_finished" {
                    busy = false;
                }
                writeln!(output, "{record}")?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(io::Error::other("Diagnostic output stopped"));
            }
        }
    }
    stop.store(true, Ordering::Relaxed);
    writeln!(
        output,
        "{}",
        json!({"event": "stopped", "elapsed_ms": start.elapsed().as_millis()})
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 || args[0] != "--observe" {
        eprintln!("DEV-only GSMTC observer. Run with --observe for 60 seconds. Enter or Ctrl+C stops early. No PLIX UI or playback commands are started.");
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let input_stop = Arc::clone(&stop);
    thread::Builder::new()
        .name("gsmtc-stop-input".into())
        .spawn(move || {
            let mut line = String::new();
            if io::stdin()
                .read_line(&mut line)
                .is_ok_and(|bytes| bytes > 0)
            {
                input_stop.store(true, Ordering::Relaxed);
            }
        })?;
    let (requests, records) = start_worker(Arc::clone(&stop))?;
    eprintln!("Observing all GSMTC sessions for 60 seconds. Enter or Ctrl+C stops. Output: JSON lines on stdout. Text metadata may contain private titles; output stays local. Timeline units: 100 ns; LastUpdatedTime: Windows UTC ticks since 1601. Indices are per sample, not stable session IDs.");
    let result = observe(
        requests,
        records,
        &stop,
        OBSERVATION_TIME,
        SAMPLE_INTERVAL,
        io::stdout().lock(),
    );
    stop.store(true, Ordering::Relaxed);
    result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_worker_cannot_extend_observation_or_accumulate_requests() {
        let (requests, work) = mpsc::sync_channel(1);
        let (records, output) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let worker = thread::spawn(move || {
            ready.send(()).unwrap();
            let first = work.recv().unwrap();
            blocked.recv().unwrap();
            assert_eq!(first, 0);
            assert!(work.try_recv().is_err());
            drop(records);
        });
        started.recv().unwrap();
        let mut log = Vec::new();
        let now = Instant::now();
        observe(
            requests,
            output,
            &AtomicBool::new(false),
            Duration::from_millis(120),
            Duration::from_millis(20),
            &mut log,
        )
        .unwrap();
        let elapsed = now.elapsed();
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(elapsed < Duration::from_secs(2));
        let events: Vec<Value> = String::from_utf8(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            events
                .iter()
                .filter(|v| v["event"] == "sample_requested")
                .count(),
            1
        );
        assert!(events.iter().any(|v| v["event"] == "sample_skipped_busy"));
        assert_eq!(events.last().unwrap()["event"], "stopped");
    }

    #[test]
    fn manual_stop_does_not_wait_for_native_worker() {
        let (requests, _work) = mpsc::sync_channel(0);
        let (_records, output) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let input_stop = Arc::clone(&stop);
        let input = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            input_stop.store(true, Ordering::Relaxed);
        });
        let mut log = Vec::new();
        let now = Instant::now();
        observe(
            requests,
            output,
            &stop,
            OBSERVATION_TIME,
            SAMPLE_INTERVAL,
            &mut log,
        )
        .unwrap();
        input.join().unwrap();
        assert!(now.elapsed() < Duration::from_secs(2));
        let last: Value =
            serde_json::from_str(String::from_utf8(log).unwrap().lines().last().unwrap()).unwrap();
        assert_eq!(last["event"], "stopped");
    }

    #[test]
    fn failed_sample_does_not_stop_following_samples() {
        let (requests, work) = mpsc::sync_channel(1);
        let (records, output) = mpsc::channel();
        let worker = thread::spawn(move || {
            for sample in work {
                if records
                    .send(json!({"event": "sample_finished", "sample": sample,
                    "error": if sample == 0 { Some("simulated Windows error") } else { None }}))
                    .is_err()
                {
                    break;
                }
            }
        });
        let mut log = Vec::new();
        observe(
            requests,
            output,
            &AtomicBool::new(false),
            Duration::from_millis(150),
            Duration::from_millis(20),
            &mut log,
        )
        .unwrap();
        worker.join().unwrap();
        let events: Vec<Value> = String::from_utf8(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(events.iter().any(|v| v["event"] == "sample_finished"
            && v["sample"] == 0
            && v["error"].is_string()));
        assert!(events.iter().any(|v| v["event"] == "sample_finished"
            && v["sample"].as_u64().is_some_and(|n| n > 0)
            && v["error"].is_null()));
    }
}
