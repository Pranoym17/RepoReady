//! Client-update authority is independent of catalog authority and Windows publisher signing.
//! No production key, endpoint, downloader, or installer is enabled by this module.
use crate::{catalog::sha256, contracts};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::DateTime;
use ed25519_dalek::{Signature, VerifyingKey};
use minisign_verify::{PublicKey, Signature as MinisignSignature};
use reqwest::Url;
use semver::Version;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::{
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub const DOMAIN: &[u8] = b"repoready.client-update.v1:";
pub const TARGET: &str = "windows-x86_64";
pub const MAX_POLICY_BYTES: usize = 96 * 1024;
pub const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const WEEK: i64 = 7 * 24 * 60 * 60;

/// Dedicated policy keys. Never construct this from a fetched document or webview argument.
/// These are NOT catalog keys, the Tauri artifact key, or a Windows publisher certificate.
#[derive(Default)]
pub struct UpdatePolicyKeys(BTreeMap<String, [u8; 32]>);

impl UpdatePolicyKeys {
    pub fn from_pinned(keys: BTreeMap<String, [u8; 32]>) -> Self {
        Self(keys)
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn from_hex_pinned(keys: &BTreeMap<String, String>) -> Result<Self, String> {
        let mut parsed = BTreeMap::new();
        for (id, encoded) in keys {
            if id.is_empty()
                || id.len() > 100
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            {
                return Err("UPDATE_CONFIGURATION_INVALID".into());
            }
            let public: [u8; 32] = hex::decode(encoded)
                .map_err(|_| "UPDATE_CONFIGURATION_INVALID")?
                .try_into()
                .map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
            VerifyingKey::from_bytes(&public).map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
            parsed.insert(id.clone(), public);
        }
        Ok(Self(parsed))
    }
    pub fn ensure_independent_artifact_key(&self, encoded: &str) -> Result<(), String> {
        let outer = STANDARD
            .decode(encoded)
            .map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
        let text = std::str::from_utf8(&outer).map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
        PublicKey::decode(text).map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
        let raw = STANDARD
            .decode(text.lines().nth(1).ok_or("UPDATE_CONFIGURATION_INVALID")?)
            .map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
        if raw.len() != 42 || self.0.values().any(|key| key.as_slice() == &raw[10..]) {
            return Err("UPDATE_KEY_ROLES_NOT_INDEPENDENT".into());
        }
        Ok(())
    }
}

/// All update network I/O is capped here. The Tauri adapter restores its small manifest
/// directly from the authenticated policy and never calls the plugin's remote check/download.
pub struct UpdateTransport {
    client: reqwest::blocking::Client,
}
impl UpdateTransport {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .no_proxy()
            .user_agent("RepoReady client updater")
            .build()
            .map_err(|_| "UPDATE_NETWORK_UNAVAILABLE")?;
        Ok(Self { client })
    }
    pub fn fetch_policy(&self, endpoint: &str, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
        validate_policy_endpoint(endpoint)?;
        self.fetch(endpoint, MAX_POLICY_BYTES as u64, None, cancel)
    }
    pub fn download_artifact(
        &self,
        policy: &VerifiedClientUpdate,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>, String> {
        self.fetch(
            policy.url(),
            policy.size_bytes(),
            Some(policy.size_bytes()),
            cancel,
        )
    }
    fn fetch(
        &self,
        endpoint: &str,
        limit: u64,
        exact_size: Option<u64>,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>, String> {
        if cancel.load(Ordering::SeqCst) {
            return Err("UPDATE_CANCELLED".into());
        }
        let mut response = self
            .client
            .get(endpoint)
            .send()
            .map_err(|_| "UPDATE_NETWORK_UNAVAILABLE")?;
        if !response.status().is_success() {
            return Err("UPDATE_HTTP_FAILED".into());
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|v| v != "identity")
        {
            return Err("UPDATE_ENCODING_UNSUPPORTED".into());
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit || exact_size.is_some_and(|size| length != size))
        {
            return Err("UPDATE_DOWNLOAD_SIZE_MISMATCH".into());
        }
        let mut bytes = Vec::new();
        let mut buffer = [0; 65536];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("UPDATE_CANCELLED".into());
            }
            let read = response
                .read(&mut buffer)
                .map_err(|_| "UPDATE_NETWORK_UNAVAILABLE")?;
            if read == 0 {
                break;
            }
            if (bytes.len() as u64).saturating_add(read as u64) > limit {
                return Err("UPDATE_DOWNLOAD_TOO_LARGE".into());
            }
            bytes
                .try_reserve(read)
                .map_err(|_| "UPDATE_MEMORY_UNAVAILABLE")?;
            bytes.extend_from_slice(&buffer[..read]);
        }
        if exact_size.is_some_and(|size| size != bytes.len() as u64) {
            return Err("UPDATE_DOWNLOAD_SIZE_MISMATCH".into());
        }
        Ok(bytes)
    }
}

pub fn validate_policy_endpoint(endpoint: &str) -> Result<(), String> {
    let url = Url::parse(endpoint).map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
    let host = url.host_str().ok_or("UPDATE_CONFIGURATION_INVALID")?;
    if url.scheme() != "https"
        || url.port().is_some_and(|v| v != 443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || host == "localhost"
        || host.parse::<std::net::IpAddr>().is_ok()
        || !host.contains('.')
        || [".test", ".invalid", ".example", ".localhost"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
        || ["example.com", "example.org", "example.net"].contains(&host)
    {
        return Err("UPDATE_CONFIGURATION_INVALID".into());
    }
    Ok(())
}

pub fn validate_artifact_origin(origin: &str) -> Result<(), String> {
    validate_policy_endpoint(origin)?;
    let url = Url::parse(origin).map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
    if origin != url.origin().ascii_serialization() {
        return Err("UPDATE_CONFIGURATION_INVALID".into());
    }
    Ok(())
}

/// Persist atomically with accepted policy bytes, independently for each update channel.
/// Cache clearing must not clear this floor. Unknown/corrupt persisted state fails closed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateTrustState {
    pub highest_sequence: u64,
    pub accepted_digest: Option<String>,
}

pub struct UpdateContext<'a> {
    pub policy_keys: &'a UpdatePolicyKeys,
    pub channel: &'a str,
    pub current_version: &'a str,
    /// Exact HTTPS origins from native build configuration, never metadata or JavaScript.
    pub artifact_origins: &'a [&'a str],
}

/// Authenticated policy, including policies whose release is held or ineligible. Persist its
/// exact envelope and trust_state atomically BEFORE checking release eligibility. A newly held
/// policy advances the replay floor even though it must never create install authority.
pub struct AuthenticatedClientPolicy {
    policy: Value,
    sequence: u64,
    digest: String,
    issued_at: i64,
    expires_at: i64,
}
impl AuthenticatedClientPolicy {
    pub fn trust_state(&self) -> UpdateTrustState {
        UpdateTrustState {
            highest_sequence: self.sequence,
            accepted_digest: Some(self.digest.clone()),
        }
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

/// Can be created only by policy verification. This is eligibility, not permission to execute.
#[derive(Debug)]
pub struct VerifiedClientUpdate {
    channel: String,
    version: String,
    url: String,
    artifact_sha256: String,
    size: u64,
    signature: String,
    sequence: u64,
    digest: String,
    issued_at: i64,
    expires_at: i64,
}

impl VerifiedClientUpdate {
    pub fn channel(&self) -> &str {
        &self.channel
    }
    pub fn version(&self) -> &str {
        &self.version
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn artifact_sha256(&self) -> &str {
        &self.artifact_sha256
    }
    pub fn size_bytes(&self) -> u64 {
        self.size
    }
    pub fn signature(&self) -> &str {
        &self.signature
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }
    pub fn trust_state(&self) -> UpdateTrustState {
        UpdateTrustState {
            highest_sequence: self.sequence,
            accepted_digest: Some(self.digest.clone()),
        }
    }
    pub fn ensure_fresh(&self, now: i64) -> Result<(), String> {
        if now < self.issued_at || now >= self.expires_at {
            return Err("UPDATE_POLICY_STALE".into());
        }
        Ok(())
    }
    fn same_release(&self, other: &Self) -> bool {
        self.channel == other.channel
            && self.version == other.version
            && self.url == other.url
            && self.artifact_sha256 == other.artifact_sha256
            && self.size == other.size
            && self.signature == other.signature
    }
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .ok_or_else(|| "UPDATE_POLICY_INVALID".into())
}

fn timestamp(value: &Value, field: &str) -> Result<i64, String> {
    let input = text(value, field)?;
    // The contract permits only UTC, second precision; do not silently accept offsets/fractions.
    if input.len() != 20 || !input.ends_with('Z') {
        return Err("UPDATE_POLICY_INVALID_TIME".into());
    }
    DateTime::parse_from_rfc3339(input)
        .map(|v| v.timestamp())
        .map_err(|_| "UPDATE_POLICY_INVALID_TIME".into())
}

fn allowed_artifact_url(input: &str, version: &str, origins: &[&str]) -> Result<(), String> {
    let url = Url::parse(input).map_err(|_| "UPDATE_ARTIFACT_URL_INVALID")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !origins
            .iter()
            .any(|origin| *origin == url.origin().ascii_serialization())
    {
        return Err("UPDATE_ARTIFACT_ORIGIN_DENIED".into());
    }
    let segments: Vec<_> = url
        .path_segments()
        .ok_or("UPDATE_ARTIFACT_URL_INVALID")?
        .collect();
    if segments
        .iter()
        .any(|segment| segment.to_ascii_lowercase().contains("latest"))
        || !segments
            .iter()
            .any(|segment| *segment == version || *segment == format!("v{version}"))
        || url.path().contains('%')
        || url.path().ends_with('/')
    {
        return Err("UPDATE_ARTIFACT_URL_NOT_VERSIONED".into());
    }
    Ok(())
}

/// Authenticate a bounded purpose-bound envelope before parsing release authority. A hold,
/// malformed policy, stale response, or rollback can never be overridden by user consent.
pub fn authenticate_policy(
    envelope_bytes: &[u8],
    context: &UpdateContext<'_>,
    now: i64,
    prior: &UpdateTrustState,
) -> Result<AuthenticatedClientPolicy, String> {
    if envelope_bytes.len() > MAX_POLICY_BYTES {
        return Err("UPDATE_POLICY_TOO_LARGE".into());
    }
    if !["development", "stable"].contains(&context.channel) {
        return Err("UPDATE_CHANNEL_INVALID".into());
    }
    if (prior.highest_sequence == 0) != prior.accepted_digest.is_none()
        || prior.accepted_digest.as_ref().is_some_and(|d| {
            d.len() != 64
                || !d
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        })
    {
        return Err("UPDATE_TRUST_STATE_INVALID".into());
    }
    let envelope: Value =
        serde_json::from_slice(envelope_bytes).map_err(|_| "UPDATE_ENVELOPE_INVALID")?;
    contracts::validate("SignedEnvelope", &envelope)?;
    let key_id = text(&envelope, "keyId")?;
    let key = VerifyingKey::from_bytes(
        context
            .policy_keys
            .0
            .get(key_id)
            .ok_or("UPDATE_POLICY_KEY_UNKNOWN")?,
    )
    .map_err(|_| "UPDATE_POLICY_KEY_INVALID")?;
    let payload = STANDARD
        .decode(text(&envelope, "payload")?)
        .map_err(|_| "UPDATE_PAYLOAD_INVALID")?;
    if payload.len() > MAX_POLICY_BYTES {
        return Err("UPDATE_POLICY_TOO_LARGE".into());
    }
    let signature =
        hex::decode(text(&envelope, "signature")?).map_err(|_| "UPDATE_SIGNATURE_INVALID")?;
    let signature = Signature::from_slice(&signature).map_err(|_| "UPDATE_SIGNATURE_INVALID")?;
    let mut message = DOMAIN.to_vec();
    message.extend_from_slice(&payload);
    key.verify_strict(&message, &signature)
        .map_err(|_| "UPDATE_POLICY_UNTRUSTED")?;
    let policy: Value = serde_json::from_slice(&payload).map_err(|_| "UPDATE_POLICY_INVALID")?;
    contracts::validate("ClientReleasePolicy", &policy)?;
    if text(&policy, "channel")? != context.channel {
        return Err("UPDATE_CHANNEL_MISMATCH".into());
    }
    let sequence = policy["sequence"]
        .as_u64()
        .ok_or("UPDATE_SEQUENCE_INVALID")?;
    let digest = sha256(&payload);
    if sequence == 0
        || sequence < prior.highest_sequence
        || (sequence == prior.highest_sequence && prior.accepted_digest.as_deref() != Some(&digest))
    {
        return Err("UPDATE_POLICY_REPLAYED".into());
    }
    let issued_at = timestamp(&policy, "issuedAt")?;
    let expires_at = timestamp(&policy, "expiresAt")?;
    if issued_at > now
        || expires_at <= now
        || expires_at <= issued_at
        || expires_at - issued_at > WEEK
    {
        return Err("UPDATE_POLICY_STALE".into());
    }
    Ok(AuthenticatedClientPolicy {
        policy,
        sequence,
        digest,
        issued_at,
        expires_at,
    })
}

/// Check release eligibility after authentication. See authenticate_policy for persistence order.
pub fn verify_policy(
    envelope_bytes: &[u8],
    context: &UpdateContext<'_>,
    now: i64,
    prior: &UpdateTrustState,
) -> Result<VerifiedClientUpdate, String> {
    let authenticated = authenticate_policy(envelope_bytes, context, now, prior)?;
    let AuthenticatedClientPolicy {
        policy,
        sequence,
        digest,
        issued_at,
        expires_at,
    } = authenticated;
    let release = &policy["release"];
    let version = text(release, "version")?;
    let parsed = Version::parse(version).map_err(|_| "UPDATE_VERSION_INVALID")?;
    let current =
        Version::parse(context.current_version).map_err(|_| "UPDATE_CURRENT_VERSION_INVALID")?;
    if parsed.cmp_precedence(&current).is_le() {
        return Err("UPDATE_VERSION_NOT_NEWER".into());
    }
    if context.channel == "stable" && !parsed.pre.is_empty() {
        return Err("UPDATE_PRERELEASE_IN_STABLE".into());
    }
    if text(release, "target")? != TARGET {
        return Err("UPDATE_TARGET_MISMATCH".into());
    }
    let mut seen = BTreeSet::new();
    let holds = policy["holds"].as_array().ok_or("UPDATE_HOLDS_INVALID")?;
    if holds.len() > 100 {
        return Err("UPDATE_HOLDS_INVALID".into());
    }
    for hold in holds {
        let held = Version::parse(text(hold, "version")?).map_err(|_| "UPDATE_HOLDS_INVALID")?;
        if !seen.insert(held.clone()) {
            return Err("UPDATE_HOLDS_INVALID".into());
        }
        if held.cmp_precedence(&parsed).is_eq() {
            return Err("UPDATE_VERSION_HELD".into());
        }
    }
    let url = text(release, "url")?;
    allowed_artifact_url(url, version, context.artifact_origins)?;
    let artifact_sha256 = text(release, "sha256")?;
    if artifact_sha256.len() != 64
        || !artifact_sha256
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || artifact_sha256.bytes().all(|c| c == b'0')
    {
        return Err("UPDATE_HASH_INVALID".into());
    }
    let size = release["sizeBytes"].as_u64().ok_or("UPDATE_SIZE_INVALID")?;
    if size == 0 || size > MAX_ARTIFACT_BYTES {
        return Err("UPDATE_SIZE_INVALID".into());
    }
    let signature = text(release, "signature")?;
    if signature.is_empty() || signature.len() > 4096 {
        return Err("UPDATE_ARTIFACT_SIGNATURE_INVALID".into());
    }
    Ok(VerifiedClientUpdate {
        channel: context.channel.into(),
        version: version.into(),
        url: url.into(),
        artifact_sha256: artifact_sha256.into(),
        size,
        signature: signature.into(),
        sequence,
        digest,
        issued_at,
        expires_at,
    })
}

/// Bytes never enter the webview or executable authority until all integrity checks pass.
pub struct VerifiedClientArtifact {
    bytes: Vec<u8>,
    policy_digest: String,
}

/// The key uses Tauri's format: outer base64 of a full Minisign public-key document.
/// Artifact signing is separate from the signed policy and must cover the exact final bytes.
pub fn verify_artifact(
    policy: &VerifiedClientUpdate,
    bytes: Vec<u8>,
    artifact_public_key: &str,
    now: i64,
) -> Result<VerifiedClientArtifact, String> {
    policy.ensure_fresh(now)?;
    if bytes.len() as u64 != policy.size || sha256(&bytes) != policy.artifact_sha256 {
        return Err("UPDATE_ARTIFACT_INTEGRITY_FAILED".into());
    }
    if artifact_public_key.len() > 4096 {
        return Err("UPDATE_ARTIFACT_KEY_INVALID".into());
    }
    let key_text = STANDARD
        .decode(artifact_public_key)
        .map_err(|_| "UPDATE_ARTIFACT_KEY_INVALID")?;
    let key = PublicKey::decode(
        std::str::from_utf8(&key_text).map_err(|_| "UPDATE_ARTIFACT_KEY_INVALID")?,
    )
    .map_err(|_| "UPDATE_ARTIFACT_KEY_INVALID")?;
    let signature_text = STANDARD
        .decode(&policy.signature)
        .map_err(|_| "UPDATE_ARTIFACT_SIGNATURE_INVALID")?;
    let signature = MinisignSignature::decode(
        std::str::from_utf8(&signature_text).map_err(|_| "UPDATE_ARTIFACT_SIGNATURE_INVALID")?,
    )
    .map_err(|_| "UPDATE_ARTIFACT_SIGNATURE_INVALID")?;
    // Tauri's verifier supports legacy and prehashed Minisign payloads; never skip its global signature.
    key.verify(&bytes, &signature, true)
        .map_err(|_| "UPDATE_ARTIFACT_SIGNATURE_UNTRUSTED")?;
    let versions: Vec<_> = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|s| s.strip_prefix("version:"))
        .collect();
    if versions.len() != 1
        || Version::parse(versions[0]).ok() != Version::parse(&policy.version).ok()
    {
        return Err("UPDATE_ARTIFACT_SIGNED_VERSION_MISMATCH".into());
    }
    Ok(VerifiedClientArtifact {
        bytes,
        policy_digest: policy.digest.clone(),
    })
}

/// This short-lived borrowed authority cannot be serialized or restored from disk.
pub struct InstallAuthorization<'a> {
    artifact: &'a VerifiedClientArtifact,
}
impl InstallAuthorization<'_> {
    pub fn bytes(&self) -> &[u8] {
        &self.artifact.bytes
    }
}

/// Call only after fetching and verifying the latest policy against the persisted replay floor.
/// Persist an installing intent before the native adapter consumes this authorization. A newly
/// held policy fails verification; a changed release requires a new check, download and consent.
pub fn authorize_install<'a>(
    prepared: &VerifiedClientUpdate,
    latest: &VerifiedClientUpdate,
    artifact: &'a VerifiedClientArtifact,
    now: i64,
    user_consented: bool,
) -> Result<InstallAuthorization<'a>, String> {
    if !user_consented {
        return Err("UPDATE_CONSENT_REQUIRED".into());
    }
    prepared.ensure_fresh(now)?;
    latest.ensure_fresh(now)?;
    if latest.sequence < prepared.sequence
        || !prepared.same_release(latest)
        || artifact.policy_digest != prepared.digest
        || (latest.sequence == prepared.sequence && latest.digest != prepared.digest)
    {
        return Err("UPDATE_PREPARATION_CHANGED".into());
    }
    if artifact.bytes.len() as u64 != latest.size
        || sha256(&artifact.bytes) != latest.artifact_sha256
    {
        return Err("UPDATE_ARTIFACT_INTEGRITY_FAILED".into());
    }
    Ok(InstallAuthorization { artifact })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    const NOW: i64 = 1_792_022_400; // 2026-10-15T00:00:00Z.
    const CURRENT: &str = "0.1.0-alpha.1";
    const NEXT: &str = "0.1.0-alpha.2";
    const BYTES: &[u8] = b"inert update fixture; never an executable";
    const ORIGINS: &[&str] = &["https://updates.repoready.test"];

    // Public deterministic TEST seeds; no persistent/private production keys are generated.
    fn policy_key() -> SigningKey {
        SigningKey::from_bytes(&[51; 32])
    }
    fn artifact_key() -> SigningKey {
        SigningKey::from_bytes(&[73; 32])
    }
    fn keys() -> UpdatePolicyKeys {
        UpdatePolicyKeys::from_pinned(BTreeMap::from([(
            "update-test-only".into(),
            policy_key().verifying_key().to_bytes(),
        )]))
    }
    fn context(keys: &UpdatePolicyKeys) -> UpdateContext<'_> {
        UpdateContext {
            policy_keys: keys,
            channel: "development",
            current_version: CURRENT,
            artifact_origins: ORIGINS,
        }
    }
    fn signed_artifact(signing: &SigningKey, bytes: &[u8], version: &str) -> (String, String) {
        let mut public = b"Ed".to_vec();
        public.extend_from_slice(&[4; 8]);
        public.extend_from_slice(&signing.verifying_key().to_bytes());
        let public = STANDARD.encode(format!(
            "untrusted comment: RepoReady TEST public key\n{}\n",
            STANDARD.encode(public)
        ));
        let detached = signing.sign(bytes).to_bytes();
        let mut signature = b"Ed".to_vec();
        signature.extend_from_slice(&[4; 8]);
        signature.extend_from_slice(&detached);
        let comment = format!("timestamp:1792022400\tfile:inert.txt\tversion:{version}");
        let mut global = detached.to_vec();
        global.extend_from_slice(comment.as_bytes());
        let encoded = STANDARD.encode(format!(
            "untrusted comment: RepoReady TEST signature\n{}\ntrusted comment: {}\n{}\n",
            STANDARD.encode(signature),
            comment,
            STANDARD.encode(signing.sign(&global).to_bytes())
        ));
        (public, encoded)
    }
    fn policy() -> Value {
        let (_, signature) = signed_artifact(&artifact_key(), BYTES, NEXT);
        json!({"schemaVersion":1,"channel":"development","sequence":2,
            "issuedAt":"2026-10-15T00:00:00Z","expiresAt":"2026-10-16T00:00:00Z",
            "release":{"version":NEXT,"target":TARGET,"url":format!("https://updates.repoready.test/releases/{NEXT}/RepoReady.exe"),
                "sha256":sha256(BYTES),"sizeBytes":BYTES.len(),"signature":signature},"holds":[]})
    }
    fn envelope_with(value: &Value, key: &SigningKey, domain: &[u8]) -> Vec<u8> {
        let payload = serde_json::to_vec(value).unwrap();
        let mut message = domain.to_vec();
        message.extend_from_slice(&payload);
        serde_json::to_vec(&json!({"schemaVersion":1,"keyId":"update-test-only", "payload":STANDARD.encode(payload),
            "signature":hex::encode(key.sign(&message).to_bytes())})).unwrap()
    }
    fn envelope(value: &Value) -> Vec<u8> {
        envelope_with(value, &policy_key(), DOMAIN)
    }
    fn verify(value: &Value) -> Result<VerifiedClientUpdate, String> {
        verify_policy(
            &envelope(value),
            &context(&keys()),
            NOW,
            &UpdateTrustState::default(),
        )
    }
    fn artifact_public() -> String {
        signed_artifact(&artifact_key(), BYTES, NEXT).0
    }

    #[test]
    fn alpha_progression_requires_independent_policy_and_artifact_signatures_and_consent() {
        let verified = verify(&policy()).unwrap();
        assert_eq!(verified.version(), NEXT);
        assert_eq!(verified.channel(), "development");
        assert_eq!(verified.size_bytes(), BYTES.len() as u64);
        let artifact = verify_artifact(&verified, BYTES.into(), &artifact_public(), NOW).unwrap();
        assert!(authorize_install(&verified, &verified, &artifact, NOW, false).is_err());
        let authority = authorize_install(&verified, &verified, &artifact, NOW, true).unwrap();
        assert_eq!(authority.bytes(), BYTES);
        // Deliberately no install callback, process launch, registry or real appdata access.
    }

    #[test]
    fn unknown_wrong_and_catalog_keys_or_signature_tampering_cannot_authorize_update() {
        let good = envelope(&policy());
        assert!(
            verify_policy(
                &good,
                &context(&UpdatePolicyKeys::default()),
                NOW,
                &UpdateTrustState::default()
            )
            .is_err()
        );
        let wrong = envelope_with(&policy(), &artifact_key(), DOMAIN);
        assert!(
            verify_policy(&wrong, &context(&keys()), NOW, &UpdateTrustState::default()).is_err()
        );
        let catalog_signed = envelope_with(&policy(), &policy_key(), crate::catalog::DOMAIN);
        assert!(
            verify_policy(
                &catalog_signed,
                &context(&keys()),
                NOW,
                &UpdateTrustState::default()
            )
            .is_err()
        );
        let catalog_keys = BTreeMap::from([(
            "update-test-only".into(),
            policy_key().verifying_key().to_bytes(),
        )]);
        assert!(
            crate::catalog::verify_index(
                &good,
                &catalog_keys,
                NOW,
                &crate::catalog::TrustState::default()
            )
            .is_err()
        );
        let mut tampered: Value = serde_json::from_slice(&good).unwrap();
        tampered["signature"] = json!("00".repeat(64));
        assert!(
            verify_policy(
                &serde_json::to_vec(&tampered).unwrap(),
                &context(&keys()),
                NOW,
                &UpdateTrustState::default()
            )
            .is_err()
        );
    }

    #[test]
    fn freshness_clock_precision_schema_and_size_fail_closed() {
        let good = envelope(&policy());
        for now in [NOW - 1, NOW + 86400, NOW + WEEK] {
            assert!(
                verify_policy(&good, &context(&keys()), now, &UpdateTrustState::default()).is_err()
            );
        }
        for (field, value) in [
            ("issuedAt", json!("2026-10-15T00:00:00.000Z")),
            ("issuedAt", json!("2026-10-15T00:00:00+00:00")),
            ("expiresAt", json!("2026-10-23T00:00:00Z")),
            ("expiresAt", json!("2026-10-15T00:00:00Z")),
            ("schemaVersion", json!(2)),
            ("sequence", json!(0)),
            ("unexpected", json!(true)),
        ] {
            let mut value_policy = policy();
            value_policy[field] = value;
            assert!(verify(&value_policy).is_err(), "{field}");
        }
        assert!(
            verify_policy(
                &vec![0; MAX_POLICY_BYTES + 1],
                &context(&keys()),
                NOW,
                &UpdateTrustState::default()
            )
            .is_err()
        );
        assert!(
            verify_policy(b"{}", &context(&keys()), NOW, &UpdateTrustState::default()).is_err()
        );
    }

    #[test]
    fn replay_equivocation_and_corrupt_floor_are_rejected_but_exact_retry_is_safe() {
        let first = verify(&policy()).unwrap();
        let prior = first.trust_state();
        assert!(verify_policy(&envelope(&policy()), &context(&keys()), NOW, &prior).is_ok());
        let mut changed = policy();
        changed["sequence"] = json!(1);
        assert!(verify_policy(&envelope(&changed), &context(&keys()), NOW, &prior).is_err());
        changed = policy();
        changed["expiresAt"] = json!("2026-10-17T00:00:00Z");
        assert!(verify_policy(&envelope(&changed), &context(&keys()), NOW, &prior).is_err());
        changed["sequence"] = json!(3);
        assert!(verify_policy(&envelope(&changed), &context(&keys()), NOW, &prior).is_ok());
        for corrupt in [
            UpdateTrustState {
                highest_sequence: 2,
                accepted_digest: None,
            },
            UpdateTrustState {
                highest_sequence: 0,
                accepted_digest: Some(first.digest().into()),
            },
        ] {
            assert!(verify_policy(&envelope(&policy()), &context(&keys()), NOW, &corrupt).is_err());
        }
    }

    #[test]
    fn holds_targets_channels_downgrades_and_build_metadata_cannot_bypass_ordering() {
        let mut held = policy();
        held["holds"] = json!([{"version":NEXT,"reason":"Test hold"}]);
        assert!(verify(&held).is_err());
        held["holds"] = json!([{"version":format!("{NEXT}+another-build"),"reason":"Test hold"}]);
        assert!(verify(&held).is_err());
        for (field, value) in [
            ("version", CURRENT),
            ("version", "0.0.9"),
            ("version", "0.1.0-alpha.1+new-build"),
            ("version", "nonsense"),
            ("target", "linux-x86_64"),
        ] {
            let mut changed = policy();
            changed["release"][field] = json!(value);
            assert!(verify(&changed).is_err());
        }
        let mut wrong_channel = policy();
        wrong_channel["channel"] = json!("stable");
        assert!(verify(&wrong_channel).is_err());
        let binding = keys();
        let mut stable = context(&binding);
        stable.channel = "stable";
        assert!(
            verify_policy(
                &envelope(&wrong_channel),
                &stable,
                NOW,
                &UpdateTrustState::default()
            )
            .is_err()
        );
    }

    #[test]
    fn artifact_urls_must_have_pinned_origins_version_and_no_mutable_or_credential_parts() {
        for url in [
            "http://updates.repoready.test/releases/0.1.0-alpha.2/RepoReady.exe",
            "https://evil.test/releases/0.1.0-alpha.2/RepoReady.exe",
            "https://updates.repoready.test/releases/latest/RepoReady.exe",
            "https://updates.repoready.test/releases/0.1.0-alpha.2/latest.exe",
            "https://updates.repoready.test/releases/0.1.0-alpha.2/RepoReady.exe?token=x",
            "https://updates.repoready.test/releases/0.1.0-alpha.2/RepoReady.exe#fragment",
            "https://user@updates.repoready.test/releases/0.1.0-alpha.2/RepoReady.exe",
            "https://updates.repoready.test/releases/%30.1.0-alpha.2/RepoReady.exe",
            "https://updates.repoready.test/releases/0.1.0-alpha.2/",
        ] {
            let mut changed = policy();
            changed["release"]["url"] = json!(url);
            assert!(verify(&changed).is_err(), "{url}");
        }
    }

    #[test]
    fn wrong_size_hash_key_signature_or_signed_version_reject_exact_artifact() {
        let verified = verify(&policy()).unwrap();
        for bytes in [
            b"changed bytes".to_vec(),
            BYTES[..BYTES.len() - 1].to_vec(),
            [BYTES, b"extra"].concat(),
        ] {
            assert!(verify_artifact(&verified, bytes, &artifact_public(), NOW).is_err());
        }
        let wrong_public = signed_artifact(&policy_key(), BYTES, NEXT).0;
        assert!(verify_artifact(&verified, BYTES.into(), &wrong_public, NOW).is_err());
        assert!(verify_artifact(&verified, BYTES.into(), &artifact_public(), NOW + 86400).is_err());
        for (field, value) in [
            ("sha256", json!("0".repeat(64))),
            ("sha256", json!("A".repeat(64))),
            ("sizeBytes", json!(0)),
            ("sizeBytes", json!(MAX_ARTIFACT_BYTES + 1)),
        ] {
            let mut changed = policy();
            changed["release"][field] = value;
            assert!(verify(&changed).is_err());
        }
        let mut changed = policy();
        changed["release"]["sha256"] = json!(sha256(b"replacement"));
        changed["release"]["sizeBytes"] = json!(b"replacement".len());
        assert!(
            verify_artifact(
                &verify(&changed).unwrap(),
                b"replacement".to_vec(),
                &artifact_public(),
                NOW
            )
            .is_err()
        );
        changed = policy();
        changed["release"]["signature"] = json!(signed_artifact(&artifact_key(), BYTES, CURRENT).1);
        assert!(
            verify_artifact(
                &verify(&changed).unwrap(),
                BYTES.into(),
                &artifact_public(),
                NOW
            )
            .is_err()
        );
        changed["release"]["signature"] = json!("invalid-signature");
        assert!(
            verify_artifact(
                &verify(&changed).unwrap(),
                BYTES.into(),
                &artifact_public(),
                NOW
            )
            .is_err()
        );
    }

    #[test]
    fn execution_rechecks_policy_age_hold_artifact_and_release_even_with_consent() {
        let prepared = verify(&policy()).unwrap();
        let artifact = verify_artifact(&prepared, BYTES.into(), &artifact_public(), NOW).unwrap();
        assert!(authorize_install(&prepared, &prepared, &artifact, NOW + 86400, true).is_err());
        let mut fresh = policy();
        fresh["sequence"] = json!(3);
        fresh["holds"] = json!([{"version":NEXT,"reason":"Hold after preparation"}]);
        assert!(
            verify_policy(
                &envelope(&fresh),
                &context(&keys()),
                NOW,
                &prepared.trust_state()
            )
            .is_err()
        );
        let held_state = authenticate_policy(
            &envelope(&fresh),
            &context(&keys()),
            NOW,
            &prepared.trust_state(),
        )
        .unwrap()
        .trust_state();
        assert!(verify_policy(&envelope(&policy()), &context(&keys()), NOW, &held_state).is_err());
        fresh["holds"] = json!([]);
        fresh["expiresAt"] = json!("2026-10-17T00:00:00Z");
        let refreshed = verify_policy(
            &envelope(&fresh),
            &context(&keys()),
            NOW,
            &prepared.trust_state(),
        )
        .unwrap();
        assert!(authorize_install(&prepared, &refreshed, &artifact, NOW, true).is_ok());
        fresh["release"]["url"] = json!(format!(
            "https://updates.repoready.test/other/{NEXT}/RepoReady.exe"
        ));
        let changed = verify(&fresh).unwrap();
        assert!(authorize_install(&prepared, &changed, &artifact, NOW, true).is_err());
    }

    #[test]
    fn key_roles_and_production_endpoints_are_separate_and_pinned() {
        assert!(
            keys()
                .ensure_independent_artifact_key(&artifact_public())
                .is_ok()
        );
        assert!(
            keys()
                .ensure_independent_artifact_key(&signed_artifact(&policy_key(), BYTES, NEXT).0)
                .is_err()
        );
        for endpoint in [
            "http://updates.repoready.org/policy",
            "https://127.0.0.1/policy",
            "https://localhost/policy",
            "https://updates.test/policy",
            "https://example.com/policy",
            "https://user@updates.repoready.org/policy",
            "https://updates.repoready.org:444/policy",
            "https://updates.repoready.org/policy?q=secret",
        ] {
            assert!(validate_policy_endpoint(endpoint).is_err());
        }
        assert!(
            validate_policy_endpoint("https://updates.repoready.org/development/policy.json")
                .is_ok()
        );
    }

    #[test]
    fn bounded_transport_rejects_redirect_encoding_oversize_truncation_and_cancellation() {
        use std::{io::Write, net::TcpListener, thread};
        fn response(bytes: Vec<u8>) -> (String, thread::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/artifact", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 2048];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(&bytes);
            });
            (endpoint, server)
        }
        // HTTP relaxation exists ONLY inside this unit-test-local client.
        let transport = UpdateTransport {
            client: reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(1))
                .no_proxy()
                .build()
                .unwrap(),
        };
        let cancel = AtomicBool::new(false);
        for raw in [
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\n\r\n"
                .to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n".to_vec(),
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n12345678901234567890".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\na".to_vec(),
        ] {
            let (url, server) = response(raw);
            assert!(transport.fetch(&url, 10, None, &cancel).is_err());
            server.join().unwrap();
        }
        let (url, server) = response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec());
        assert_eq!(transport.fetch(&url, 10, Some(2), &cancel).unwrap(), b"{}");
        server.join().unwrap();
        cancel.store(true, Ordering::SeqCst);
        assert!(
            transport
                .fetch("http://127.0.0.1:1/", 10, None, &cancel)
                .is_err()
        );
    }
}
