use std::{
    mem::{size_of, ManuallyDrop},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use wasapi::{AudioClient, Direction};
use windows::{
    core::{implement, IUnknown, Interface, Ref, HRESULT},
    Win32::{
        Media::Audio::*,
        System::{
            Com::{
                StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                BLOB,
            },
            Variant::VT_BLOB,
        },
    },
};

// Same INCLUDE_TARGET_PROCESS_TREE activation as wasapi-rs 0.26, but its
// unbounded Condvar wait is replaced with a deadline and lifecycle cancellation.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion {
    ready: mpsc::Sender<()>,
    // Keep the activation blob alive even if Windows completes after cancellation.
    _params: Arc<AUDIOCLIENT_ACTIVATION_PARAMS>,
}
impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.ready.send(());
        Ok(())
    }
}

pub fn activate(
    pid: u32,
    running: impl Fn() -> bool,
) -> Result<Option<AudioClient>, Box<dyn std::error::Error>> {
    let params = Arc::new(AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    });
    let prop = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: Arc::as_ptr(&params).cast_mut().cast(),
                    },
                },
            }),
        },
    });
    let (ready, receive) = mpsc::channel();
    let completion: IActivateAudioInterfaceCompletionHandler = Completion {
        ready,
        _params: params,
    }
    .into();
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*prop),
            &completion,
        )?
    };
    if !wait_ready(&receive, running, Duration::from_secs(3))? {
        return Ok(None);
    }
    let mut result = HRESULT(0);
    let mut interface: Option<IUnknown> = None;
    unsafe {
        operation.GetActivateResult(&mut result, &mut interface)?;
    }
    result.ok()?;
    let client: IAudioClient = interface
        .ok_or("Activation returned no IAudioClient")?
        .cast()?;
    Ok(Some(AudioClient::from_iaudioclient(
        client,
        Direction::Render,
    )))
}

fn wait_ready(
    receive: &mpsc::Receiver<()>,
    running: impl Fn() -> bool,
    timeout: Duration,
) -> Result<bool, Box<dyn std::error::Error>> {
    let deadline = Instant::now() + timeout;
    while running() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("ACTIVATION_TIMEOUT".into());
        }
        match receive.recv_timeout(remaining.min(Duration::from_millis(20))) {
            Ok(()) => return Ok(running()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(false)
}

