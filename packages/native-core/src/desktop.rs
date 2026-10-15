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
    let error = error
        .or_else(|| cache_failed.then(|| json!({"code":"UNTRUSTED_CATALOG","retryable":true})));
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
        },"library":library,"preferences":store.preferences()?,"recoveryRequired":store.recovery_required()?,
        "update":update,"diagnostics":{"logBytes":store.log_bytes()?},
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
}
