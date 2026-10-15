//! Fixed native configuration only. Frontend arguments must never construct this source.
use crate::{catalog, storage::Store};
use reqwest::{Url, blocking::Client, redirect::Policy};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::Mutex,
    time::{Duration, Instant},
};
pub struct CatalogSource {
    origin: Url,
    index_path: String,
    keys: BTreeMap<String, [u8; 32]>,
    client: Client,
    refresh_lock: Mutex<()>,
}
impl CatalogSource {
    pub fn new(
        origin: &str,
        index_path: &str,
        keys: BTreeMap<String, [u8; 32]>,
    ) -> Result<Self, String> {
        let url = Url::parse(origin).map_err(|_| "INVALID_CATALOG_CONFIG")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || url.port().is_some_and(|port| port != 443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || keys.is_empty()
        {
            return Err("INVALID_CATALOG_CONFIG".into());
        }
        let host = url.host_str().unwrap_or_default();
        if host == "localhost"
            || host.parse::<std::net::IpAddr>().is_ok()
            || !host.contains('.')
            || host.ends_with(".invalid")
            || host.ends_with(".test")
            || host == "example.com"
        {
            return Err("INVALID_CATALOG_CONFIG".into());
        }
        Self::build(url, index_path, keys)
    }
    fn build(
        origin: Url,
        index_path: &str,
        keys: BTreeMap<String, [u8; 32]>,
    ) -> Result<Self, String> {
        if !index_path.starts_with('/')
            || index_path.starts_with("//")
            || index_path.contains(['?', '#', '\\', '%'])
            || index_path
                .split('/')
                .any(|part| part == ".." || part == ".")
        {
            return Err("INVALID_CATALOG_CONFIG".into());
        }
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .no_proxy()
            .user_agent("RepoReady/0.0 catalog")
            .build()
            .map_err(|_| "NETWORK_UNAVAILABLE")?;
        Ok(Self {
            origin,
            index_path: index_path.into(),
            keys,
            client,
            refresh_lock: Mutex::new(()),
        })
    }
    fn fetch(&self, path: &str, limit: usize) -> Result<Vec<u8>, String> {
        let url = self
            .origin
            .join(path)
            .map_err(|_| "INVALID_CATALOG_CONFIG")?;
        if url.origin() != self.origin.origin() {
            return Err("INVALID_CATALOG_CONFIG".into());
        }
        let response = self
            .client
            .get(url)
            .send()
            .map_err(|_| "CATALOG_NETWORK_UNAVAILABLE")?;
        if !response.status().is_success() {
            return Err("CATALOG_HTTP_FAILED".into());
        }
        // Content encoding is never enabled; reject encoded payloads explicitly.
        if response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|encoding| encoding != "identity")
        {
            return Err("CATALOG_ENCODING_UNSUPPORTED".into());
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err("CATALOG_TOO_LARGE".into());
        }
        let mut bytes = Vec::new();
        response
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "CATALOG_NETWORK_UNAVAILABLE")?;
        if bytes.len() > limit {
            return Err("CATALOG_TOO_LARGE".into());
        }
        Ok(bytes)
    }
    pub fn refresh(&self, store: &mut Store, now: i64) -> Result<(), String> {
        let _guard = self
            .refresh_lock
            .try_lock()
            .map_err(|_| "CATALOG_REFRESH_BUSY")?;
        let started = Instant::now();
        let envelope = self.fetch(&self.index_path, catalog::MAX_ENVELOPE_BYTES)?;
        let verified = catalog::verify_index(&envelope, &self.keys, now, &store.trust_state()?)?;
        let mut details = BTreeMap::new();
        let mut total = 0usize;
        for reference in verified.index()["details"]
            .as_array()
            .ok_or("INVALID_CATALOG")?
        {
            if started.elapsed() > Duration::from_secs(45) {
                return Err("CATALOG_REFRESH_TIMEOUT".into());
            }
            let id = reference["appId"].as_str().ok_or("INVALID_CATALOG")?;
            let version = reference["version"].as_str().ok_or("INVALID_CATALOG")?;
            // Both pieces have already passed the strict signed index schema.
            let bytes = self.fetch(
                &format!("/apps/{id}/{version}/manifest.json"),
                catalog::MAX_PAYLOAD_BYTES,
            )?;
            total += bytes.len();
            if total > 16_000_000 {
                return Err("CATALOG_TOO_LARGE".into());
            }
            details.insert(format!("{id}/{version}"), bytes);
        }
        store.accept_catalog(&envelope, &details, &self.keys, now)
    }
    #[cfg(test)]
    fn loopback(origin: &str) -> Self {
        Self::build(Url::parse(origin).unwrap(), "/index.json", BTreeMap::new()).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, thread};
    fn response(raw: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 2048];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(&raw);
        });
        origin
    }
    #[test]
    fn transport_rejects_redirects_oversize_encoding_and_truncated_bodies() {
        for raw in [b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\n\r\n".to_vec(),b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n".to_vec(),b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1\r\n\r\na".to_vec(),b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\na".to_vec()] {assert!(CatalogSource::loopback(&response(raw)).fetch("/index.json",10).is_err());}
        let source = CatalogSource::loopback(&response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
        ));
        assert_eq!(source.fetch("/index.json", 10).unwrap(), b"{}");
    }
    #[test]
    fn production_config_rejects_http_credentials_local_and_arbitrary_paths() {
        for origin in [
            "http://catalog.repoready.org",
            "https://user:password@catalog.repoready.org",
            "https://127.0.0.1",
            "https://localhost",
            "https://catalog.repoready.org/other",
            "https://catalog.repoready.org/?token=secret",
        ] {
            assert!(
                CatalogSource::new(
                    origin,
                    "/index.json",
                    BTreeMap::from([("key".into(), [0; 32])])
                )
                .is_err()
            );
        }
        assert!(
            CatalogSource::new(
                "https://catalog.repoready.org",
                "//evil.org/a",
                BTreeMap::from([("key".into(), [0; 32])])
            )
            .is_err()
        );
    }
    #[test]
    fn loopback_fixture_refresh_uses_real_verifier_and_atomic_store() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../contracts/fixtures/catalog-vector.json"))
                .unwrap();
        let envelope = serde_json::to_vec(&vector["envelope"]).unwrap();
        let detail = STANDARD
            .decode(vector["detailBase64"].as_str().unwrap())
            .unwrap();
        let key: [u8; 32] = hex::decode(vector["publicKeyHex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for (path, bytes) in [
                ("/index.json", envelope),
                ("/apps/test-fixture/1.0.0/manifest.json", detail),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 2048];
                let length = stream.read(&mut request).unwrap();
                assert!(
                    std::str::from_utf8(&request[..length])
                        .unwrap()
                        .starts_with(&format!("GET {path} "))
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    bytes.len()
                )
                .unwrap();
                stream.write_all(&bytes).unwrap();
            }
        });
        let source = CatalogSource::build(
            Url::parse(&origin).unwrap(),
            "/index.json",
            BTreeMap::from([("test-only".into(), key)]),
        )
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path()).unwrap();
        let now = vector["nowUnixSeconds"].as_i64().unwrap();
        source.refresh(&mut store, now).unwrap();
        server.join().unwrap();
        assert_eq!(store.cache_snapshot(now).unwrap()["status"], "verified");
    }
    #[test]
    fn timeout_and_streamed_oversize_have_bounds() {
        let source = CatalogSource::loopback(&response(
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n12345678901234567890".to_vec(),
        ));
        assert!(source.fetch("/index.json", 10).is_err());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(200));
        });
        let mut source = CatalogSource::loopback(&origin);
        source.client = Client::builder()
            .timeout(Duration::from_millis(50))
            .build()
            .unwrap();
        assert!(source.fetch("/index.json", 10).is_err());
        server.join().unwrap();
    }
}
