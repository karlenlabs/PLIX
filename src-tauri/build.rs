fn main() {
    // Release optimization alone does not enable Tauri's production protocol.
    // Without custom-protocol Tauri selects devUrl and embeds no frontend assets.
    if std::env::var("PROFILE").as_deref() == Ok("release") && tauri_build::is_dev() {
        panic!(
            "PLIX release requires tauri/custom-protocol. Build with Tauri CLI: \
             npm run tauri build -- --no-bundle -- --locked --offline. \
             Plain cargo build --release would load devUrl instead of embedded assets."
        );
    }
    tauri_build::build()
}
