use tauri::{Manager, PhysicalPosition, PhysicalRect, PhysicalSize};

const GAP_LOGICAL: f64 = 8.0;

fn panel_size(work_area: PhysicalSize<u32>, scale: f64) -> tauri::LogicalSize<f64> {
    tauri::LogicalSize::new(
        392.0_f64.min((f64::from(work_area.width) / scale).floor()),
        437.0_f64.min((f64::from(work_area.height) / scale).floor()),
    )
}

fn size_at_scale(size: PhysicalSize<u32>, from: f64, to: f64) -> PhysicalSize<u32> {
    let ratio = to / from;
    PhysicalSize::new(
        (f64::from(size.width) * ratio).ceil() as u32,
        (f64::from(size.height) * ratio).ceil() as u32,
    )
}

fn placement(
    main_position: PhysicalPosition<i32>,
    main_size: PhysicalSize<u32>,
    appearance_size: PhysicalSize<u32>,
    work_area: &PhysicalRect<i32, u32>,
    gap: i64,
) -> Option<PhysicalPosition<i32>> {
    if appearance_size.width > work_area.size.width
        || appearance_size.height > work_area.size.height
        || work_area.size.width == 0
        || work_area.size.height == 0
    {
        return None;
    }
    let left = i64::from(work_area.position.x);
    let top = i64::from(work_area.position.y);
    let width = i64::from(appearance_size.width);
    let height = i64::from(appearance_size.height);
    let max_x = left + i64::from(work_area.size.width) - width;
    let max_y = top + i64::from(work_area.size.height) - height;
    let x = i64::from(main_position.x);
    let y = i64::from(main_position.y);
    let centered_x = (x + (i64::from(main_size.width) - width).div_euclid(2)).clamp(left, max_x);
    let aligned_y = y.clamp(top, max_y);
    // Clamp only the perpendicular axis so an edge cannot obscure a fitting side.
    let candidates = [
        (centered_x, y - height - gap),                      // above
        (x + i64::from(main_size.width) + gap, aligned_y),   // right
        (x - width - gap, aligned_y),                        // left
        (centered_x, y + i64::from(main_size.height) + gap), // below
    ];
    let (x, y) = candidates
        .iter()
        .copied()
        .find(|(x, y)| *x >= left && *x <= max_x && *y >= top && *y <= max_y)
        // A small work area may require overlap; visibility takes precedence.
        .unwrap_or((
            candidates[0].0.clamp(left, max_x),
            candidates[0].1.clamp(top, max_y),
        ));
    Some(PhysicalPosition::new(
        i32::try_from(x).ok()?,
        i32::try_from(y).ok()?,
    ))
}

pub fn position(app: &tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Main window is missing")?;
    let appearance = app
        .get_webview_window("appearance")
        .ok_or("Appearance window is missing")?;
    let main_position = main.outer_position().map_err(|error| error.to_string())?;
    let main_size = main.outer_size().map_err(|error| error.to_string())?;
    let monitor = main
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("Main window monitor is unavailable")?;
    let target_scale = monitor.scale_factor();
    if !target_scale.is_finite() || target_scale <= 0.0 {
        return Err("Monitor scale factor is invalid".into());
    }
    // Fit the actual work area at this DPI; the content scrolls vertically if needed.
    appearance
        .set_size(panel_size(monitor.work_area().size, target_scale))
        .map_err(|error| error.to_string())?;
    let gap = (GAP_LOGICAL * target_scale).round() as i64;

    // Moving a hidden panel to another monitor may trigger native DPI adjustments.
    // Recalculate once using its actual size/scale after that move, before showing it.
    for _ in 0..2 {
        let panel_scale = appearance
            .scale_factor()
            .map_err(|error| error.to_string())?;
        if !panel_scale.is_finite()
            || panel_scale <= 0.0
            || !target_scale.is_finite()
            || target_scale <= 0.0
        {
            return Err("Window scale factor is invalid".into());
        }
        let panel_size = size_at_scale(
            appearance.outer_size().map_err(|error| error.to_string())?,
            panel_scale,
            target_scale,
        );
        let position = placement(
            main_position,
            main_size,
            panel_size,
            monitor.work_area(),
            gap,
        )
        .ok_or("Monitor work area is too small for Appearance")?;
        if appearance
            .outer_position()
            .map_err(|error| error.to_string())?
            == position
        {
            break;
        }
        appearance
            .set_position(position)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

