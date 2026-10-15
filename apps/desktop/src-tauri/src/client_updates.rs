//! Native-only client update service. No generic plugin commands or frontend-selected URL/key.
//! Kept disabled by the checked-in authority file until real release approval and device tests.
use repoready_core::{
    client_update::{
        self, UpdateContext, UpdatePolicyKeys, UpdateTransport, UpdateTrustState,
        VerifiedClientUpdate,
    },
    storage::Store,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

const AUTHORITY: &str = include_str!("../packaging/update-authority.json");

struct PinnedConfiguration {
    channel: String,
    policy_endpoint: String,
    policy_keys: UpdatePolicyKeys,
    artifact_origins: Vec<String>,
    artifact_public_key: String,
}
impl PinnedConfiguration {
    fn load() -> Result<Option<Self>, String> {
        let value: Value =
            serde_json::from_str(AUTHORITY).map_err(|_| "UPDATE_CONFIGURATION_INVALID")?;
        let object = value.as_object().ok_or("UPDATE_CONFIGURATION_INVALID")?;
        let fields = [
            "schemaVersion",
            "enabled",
            "channel",
            "policyEndpoint",
            "policyKeys",
            "artifactOrigins",
            "artifactPublicKey",
        ];
        if value["schemaVersion"] != 1
            || object.len() != fields.len()
            || object.keys().any(|key| !fields.contains(&key.as_str()))
        {
            return Err("UPDATE_CONFIGURATION_INVALID".into());
        }
        let enabled = value["enabled"]
            .as_bool()
            .ok_or("UPDATE_CONFIGURATION_INVALID")?;
        let channel = value["channel"]
            .as_str()
            .filter(|v| ["development", "stable"].contains(v))
            .ok_or("UPDATE_CONFIGURATION_INVALID")?
            .to_owned();
        if !enabled {
            if !value["policyEndpoint"].is_null()
                || !value["artifactPublicKey"].is_null()
                || value["policyKeys"]
                    .as_object()
                    .is_none_or(|v| !v.is_empty())
                || value["artifactOrigins"]
                    .as_array()
                    .is_none_or(|v| !v.is_empty())
            {
                return Err("UPDATE_CONFIGURATION_INVALID".into());
            }
            return Ok(None);
        }
        let policy_endpoint = value["policyEndpoint"]
            .as_str()
            .ok_or("UPDATE_CONFIGURATION_INVALID")?
            .to_owned();
        client_update::validate_policy_endpoint(&policy_endpoint)?;
        let keys: BTreeMap<String, String> = value["policyKeys"]
            .as_object()
            .ok_or("UPDATE_CONFIGURATION_INVALID")?
            .iter()
            .map(|(id, key)| {
                key.as_str()
                    .map(|key| (id.clone(), key.to_owned()))
                    .ok_or("UPDATE_CONFIGURATION_INVALID".into())
            })
            .collect::<Result<_, String>>()?;
        if keys.is_empty()
            || keys.len() > 10
            || (channel == "stable"
                && keys
                    .keys()
                    .any(|id| id.to_ascii_lowercase().contains("test")))
        {
            return Err("UPDATE_CONFIGURATION_INVALID".into());
        }
        let policy_keys = UpdatePolicyKeys::from_hex_pinned(&keys)?;
        let artifact_public_key = value["artifactPublicKey"]
            .as_str()
            .ok_or("UPDATE_CONFIGURATION_INVALID")?
            .to_owned();
        policy_keys.ensure_independent_artifact_key(&artifact_public_key)?;
        let artifact_origins: Vec<String> = value["artifactOrigins"]
            .as_array()
            .ok_or("UPDATE_CONFIGURATION_INVALID")?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or("UPDATE_CONFIGURATION_INVALID".into())
            })
            .collect::<Result<_, String>>()?;
        if artifact_origins.is_empty() || artifact_origins.len() > 10 {
            return Err("UPDATE_CONFIGURATION_INVALID".into());
        }
        for origin in &artifact_origins {
            client_update::validate_artifact_origin(origin)?;
        }
        Ok(Some(Self {
            channel,
            policy_endpoint,
            policy_keys,
            artifact_origins,
            artifact_public_key,
        }))
    }
}

struct PreparedUpdate {
    policy: VerifiedClientUpdate,
    plugin: Update,
}

/// Keep one instance in a native Mutex and run blocking methods with spawn_blocking. It owns
/// an independent marked state root so main catalog Store startup cannot reset its intent.
/// The caller passes its owned `client-updates` child directory.
pub struct ClientUpdates {
    store: Store,
    configuration: Option<PinnedConfiguration>,
    prepared: Option<PreparedUpdate>,
    cancelled: Arc<AtomicBool>,
    status: &'static str,
    message: String,
    version: Option<String>,
}

fn now() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "UPDATE_CLOCK_INVALID")?
        .as_secs()
        .try_into()
        .map_err(|_| "UPDATE_CLOCK_INVALID".into())
}

impl ClientUpdates {
    pub fn new(root: &Path) -> Result<Self, String> {
        let store = Store::open(root)?;
        let configuration = PinnedConfiguration::load()?;
        let channel = configuration
            .as_ref()
            .map(|v| v.channel.as_str())
            .unwrap_or("development");
        let recovery = store.update_intent(channel)?.is_some_and(|value| {
            ["interrupted", "recovery-required"]
                .contains(&value["stage"].as_str().unwrap_or_default())
        });
        Ok(Self {
            store,
            configuration,
            prepared: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            status: if recovery { "failed" } else { "not-configured" },
            message: if recovery {
                "UPDATE_RECOVERY_REQUIRED"
            } else {
                "UPDATE_NOT_CONFIGURED"
            }
            .into(),
            version: None,
        })
    }
    pub fn snapshot(&self) -> Value {
        json!({ "status": self.status, "version": self.version, "messageCode": self.message })
    }
    /// Clone before entering a blocking operation so cancellation does not wait for its Mutex.
    pub fn cancellation_handle(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    pub fn check(&mut self, app: &AppHandle) -> Result<Value, String> {
        if self.configuration.is_none() {
            return Ok(self.snapshot());
        }
        self.cancelled.store(false, Ordering::SeqCst);
        self.status = "checking";
        self.prepared = None;
        self.version = None;
        match self.prepare(app) {
            Ok(prepared) => {
                self.version = Some(prepared.policy.version().into());
                self.prepared = Some(prepared);
                self.status = "available";
                self.message = "UPDATE_AVAILABLE".into();
                Ok(self.snapshot())
            }
            Err(error) if error == "UPDATE_VERSION_NOT_NEWER" => {
                self.status = "current";
                self.message = "UPDATE_CURRENT".into();
                Ok(self.snapshot())
            }
            Err(error) => self.fail(error),
        }
    }

    fn latest_policy(&mut self, current: &str) -> Result<VerifiedClientUpdate, String> {
        let configuration = self.configuration.as_ref().ok_or("UPDATE_NOT_CONFIGURED")?;
        let origins: Vec<_> = configuration
            .artifact_origins
            .iter()
            .map(String::as_str)
            .collect();
        let context = UpdateContext {
            policy_keys: &configuration.policy_keys,
            channel: &configuration.channel,
            current_version: current,
            artifact_origins: &origins,
        };
        let prior = self.store.update_trust_state(&configuration.channel)?;
        let prior = UpdateTrustState {
            highest_sequence: prior.highest_sequence,
            accepted_digest: prior.accepted_digest,
        };
        let envelope = UpdateTransport::new()?
            .fetch_policy(&configuration.policy_endpoint, &self.cancelled)?;
        let checked_at = now()?;
        let authenticated =
            client_update::authenticate_policy(&envelope, &context, checked_at, &prior)?;
        // Save even when eligibility fails because the release is held, downgraded, or wrong-target.
        self.store.accept_update_policy(
            &configuration.channel,
            &envelope,
            authenticated.sequence(),
            authenticated.digest(),
            checked_at,
        )?;
        client_update::verify_policy(
            &envelope,
            &context,
            checked_at,
            &authenticated.trust_state(),
        )
    }

    fn prepare(&mut self, app: &AppHandle) -> Result<PreparedUpdate, String> {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return Err("UPDATE_PLATFORM_UNSUPPORTED".into());
        }
        let current = app.package_info().version.to_string();
        let policy = self.latest_policy(&current)?;
        let configuration = self.configuration.as_ref().ok_or("UPDATE_NOT_CONFIGURED")?;
        // restore_update applies normal version ordering and mandatory signed-version binding.
        // The tiny manifest is constructed ONLY from our opaque verified policy. No remote
        // plugin check is made, and no remote/raw JSON reaches this API from JavaScript.
        let manifest = json!({"version": policy.version(), "platforms": {(client_update::TARGET): {"url": policy.url(), "signature": policy.signature()}}});
        let updater = app
            .updater_builder()
            .target(client_update::TARGET)
            .pubkey(configuration.artifact_public_key.clone())
            .endpoints(vec![
                configuration
                    .policy_endpoint
                    .parse()
                    .map_err(|_| "UPDATE_CONFIGURATION_INVALID")?,
            ])
            .map_err(|_| "UPDATE_CONFIGURATION_INVALID")?
            .restart_after_install(false)
            .clear_installer_args()
            .build()
            .map_err(|_| "UPDATE_NATIVE_UNAVAILABLE")?;
        let plugin = updater
            .restore_update(manifest)
            .map_err(|_| "UPDATE_NATIVE_METADATA_REJECTED")?
            .ok_or("UPDATE_VERSION_NOT_NEWER")?;
        if plugin.version != policy.version()
            || plugin.download_url.as_str() != policy.url()
            || plugin.signature != policy.signature()
            || plugin.target != client_update::TARGET
        {
            return Err("UPDATE_NATIVE_METADATA_REJECTED".into());
        }
        Ok(PreparedUpdate { policy, plugin })
    }

    /// Explicit consent covers downloading and starting THIS prepared client installer. On
    /// Windows Tauri exits after spawning it; a spawn is NOT a successful update. Automatic
    /// relaunch is disabled. Only a later startup/version reconciliation can mark completion.
    /// Never invoke this method in integration tests or without a deliberate user gesture.
    pub fn install(&mut self, app: &AppHandle, consent: bool) -> Result<Value, String> {
        if !consent {
            return Err("UPDATE_CONSENT_REQUIRED".into());
        }
        if self.configuration.is_none() {
            return Ok(self.snapshot());
        }
        let Some(prepared) = self.prepared.take() else {
            return Err("UPDATE_CHECK_REQUIRED".into());
        };
        self.cancelled.store(false, Ordering::SeqCst);
        let result = self.install_prepared(app, &prepared);
        if let Err(error) = result {
            if let Some(configuration) = &self.configuration {
                let _ = self.store.save_update_intent(
                    &configuration.channel,
                    prepared.policy.version(),
                    "failed",
                    now().unwrap_or(0),
                );
            }
            return self.fail(error);
        }
        // Windows normally exits inside the plugin call. This state does not claim success.
        self.status = "restart-required";
        self.message = "UPDATE_RESTART_REQUIRED".into();
        Ok(self.snapshot())
    }

    fn install_prepared(
        &mut self,
        app: &AppHandle,
        prepared: &PreparedUpdate,
    ) -> Result<(), String> {
        prepared.policy.ensure_fresh(now()?)?;
        let configuration = self.configuration.as_ref().ok_or("UPDATE_NOT_CONFIGURED")?;
        self.store.save_update_intent(
            &configuration.channel,
            prepared.policy.version(),
            "downloading",
            now()?,
        )?;
        let bytes = UpdateTransport::new()?.download_artifact(&prepared.policy, &self.cancelled)?;
        let artifact = client_update::verify_artifact(
            &prepared.policy,
            bytes,
            &configuration.artifact_public_key,
            now()?,
        )?;
        self.store.save_update_intent(
            &configuration.channel,
            prepared.policy.version(),
            "downloaded",
            now()?,
        )?;
        self.status = "downloaded";
        self.message = "UPDATE_DOWNLOADED".into();
        // Always refetch and persist the newest authenticated policy after download. Offline,
        // stale, replayed or held metadata cannot be bypassed by previously granted consent.
        let latest = self.latest_policy(&app.package_info().version.to_string())?;
        let authority =
            client_update::authorize_install(&prepared.policy, &latest, &artifact, now()?, true)?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("UPDATE_CANCELLED".into());
        }
        prepared
            .plugin
            .verify(authority.bytes())
            .map_err(|_| "UPDATE_NATIVE_SIGNATURE_REJECTED")?;
        let configuration = self.configuration.as_ref().ok_or("UPDATE_NOT_CONFIGURED")?;
        self.store.save_update_intent(
            &configuration.channel,
            prepared.policy.version(),
            "installing",
            now()?,
        )?;
        prepared
            .plugin
            .install(authority.bytes())
            .map_err(|_| "UPDATE_NATIVE_INSTALL_FAILED")
    }
    fn fail(&mut self, error: String) -> Result<Value, String> {
        self.status = "failed";
        self.message = if error.len() <= 80
            && error
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        {
            error.clone()
        } else {
            "UPDATE_POLICY_REJECTED".into()
        };
        Err(self.message.clone())
    }
}
