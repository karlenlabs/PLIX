//! Narrow packet-read workaround; activation, initialization, events and stream lifecycle use wasapi-rs.
//! Reviewed upstream read_from_device unconditionally dereferences the buffer even on SILENT.
//! Here SILENT is handled before touching the pointer. No alternate capture activation exists.

use windows::{
    core::{Error, Result},
    Win32::{
        Foundation::E_POINTER,
        Media::Audio::{
            IAudioCaptureClient, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
        },
    },
};

pub struct Packet {
    pub discontinuity: bool,
}

pub fn read_packet(
    client: &IAudioCaptureClient,
    pcm: &mut Vec<[f32; 2]>,
) -> Result<Option<Packet>> {
    pcm.clear();
    if unsafe { client.GetNextPacketSize()? } == 0 {
        return Ok(None);
    }
    let (mut data, mut frames, mut flags, mut index, mut timestamp) =
        (std::ptr::null_mut(), 0, 0, 0, 0);
    unsafe {
        client.GetBuffer(
            &mut data,
            &mut frames,
            &mut flags,
            Some(&mut index),
            Some(&mut timestamp),
        )?;
    }
    if frames == 0 {
        return Ok(None);
    }
    // Every successful nonempty GetBuffer is paired with ReleaseBuffer on this thread,
    // including the null-pointer error path. PCM is consumed only while the buffer is held.
    let result = (|| {
        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
            pcm.resize(frames as usize, [0.0; 2]);
        } else {
            if data.is_null() {
                return Err(Error::from_hresult(E_POINTER));
            }
            // Stream is explicitly initialized as interleaved stereo float32 by wasapi-rs.
            let bytes = unsafe { std::slice::from_raw_parts(data, frames as usize * 8) };
            pcm.reserve(frames as usize);
            for frame in bytes.chunks_exact(8) {
                let left = f32::from_le_bytes(frame[..4].try_into().unwrap());
                let right = f32::from_le_bytes(frame[4..].try_into().unwrap());
                pcm.push([left, right]);
            }
        }
        Ok(Packet {
            discontinuity: flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0,
        })
    })();
    unsafe {
        client.ReleaseBuffer(frames)?;
    }
    result.map(Some)
}
