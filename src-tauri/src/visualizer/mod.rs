//! Optional process-tree PCM/FFT enhancement. No endpoint meter, media session,
//! volume writes, subprocess or audio files. All COM ownership stays on one MTA.
mod activation;
mod frequency;
mod packet;
mod platform;

use std::{
    error::Error,
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::State;
use wasapi::{Direction, SampleType, StreamMode, WaveFormat};
use windows::Win32::Media::Audio::IAudioCaptureClient;

const LEASE: Duration = Duration::from_secs(2);
#[derive(Clone, Default, serde::Serialize)]
pub struct Frame {
    status: String,
    pid: u32,
    fresh: bool,
    low: f32,
    mid: f32,
    high: f32,
    bands16: [f32; 16],
}
struct Inner {
    enabled: bool,
    shutdown: bool,
    generation: u64,
    lease: Instant,
    last_pcm: Option<Instant>,
    frame: Frame,
}
struct Shared {
    inner: Mutex<Inner>,
    wake: Condvar,
}
impl Shared {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                enabled: false,
                shutdown: false,
                generation: 0,
                lease: Instant::now(),
                last_pcm: None,
                frame: Frame {
                    status: "OFF".into(),
                    ..Frame::default()
                },
            }),
            wake: Condvar::new(),
        }
    }
    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.shutdown {
            return Ok(());
        }
        if inner.enabled != enabled {
            inner.generation += 1;
            inner.enabled = enabled;
            inner.last_pcm = None;
            inner.frame = Frame {
                status: if enabled { "STARTING" } else { "OFF" }.into(),
                ..Frame::default()
            };
        }
        inner.lease = Instant::now();
        self.wake.notify_all();
        Ok(())
    }

    fn live(inner: &Inner, token: u64) -> bool {
        inner.enabled
            && !inner.shutdown
            && inner.generation == token
            && inner.lease.elapsed() < LEASE
    }
    fn running(&self, token: u64) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        Self::live(&inner, token)
    }
    fn status(&self, token: u64, pid: u32, status: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if !Self::live(&inner, token) {
            return;
        }
        inner.frame = Frame {
            pid,
            status: status.into(),
            ..Frame::default()
        };
        inner.last_pcm = None;
    }
    fn fail(&self, token: u64, status: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if !Self::live(&inner, token) {
            return;
        }
        inner.enabled = false;
        inner.last_pcm = None;
        inner.frame = Frame {
            status: status.into(),
            ..Frame::default()
        };
    }
    fn wait(&self, token: u64, duration: Duration) {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if Self::live(&inner, token) {
            drop(
                self.wake
                    .wait_timeout(inner, duration)
                    .unwrap_or_else(|p| p.into_inner()),
            );
        }
    }
}

pub struct Visualizer {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Visualizer {
    pub fn new() -> Self {
        let shared = Arc::new(Shared::new());
        let owner = shared.clone();
        let worker = thread::Builder::new()
            .name("visualizer-pcm".into())
            .spawn(move || {
                if std::panic::catch_unwind(|| worker(&owner)).is_err() {
                    let token = owner
                        .inner
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .generation;
                    owner.fail(token, "WORKER_ERROR");
                }
            });
        if let Err(error) = &worker {
            eprintln!("Visualizer worker unavailable: {error}");
        }
        Self {
            shared,
            worker: Mutex::new(worker.ok()),
        }
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled
            && self
                .worker
                .lock()
                .map_err(|e| e.to_string())?
                .as_ref()
                .is_none_or(|w| w.is_finished())
        {
            return Err("Visualizer worker unavailable".into());
        }
        self.shared.set_enabled(enabled)
    }
    pub fn frame(&self) -> Frame {
        let mut inner = self.shared.inner.lock().unwrap_or_else(|p| p.into_inner());
        // A frontend that disappears cannot leave a capture stream running.
        // Readback renews the selected enhancement, but never enables Off.
        if inner.enabled {
            let was_idle = inner.lease.elapsed() >= LEASE;
            inner.lease = Instant::now();
            if was_idle {
                self.shared.wake.notify_all();
            }
        }
        let mut frame = inner.frame.clone();
        frame.fresh = inner.enabled
            && inner
                .last_pcm
                .is_some_and(|at| at.elapsed() < Duration::from_millis(100));
        if !frame.fresh {
            frame.low = 0.0;
            frame.mid = 0.0;
            frame.high = 0.0;
            frame.bands16 = [0.0; 16];
        }
        frame
    }
    pub fn shutdown(&self) {
        {
            let mut inner = self.shared.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.shutdown = true;
            inner.enabled = false;
            self.shared.wake.notify_all();
        }
        let mut worker = self.worker.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(worker) = worker.take() {
            // Activation checks cancellation every 20 ms; event waits are <=100 ms.
            // Never block application exit on an unexpected OS/driver stall.
            let deadline = Instant::now() + Duration::from_secs(1);
            while !worker.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            if worker.is_finished() {
                let _ = worker.join();
            } else {
                eprintln!(
                    "Visualizer shutdown deadline reached; OS will reclaim remaining COM resources"
                );
            }
        }
    }
}
impl Drop for Visualizer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
pub fn set_visualizer_active(
    window: tauri::WebviewWindow,
    state: State<'_, Visualizer>,
    appearance: State<'_, crate::appearance::Appearance>,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Visualizer belongs to the main window".into());
    }
    appearance.apply_visualizer_request(&state, enabled)
}
#[tauri::command]
pub fn get_visualizer_frame(
    window: tauri::WebviewWindow,
    state: State<'_, Visualizer>,
) -> Result<Frame, String> {
    if window.label() != "main" {
        return Err("Visualizer belongs to the main window".into());
    }
    Ok(state.frame())
}

struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}
fn worker(shared: &Shared) {
    loop {
        let token = {
            let mut inner = shared.inner.lock().unwrap_or_else(|p| p.into_inner());
            while !inner.shutdown && !Shared::live(&inner, inner.generation) {
                inner.last_pcm = None;
                // Preserve an error for frontend readback until it acknowledges Off.
                inner = shared.wake.wait(inner).unwrap_or_else(|p| p.into_inner());
            }
            if inner.shutdown {
                return;
            }
            inner.generation
        };
        if let Err(error) = wasapi::initialize_mta().ok() {
            eprintln!("Visualizer COM: {error}");
            shared.fail(token, "COM_ERROR");
            continue;
        }
        let _com = Com;
        while shared.running(token) {
            let result = (|| -> Result<(), Box<dyn Error>> {
                let mut roots = platform::yandex_roots(&platform::processes()?);
                match roots.len() {
                    0 => shared.status(token, 0, "PROCESS_NOT_FOUND"),
                    1 => capture(shared, token, roots.remove(0))?,
                    _ => shared.status(token, 0, "AMBIGUOUS_PROCESS"),
                }
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("Visualizer capture: {error}");
                let status = if error.to_string().contains("ACTIVATION_TIMEOUT") {
                    "ACTIVATION_TIMEOUT"
                } else {
                    "CAPTURE_ERROR"
                };
                shared.fail(token, status);
            }
            shared.wait(token, Duration::from_millis(500));
        }
    }
}

fn capture(shared: &Shared, token: u64, process: platform::Process) -> Result<(), Box<dyn Error>> {
    let target = platform::open_target(process.pid)?;
    let path = platform::image_path(&target)?;
    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if name != "Яндекс Музыка.exe" && !name.eq_ignore_ascii_case("YandexMusic.exe") {
        return Err("PID identity changed before activation; refusing capture".into());
    }
    shared.status(token, process.pid, "ACTIVATING");
    let Some(mut client) = activation::activate(process.pid, || shared.running(token))? else {
        return Ok(());
    };
    if !shared.running(token) || !platform::alive(&target)? {
        return Ok(());
    }
    let format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
    client.initialize_client(
        &format,
        &Direction::Capture,
        &StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 0,
        },
    )?;
    let event = client.set_get_eventhandle()?;
    let reader: IAudioCaptureClient = unsafe { client.as_iaudioclient().GetService()? };
    let mut analyzer = frequency::Analyzer::new();
    let mut pcm = Vec::with_capacity(480);
    client.start_stream()?;
    shared.status(token, process.pid, "RUNNING");
    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut next_alive = Instant::now();
        let mut last_packet = Instant::now();
        while shared.running(token) {
            if Instant::now() >= next_alive {
                if !platform::alive(&target)? {
                    shared.status(token, process.pid, "PID_LOST");
                    return Ok(());
                }
                next_alive = Instant::now() + Duration::from_millis(500);
            }
            match event.wait_for_event(100) {
                Ok(()) | Err(wasapi::WasapiError::EventTimeout) => {}
                Err(error) => return Err(error.into()),
            }
            while shared.running(token) {
                let Some(packet) = packet::read_packet(&reader, &mut pcm)? else {
                    break;
                };
                if packet.discontinuity || last_packet.elapsed() > Duration::from_millis(100) {
                    analyzer.reset();
                }
                last_packet = Instant::now();
                // The WASAPI buffer was released before FFT. No queue or audio file.
                analyzer.push_stereo(&pcm);
                let bands = analyzer.latest();
                let mut inner = shared.inner.lock().unwrap_or_else(|p| p.into_inner());
                if !Shared::live(&inner, token) {
                    break;
                }
                inner.last_pcm = Some(Instant::now());
                inner.frame = Frame {
                    status: "RUNNING".into(),
                    pid: process.pid,
                    fresh: true,
                    low: bands.normalized[0],
                    mid: bands.normalized[1],
                    high: bands.normalized[2],
                    bands16: bands.bands16,
                };
            }
        }
        Ok(())
    })();
    let stopped = client.stop_stream();
    result?;
    stopped?;
    Ok(())
}

