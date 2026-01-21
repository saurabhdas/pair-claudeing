//! Configuration and CLI argument handling.

use anyhow::{anyhow, Result};
use clap::Parser;
use std::env;
use url::Url;

/// A CLI tool that hosts a terminal over the internet by connecting to a relay service.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// WebSocket URL of the relay service (ws:// or wss://)
    pub relay_url: String,

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
        // Validate and parse the relay URL
        let relay_url = Url::parse(&args.relay_url)
            .map_err(|e| anyhow!("invalid relay URL: {}", e))?;

        // Ensure it's a websocket URL
        match relay_url.scheme() {
            "ws" | "wss" => {}
            scheme => return Err(anyhow!(
                "relay URL must use ws:// or wss:// scheme, got: {}://",
                scheme
            )),
        }

        // Determine shell to use
        let shell = args.shell.unwrap_or_else(|| {
            env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        });

        Ok(Config {
            relay_url,
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
    fn test_valid_ws_url() {
        let args = Args {
            relay_url: "ws://localhost:8080".to_string(),
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args).unwrap();
        assert_eq!(config.relay_url.scheme(), "ws");
    }

    #[test]
    fn test_valid_wss_url() {
        let args = Args {
            relay_url: "wss://relay.example.com/connect".to_string(),
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args).unwrap();
        assert_eq!(config.relay_url.scheme(), "wss");
    }

    #[test]
    fn test_invalid_scheme() {
        let args = Args {
            relay_url: "http://localhost:8080".to_string(),
            shell: None,
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let result = Config::from_args(args);
        assert!(result.is_err());
    }

    #[test]
    fn test_custom_shell() {
        let args = Args {
            relay_url: "ws://localhost:8080".to_string(),
            shell: Some("/bin/zsh".to_string()),
            command: None,
            verbose: false,
            no_reconnect: false,
        };
        let config = Config::from_args(args).unwrap();
        assert_eq!(config.shell, "/bin/zsh");
    }
}
