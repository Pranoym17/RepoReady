//! Public desktop state boundary. No frontend paths, URLs or executable arguments.
use crate::{contracts, storage::Store};
use serde_json::{Value, json};

fn timestamp(seconds: Option<i64>) -> Value {
    seconds
        .and_then(|n| chrono::DateTime::from_timestamp(n, 0))
        .map(|n| json!(n.format("%Y-%m-%dT%H:%M:%SZ").to_string()))
        .unwrap_or(Value::Null)
}

pub fn snapshot(
    store: &Store,
    now: i64,
    update: Value,
    error: Option<Value>,
) -> Result<Value, String> {
    // Cache corruption/clock/key rotation must not hide the independently persisted Library.
    let cache_result = store.cache_snapshot(now);
    let cache_failed = cache_result.is_err();
    let cache = cache_result.unwrap_or_else(|_| json!({"status":"error","apps":[]}));
    let logs = store.log_bytes();
    let logs_failed = logs.is_err();
    let error = error
        .or_else(|| cache_failed.then(|| json!({"code":"UNTRUSTED_CATALOG","retryable":true})));
    let error = error
        .or_else(|| logs_failed.then(|| json!({"code":"RECOVERY_REQUIRED","retryable":false})));
    let library = store.library()?.into_iter().map(|item| json!({
        "appId":item["appId"],"version":item["version"],"installedAt":item["installedAt"],
        "lastLaunchAt":item["lastLaunchAt"],"updateStatus":item["updateStatus"],
        "sourceSummary":item["sourceSummary"].as_str().unwrap_or("Previously installed application")
    })).collect::<Vec<_>>();
    let items = cache["apps"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let mut app = item["app"].clone();
            if item["held"] == true {
                app["status"] = item["holdStatus"].clone();
            }
            app
        })
        .collect::<Vec<_>>();
    let value = json!({
        "version":"0.1.0-alpha.1","mode":"development",
        "catalog":{
            "status":match cache["status"].as_str() {Some("verified")=>"fresh",Some("stale")=>"stale",Some("error")=>"error",_=>"not-configured"},
            "issuedAt":timestamp(cache["issuedAt"].as_i64()),"expiresAt":timestamp(cache["expiresAt"].as_i64()),
            "lastVerifiedAt":timestamp(cache["acceptedAt"].as_i64()),"sequence":cache["sequence"],"items":items
        },"library":library,"preferences":store.preferences()?,"recoveryRequired":store.recovery_required()?||logs_failed,
        "update":update,"diagnostics":{"logBytes":logs.unwrap_or(0)},
        "capabilities":{"manageApps":false,"requests":false},"lastError":error
    });
    contracts::validate("DesktopSnapshot", &value)?;
    Ok(value)
}

pub fn unavailable_update() -> Value {
    json!({"status":"not-configured","version":null,"messageCode":"UPDATE_NOT_CONFIGURED"})
}

pub fn project_page(page: &str) -> Result<&'static str, String> {
    match page {
        "source" => Ok("https://github.com/Pranoym17/RepoReady"),
        "support" => Ok("https://github.com/Pranoym17/RepoReady/issues"),
        // A deployed site/request service has not been established.
        "request" | "privacy" => Err("PAGE_NOT_CONFIGURED".into()),
        _ => Err("INVALID_PROJECT_PAGE".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_state_is_contract_valid_and_has_no_app_authority() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("state")).unwrap();
        let value = snapshot(&store, 1_792_022_400, unavailable_update(), None).unwrap();
        assert_eq!(value["capabilities"]["manageApps"], false);
        assert_eq!(value["catalog"]["status"], "not-configured");
        assert_eq!(value["preferences"]["cacheLimitMb"], 64);
    }
    #[test]
    fn page_arguments_cannot_be_urls_or_paths() {
        for page in [
            "https://evil.org",
            "file:///C:/",
            "../source",
            "cmd",
            "SOURCE",
        ] {
            assert!(project_page(page).is_err());
        }
        assert!(
            project_page("source")
                .unwrap()
                .starts_with("https://github.com/")
        );
    }
    #[test]
    fn damaged_logs_do_not_hide_settings_and_can_be_explicitly_cleared() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        std::fs::write(root.path().join("events.log"), vec![b'x'; 65537]).unwrap();
        let value = snapshot(&store, 1_792_022_400, unavailable_update(), None).unwrap();
        assert_eq!(value["preferences"]["cacheLimitMb"], 64);
        assert_eq!(value["recoveryRequired"], true);
        assert_eq!(value["lastError"]["code"], "RECOVERY_REQUIRED");
        store.clear_logs().unwrap();
        assert_eq!(
            snapshot(&store, 1_792_022_400, unavailable_update(), None).unwrap()["recoveryRequired"],
            false
        );
    }
}
