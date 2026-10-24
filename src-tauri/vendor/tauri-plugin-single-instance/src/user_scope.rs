//! One Global mutex per Windows token SID, independent of EXE path or session.
use std::{io, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree},
    Security::{
        Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
        TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

pub(super) fn identity(identifier: &str) -> io::Result<String> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut length = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
            if length == 0 {
                return Err(io::Error::last_os_error());
            }
            // TOKEN_USER and its SID storage require pointer alignment.
            let mut storage =
                vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
            if GetTokenInformation(
                token,
                TokenUser,
                storage.as_mut_ptr().cast(),
                length,
                &mut length,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let user = &*storage.as_ptr().cast::<TOKEN_USER>();
            let mut sid = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut count = 0;
            while *sid.add(count) != 0 {
                count += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(sid, count));
            LocalFree(sid.cast());
            Ok(format!("{identifier}.{text}"))
        })();
        CloseHandle(token);
        result
    }
}
