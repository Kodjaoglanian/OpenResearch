//! Reads the saved Trackio variables for the Settings check, run links and launch warning.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

pub const SERVER_URL: &str = "TRACKIO_SERVER_URL";
const PROJECT: &str = "TRACKIO_PROJECT";
pub const WRITE_TOKEN: &str = "TRACKIO_WRITE_TOKEN";

/// The saved server URL, stripped to scheme, host, port and path.
pub fn server_url() -> Option<String> {
    crate::config::synced_env_var(SERVER_URL).and_then(|raw| base_url(&raw))
}

pub fn project() -> Option<String> {
    crate::config::synced_env_var(PROJECT)
}

/// Drops the query (`trackio.show()` URLs carry `?write_token=`), fragment and
/// credentials, so the result is safe to show, link to, and log.
fn base_url(raw: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    Some(url.as_str().trim_end_matches('/').to_string())
}

/// True for an address only this machine can reach, including Gradio's `0.0.0.0` bind address.
pub fn is_local_only(url: &str) -> bool {
    crate::local::local_models::is_loopback_url(url)
        || reqwest::Url::parse(url).is_ok_and(|url| {
            url.host_str()
                .and_then(|host| {
                    host.trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .ok()
                })
                .is_some_and(|ip| ip.is_unspecified())
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub reachable: bool,
    pub version: Option<String>,
    /// `None` when no write token is saved or the server didn't say.
    pub write_access: Option<bool>,
    pub error: Option<String>,
}

/// `GET /version`, then (with a token) Trackio's read-only write-access check.
pub async fn preflight(base: &str, token: Option<&str>) -> Preflight {
    let failed = |error: String| Preflight {
        reachable: false,
        version: None,
        write_access: None,
        error: Some(error),
    };
    let builder = if is_local_only(base) {
        crate::net::loopback_client()
    } else {
        crate::net::remote_client()
    };
    // No redirects: the write token must only ever reach the saved host.
    let client = match builder
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(error) => return failed(error.to_string()),
    };
    let version = match client.get(format!("{base}/version")).send().await {
        Ok(res) if res.status().is_success() => res
            .json::<Value>()
            .await
            .ok()
            .and_then(|body| body["version"].as_str().map(str::to_string)),
        Ok(res) => {
            return failed(format!(
                "{base}/version answered {}; is this a Trackio server?",
                res.status()
            ))
        }
        Err(error) => return failed(format!("Could not reach {base}: {}", error.without_url())),
    };
    let Some(version) = version else {
        return failed(format!("{base}/version did not identify a Trackio server"));
    };
    let write_access = match token {
        Some(token) => client
            .post(format!("{base}/api/get_run_mutation_status"))
            .header("X-Trackio-Write-Token", token)
            .json(&json!({}))
            .send()
            .await
            .ok()
            .filter(|res| res.status().is_success()),
        None => None,
    };
    let write_access = match write_access {
        Some(res) => res
            .json::<Value>()
            .await
            .ok()
            .and_then(|body| body["data"]["allowed"].as_bool()),
        None => None,
    };
    Preflight {
        reachable: true,
        version: Some(version),
        write_access,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_drops_tokens_and_credentials() {
        assert_eq!(
            base_url(" https://user:pw@trackio.example:7860/?write_token=secret#x ").as_deref(),
            Some("https://trackio.example:7860")
        );
        assert_eq!(
            base_url("http://10.0.0.5:7860/trackio/").as_deref(),
            Some("http://10.0.0.5:7860/trackio")
        );
        assert_eq!(base_url("localhost:7860"), None);
        assert_eq!(base_url("ftp://trackio.example"), None);
    }

    #[test]
    fn local_only_addresses() {
        for url in [
            "http://localhost:7860",
            "http://127.0.0.1:7860",
            "http://0.0.0.0:7860",
            "http://[::]:7860",
            "http://[::1]:7860",
        ] {
            assert!(is_local_only(url), "{url}");
        }
        for url in ["http://10.0.0.5:7860", "https://trackio.example"] {
            assert!(!is_local_only(url), "{url}");
        }
    }
}
