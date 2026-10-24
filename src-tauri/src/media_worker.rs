use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const RETRY_DELAY: Duration = Duration::from_secs(5);
const WINRT_TIMEOUT: Duration = Duration::from_secs(4);

thread_local! {
    static REQUEST_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}

pub(crate) fn winrt_budget() -> windows::core::Result<Duration> {
    let remaining = REQUEST_DEADLINE
        .get()
        .map(|deadline| deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(WINRT_TIMEOUT)
        .min(WINRT_TIMEOUT);
    if remaining.is_zero() {
        Err(winrt_timeout())
    } else {
        Ok(remaining)
    }
}

fn winrt_timeout() -> windows::core::Error {
    windows::core::Error::new(
        windows::core::HRESULT(0x800705B4_u32 as i32),
        "Media WinRT operation timed out",
    )
}

// Register completion without joining indefinitely. Cancellation is best effort;
// synchronous registration/cancellation calls are covered by the supervisor.
pub(crate) fn wait_winrt<T: windows::core::RuntimeType>(
    budget: Duration,
    operation: windows_future::IAsyncOperation<T>,
) -> windows::core::Result<T> {
    // Include the time spent starting the Windows operation in the request limit.
    let budget = budget.min(
        REQUEST_DEADLINE
            .get()
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(budget),
    );
    wait_completion(
        budget,
        |reply| {
            operation.SetCompleted(&windows_future::AsyncOperationCompletedHandler::new(
                move |_, _| {
                    let _ = reply.send(());
                    Ok(())
                },
            ))
        },
        || operation.GetResults(),
        || {
            // Cancel is advisory. Never replay transport/seek/volume writes.
            let _ = windows::core::Interface::cast::<windows_future::IAsyncInfo>(&operation)
                .and_then(|info| info.Cancel());
        },
    )
}

fn wait_completion<T>(
    budget: Duration,
    register: impl FnOnce(mpsc::Sender<()>) -> windows::core::Result<()>,
    get_results: impl FnOnce() -> windows::core::Result<T>,
    cancel: impl FnOnce(),
) -> windows::core::Result<T> {
    let deadline = Instant::now() + budget;
    let (reply, result) = mpsc::channel();
    register(reply)?;
    match result.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(()) => get_results(),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            cancel();
            Err(winrt_timeout())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(windows::core::Error::new(
            windows::core::HRESULT(0x80004004_u32 as i32),
            "Media WinRT completion disconnected",
        )),
    }
}

type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

struct Lane<S> {
    jobs: mpsc::Sender<Job<S>>,
    thread: JoinHandle<()>,
}

// The supervisor never calls Windows. Each lane creates, uses and drops all
// COM/WinRT state on its own MTA thread; only owned request/results cross it.
pub(crate) struct RecoveringWorker<S> {
    setup: Arc<dyn Fn() -> Result<S, String> + Send + Sync>,
    lane: Option<Lane<S>>,
    retiring: Option<JoinHandle<()>>,
    retry_at: Option<Instant>,
    last_error: String,
    timeout: Duration,
    retry_delay: Duration,
}

impl<S: 'static> RecoveringWorker<S> {
    pub(crate) fn new(setup: impl Fn() -> Result<S, String> + Send + Sync + 'static) -> Self {
        Self {
            setup: Arc::new(setup),
            lane: None,
            retiring: None,
            retry_at: None,
            last_error: String::new(),
            timeout: REQUEST_TIMEOUT,
            retry_delay: RETRY_DELAY,
        }
    }

    pub(crate) fn execute<T: Send + 'static>(
        &mut self,
        work: impl FnOnce(&mut S) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let deadline = Instant::now() + self.timeout;
        self.ensure_lane(deadline)?;
        let (reply, result) = mpsc::channel();
        let job = Box::new(move |state: &mut S| {
            REQUEST_DEADLINE.set(Some(deadline));
            let _ = reply.send(work(state));
        });
        let outcome = match self.lane.as_ref().unwrap().jobs.send(job) {
            Ok(()) => result
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(wait_error)
                .and_then(|result| result),
            Err(_) => Err("Media Windows thread stopped".to_string()),
        };
        if let Err(error) = &outcome {
            self.retire(error.clone());
        }
        outcome
    }

    fn ensure_lane(&mut self, deadline: Instant) -> Result<(), String> {
        if self.lane.is_some() {
            return Ok(());
        }
        if self
            .retiring
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
        {
            // Do not overlap late writes or leak a new thread on every poll.
            return Err(format!(
                "{}; waiting for the previous Windows request to finish",
                self.last_error
            ));
        }
        if let Some(thread) = self.retiring.take() {
            let _ = thread.join(); // is_finished above makes this non-blocking.
        }
        if self.retry_at.is_some_and(|retry| Instant::now() < retry) {
            return Err(format!("{}; media recovery cooldown", self.last_error));
        }

        let setup = Arc::clone(&self.setup);
        let (jobs, requests) = mpsc::channel::<Job<S>>();
        let (ready, initialized) = mpsc::channel();
        let thread = match thread::Builder::new()
            .name("media-windows".to_string())
            .spawn(move || {
                REQUEST_DEADLINE.set(Some(deadline));
                match setup() {
                    Ok(mut state) => {
                        // A timed-out initialization must never receive a job.
                        if ready.send(Ok(())).is_ok() {
                            for job in requests {
                                job(&mut state);
                            }
                        }
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                    }
                }
            }) {
            Ok(thread) => thread,
            Err(error) => {
                let error = format!("Cannot start media Windows thread: {error}");
                self.retire(error.clone());
                return Err(error);
            }
        };
        self.lane = Some(Lane { jobs, thread });
        let outcome = initialized
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(wait_error)
            .and_then(|result| result);
        if let Err(error) = &outcome {
            self.retire(error.clone());
        }
        outcome
    }

    fn retire(&mut self, error: String) {
        if let Some(Lane { jobs, thread }) = self.lane.take() {
            // Closing the queue retires the state after any in-flight call
            // returns. Rust cannot safely kill a thread blocked inside Windows.
            drop(jobs);
            self.retiring = Some(thread);
        }
        self.last_error = error;
        self.retry_at = Some(Instant::now() + self.retry_delay);
    }
}

fn wait_error(error: mpsc::RecvTimeoutError) -> String {
    match error {
        mpsc::RecvTimeoutError::Timeout => "Media Windows request timed out".to_string(),
        mpsc::RecvTimeoutError::Disconnected => "Media Windows thread stopped".to_string(),
    }
}

