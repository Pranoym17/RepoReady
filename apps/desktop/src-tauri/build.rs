fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_state",
            "catalog_refresh",
            "preferences_save",
            "catalog_cache_clear",
            "client_update_check",
            "client_update_install",
            "client_update_cancel",
            "diagnostics_clear",
            "open_project_page",
        ]),
    ))
    .expect("Tauri manifest validation failed");
}
