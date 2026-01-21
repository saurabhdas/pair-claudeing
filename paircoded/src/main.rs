//! paircoded - Host a terminal over the internet by connecting to a relay service.
//!
//! Unlike ttyd (which hosts a websocket server for incoming connections), paircoded
//! makes **outgoing** websocket connections to a relay, acting as a bridge between
//! a local PTY and the relay service.
//!
//! ## Architecture
//!
//! 1. Paircoded connects to the relay's control endpoint (no PTY spawned yet)
//! 2. When a browser requests a new terminal, the relay sends `start_terminal`
//! 3. Paircoded spawns a PTY and opens a data websocket for that terminal
//! 4. Multiple terminals can be active simultaneously, each with their own PTY

mod auth;
mod bridge;
mod config;
mod control;
mod protocol;
mod pty;
mod relay;
mod terminal_manager;

use anyhow::Result;
use clap::Parser;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::auth::get_auth;
use crate::config::{Args, Config};
use crate::control::{ControlConnection, ControlEvent, HandshakeInfo, ReconnectManager};
use crate::terminal_manager::{TerminalEvent, TerminalManager};

fn setup_logging(verbose: bool) {
    let filter = if verbose {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug"))
    } else {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"))
    };

    tracing_subscriber::registry()
        .with(fmt::layer().with_target(true))
        .with(filter)
        .init();
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let force_login = args.login;
    let verbose = args.verbose;

    // Set up logging early (but quiet by default)
    setup_logging(verbose);

    // Authenticate with GitHub
    let auth = get_auth(force_login).await?;

    // Create config with username from auth
    let config = Config::from_args(args, &auth.user.login)?;

    // Print user-friendly session info (always visible regardless of log level)
    println!();
    println!("  User:    {} ({})", auth.user.login, config.hostname);
    println!("  Session: {}", config.session_name);
    println!("  Path:    {}", config.working_dir.display());
    println!("  Pair at: {}", config.browser_url);
    println!();

    info!(
        relay_url = %config.relay_url,
        shell = %config.shell,
        working_dir = %config.working_dir.display(),
        "starting paircoded"
    );

    // Get shell command and args
    let (shell, shell_args) = config.spawn_command();
    let shell_args: Vec<String> = shell_args.iter().map(|s| s.to_string()).collect();

    // Create terminal manager with working directory
    let (terminal_manager, mut terminal_event_rx) = TerminalManager::new(
        config.relay_url.clone(),
        shell.to_string(),
        shell_args,
        config.working_dir.clone(),
    );

    // Handle graceful shutdown
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);

    // Reconnection manager for control connection
    let mut reconnect_mgr = ReconnectManager::new();

    // Main loop with reconnection support
    'main: loop {
        // Connect to control endpoint
        let handshake_info = HandshakeInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            hostname: config.hostname.clone(),
            username: config.username.clone(),
            working_dir: config.working_dir.display().to_string(),
        };

        let connect_result = ControlConnection::connect(
            &config.relay_url,
            handshake_info,
        )
        .await;

        let (control_conn, mut control_event_rx) = match connect_result {
            Ok(result) => {
                reconnect_mgr.reset();
                info!("connected to relay control endpoint, waiting for terminal requests");
                result
            }
            Err(e) => {
                error!(error = %e, "failed to connect to control endpoint");

                if !config.reconnect {
                    error!("reconnection disabled, exiting");
                    break 'main;
                }

                let delay = reconnect_mgr.next_delay();
                info!(
                    delay_ms = delay.as_millis(),
                    attempt = reconnect_mgr.attempts(),
                    "waiting before reconnect"
                );

                tokio::select! {
                    _ = tokio::time::sleep(delay) => {
                        continue 'main;
                    }
                    _ = &mut shutdown => {
                        info!("received shutdown signal during reconnect wait");
                        break 'main;
                    }
                }
            }
        };

        // Event loop for current connection
        loop {
            tokio::select! {
                // Handle control events from relay
                event = control_event_rx.recv() => {
                    match event {
                        Some(ControlEvent::StartTerminal { name, cols, rows, request_id }) => {
                            match terminal_manager.start_terminal(name.clone(), cols, rows).await {
                                Ok(()) => {
                                    let _ = control_conn.terminal_started(
                                        name,
                                        request_id,
                                        true,
                                        None,
                                    ).await;
                                }
                                Err(e) => {
                                    error!(error = %e, name = %name, "failed to start terminal");
                                    let _ = control_conn.terminal_started(
                                        name,
                                        request_id,
                                        false,
                                        Some(e.to_string()),
                                    ).await;
                                }
                            }
                        }

                        Some(ControlEvent::CloseTerminal { name, signal }) => {
                            if let Err(e) = terminal_manager.close_terminal(&name, signal).await {
                                warn!(error = %e, name = %name, "failed to close terminal");
                            }
                        }

                        Some(ControlEvent::Disconnected) => {
                            warn!("control connection lost");

                            if !config.reconnect {
                                info!("reconnection disabled, exiting");
                                break 'main;
                            }

                            let delay = reconnect_mgr.next_delay();
                            info!(
                                delay_ms = delay.as_millis(),
                                attempt = reconnect_mgr.attempts(),
                                "control connection lost, reconnecting"
                            );

                            tokio::select! {
                                _ = tokio::time::sleep(delay) => {
                                    continue 'main; // Try to reconnect
                                }
                                _ = &mut shutdown => {
                                    info!("received shutdown signal during reconnect wait");
                                    break 'main;
                                }
                            }
                        }

                        None => {
                            warn!("control event channel closed");
                            if config.reconnect {
                                continue 'main;
                            }
                            break 'main;
                        }
                    }
                }

                // Handle terminal events
                event = terminal_event_rx.recv() => {
                    match event {
                        Some(TerminalEvent::Exited { name, exit_code }) => {
                            info!(name = %name, exit_code, "terminal exited");
                            let _ = control_conn.terminal_closed(name.clone(), exit_code).await;
                            terminal_manager.remove_terminal(&name).await;
                        }

                        Some(TerminalEvent::Disconnected { name }) => {
                            warn!(name = %name, "terminal disconnected (will auto-reconnect)");
                            // Note: Terminal data connection handles its own reconnection
                            // We don't need to do anything here - the terminal task will reconnect
                        }

                        None => {
                            // Terminal event channel closed - shouldn't happen
                            warn!("terminal event channel closed");
                        }
                    }
                }

                // Handle shutdown signal
                _ = &mut shutdown => {
                    info!("received shutdown signal");
                    break 'main;
                }
            }
        }
    }

    info!("paircoded exiting");
    std::process::exit(0);
}
