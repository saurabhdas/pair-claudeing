//! paircoded - Host a terminal over the internet by connecting to a relay service.
//!
//! Unlike ttyd (which hosts a websocket server for incoming connections), paircoded
//! makes **outgoing** websocket connections to a relay, acting as a bridge between
//! a local PTY and the relay service.

mod bridge;
mod config;
mod protocol;
mod pty;
mod relay;

use anyhow::Result;
use clap::Parser;
use tracing::{error, info};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::config::{Args, Config};
use crate::protocol::HandshakeMessage;
use crate::pty::{AsyncPty, PtyHandle, DEFAULT_COLS, DEFAULT_ROWS};

fn setup_logging(verbose: bool) {
    let filter = if verbose {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug"))
    } else {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
    };

    tracing_subscriber::registry()
        .with(fmt::layer().with_target(true))
        .with(filter)
        .init();
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let config = Config::from_args(args)?;

    setup_logging(config.verbose);

    info!(
        relay_url = %config.relay_url,
        shell = %config.shell,
        "starting paircoded"
    );

    // Spawn the PTY
    let (shell, shell_args) = config.spawn_command();
    let pty_handle = PtyHandle::spawn(shell, &shell_args)?;
    let pty = AsyncPty::new(pty_handle)?;

    // Build handshake message
    let handshake = HandshakeMessage {
        version: env!("CARGO_PKG_VERSION").to_string(),
        shell: config.shell.clone(),
        cols: Some(DEFAULT_COLS),
        rows: Some(DEFAULT_ROWS),
    };

    // Handle graceful shutdown
    let shutdown = tokio::signal::ctrl_c();

    tokio::select! {
        result = bridge::run_bridge_loop(
            pty,
            &config.relay_url,
            handshake,
            config.reconnect,
            config.max_reconnects,
        ) => {
            match result {
                Ok(exit_code) => {
                    info!(exit_code, "exiting");
                    std::process::exit(exit_code);
                }
                Err(e) => {
                    error!(error = %e, "fatal error");
                    std::process::exit(1);
                }
            }
        }

        _ = shutdown => {
            info!("received shutdown signal");
            std::process::exit(0);
        }
    }
}
