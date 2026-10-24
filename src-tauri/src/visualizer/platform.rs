use std::mem::size_of;
use windows::{
    core::{Error, Result, PWSTR},
    Win32::{
        Foundation::{CloseHandle, ERROR_NO_MORE_FILES, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    },
};

pub struct OwnedHandle(pub HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[derive(Clone, Debug)]
pub struct Process {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}
impl Process {
    pub fn is_yandex(&self) -> bool {
        self.name.eq_ignore_ascii_case("YandexMusic.exe") || self.name == "Яндекс Музыка.exe"
    }
}

pub fn processes() -> Result<Vec<Process>> {
    let snapshot = OwnedHandle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)? });
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if let Err(error) = unsafe { Process32FirstW(snapshot.0, &mut entry) } {
        if error.code() == ERROR_NO_MORE_FILES.to_hresult() {
            return Ok(Vec::new());
        }
        return Err(error);
    }
    let mut list = Vec::new();
    loop {
        let end = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        list.push(Process {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..end]),
        });
        match unsafe { Process32NextW(snapshot.0, &mut entry) } {
            Ok(()) => {}
            Err(error) if error.code() == ERROR_NO_MORE_FILES.to_hresult() => break,
            Err(error) => return Err(error),
        }
    }
    Ok(list)
}

// Never walk above the matching Yandex executable to Explorer, an updater, or a shell.
pub fn yandex_roots(list: &[Process]) -> Vec<Process> {
    let mut roots: Vec<_> = list
        .iter()
        .filter(|p| {
            p.is_yandex()
                && !list
                    .iter()
                    .any(|parent| parent.pid == p.parent && parent.is_yandex())
        })
        .cloned()
        .collect();
    roots.sort_by_key(|p| p.pid);
    roots
}

pub fn open_target(pid: u32) -> Result<OwnedHandle> {
    Ok(OwnedHandle(unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )?
    }))
}

pub fn image_path(handle: &OwnedHandle) -> Result<String> {
    let mut path = vec![0_u16; 32768];
    let mut length = path.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle.0,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )?;
    }
    Ok(String::from_utf16_lossy(&path[..length as usize]))
}

pub fn alive(handle: &OwnedHandle) -> Result<bool> {
    match unsafe { WaitForSingleObject(handle.0, 0) } {
        WAIT_TIMEOUT => Ok(true),
        WAIT_OBJECT_0 => Ok(false),
        _ => Err(Error::from_thread()),
    }
}
