//! GitHub Device Flow authentication and token persistence.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tracing::{info, warn};

/// GitHub OAuth client ID for paircoded
/// This is a public client ID for the Device Flow
const GITHUB_CLIENT_ID: &str = "Ov23liJOmsIBB3qHy0x6";

/// Stored authentication data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthData {
    pub access_token: String,
    pub token_type: String,
    pub scope: String,
    pub user: GitHubUser,
}

/// GitHub user info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubUser {
    pub id: u64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
}

/// Device Flow response from GitHub
#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

/// Token response from GitHub
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    token_type: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    #[allow(dead_code)]
    error_description: Option<String>,
}

/// Relay token response
#[derive(Debug, Deserialize)]
struct RelayTokenResponse {
    token: String,
    #[serde(rename = "expiresIn")]
    expires_in: String,
}

/// Relay token error response
#[derive(Debug, Deserialize)]
struct RelayErrorResponse {
    error: String,
    code: String,
}

/// Get the config directory for paircoded
fn config_dir() -> Result<PathBuf> {
    let dir = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not determine config directory"))?
        .join("paircoded");
    Ok(dir)
}

/// Get the path to the auth file
fn auth_file_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("auth.json"))
}

/// Load saved authentication data
pub fn load_auth() -> Result<Option<AuthData>> {
    let path = auth_file_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)?;
    let auth: AuthData = serde_json::from_str(&content)?;
    Ok(Some(auth))
}

/// Save authentication data
fn save_auth(auth: &AuthData) -> Result<()> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir)?;

    let path = auth_file_path()?;
    let content = serde_json::to_string_pretty(auth)?;
    fs::write(&path, content)?;

    // Set file permissions to 0600 (owner read/write only) on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&path, perms)?;
    }

    info!(?path, "saved authentication data");
    Ok(())
}

/// Clear saved authentication data
pub fn clear_auth() -> Result<()> {
    let path = auth_file_path()?;
    if path.exists() {
        fs::remove_file(&path)?;
        info!(?path, "cleared authentication data");
    }
    Ok(())
}

/// Perform GitHub Device Flow authentication
pub async fn device_flow_login() -> Result<AuthData> {
    let client = reqwest::Client::new();

    // Step 1: Request device code
    println!();
    println!("  Authenticating with GitHub...");

    let device_resp: DeviceCodeResponse = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", GITHUB_CLIENT_ID),
            ("scope", "read:user"),
        ])
        .send()
        .await?
        .json()
        .await?;

    // Step 2: Show user the code
    println!();
    println!("  Open: {}", device_resp.verification_uri);
    println!("  Enter code: {}", device_resp.user_code);
    println!();
    println!("  Waiting for authorization...");

    // Step 3: Poll for token
    let interval = Duration::from_secs(device_resp.interval.max(5));
    let mut attempts = 0;
    let max_attempts = (device_resp.expires_in / device_resp.interval.max(5)) as u32;

    let token_resp = loop {
        attempts += 1;
        if attempts > max_attempts {
            return Err(anyhow!("authorization timed out"));
        }

        tokio::time::sleep(interval).await;

        let resp: TokenResponse = client
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", GITHUB_CLIENT_ID),
                ("device_code", &device_resp.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?
            .json()
            .await?;

        if let Some(ref error) = resp.error {
            match error.as_str() {
                "authorization_pending" => continue,
                "slow_down" => {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                "expired_token" => return Err(anyhow!("authorization expired")),
                "access_denied" => return Err(anyhow!("authorization denied")),
                _ => return Err(anyhow!("authorization error: {}", error)),
            }
        }

        if resp.access_token.is_some() {
            break resp;
        }
    };

    let access_token = token_resp.access_token.ok_or_else(|| anyhow!("no access token"))?;
    let token_type = token_resp.token_type.unwrap_or_else(|| "bearer".to_string());
    let scope = token_resp.scope.unwrap_or_default();

    // Step 4: Get user info
    let user: GitHubUser = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "paircoded")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await?
        .json()
        .await?;

    println!("  Logged in as: {}", user.login);
    println!();

    let auth = AuthData {
        access_token,
        token_type,
        scope,
        user,
    };

    // Save for future use
    save_auth(&auth)?;

    Ok(auth)
}

/// Validate that a saved token is still valid
pub async fn validate_token(auth: &AuthData) -> Result<bool> {
    let client = reqwest::Client::new();

    let resp = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("User-Agent", "paircoded")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await?;

    if resp.status().is_success() {
        Ok(true)
    } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        warn!("saved token is no longer valid");
        Ok(false)
    } else {
        // Network error or other issue - assume token is still valid
        Ok(true)
    }
}

/// Get authentication, loading from disk or prompting for login
pub async fn get_auth(force_login: bool) -> Result<AuthData> {
    // If force_login, always do device flow
    if force_login {
        return device_flow_login().await;
    }

    // Try to load existing auth
    if let Some(auth) = load_auth()? {
        // Validate token is still good
        if validate_token(&auth).await? {
            info!(user = %auth.user.login, "using saved authentication");
            return Ok(auth);
        } else {
            // Token expired, clear and re-login
            clear_auth()?;
        }
    }

    // No valid auth, need to login
    device_flow_login().await
}

/// Get a relay JWT token by exchanging the GitHub token
pub async fn get_relay_token(relay_base_url: &url::Url, github_token: &str) -> Result<String> {
    let client = reqwest::Client::new();

    // Build the token endpoint URL
    let mut token_url = relay_base_url.clone();

    // Convert ws/wss to http/https
    let scheme = match relay_base_url.scheme() {
        "wss" => "https",
        "ws" => "http",
        s => s,
    };
    token_url.set_scheme(scheme).map_err(|_| anyhow!("failed to set URL scheme"))?;
    token_url.set_path("/api/auth/token");

    info!(url = %token_url, "requesting relay token");

    let resp = client
        .post(token_url.as_str())
        .header("Content-Type", "application/json")
        .header("User-Agent", "paircoded")
        .json(&serde_json::json!({
            "github_token": github_token
        }))
        .send()
        .await?;

    if resp.status().is_success() {
        let token_resp: RelayTokenResponse = resp.json().await?;
        info!(expires_in = %token_resp.expires_in, "obtained relay token");
        Ok(token_resp.token)
    } else {
        let error_resp: RelayErrorResponse = resp.json().await
            .unwrap_or_else(|_| RelayErrorResponse {
                error: "Unknown error".to_string(),
                code: "UNKNOWN".to_string(),
            });
        Err(anyhow!("failed to get relay token: {} ({})", error_resp.error, error_resp.code))
    }
}
