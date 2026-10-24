use crate::MediaState;
use std::sync::Mutex;
use tauri::image::Image;
use tauri::Manager;
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSMICON};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlaybackIcon {
    Neutral,
    Play,
    Pause,
}

impl PlaybackIcon {
    fn from_read(read: &Result<Option<MediaState>, String>) -> Self {
        match read
            .as_ref()
            .ok()
            .and_then(|media| media.as_ref())
            .map(|media| media.playback_state)
        {
            Some("playing") => Self::Play,
            Some("paused") => Self::Pause,
            _ => Self::Neutral,
        }
    }
}

struct AppliedIcon {
    current: PlaybackIcon,
    last_error: Option<String>,
}

impl AppliedIcon {
    fn new() -> Self {
        Self {
            current: PlaybackIcon::Neutral,
            last_error: None,
        }
    }

    fn update(
        &mut self,
        desired: PlaybackIcon,
        set_icon: impl FnOnce(PlaybackIcon) -> Result<(), String>,
    ) -> Result<bool, String> {
        if self.current == desired {
            return Ok(false);
        }
        set_icon(desired)?;
        // A failed Windows update must not suppress the next read's retry.
        self.current = desired;
        Ok(true)
    }
}

struct TrayPlayback {
    neutral: Image<'static>,
    play: Image<'static>,
    pause: Image<'static>,
    applied: Mutex<AppliedIcon>,
}

impl TrayPlayback {
    fn image(&self, icon: PlaybackIcon) -> &Image<'static> {
        match icon {
            PlaybackIcon::Neutral => &self.neutral,
            PlaybackIcon::Play => &self.play,
            PlaybackIcon::Pause => &self.pause,
        }
    }
}

pub fn neutral_image() -> Image<'static> {
    // Keep the existing Windows slot/canvas size; only change the pixels inside it.
    let size = unsafe { GetSystemMetrics(SM_CXSMICON) }.clamp(16, 64) as u32;
    symbol_image(PlaybackIcon::Neutral, size)
}

// Called only after lifecycle creates the tray with this exact neutral image.
pub fn setup(app: &tauri::App, neutral: Image<'static>) {
    let size = neutral.width();
    app.manage(TrayPlayback {
        neutral,
        play: symbol_image(PlaybackIcon::Play, size),
        pause: symbol_image(PlaybackIcon::Pause, size),
        applied: Mutex::new(AppliedIcon::new()),
    });
}

// Observe the existing GSMTC read result. No session query, timer or subscription here.
pub fn sync(app: &tauri::AppHandle, read: &Result<Option<MediaState>, String>) {
    let Some(state) = app.try_state::<TrayPlayback>() else {
        return; // A read during startup/shutdown must not affect media IPC.
    };
    let Ok(mut applied) = state.applied.lock() else {
        eprintln!("Failed to lock tray playback state");
        return;
    };
    let result = applied.update(PlaybackIcon::from_read(read), |icon| {
        let tray = app.tray_by_id("ympleer").ok_or("PLIX tray is missing")?;
        // Replace only the image on the existing tray; Tauri owns the native HICON lifetime.
        tray.set_icon(Some(state.image(icon).clone()))
            .map_err(|error| error.to_string())
    });
    match result {
        Ok(_) => applied.last_error = None,
        Err(error) => {
            if applied.last_error.as_ref() != Some(&error) {
                eprintln!("Failed to update tray playback icon: {error}");
            }
            applied.last_error = Some(error);
        }
    }
}

fn symbol_sample(icon: PlaybackIcon, x: f32, y: f32, size: u32) -> Option<[u8; 3]> {
    let edge_distance = match icon {
        PlaybackIcon::Play => {
            // Slight right bias balances the filled mass of the larger triangle.
            let vertices = [(3.75, 1.0), (15.5, 8.0), (3.75, 15.0)];
            let mut distance = f32::INFINITY;
            for index in 0..3 {
                let (ax, ay) = vertices[index];
                let (bx, by) = vertices[(index + 1) % 3];
                let dx = bx - ax;
                let dy = by - ay;
                distance = distance.min((dx * (y - ay) - dy * (x - ax)) / dx.hypot(dy));
            }
            distance
        }
        PlaybackIcon::Pause => {
            // Snap both bars and their gap to physical pixels, without bitmap scaling.
            let pixels = size as f32;
            let margin = (pixels / 8.0).floor();
            let gap = (pixels * 0.075).round().max(2.0);
            let bar = ((pixels - margin * 2.0 - gap) / 2.0).floor();
            let right_edge = pixels - margin;
            let px = x * pixels / 16.0;
            let py = y * pixels / 16.0;
            let top = (pixels / 16.0).round();
            let left = (px - margin).min(margin + bar - px);
            let right = (px - (right_edge - bar)).min(right_edge - px);
            left.max(right).min(py - top).min(pixels - top - py) * 16.0 / pixels
        }
        PlaybackIcon::Neutral => return None,
    };
    if edge_distance < 0.0 {
        None
    } else if edge_distance < 1.2 {
        Some([32, 36, 43]) // Dark keyline remains visible on a light taskbar.
    } else {
        Some([246, 247, 249]) // Light fill remains visible on a dark taskbar.
    }
}

const NEUTRAL_ATLAS: &[u8] = include_bytes!("../icons/tray/neutral-16-64.rgba");

fn plix_neutral_image(size: u32) -> Image<'static> {
    assert!((16..=64).contains(&size));
    let offset: usize = (16..size).map(|n| (n * n * 4) as usize).sum();
    let length = (size * size * 4) as usize;
    Image::new_owned(NEUTRAL_ATLAS[offset..offset + length].to_vec(), size, size)
}

fn symbol_image(icon: PlaybackIcon, size: u32) -> Image<'static> {
    if icon == PlaybackIcon::Neutral {
        return plix_neutral_image(size);
    }
    // Render each target size directly: crisp bars and antialiased diagonals, with transparent unused pixels.
    let mut rgba = vec![0; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let mut covered = 0;
            let mut rgb = [0_u32; 3];
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = (x as f32 + (sx as f32 + 0.5) / 4.0) * 16.0 / size as f32;
                    let py = (y as f32 + (sy as f32 + 0.5) / 4.0) * 16.0 / size as f32;
                    if let Some(color) = symbol_sample(icon, px, py, size) {
                        covered += 1;
                        for channel in 0..3 {
                            rgb[channel] += color[channel] as u32;
                        }
                    }
                }
            }
            if covered != 0 {
                let offset = ((y * size + x) * 4) as usize;
                for channel in 0..3 {
                    rgba[offset + channel] = ((rgb[channel] + covered / 2) / covered) as u8;
                }
                rgba[offset + 3] = ((covered * 255 + 8) / 16) as u8;
            }
        }
    }
    Image::new_owned(rgba, size, size)
}

