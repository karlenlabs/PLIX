use crate::volume::{AudioVolume, VolumeChange, VolumeSessionOwner};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const RECOVERY_COOLDOWN: Duration = Duration::from_secs(1);
const IDLE_POLL: Duration = Duration::from_millis(250);
const STOPPED: u64 = 1;
const RETIRED: u64 = 2;
const WRITING: u64 = 4;

// Generation and write admission share one atomic word. Cancellation cannot race
// a check-then-setter gap into admitting a new write on an invalidated generation.
#[derive(Default)]
struct Gate(AtomicU64);
impl Gate {
    fn start(&self, generation: u64) -> Result<(), String> {
        self.0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                (value & STOPPED == 0).then_some(generation << 3)
            })
            .map(|_| ())
            .map_err(|_| "Audio worker shut down".into())
    }
    fn cancel(&self, generation: u64) {
        let _ = self
            .0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                (value >> 3 == generation).then_some(value | RETIRED)
            });
    }
    fn stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst) & STOPPED != 0
    }
    fn valid(&self, generation: u64) -> bool {
        let value = self.0.load(Ordering::SeqCst);
        value >> 3 == generation && value & (STOPPED | RETIRED) == 0
    }
}

pub(crate) struct RequestControl {
    gate: Arc<Gate>,
    generation: u64,
    deadline: Instant,
}
impl RequestControl {
    pub(crate) fn check(&self) -> windows::core::Result<()> {
        if !self.gate.valid(self.generation) || Instant::now() >= self.deadline {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x800705B4_u32 as i32),
                "Audio request expired, retired or shut down",
            ));
        }
        Ok(())
    }
    pub(crate) fn read<T>(
        &self,
        call: impl FnOnce() -> windows::core::Result<T>,
    ) -> windows::core::Result<T> {
        self.check()?;
        let result = call()?;
        self.check()?;
        Ok(result)
    }
    pub(crate) fn write<T>(
        &self,
        call: impl FnOnce() -> windows::core::Result<T>,
    ) -> windows::core::Result<T> {
        self.check()?;
        self.gate
            .0
            .compare_exchange(
                self.generation << 3,
                (self.generation << 3) | WRITING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| {
                windows::core::Error::new(
                    windows::core::HRESULT(0x800705B4_u32 as i32),
                    "Audio write admission cancelled",
                )
            })?;
        let _permit = WritePermit {
            gate: &self.gate,
            generation: self.generation,
        };
        self.check()?;
        // Once admitted, Windows may still complete this setter after our timeout.
        // Never replay it or start a replacement lane before this lane has exited.
        let result = call()?;
        self.check()?;
        Ok(result)
    }
}
struct WritePermit<'a> {
    gate: &'a Gate,
    generation: u64,
}
impl Drop for WritePermit<'_> {
    fn drop(&mut self) {
        let _ = self
            .gate
            .0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                (value >> 3 == self.generation).then_some(value & !WRITING)
            });
    }
}

struct ComApartment;
impl ComApartment {
    fn new() -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|error| error.to_string())?;
        }
        Ok(Self)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

type Target = Option<(String, VolumeChange)>;
type Reply = Result<Option<AudioVolume>, String>;
// Created and destroyed on its lane; deliberately no Send bound on COM state.
trait Backend {
    fn volume(&mut self, target: Target, control: &RequestControl) -> Reply;
    fn idle(&mut self) {}
}
struct NativeBackend {
    // Field destruction order releases interfaces before CoUninitialize.
    owner: VolumeSessionOwner,
    apartment: Option<ComApartment>,
}
impl Backend for NativeBackend {
    fn volume(&mut self, target: Target, control: &RequestControl) -> Reply {
        control.check().map_err(|error| error.to_string())?;
        if self.apartment.is_none() {
            self.apartment = Some(ComApartment::new()?);
        }
        control.check().map_err(|error| error.to_string())?;
        self.owner
            .volume(
                target.as_ref().map(|(id, change)| (id.as_str(), *change)),
                control,
            )
            .map_err(|error| error.to_string())
    }
    fn idle(&mut self) {
        if self.owner.selected().is_none() {
            self.apartment = None;
        }
    }
}
type Factory = Arc<dyn Fn() -> Result<Box<dyn Backend>, String> + Send + Sync>;
struct Request {
    target: Target,
    control: RequestControl,
    reply: mpsc::Sender<Reply>,
}
struct Lane {
    generation: u64,
    sender: mpsc::SyncSender<Request>,
    thread: JoinHandle<()>,
}
#[derive(Default)]
struct State {
    generation: u64,
    active: Option<Lane>,
    retiring: Option<Lane>,
    retry_at: Option<Instant>,
}
struct Supervisor {
    state: Mutex<State>,
    gate: Arc<Gate>,
    factory: Factory,
}
impl Supervisor {
    fn new(factory: Factory) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            gate: Arc::new(Gate::default()),
            factory,
        })
    }
    fn retire_locked(&self, state: &mut State, now: Instant) {
        if let Some(lane) = state.active.take() {
            self.gate.cancel(lane.generation);
            // At most one lane in total: a replacement waits for full thread exit,
            // including COM Release/CoUninitialize, not just the late reply.
            debug_assert!(state.retiring.is_none());
            state.retiring = Some(lane);
            state.retry_at = Some(now + RECOVERY_COOLDOWN);
        }
    }
    fn retire(&self, generation: u64, now: Instant) {
        self.gate.cancel(generation); // invalidate immediately, even if admission holds state
        if let Ok(mut state) = self.state.try_lock() {
            if state
                .active
                .as_ref()
                .is_some_and(|lane| lane.generation == generation)
            {
                self.retire_locked(&mut state, now);
            }
        }
        // If contended, the next admission observes the invalid gate and retires it.
    }
    fn ensure_lane(&self, state: &mut State, now: Instant) -> Result<(), String> {
        if self.gate.stopped() {
            return Err("Audio worker shut down".into());
        }
        if state
            .active
            .as_ref()
            .is_some_and(|lane| !self.gate.valid(lane.generation) || lane.thread.is_finished())
        {
            self.retire_locked(state, now);
        }
        if state.active.is_some() {
            return Ok(());
        }
        if state
            .retiring
            .as_ref()
            .is_some_and(|lane| !lane.thread.is_finished())
        {
            return Err("Audio worker quarantined; previous Windows call has not exited".into());
        }
        if let Some(lane) = state.retiring.take() {
            // Only a fully finished thread is joined. No join in shutdown or Drop.
            let _ = lane.thread.join();
        }
        if state.retry_at.is_some_and(|retry| now < retry) {
            return Err("Audio worker recovery cooldown".into());
        }
        state.generation += 1;
        let generation = state.generation;
        self.gate.start(generation)?;
        let gate = self.gate.clone();
        let factory = self.factory.clone();
        let (sender, requests) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name(format!("audio-volume-mta-{generation}"))
            .spawn(move || run_lane(generation, gate, factory, requests))
            .map_err(|error| {
                state.retry_at = Some(now + RECOVERY_COOLDOWN);
                format!("Cannot start audio MTA worker: {error}")
            })?;
        state.active = Some(Lane {
            generation,
            sender,
            thread,
        });
        Ok(())
    }
    fn submit(self: &Arc<Self>, target: Target, now: Instant) -> Result<Ticket, String> {
        if self.gate.stopped() {
            return Err("Audio worker shut down".into());
        }
        // No caller queues behind a mutex held across Windows work or a result wait.
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| "Audio worker admission busy".to_string())?;
        self.ensure_lane(&mut state, now)?;
        let lane = state.active.as_ref().unwrap();
        let generation = lane.generation;
        let deadline = now + REQUEST_TIMEOUT;
        let control = RequestControl {
            gate: self.gate.clone(),
            generation,
            deadline,
        };
        control.check().map_err(|error| error.to_string())?;
        let (reply, response) = mpsc::channel(); // one reply, nonblocking sender
        match lane.sender.try_send(Request {
            target,
            control,
            reply,
        }) {
            Ok(()) => Ok(Ticket {
                supervisor: self.clone(),
                generation,
                deadline,
                response,
                completed: false,
            }),
            Err(mpsc::TrySendError::Full(_)) => {
                Err("Audio worker queue full; request was not sent".into())
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.retire_locked(&mut state, now);
                Err("Audio MTA worker stopped".into())
            }
        }
    }
    fn shutdown(&self) {
        // Also linearizes against setter admission. Never send Shutdown into a
        // full queue, wait for a result, or join a live (possibly hung) COM lane.
        self.gate.0.fetch_or(STOPPED, Ordering::SeqCst);
        if let Ok(mut state) = self.state.try_lock() {
            drop(state.active.take());
            drop(state.retiring.take()); // dropping JoinHandle detaches; no COM object moves
        }
    }
}

fn run_lane(generation: u64, gate: Arc<Gate>, factory: Factory, requests: mpsc::Receiver<Request>) {
    let mut backend: Option<Box<dyn Backend>> = None;
    while gate.valid(generation) {
        let request = match requests.recv_timeout(IDLE_POLL) {
            Ok(request) => request,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(backend) = &mut backend {
                    backend.idle();
                }
                continue;
            }
        };
        let result = (|| {
            request.control.check().map_err(|error| error.to_string())?;
            if backend.is_none() {
                backend = Some(factory()?);
            }
            request.control.check().map_err(|error| error.to_string())?;
            let result = backend
                .as_mut()
                .unwrap()
                .volume(request.target, &request.control)?;
            request.control.check().map_err(|error| error.to_string())?;
            Ok(result)
        })();
        let failed = result.is_err();
        let _ = request.reply.send(result); // unbounded channel with exactly one item
        if failed {
            gate.cancel(generation);
            break;
        }
    }
    // All interfaces/apartment are released here, on the same MTA, even after retirement.
}
struct Ticket {
    supervisor: Arc<Supervisor>,
    generation: u64,
    deadline: Instant,
    response: mpsc::Receiver<Reply>,
    completed: bool,
}
impl Ticket {
    fn wait(self) -> Reply {
        let outcome = self
            .response
            .recv_timeout(self.deadline.saturating_duration_since(Instant::now()));
        self.finish(outcome, Instant::now())
    }
    fn finish(mut self, outcome: Result<Reply, mpsc::RecvTimeoutError>, now: Instant) -> Reply {
        let result = match outcome {
            Ok(Err(error)) => Err(error),
            Ok(Ok(result)) if now < self.deadline && self.supervisor.gate.valid(self.generation) => Ok(result),
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => Err(
                "Audio Windows request timed out or retired; admitted setter outcome may be unknown; never replayed".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("Audio MTA worker stopped".into()),
        };
        if result.is_err() {
            self.supervisor.retire(self.generation, now);
        }
        self.completed = true;
        result
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.completed {
            self.supervisor.retire(self.generation, Instant::now());
        }
    }
}

pub(crate) struct VolumeWorker {
    supervisor: Arc<Supervisor>,
}
impl VolumeWorker {
    pub fn new() -> Self {
        Self {
            supervisor: Supervisor::new(Arc::new(|| {
                Ok(Box::new(NativeBackend {
                    owner: VolumeSessionOwner::default(),
                    apartment: None,
                }))
            })),
        }
    }
    pub fn shutdown(&self) {
        self.supervisor.shutdown();
    }
}
impl Drop for VolumeWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}
pub(crate) async fn send_volume(worker: &VolumeWorker, target: Target) -> Reply {
    let ticket = worker.supervisor.submit(target, Instant::now())?;
    // A stalled lane admits at most one running and one queued request.
    // Full/busy/shutdown errors return before spawning a blocking waiter.
    tauri::async_runtime::spawn_blocking(move || ticket.wait())
        .await
        .map_err(|error| error.to_string())?
}

