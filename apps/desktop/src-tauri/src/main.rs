#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(feature = "desktop")]
mod client_updates;
#[cfg(feature = "desktop")]
mod commands;
#[cfg(feature = "desktop")]
mod update_cancel;

#[cfg(feature = "desktop")]
fn main() {
    #[cfg(windows)]
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--remove-client-state")
    {
        let result = remove_client_state();
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
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

#[cfg(all(windows, feature = "desktop"))]
fn remove_client_state() -> Result<(), String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath},
    };
    if std::env::args_os().count() != 2 {
        return Err("INVALID_CLEANUP_ARGUMENTS".into());
    }
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let identifier = context.config().identifier.clone();
    let mut pointer = std::ptr::null_mut();
    // SAFETY: the Windows API allocates a terminated UTF-16 known-folder string.
    let result = unsafe {
        SHGetKnownFolderPath(
            &FOLDERID_LocalAppData,
            0,
            std::ptr::null_mut(),
            &mut pointer,
        )
    };
    if result < 0 || pointer.is_null() {
        return Err("CLEANUP_FOLDER_UNAVAILABLE".into());
    }
    let mut length = 0usize;
    // SAFETY: scan the OS-owned terminated string with an upper bound, then free it once.
    unsafe {
        while length < 32768 && *pointer.add(length) != 0 {
            length += 1;
        }
        if length == 32768 {
            CoTaskMemFree(pointer.cast());
            return Err("CLEANUP_FOLDER_UNAVAILABLE".into());
        }
        let folder = std::ffi::OsString::from_wide(std::slice::from_raw_parts(pointer, length));
        CoTaskMemFree(pointer.cast());
        repoready_core::cleanup::remove_client_state(std::path::Path::new(&folder), &identifier)
    }
}

#[cfg(not(feature = "desktop"))]
fn main() {
    println!("Native shell disabled; enable desktop feature with Windows Tauri prerequisites.");
}
