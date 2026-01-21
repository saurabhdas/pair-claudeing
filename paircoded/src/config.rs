//! Configuration and CLI argument handling.

use anyhow::{anyhow, Result};
use clap::Parser;
use rand::Rng;
use std::env;
use std::path::PathBuf;
use url::Url;

/// Default relay URL
const DEFAULT_RELAY_URL: &str = "https://retrievable-timidly-drusilla.ngrok-free.app";

/// A CLI tool that hosts a terminal over the internet by connecting to a relay service.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// Working directory path for the terminal (default: current directory)
    pub path: Option<PathBuf>,

    /// Authenticate with GitHub (uses Device Flow)
    #[arg(long)]
    pub login: bool,

    /// Session name (default: <username>-<8 random digits>)
    #[arg(short = 'n', long)]
    pub session: Option<String>,

    /// Shell to spawn (default: $SHELL or /bin/sh)
    #[arg(short, long)]
    pub shell: Option<String>,

    /// Run a specific command instead of shell
    #[arg(short, long)]
    pub command: Option<String>,

    /// Enable verbose logging
    #[arg(short, long)]
    pub verbose: bool,

    /// Disable automatic reconnection on disconnect
    #[arg(long)]
    pub no_reconnect: bool,
}

/// Runtime configuration derived from CLI args and environment
#[derive(Debug, Clone)]
pub struct Config {
    /// Parsed and validated relay URL (WebSocket)
    pub relay_url: Url,

    /// Session name (e.g., "saurabhdas-12345678")
    pub session_name: String,

    /// Dashboard URL to display to user
    pub dashboard_url: String,

    /// Working directory for the terminal
    pub working_dir: PathBuf,

    /// Shell command to execute
    pub shell: String,

    /// Optional command to run instead of interactive shell
    pub command: Option<String>,

    /// Verbose logging enabled
    pub verbose: bool,

    /// Auto-reconnect on disconnect
    pub reconnect: bool,

    /// Force login even if token exists
    pub force_login: bool,

    /// Computer hostname
    pub hostname: String,

    /// Username
    pub username: String,
}

impl Config {
    /// Create configuration from CLI arguments and a username
    pub fn from_args(args: Args, username: &str) -> Result<Self> {
        // Generate session name: <username>-<8 random digits>
        let session_name = args.session.unwrap_or_else(|| {
            let random_digits: u32 = rand::thread_rng().gen_range(10000000..99999999);
            format!("{}-{}", username, random_digits)
        });

        // Get relay URL from environment or use default
        let relay_base = env::var("PAIRCODED_RELAY_URL")
            .unwrap_or_else(|_| DEFAULT_RELAY_URL.to_string());

        // Parse the base URL to determine scheme
        let base_url = Url::parse(&relay_base)
            .map_err(|e| anyhow!("invalid relay URL '{}': {}", relay_base, e))?;

        // Determine WebSocket scheme based on HTTP scheme
        let ws_scheme = match base_url.scheme() {
            "https" => "wss",
            "http" => "ws",
            "wss" => "wss",
            "ws" => "ws",
            scheme => return Err(anyhow!("unsupported URL scheme: {}", scheme)),
        };

        // Construct WebSocket URL
        let host = base_url.host_str()
            .ok_or_else(|| anyhow!("relay URL has no host"))?;
        let port_str = base_url.port().map(|p| format!(":{}", p)).unwrap_or_default();

        let relay_url = Url::parse(&format!(
            "{}://{}{}/ws/control/{}",
            ws_scheme, host, port_str, session_name
        ))?;

        // Construct dashboard URL
        let http_scheme = match ws_scheme {
            "wss" => "https",
            _ => "http",
        };
        let dashboard_url = format!(
            "{}://{}{}",
            http_scheme, host, port_str
        );

        // Determine working directory
        let working_dir = if let Some(path) = args.path {
            if path.is_absolute() {
                path
            } else {
                env::current_dir()?.join(path)
            }
        } else {
            env::current_dir()?
        };

        // Canonicalize the path
        let working_dir = working_dir.canonicalize()
            .unwrap_or(working_dir);

        // Determine shell to use
        let shell = args.shell.unwrap_or_else(|| {
            env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        });

        // Get system info
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());

        Ok(Config {
            relay_url,
            session_name,
            dashboard_url,
            working_dir,
            shell,
            command: args.command,
            verbose: args.verbose,
            reconnect: !args.no_reconnect,
            force_login: args.login,
            hostname,
            username: username.to_string(),
        })
    }

    /// Get the command and arguments to spawn
    pub fn spawn_command(&self) -> (&str, Vec<&str>) {
        if let Some(ref cmd) = self.command {
            // Run command with shell -c
            (&self.shell, vec!["-c", cmd])
        } else {
            // Interactive shell
            (&self.shell, vec![])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_name_format() {
        let args = Args {
            path: None,
            login: false,
            session: None,
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args, "testuser").unwrap();
        assert!(config.session_name.starts_with("testuser-"));
        assert_eq!(config.session_name.len(), "testuser-".len() + 8);
    }

    #[test]
    fn test_custom_session_name() {
        let args = Args {
            path: None,
            login: false,
            session: Some("my-custom-session".to_string()),
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args, "testuser").unwrap();
        assert_eq!(config.session_name, "my-custom-session");
    }

    #[test]
    fn test_default_relay_url() {
        let args = Args {
            path: None,
            login: false,
            session: Some("test".to_string()),
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args, "user").unwrap();
        assert_eq!(config.relay_url.scheme(), "wss");
        assert!(config.relay_url.as_str().contains("retrievable-timidly-drusilla"));
    }

    #[test]
    fn test_custom_shell() {
        let args = Args {
            path: None,
            login: false,
            session: None,
            shell: Some("/bin/zsh".to_string()),
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args, "user").unwrap();
        assert_eq!(config.shell, "/bin/zsh");
    }
}
