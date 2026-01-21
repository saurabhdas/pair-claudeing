//! Configuration and CLI argument handling.

use anyhow::{anyhow, Result};
use clap::Parser;
use std::env;
use url::Url;

/// A CLI tool that hosts a terminal over the internet by connecting to a relay service.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// Relay server address (HOST:PORT, e.g., localhost:8080)
    pub relay: String,

    /// Session name (default: auto-generated friendly name)
    #[arg(short = 'n', long)]
    pub session: Option<String>,

    /// Use secure WebSocket (wss://) and HTTPS
    #[arg(long)]
    pub secure: bool,

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
    /// Parsed and validated relay URL
    pub relay_url: Url,

    /// Session name (e.g., "curious-purple-panda")
    pub session_name: String,

    /// Browser URL to display to user
    pub browser_url: String,

    /// Shell command to execute
    pub shell: String,

    /// Optional command to run instead of interactive shell
    pub command: Option<String>,

    /// Verbose logging enabled
    pub verbose: bool,

    /// Auto-reconnect on disconnect
    pub reconnect: bool,
}

impl Config {
    /// Create configuration from CLI arguments
    pub fn from_args(args: Args) -> Result<Self> {
        // Generate or use provided session name
        let session_name = args.session.unwrap_or_else(|| {
            petname::petname(3, "-").unwrap_or_else(|| "session".to_string())
        });

        // Determine scheme based on --secure flag
        let (ws_scheme, http_scheme) = if args.secure {
            ("wss", "https")
        } else {
            ("ws", "http")
        };

        // Construct WebSocket URL from relay address
        let relay_url = Url::parse(&format!("{}://{}/ws/control/{}", ws_scheme, args.relay, session_name))
            .map_err(|e| anyhow!("invalid relay address '{}': {}", args.relay, e))?;

        // Construct browser URL for display (new format requires two sessions)
        let browser_url = format!("{}://{}/terminal/{}/<other-session>", http_scheme, args.relay, session_name);

        // Determine shell to use
        let shell = args.shell.unwrap_or_else(|| {
            env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        });

        Ok(Config {
            relay_url,
            session_name,
            browser_url,
            shell,
            command: args.command,
            verbose: args.verbose,
            reconnect: !args.no_reconnect,
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
    fn test_auto_generated_session() {
        let args = Args {
            relay: "localhost:8080".to_string(),
            session: None,
            secure: false,
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args).unwrap();
        assert_eq!(config.relay_url.scheme(), "ws");
        assert!(!config.session_name.is_empty());
        assert!(config.browser_url.contains(&config.session_name));
    }

    #[test]
    fn test_custom_session_name() {
        let args = Args {
            relay: "localhost:8080".to_string(),
            session: Some("my-custom-session".to_string()),
            secure: false,
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args).unwrap();
        assert_eq!(config.session_name, "my-custom-session");
        assert!(config.relay_url.as_str().contains("my-custom-session"));
        assert!(config.browser_url.contains("my-custom-session"));
    }

    #[test]
    fn test_url_construction() {
        let args = Args {
            relay: "relay.example.com:9000".to_string(),
            session: Some("test-session".to_string()),
            secure: false,
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args).unwrap();
        assert_eq!(
            config.relay_url.as_str(),
            "ws://relay.example.com:9000/ws/control/test-session"
        );
        assert_eq!(
            config.browser_url,
            "http://relay.example.com:9000/terminal/test-session/<other-session>"
        );
    }

    #[test]
    fn test_secure_flag() {
        let args = Args {
            relay: "relay.example.com".to_string(),
            session: Some("test-session".to_string()),
            secure: true,
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args).unwrap();
        assert_eq!(config.relay_url.scheme(), "wss");
        assert!(config.browser_url.starts_with("https://"));
    }

    #[test]
    fn test_custom_shell() {
        let args = Args {
            relay: "localhost:8080".to_string(),
            session: None,
            secure: false,
            shell: Some("/bin/zsh".to_string()),
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args).unwrap();
        assert_eq!(config.shell, "/bin/zsh");
    }
}
