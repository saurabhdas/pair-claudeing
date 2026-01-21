//! Terminal manager for handling multiple named terminals.
//!
//! Manages the lifecycle of terminals including spawning PTYs,
//! connecting to data websockets, and running bridges.

use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, oneshot};
use tracing::{error, info, warn};
use url::Url;

use crate::bridge::Bridge;
use crate::protocol::HandshakeMessage;
use crate::pty::{AsyncPty, PtyHandle};
use crate::relay::RelayConnection;

/// Event from a terminal to the manager
#[derive(Debug)]
pub enum TerminalEvent {
    /// Terminal PTY process exited
    Exited { name: String, exit_code: i32 },
    /// Terminal data connection lost
    Disconnected { name: String },
}

/// Active terminal instance
struct Terminal {
    /// Name of the terminal
    name: String,
    /// Handle to send shutdown signal
    shutdown_tx: oneshot::Sender<()>,
}

/// Manages multiple named terminals
pub struct TerminalManager {
    /// Active terminals by name
    terminals: Arc<Mutex<HashMap<String, Terminal>>>,
    /// Channel to send terminal events to the main loop
    event_tx: mpsc::Sender<TerminalEvent>,
    /// Base URL for terminal data connections
    base_url: Url,
    /// Shell command to spawn
    shell: String,
    /// Shell arguments
    shell_args: Vec<String>,
}

impl TerminalManager {
    /// Create a new terminal manager
    pub fn new(
        base_url: Url,
        shell: String,
        shell_args: Vec<String>,
    ) -> (Self, mpsc::Receiver<TerminalEvent>) {
        let (event_tx, event_rx) = mpsc::channel(64);

        (
            TerminalManager {
                terminals: Arc::new(Mutex::new(HashMap::new())),
                event_tx,
                base_url,
                shell,
                shell_args,
            },
            event_rx,
        )
    }

    /// Start a new terminal with the given name and dimensions
    pub async fn start_terminal(
        &self,
        name: String,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        let mut terminals = self.terminals.lock().await;

        // Check if terminal already exists
        if terminals.contains_key(&name) {
            return Err(anyhow!("terminal '{}' already exists", name));
        }

        // Build data websocket URL
        let session_id = self.base_url
            .path_segments()
            .and_then(|s| s.last())
            .unwrap_or("unknown");

        let data_url = self.build_data_url(session_id, &name)?;

        // Spawn the PTY
        let shell_args: Vec<&str> = self.shell_args.iter().map(|s| s.as_str()).collect();
        let pty_handle = PtyHandle::spawn(&self.shell, &shell_args)
            .context("failed to spawn PTY")?;

        // Resize to requested dimensions
        pty_handle.resize(cols, rows)?;

        let pty = AsyncPty::new(pty_handle)?;

        // Create handshake
        let handshake = HandshakeMessage {
            version: env!("CARGO_PKG_VERSION").to_string(),
            shell: self.shell.clone(),
            cols: Some(cols),
            rows: Some(rows),
        };

        // Create shutdown channel
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        // Store terminal
        terminals.insert(
            name.clone(),
            Terminal {
                name: name.clone(),
                shutdown_tx,
            },
        );

        // Spawn terminal task
        let event_tx = self.event_tx.clone();
        let terminal_name = name.clone();

        tokio::spawn(async move {
            let result = run_terminal_task(
                terminal_name.clone(),
                pty,
                data_url,
                handshake,
                shutdown_rx,
            )
            .await;

            match result {
                Ok(exit_code) => {
                    let _ = event_tx
                        .send(TerminalEvent::Exited {
                            name: terminal_name,
                            exit_code,
                        })
                        .await;
                }
                Err(e) => {
                    error!(terminal = %terminal_name, error = %e, "terminal task error");
                    let _ = event_tx
                        .send(TerminalEvent::Disconnected {
                            name: terminal_name,
                        })
                        .await;
                }
            }
        });

        info!(name = %name, cols, rows, "started terminal");
        Ok(())
    }

    /// Close a terminal by name
    pub async fn close_terminal(&self, name: &str, signal: Option<i32>) -> Result<()> {
        let mut terminals = self.terminals.lock().await;

        if let Some(terminal) = terminals.remove(name) {
            // Send shutdown signal (the receiver may be dropped if already exited)
            let _ = terminal.shutdown_tx.send(());
            info!(name = %name, signal = ?signal, "closing terminal");
            Ok(())
        } else {
            Err(anyhow!("terminal '{}' not found", name))
        }
    }

    /// Remove a terminal from tracking (called after exit event)
    pub async fn remove_terminal(&self, name: &str) {
        let mut terminals = self.terminals.lock().await;
        terminals.remove(name);
    }

    /// Check if a terminal exists
    pub async fn has_terminal(&self, name: &str) -> bool {
        let terminals = self.terminals.lock().await;
        terminals.contains_key(name)
    }

    /// Get the number of active terminals
    pub async fn terminal_count(&self) -> usize {
        let terminals = self.terminals.lock().await;
        terminals.len()
    }

    /// Build the data websocket URL for a terminal
    fn build_data_url(&self, session_id: &str, terminal_name: &str) -> Result<Url> {
        // Start from base URL and replace path
        let mut url = self.base_url.clone();
        url.set_path(&format!("/ws/terminal-data/{}/{}", session_id, terminal_name));
        Ok(url)
    }
}

/// Run a terminal's bridge loop
async fn run_terminal_task(
    name: String,
    pty: AsyncPty,
    data_url: Url,
    handshake: HandshakeMessage,
    mut shutdown_rx: oneshot::Receiver<()>,
) -> Result<i32> {
    let mut bridge = Bridge::new(pty).await?;

    // Connect to data websocket
    let conn = RelayConnection::connect(&data_url, handshake).await?;
    let (tx, rx) = conn.into_receiver();

    // Run bridge with shutdown signal
    tokio::select! {
        result = bridge.run(tx, rx) => {
            match result {
                Ok(Some(exit_code)) => {
                    info!(terminal = %name, exit_code, "terminal PTY exited");
                    Ok(exit_code)
                }
                Ok(None) => {
                    warn!(terminal = %name, "terminal data connection lost");
                    Ok(1)
                }
                Err(e) => {
                    error!(terminal = %name, error = %e, "terminal bridge error");
                    Err(e)
                }
            }
        }

        _ = &mut shutdown_rx => {
            info!(terminal = %name, "terminal shutdown requested");
            Ok(0)
        }
    }
}
