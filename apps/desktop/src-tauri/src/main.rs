#[cfg(feature = "desktop")]
#[tauri::command]
fn foundation_status() -> &'static str {
    "foundation-only-no-installation"
}

#[cfg(feature = "desktop")]
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![foundation_status])
        .run(tauri::generate_context!())
        .expect("Application failed");
}

#[cfg(not(feature = "desktop"))]
fn main() {
    println!("Native shell disabled; enable desktop feature with Windows Tauri prerequisites.");
}
