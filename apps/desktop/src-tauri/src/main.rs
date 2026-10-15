#[cfg(feature = "desktop")]
mod client_updates;
#[cfg(feature = "desktop")]
mod commands;
#[cfg(feature = "desktop")]
mod update_cancel;

#[cfg(feature = "desktop")]
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(commands::setup)
        .invoke_handler(tauri::generate_handler![
            commands::desktop_state,
            commands::catalog_refresh,
            commands::preferences_save,
            commands::catalog_cache_clear,
            commands::client_update_check,
            commands::client_update_install,
            commands::client_update_cancel,
            commands::diagnostics_clear,
            commands::open_project_page
        ])
        .run(tauri::generate_context!())
        .expect("Application failed");
}

#[cfg(not(feature = "desktop"))]
fn main() {
    println!("Native shell disabled; enable desktop feature with Windows Tauri prerequisites.");
}
