use crate::volume_worker::RequestControl;
use windows::core::{Interface, Owned, PWSTR};
use windows::Win32::Foundation::{S_FALSE, S_OK};
use windows::Win32::Media::Audio::{
    eRender, AudioSessionStateActive, AudioSessionStateExpired, IAudioSessionControl2,
    IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioVolume {
    pub session_id: String,
    level: f32,
    muted: bool,
}
#[derive(Clone, Copy)]
pub(crate) enum VolumeChange {
    Level(f32),
    Mute(bool),
}
struct ComString(PWSTR);
impl Drop for ComString {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0.as_ptr().cast())) };
    }
}
fn string(result: windows::core::Result<PWSTR>) -> windows::core::Result<String> {
    let value = ComString(result?);
    unsafe { Ok(value.0.to_string()?) }
}
fn process_identity(pid: u32) -> Result<String, String> {
    if pid == 0 {
        return Err("PID 0 has no process identity".into());
    }
    unsafe {
        let handle = Owned::new(
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .map_err(|error| format!("PID {pid} OpenProcess: {error}"))?,
        );
        let mut path = vec![0_u16; 32768];
        let mut length = path.len() as u32;
        QueryFullProcessImageNameW(
            *handle,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
        .map_err(|error| format!("PID {pid} QueryFullProcessImageNameW: {error}"))?;
        let name = String::from_utf16_lossy(&path[..length as usize])
            .rsplit('\\')
            .next()
            .unwrap_or("")
            .to_string();
        Ok(name)
    }
}
fn yandex_name(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "яндекс музыка.exe" | "yandexmusic.exe"
    )
}

pub(crate) struct YandexSession {
    pub session_id: String,
    pub control: IAudioSessionControl2,
    pub active: bool,
}
struct SelectedSession {
    session: YandexSession,
    volume: ISimpleAudioVolume,
}
struct Scan {
    candidates: Vec<YandexSession>,
}

// The single enumeration and acceptance path for volume and mute.
fn scan_sessions(target: Option<&str>, request: &RequestControl) -> windows::core::Result<Scan> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            request.read(|| CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL))?;
        let devices =
            request.read(|| enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE))?;
        let mut result = Scan { candidates: vec![] };
        for endpoint_index in 0..request.read(|| devices.GetCount())? {
            let device = match request.read(|| devices.Item(endpoint_index)) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let device_id = request.read(|| string(device.GetId()))?;
            let manager =
                match request.read(|| device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
            let sessions = match request.read(|| manager.GetSessionEnumerator()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let count = match request.read(|| sessions.GetCount()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            for session_index in 0..count {
                request.check()?;
                let mut required_identifier_error = None;
                let inspected = (|| -> windows::core::Result<()> {
                    let session = request.read(|| sessions.GetSession(session_index))?;
                    let control = request.read(|| session.cast::<IAudioSessionControl2>())?;
                    let state = request.read(|| control.GetState());
                    let system = request.read(|| Ok(control.IsSystemSoundsSession()))?;
                    let mut pid = 0;
                    let pid_status = request
                        .read(|| Ok((control.vtable().GetProcessId)(control.as_raw(), &mut pid)))?;
                    let inspect_identity =
                        state.as_ref().is_ok_and(|s| *s != AudioSessionStateExpired)
                            && system == S_FALSE
                            && pid_status == S_OK;
                    let identity = inspect_identity.then(|| process_identity(pid));
                    let mut accepted = identity
                        .as_ref()
                        .is_some_and(|id| id.as_ref().is_ok_and(|name| yandex_name(name)));
                    let instance = if accepted {
                        Some(request.read(|| string(control.GetSessionInstanceIdentifier())))
                    } else {
                        None
                    };
                    let key = instance
                        .as_ref()
                        .and_then(|value| value.as_ref().ok())
                        .map(|value| format!("{device_id}\0{value}"));
                    if accepted && key.is_none() {
                        required_identifier_error = instance
                            .as_ref()
                            .and_then(|value| value.as_ref().err())
                            .cloned();
                        accepted = false;
                    }
                    if accepted && target.is_some_and(|expected| Some(expected) != key.as_deref()) {
                        accepted = false;
                    }
                    if accepted {
                        result.candidates.push(YandexSession {
                            session_id: key.unwrap(),
                            control,
                            active: state? == AudioSessionStateActive,
                        });
                    }
                    Ok(())
                })();
                if let Some(error) = required_identifier_error {
                    return Err(error);
                }
                let _ = inspected;
                request.check()?;
            }
        }
        Ok(result)
    }
}

pub(crate) fn unique_preferred<T>(
    mut candidates: Vec<(T, bool)>,
    prefer_active: bool,
) -> Option<T> {
    if prefer_active && candidates.iter().any(|(_, active)| *active) {
        candidates.retain(|(_, active)| *active);
    }
    if candidates.len() == 1 {
        candidates.pop().map(|(item, _)| item)
    } else {
        None
    }
}
fn select_volume_session(
    target: Option<&str>,
    request: &RequestControl,
) -> windows::core::Result<Option<SelectedSession>> {
    let mut candidates = vec![];
    for session in scan_sessions(target, request)?.candidates {
        let volume = request.read(|| session.control.cast::<ISimpleAudioVolume>())?;
        let active = session.active;
        candidates.push((SelectedSession { session, volume }, active));
    }
    Ok(unique_preferred(candidates, target.is_none()))
}

// Same key retains the exact selected COM object.
#[derive(Default)]
struct SelectionCache<T> {
    current: Option<(String, T)>,
}
impl<T> SelectionCache<T> {
    fn replace(&mut self, next: Option<(String, T)>) {
        if self.current.as_ref().map(|(id, _)| id) == next.as_ref().map(|(id, _)| id) {
            return;
        }
        self.current = next;
    }
}
pub(crate) struct VolumeSessionOwner {
    selected: SelectionCache<SelectedSession>,
}
impl Default for VolumeSessionOwner {
    fn default() -> Self {
        Self {
            selected: SelectionCache { current: None },
        }
    }
}
impl VolumeSessionOwner {
    pub fn selected(&self) -> Option<&YandexSession> {
        self.selected
            .current
            .as_ref()
            .map(|(_, value)| &value.session)
    }
    pub fn clear(&mut self) {
        self.selected.replace(None);
    }
    pub fn volume(
        &mut self,
        target: Option<(&str, VolumeChange)>,
        request: &RequestControl,
    ) -> windows::core::Result<Option<AudioVolume>> {
        let result = (|| -> windows::core::Result<Option<AudioVolume>> {
            let chosen = select_volume_session(target.map(|(id, _)| id), request)?;
            self.selected
                .replace(chosen.map(|value| (value.session.session_id.clone(), value)));
            let Some((_, selected)) = &self.selected.current else {
                return Ok(None);
            };
            unsafe {
                if let Some((_, change)) = target {
                    match change {
                        VolumeChange::Level(level) => {
                            if (request.read(|| selected.volume.GetMasterVolume())? - level).abs()
                                > 0.0001
                            {
                                request.write(|| {
                                    selected.volume.SetMasterVolume(level, std::ptr::null())
                                })?;
                            }
                        }
                        VolumeChange::Mute(muted) => {
                            if request.read(|| selected.volume.GetMute())?.as_bool() != muted {
                                request
                                    .write(|| selected.volume.SetMute(muted, std::ptr::null()))?;
                            }
                        }
                    }
                }
                Ok(Some(AudioVolume {
                    session_id: selected.session.session_id.clone(),
                    level: request.read(|| selected.volume.GetMasterVolume())?,
                    muted: request.read(|| selected.volume.GetMute())?.as_bool(),
                }))
            }
        })();
        if result.is_err() {
            self.clear();
        }
        result
    }
}


