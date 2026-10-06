use crate::contracts;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::DateTime;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const DOMAIN: &[u8] = b"repoready.catalog.v1:";
pub const MAX_ENVELOPE_BYTES: usize = 1_500_000;
pub const MAX_PAYLOAD_BYTES: usize = 1_000_000;
const WEEK: i64 = 7 * 24 * 60 * 60;

#[derive(Default)]
pub struct TrustState {
    pub highest_sequence: u64,
    pub accepted_digest: Option<String>,
}

/// This type cannot be constructed from unverified data outside this module.
pub struct VerifiedCatalog {
    index: Value,
    digest: String,
    issued_at: i64,
    expires_at: i64,
}

impl VerifiedCatalog {
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn sequence(&self) -> u64 {
        self.index["sequence"].as_u64().unwrap_or(0)
    }
}

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Keys originate in the trusted application, never in a catalog or webview argument.
/// Returned data may authorize installs only after detail and artifact verification.
pub fn verify_index(
    envelope_bytes: &[u8],
    keys: &BTreeMap<String, [u8; 32]>,
    now: i64,
    state: &TrustState,
) -> Result<VerifiedCatalog, String> {
    if envelope_bytes.len() > MAX_ENVELOPE_BYTES {
        return Err("Catalog too large".into());
    }
    let envelope: Value = serde_json::from_slice(envelope_bytes).map_err(|_| "Invalid envelope")?;
    contracts::validate("SignedEnvelope", &envelope)?;
    let key_id = envelope["keyId"].as_str().ok_or("Missing key")?;
    let key = VerifyingKey::from_bytes(keys.get(key_id).ok_or("Unknown key")?)
        .map_err(|_| "Invalid key")?;
    let payload = STANDARD
        .decode(envelope["payload"].as_str().ok_or("Missing payload")?)
        .map_err(|_| "Invalid payload encoding")?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err("Catalog too large".into());
    }
    let signature = hex::decode(envelope["signature"].as_str().ok_or("Missing signature")?)
        .map_err(|_| "Invalid signature")?;
    let signature = Signature::from_slice(&signature).map_err(|_| "Invalid signature")?;
    let mut message = DOMAIN.to_vec();
    message.extend_from_slice(&payload);
    key.verify_strict(&message, &signature)
        .map_err(|_| "Untrusted catalog")?;
    let index: Value = serde_json::from_slice(&payload).map_err(|_| "Invalid catalog")?;
    contracts::validate("CatalogIndex", &index)?;
    let sequence = index["sequence"].as_u64().ok_or("Invalid sequence")?;
    let digest = sha256(&payload);
    if sequence < state.highest_sequence
        || (sequence == state.highest_sequence && state.accepted_digest.as_deref() != Some(&digest))
    {
        return Err("Replayed or equivocated catalog".into());
    }
    let issued =
        DateTime::parse_from_rfc3339(index["issuedAt"].as_str().ok_or("Missing issue time")?)
            .map_err(|_| "Invalid time")?
            .timestamp();
    let expires =
        DateTime::parse_from_rfc3339(index["expiresAt"].as_str().ok_or("Missing expiry")?)
            .map_err(|_| "Invalid time")?
            .timestamp();
    if issued > now || expires <= now || expires <= issued || expires - issued > WEEK {
        return Err("Stale catalog or invalid clock".into());
    }
    let mut identities = std::collections::BTreeSet::new();
    for detail in index["details"].as_array().ok_or("Missing references")? {
        let pair = (detail["appId"].as_str(), detail["version"].as_str());
        if !identities.insert(pair) {
            return Err("Duplicate release identity".into());
        }
    }
    Ok(VerifiedCatalog {
        index,
        digest,
        issued_at: issued,
        expires_at: expires,
    })
}

pub fn verify_detail(
    catalog: &VerifiedCatalog,
    app_id: &str,
    version: &str,
    bytes: &[u8],
    now: i64,
) -> Result<Value, String> {
    if now < catalog.issued_at || now >= catalog.expires_at {
        return Err("Stale catalog or invalid clock".into());
    }
    let index = &catalog.index;
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return Err("Detail too large".into());
    }
    if index["holds"]
        .as_array()
        .ok_or("Missing holds")?
        .iter()
        .any(|h| h["appId"] == app_id && h["version"] == version)
    {
        return Err("Version held".into());
    }
    let reference = index["details"]
        .as_array()
        .ok_or("Missing references")?
        .iter()
        .find(|r| r["appId"] == app_id && r["version"] == version)
        .ok_or("Release not approved")?;
    if reference["sha256"] != sha256(bytes) {
        return Err("Detail digest mismatch".into());
    }
    let detail: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid detail")?;
    contracts::validate_manifest(&detail)?;
    if detail["app"]["id"] != app_id || detail["release"]["version"] != version {
        return Err("Detail identity mismatch".into());
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    fn envelope(index: &Value, signing: &SigningKey) -> Vec<u8> {
        let payload = serde_json::to_vec(index).unwrap();
        let mut message = DOMAIN.to_vec();
        message.extend_from_slice(&payload);
        serde_json::to_vec(&json!({ "schemaVersion":1, "keyId":"test-only", "payload":STANDARD.encode(&payload), "signature":hex::encode(signing.sign(&message).to_bytes()) })).unwrap()
    }
    #[test]
    fn signature_freshness_replay_substitution_and_holds_fail_closed() {
        // Deliberately public deterministic TEST seed, never a production trust root.
        let signing = SigningKey::from_bytes(&[7; 32]);
        let keys = BTreeMap::from([("test-only".into(), signing.verifying_key().to_bytes())]);
        let fixtures: Value =
            serde_json::from_str(include_str!("../../contracts/fixtures/cases.json")).unwrap();
        let detail = fixtures
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["schema"] == "InstallManifest" && f["valid"] == true)
            .unwrap()["value"]
            .clone();
        let bytes = serde_json::to_vec(&detail).unwrap();
        let mut index = json!({"schemaVersion":1,"channel":"stable","sequence":2,"issuedAt":"2026-10-04T12:00:00Z","expiresAt":"2026-10-11T12:00:00Z","details":[{"appId":"test-fixture","version":"1.0.0","sha256":sha256(&bytes)}],"holds":[]});
        let now = DateTime::parse_from_rfc3339("2026-10-05T12:00:00Z")
            .unwrap()
            .timestamp();
        let signed = envelope(&index, &signing);
        let trusted = verify_index(&signed, &keys, now, &TrustState::default()).unwrap();
        let digest = trusted.digest().to_owned();
        assert_eq!(trusted.sequence(), 2);
        assert!(verify_detail(&trusted, "test-fixture", "1.0.0", &bytes, now).is_ok());
        assert!(verify_detail(&trusted, "test-fixture", "1.0.0", b"{}", now).is_err());
        assert!(verify_detail(&trusted, "test-fixture", "1.0.0", &bytes, now + WEEK).is_err());
        assert!(verify_index(&signed, &BTreeMap::new(), now, &TrustState::default()).is_err());
        assert!(verify_index(&signed, &keys, now + WEEK, &TrustState::default()).is_err());
        assert!(verify_index(&signed, &keys, now - WEEK, &TrustState::default()).is_err());
        assert!(
            verify_index(
                &signed,
                &keys,
                now,
                &TrustState {
                    highest_sequence: 3,
                    accepted_digest: Some(digest.clone())
                }
            )
            .is_err()
        );
        assert!(
            verify_index(
                &signed,
                &keys,
                now,
                &TrustState {
                    highest_sequence: 2,
                    accepted_digest: Some(digest)
                }
            )
            .is_ok()
        );
        let wrong = SigningKey::from_bytes(&[9; 32]);
        assert!(
            verify_index(
                &envelope(&index, &wrong),
                &keys,
                now,
                &TrustState::default()
            )
            .is_err()
        );
        index["holds"] = json!([{"appId":"test-fixture","version":"1.0.0","status":"revoked","reason":"Test hold"}]);
        let held = verify_index(
            &envelope(&index, &signing),
            &keys,
            now,
            &TrustState::default(),
        )
        .unwrap();
        assert!(verify_detail(&held, "test-fixture", "1.0.0", &bytes, now).is_err());
        assert!(
            verify_index(
                &vec![0; MAX_ENVELOPE_BYTES + 1],
                &keys,
                now,
                &TrustState::default()
            )
            .is_err()
        );
    }
}
