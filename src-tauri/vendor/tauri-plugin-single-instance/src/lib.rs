// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
//! Windows profile of the official plugin. Local changes are listed in UPSTREAM.md.
#![cfg(target_os = "windows")]
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Resource, Runtime};
#[path = "windows.rs"]
mod platform_impl;
mod user_scope;

pub(crate) type SingleInstanceCallback<R> =
    dyn FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static;

/// Register first, before application setup or any worker construction.
/// Secondary processes exit here, without requesting Quit from either app.
pub fn init<R: Runtime, F: FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static>(
    callback: F,
) -> TauriPlugin<R> {
    platform_impl::init(Box::new(callback))
}

pub(crate) fn manage_instance_lock<R: Runtime, M: Manager<R>>(manager: &M, lock: impl Resource) {
    // Tauri clears resources only after the application's RunEvent::Exit callback.
    // No early destroy API: one owner releases this single lock during final cleanup.
    manager.resources_table().add(lock);
}
