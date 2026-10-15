use crate::client_updates::ClientUpdates;
use repoready_core::{
    desktop,
    diagnostics::{Code, Component, Event},
    network::CatalogSource,
    storage::Store,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

pub struct Runtime {
    store: Store,
    source: Option<CatalogSource>,
    updates: Result<ClientUpdates, String>,
    version: String,
    mode: &'static str,
}
pub struct DesktopState(Arc<Mutex<Result<Runtime, String>>>, Arc<AtomicBool>);
fn log(store: &Store, code: Code, component: Component) {
    let _ = store.log_event(Event { code, component });
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let runtime = (|| -> Result<Runtime, String> {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "STATE_STORAGE_FAILED")?;
        let mut store = Store::open(&root.join("desktop-state"))?;
        let config: Value = serde_json::from_str(include_str!("../native-config.json"))
            .map_err(|_| "INVALID_CATALOG_CONFIG")?;
        let keys: BTreeMap<String, [u8; 32]> =
            serde_json::from_value(config["catalogKeys"].clone())
                .map_err(|_| "INVALID_CATALOG_CONFIG")?;
        store.set_catalog_keys(keys.clone());
        let source = match config["catalogOrigin"].as_str() {
            Some(origin) => Some(CatalogSource::new(
                origin,
                config["catalogIndexPath"]
                    .as_str()
                    .ok_or("INVALID_CATALOG_CONFIG")?,
                keys,
            )?),
            None => None,
        };
        let version = app.package_info().version.to_string();
        // An updater-state failure must not disable the separate Library or Settings.
        let updates = ClientUpdates::new(&root.join("client-updates")).and_then(|mut updates| {
            updates.reconcile_startup(&version)?;
            Ok(updates)
        });
        log(&store, Code::Started, Component::Desktop);
        Ok(Runtime {
            store,
            source,
            updates,
            version,
            mode: if app.config().identifier == "org.repoready.development" {
                "development"
            } else {
                "stable"
            },
        })
    })();
    let cancellation = runtime
        .as_ref()
        .ok()
        .and_then(|r| r.updates.as_ref().ok())
        .map(|updates| updates.cancellation_handle())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(true)));
    app.manage(DesktopState(Arc::new(Mutex::new(runtime)), cancellation));
    Ok(())
}
fn state(runtime: &Runtime, error: Option<Value>) -> Result<Value, String> {
    let update = runtime
        .updates
        .as_ref()
        .map(|updates| updates.snapshot())
        .unwrap_or_else(
            |_| json!({"status":"failed","version":null,"messageCode":"UPDATE_RECOVERY_REQUIRED"}),
        );
    let mut value = desktop::snapshot(&runtime.store, now(), update, error)?;
    value["version"] = json!(runtime.version);
    value["mode"] = json!(runtime.mode);
    value["recoveryRequired"] = json!(
        runtime.store.recovery_required()?
            || runtime
                .updates
                .as_ref()
                .map(|updates| updates.recovery_required())
                .unwrap_or(Ok(true))?
    );
    repoready_core::contracts::validate("DesktopSnapshot", &value)?;
    Ok(value)
}
async fn run<F>(app: AppHandle, operation: F) -> Result<Value, String>
where
    F: FnOnce(&mut Runtime, &AppHandle) -> Result<Value, String> + Send + 'static,
{
    let inner = app.state::<DesktopState>().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = inner.try_lock().map_err(|_| "OPERATION_BUSY")?;
        let runtime = guard
            .as_mut()
            .map_err(|_| "RECOVERY_REQUIRED".to_string())?;
        operation(runtime, &app)
    })
    .await
    .map_err(|_| "INTERNAL_ERROR".to_string())?
}
#[tauri::command]
pub async fn desktop_state(app: AppHandle) -> Result<Value, String> {
    run(app, |runtime, _| state(runtime, None)).await
}
#[tauri::command]
pub async fn catalog_refresh(app: AppHandle) -> Result<Value, String> {
    run(app, |runtime, _| {
        let error = match &runtime.source {
            None => Some(json!({"code":"NOT_AVAILABLE","retryable":false})),
            Some(source) => source
                .refresh(&mut runtime.store, now())
                .err()
                .map(|_| json!({"code":"UNTRUSTED_CATALOG","retryable":true})),
        };
        log(
            &runtime.store,
            if error.is_none() {
                Code::CatalogRefreshed
            } else if runtime.source.is_none() {
                Code::CatalogUnavailable
            } else {
                Code::CatalogRejected
            },
            Component::Catalog,
        );
        let mut value = state(runtime, error.clone())?;
        if error.is_some() && runtime.source.is_some() {
            value["catalog"]["status"] = json!(if value["catalog"]["items"]
                .as_array()
                .is_some_and(|v| !v.is_empty())
            {
                "offline"
            } else {
                "error"
            });
        }
        Ok(value)
    })
    .await
}
#[tauri::command]
pub async fn preferences_save(app: AppHandle, preferences: Value) -> Result<Value, String> {
    run(app, move |runtime, _| {
        repoready_core::contracts::validate("DesktopPreferences", &preferences)
            .map_err(|_| "INVALID_INPUT")?;
        runtime.store.save_preferences(&preferences)?;
        log(&runtime.store, Code::SettingsSaved, Component::Storage);
        state(runtime, None)
    })
    .await
}
#[tauri::command]
pub async fn catalog_cache_clear(app: AppHandle) -> Result<Value, String> {
    run(app, |runtime, _| {
        runtime.store.clear_catalog_cache()?;
        log(&runtime.store, Code::CacheCleared, Component::Storage);
        state(runtime, None)
    })
    .await
}
#[tauri::command]
pub async fn diagnostics_clear(app: AppHandle) -> Result<Value, String> {
    run(app, |runtime, _| {
        runtime.store.clear_logs()?;
        state(runtime, None)
    })
    .await
}
#[tauri::command]
pub async fn client_update_check(app: AppHandle) -> Result<Value, String> {
    run(app, |runtime, handle| {
        let error = runtime
            .updates
            .as_mut()
            .map_err(|_| "UPDATE_RECOVERY_REQUIRED".to_string())
            .and_then(|updates| updates.check(handle))
            .err()
            .map(|_| json!({"code":"DOWNLOAD_FAILED","retryable":true}));
        state(runtime, error)
    })
    .await
}
#[tauri::command]
pub fn client_update_cancel(app: AppHandle) {
    // Never wait for the blocking download's mutex to request cancellation.
    app.state::<DesktopState>().1.store(true, Ordering::SeqCst);
}
#[tauri::command]
pub async fn client_update_install(app: AppHandle, consent: bool) -> Result<Value, String> {
    run(app, move |runtime, handle| {
        // This command is issued only after the renderer's explicit confirmation dialog.
        if !consent {
            return Err("UPDATE_CONSENT_REQUIRED".into());
        }
        let error = runtime
            .updates
            .as_mut()
            .map_err(|_| "UPDATE_RECOVERY_REQUIRED".to_string())
            .and_then(|updates| updates.install(handle, consent))
            .err()
            .map(|_| json!({"code":"INSTALL_FAILED","retryable":true}));
        state(runtime, error)
    })
    .await
}
#[tauri::command]
pub fn open_project_page(page: String) -> Result<(), String> {
    let url = desktop::project_page(&page)?;
    #[cfg(windows)]
    {
        let wide: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        // SAFETY: static allowlisted HTTPS string, terminated UTF-16, no parameters/working directory.
        let result = unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err("PROJECT_PAGE_UNAVAILABLE".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("UNSUPPORTED_PLATFORM".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updater_storage_failure_preserves_independent_desktop_state() {
        let root = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            store: Store::open(root.path()).unwrap(),
            source: None,
            updates: Err("STATE_DATABASE_CORRUPT".into()),
            version: "0.1.0-alpha.1".into(),
            mode: "development",
        };
        let value = state(&runtime, None).unwrap();
        assert_eq!(value["update"]["status"], "failed");
        assert_eq!(value["recoveryRequired"], true);
        assert_eq!(value["preferences"]["cacheLimitMb"], 64);
        assert!(value["library"].as_array().unwrap().is_empty());
    }
}
