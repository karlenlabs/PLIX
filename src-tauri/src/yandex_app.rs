use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use windows::core::{Owned, BOOL, PWSTR};
use windows::Win32::Foundation::{ERROR_NO_MORE_FILES, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindowAsync,
    GWL_EXSTYLE, GW_OWNER, SW_RESTORE, SW_SHOW, WS_EX_TOOLWINDOW,
};

fn is_yandex_executable(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy().to_lowercase();
        name == "яндекс музыка.exe" || name == "yandexmusic.exe"
    })
}

fn process_path(pid: u32) -> windows::core::Result<PathBuf> {
    unsafe {
        let process = Owned::new(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?);
        let mut path = vec![0_u16; 32768];
        let mut length = path.len() as u32;
        QueryFullProcessImageNameW(
            *process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )?;
        Ok(PathBuf::from(String::from_utf16_lossy(
            &path[..length as usize],
        )))
    }
}

fn running_processes() -> Result<Vec<u32>, String> {
    unsafe {
        let snapshot = Owned::new(
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|error| error.to_string())?,
        );
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        Process32FirstW(*snapshot, &mut entry).map_err(|error| error.to_string())?;
        let mut pids = Vec::new();
        let mut found_named_process = false;
        loop {
            let length = entry
                .szExeFile
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = PathBuf::from(String::from_utf16_lossy(&entry.szExeFile[..length]));
            if is_yandex_executable(&name) {
                found_named_process = true;
                if process_path(entry.th32ProcessID).is_ok_and(|path| is_yandex_executable(&path)) {
                    pids.push(entry.th32ProcessID);
                }
            }
            if let Err(error) = Process32NextW(*snapshot, &mut entry) {
                if error.code() != windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) {
                    return Err(error.to_string());
                }
                break;
            }
        }
        if found_named_process && pids.is_empty() {
            return Err("Cannot verify the running Yandex Music process".into());
        }
        Ok(pids)
    }
}

struct WindowSearch<'a> {
    pids: &'a [u32],
    window: Option<(HWND, u32, bool)>,
}

unsafe extern "system" fn find_window(window: HWND, data: LPARAM) -> BOOL {
    let search = &mut *(data.0 as *mut WindowSearch<'_>);
    let mut pid = 0;
    GetWindowThreadProcessId(window, Some(&mut pid));
    if !search.pids.contains(&pid)
        || GetWindow(window, GW_OWNER).is_ok_and(|owner| !owner.is_invalid())
        || GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW.0 as isize != 0
        || GetWindowTextLengthW(window) == 0
    {
        return BOOL(1);
    }
    let visible = IsWindowVisible(window).as_bool();
    // Include the hidden main window (tray), but prefer a visible app window.
    if search.window.is_none() || visible && !search.window.unwrap().2 {
        search.window = Some((window, pid, visible));
    }
    BOOL(1)
}

fn focus(pids: &[u32]) -> Result<(), String> {
    unsafe {
        let mut search = WindowSearch { pids, window: None };
        EnumWindows(
            Some(find_window),
            LPARAM((&mut search as *mut WindowSearch<'_>) as isize),
        )
        .map_err(|error| error.to_string())?;
        let (window, expected_pid, _) = search.window.ok_or("Yandex Music window was not found")?;
        let mut pid = 0;
        GetWindowThreadProcessId(window, Some(&mut pid));
        // Recheck identity before using a handle that may have become stale.
        if pid != expected_pid || !process_path(pid).is_ok_and(|path| is_yandex_executable(&path)) {
            return Err("Yandex Music window is no longer available".into());
        }
        let show = if IsIconic(window).as_bool() {
            SW_RESTORE
        } else {
            SW_SHOW
        };
        if !ShowWindowAsync(window, show).as_bool() {
            return Err("Cannot show Yandex Music window".into());
        }
        // Showing a remote window is asynchronous. Bound the wait and let Windows
        // enforce foreground rules; do not attach input threads or alter topmost.
        for _ in 0..10 {
            if SetForegroundWindow(window).as_bool() || GetForegroundWindow() == window {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err("Windows did not allow Yandex Music to take focus".into())
    }
}

fn installed_executable(local_app_data: &Path) -> Result<PathBuf, String> {
    // This per-user installation was verified on this system. Resolve the user's
    // folder at runtime and require an existing exact desktop executable.
    let directory = local_app_data.join("Programs").join("YandexMusic");
    let paths: Vec<_> = ["Яндекс Музыка.exe", "YandexMusic.exe"]
        .iter()
        .map(|name| directory.join(name))
        .filter(|path| path.is_file())
        .collect();
    if paths.len() != 1 {
        return Err("Yandex Music desktop executable is missing or ambiguous".into());
    }
    let path = paths[0].canonicalize().map_err(|error| error.to_string())?;
    if !is_yandex_executable(&path) {
        return Err("Yandex Music desktop executable could not be verified".into());
    }
    Ok(path)
}

fn open_or_focus() -> Result<(), String> {
    let pids = running_processes()?;
    if !pids.is_empty() {
        // Focus errors never fall through to launching another process/app.
        return focus(&pids);
    }
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    let executable = installed_executable(Path::new(&local_app_data))?;
    Command::new(&executable)
        .current_dir(
            executable
                .parent()
                .ok_or("Application directory is missing")?,
        )
        .spawn()
        .map_err(|error| format!("Cannot start Yandex Music: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_yandex_music() -> Result<(), String> {
    // Window/process operations remain independent of media polling and its COM lane.
    tauri::async_runtime::spawn_blocking(open_or_focus)
        .await
        .map_err(|error| error.to_string())?
}

