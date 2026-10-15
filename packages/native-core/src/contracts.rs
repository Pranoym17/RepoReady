use serde_json::Value;

pub fn validate(name: &str, value: &Value) -> Result<(), String> {
    let source = match name {
        "DesktopPreferences" => include_str!("../../contracts/schemas/DesktopPreferences.json"),
        "DesktopSnapshot" => include_str!("../../contracts/schemas/DesktopSnapshot.json"),
        "ClientReleasePolicy" => include_str!("../../contracts/schemas/ClientReleasePolicy.json"),
        "App" => include_str!("../../contracts/schemas/App.json"),
        "AppVersion" => include_str!("../../contracts/schemas/AppVersion.json"),
        "Artifact" => include_str!("../../contracts/schemas/Artifact.json"),
        "Requirements" => include_str!("../../contracts/schemas/Requirements.json"),
        "Verification" => include_str!("../../contracts/schemas/Verification.json"),
        "InstallManifest" => include_str!("../../contracts/schemas/InstallManifest.json"),
        "CatalogIndex" => include_str!("../../contracts/schemas/CatalogIndex.json"),
        "SignedEnvelope" => include_str!("../../contracts/schemas/SignedEnvelope.json"),
        "Submission" => include_str!("../../contracts/schemas/Submission.json"),
        "RequestInput" => include_str!("../../contracts/schemas/RequestInput.json"),
        "Preview" => include_str!("../../contracts/schemas/Preview.json"),
        "InstallTransaction" => include_str!("../../contracts/schemas/InstallTransaction.json"),
        "InstalledApp" => include_str!("../../contracts/schemas/InstalledApp.json"),
        "BuildRecipe" => include_str!("../../contracts/schemas/BuildRecipe.json"),
        "PublicError" => include_str!("../../contracts/schemas/PublicError.json"),
        _ => return Err("Unknown schema".into()),
    };
    let schema: Value = serde_json::from_str(source).map_err(|_| "Invalid embedded schema")?;
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .map_err(|_| "Invalid embedded schema")?;
    validator
        .validate(value)
        .map_err(|_| "Invalid contract".into())
}

pub fn validate_manifest(value: &Value) -> Result<(), String> {
    validate("InstallManifest", value)?;
    let app = &value["app"];
    let release = &value["release"];
    let artifact = &value["artifact"];
    let evidence = &value["verification"];
    if release["appId"] != app["id"]
        || artifact["appId"] != app["id"]
        || evidence["appId"] != app["id"]
        || artifact["version"] != release["version"]
        || evidence["version"] != release["version"]
        || artifact["adapter"] != release["packagingType"]
        || artifact["uninstallAdapter"] != artifact["adapter"]
        || artifact["sha256"] != evidence["artifactSha256"]
    {
        return Err("Manifest identity or certification mismatch".into());
    }
    let status = app["status"].as_str().ok_or("Missing status")?;
    let adapter = artifact["adapter"].as_str().ok_or("Missing adapter")?;
    if !["ready", "publisher-installer"].contains(&status)
        || release["status"] != app["status"]
        || app["verifiedAt"].is_null()
    {
        return Err("Not installable".into());
    }
    if !app["requirements"]["externalApiProviders"]
        .as_array()
        .ok_or("Missing providers")?
        .is_empty()
        && app["requirements"]["apiChargesDisclosed"] != true
    {
        return Err("Missing cost disclosure".into());
    }
    if artifact["credentialIntegration"] == "owned-launcher-v1"
        && !["managed-folder", "repoready-nsis"].contains(&adapter)
    {
        return Err("Unsupported credential integration".into());
    }
    if adapter != "managed-folder" && artifact["signerIdentity"].is_null() {
        return Err("Missing publisher verification".into());
    }
    if (status == "publisher-installer") != adapter.starts_with("publisher-") {
        return Err("Misleading distribution status".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_typescript_rust_fixtures_agree() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../contracts/fixtures/cases.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let result = validate(fixture["schema"].as_str().unwrap(), &fixture["value"]);
            assert_eq!(
                result.is_ok(),
                fixture["valid"].as_bool().unwrap(),
                "{}",
                fixture["name"]
            );
        }
    }
    #[test]
    fn identity_and_disclosure_checks_are_native() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../contracts/fixtures/cases.json")).unwrap();
        let original = fixtures
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["schema"] == "InstallManifest" && f["valid"] == true)
            .unwrap()["value"]
            .clone();
        assert!(validate_manifest(&original).is_ok());
        for pointer in ["/artifact/sha256", "/release/appId", "/app/status"] {
            let mut value = original.clone();
            *value.pointer_mut(pointer).unwrap() = Value::String("invalid".into());
            assert!(validate_manifest(&value).is_err());
        }
    }
}
