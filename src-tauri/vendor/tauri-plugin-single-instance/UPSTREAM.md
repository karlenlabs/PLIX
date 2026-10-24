# Windows single-instance vendor profile

This locally adapted, Windows-only profile is pinned as version 2.5.4-plix.1.
It is built from the checked-in source and is not a registry dependency.

Upstream: Tauri Programme within The Commons Conservancy, Apache-2.0 OR MIT.
The included [MIT license](LICENSE-MIT) is retained.

Source references, retrieved 2026-10-22:
- https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/single-instance/src/platform_impl/windows.rs
- https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/single-instance/src/lib.rs

Upstream Windows snapshot SHA-256:
867122B0BD2B7081FDFD73F28C2684E0E33B39551872755B87C3CB486CC51A70

The local profile keeps Windows init(callback), bounded IPC publication/delivery,
argument forwarding, and resource-owned cleanup. It scopes one Global mutex to
the application identifier and current Windows token SID. Secondary launches exit
without constructing application workers, including when activation cannot be
delivered. Mutex and callback ownership are handled by the Tauri resource.
Optional deep-link, semver and non-Windows functionality are omitted.

Window activation behavior belongs to the application's callback. The plugin
does not modify settings or interpret arguments as player commands.
