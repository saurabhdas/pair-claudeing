//! Terminal manager for handling multiple named terminals.
//!
//! Manages the lifecycle of terminals including spawning PTYs,
//! connecting to data websockets, and running bridges.

use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, RwLock, oneshot};
use tracing::{error, info, warn};
use url::Url;

use crate::bridge::Bridge;
use crate::protocol::HandshakeMessage;
use crate::pty::{AsyncPty, PtyHandle};
use crate::relay::RelayConnection;

/// Shared JWT token that can be updated when refreshed
pub type SharedToken = Arc<RwLock<String>>;

/// Event from a terminal to the manager
#[derive(Debug)]
pub enum TerminalEvent {
    /// Terminal PTY process exited
    Exited { name: String, exit_code: i32 },
    /// Terminal data connection lost (PTY may still be alive)
    Disconnected { name: String },
}

/// Active terminal instance
struct Terminal {
    /// Name of the terminal
    #[allow(dead_code)]
    name: String,
    /// Handle to send shutdown signal
    shutdown_tx: Option<oneshot::Sender<()>>,
    /// Handle to wait for task completion
    join_handle: tokio::task::JoinHandle<()>,
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
    /// Working directory for spawned terminals
    working_dir: PathBuf,
    /// Shared JWT token for authentication
    shared_token: SharedToken,
    /// Whether to sandbox terminals with bubblewrap (Linux only)
    sandboxed: bool,
}

impl TerminalManager {
    /// Create a new terminal manager
    pub fn new(
        base_url: Url,
        shell: String,
        shell_args: Vec<String>,
        working_dir: PathBuf,
        shared_token: SharedToken,
        sandboxed: bool,
    ) -> (Self, mpsc::Receiver<TerminalEvent>) {
        let (event_tx, event_rx) = mpsc::channel(64);

        (
            TerminalManager {
                terminals: Arc::new(Mutex::new(HashMap::new())),
                event_tx,
                base_url,
                shell,
                shell_args,
                working_dir,
                shared_token,
                sandboxed,
            },
            event_rx,
        )
    }

    /// Start a new terminal with the given dimensions.
    /// Returns the terminal name (which is the PID of the spawned process).
    pub async fn start_terminal(
        &self,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        // Spawn the PTY first to get the PID
        let shell_args: Vec<&str> = self.shell_args.iter().map(|s| s.as_str()).collect();
        let pty_handle = PtyHandle::spawn(&self.shell, &shell_args, &self.working_dir, self.sandboxed)
            .context("failed to spawn PTY")?;

        // Use the PID as the terminal name
        let pid = pty_handle.process_id()
            .ok_or_else(|| anyhow!("failed to get process ID from PTY"))?;
        let name = pid.to_string();

        let mut terminals = self.terminals.lock().await;

        // Check if terminal already exists (shouldn't happen with PIDs, but just in case)
        if terminals.contains_key(&name) {
            return Err(anyhow!("terminal '{}' already exists", name));
        }

        // Build data websocket URL
        let session_id = self.base_url
            .path_segments()
            .and_then(|s| s.last())
            .unwrap_or("unknown");

        let data_url = self.build_data_url(session_id, &name)?;

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

        // Spawn terminal task
        let event_tx = self.event_tx.clone();
        let terminal_name = name.clone();
        let shared_token = self.shared_token.clone();

        let join_handle = tokio::spawn(async move {
            let result = run_terminal_task(
                terminal_name.clone(),
                pty,
                data_url,
                handshake,
                shutdown_rx,
                cols,
                rows,
                shared_token,
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

        // Store terminal
        terminals.insert(
            name.clone(),
            Terminal {
                name: name.clone(),
                shutdown_tx: Some(shutdown_tx),
                join_handle,
            },
        );

        info!(pid, "New terminal opened (PID {})", pid);
        Ok(name)
    }

    /// Close a terminal by name
    pub async fn close_terminal(&self, name: &str, signal: Option<i32>) -> Result<()> {
        let mut terminals = self.terminals.lock().await;

        if let Some(mut terminal) = terminals.remove(name) {
            // Send shutdown signal (the receiver may be dropped if already exited)
            if let Some(tx) = terminal.shutdown_tx.take() {
                let _ = tx.send(());
            }
            info!(name = %name, signal = ?signal, "closing terminal");
            Ok(())
        } else {
            Err(anyhow!("terminal '{}' not found", name))
        }
    }

    /// Gracefully shutdown all terminals, waiting for them to close
    pub async fn shutdown_all(&self) {
        let mut terminals = self.terminals.lock().await;

        // Send shutdown signal to all terminals
        for (name, terminal) in terminals.iter_mut() {
            if let Some(tx) = terminal.shutdown_tx.take() {
                info!(name = %name, "sending shutdown signal to terminal");
                let _ = tx.send(());
            }
        }

        // Collect all join handles
        let handles: Vec<_> = terminals.drain().map(|(_, t)| t.join_handle).collect();
        drop(terminals); // Release the lock before awaiting

        // Wait for all tasks to complete (with timeout)
        for handle in handles {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                handle,
            ).await;
        }

        info!("all terminals shut down");
    }

    /// Remove a terminal from tracking (called after exit event)
    pub async fn remove_terminal(&self, name: &str) {
        let mut terminals = self.terminals.lock().await;
        terminals.remove(name);
    }

    /// Build the data websocket URL for a terminal
    fn build_data_url(&self, session_id: &str, terminal_name: &str) -> Result<Url> {
        // Start from base URL and replace path
        let mut url = self.base_url.clone();
        url.set_path(&format!("/ws/terminal-data/{}/{}", session_id, terminal_name));
        Ok(url)
    }
}

/// Run a terminal's bridge loop with reconnection support
async fn run_terminal_task(
    name: String,
    pty: AsyncPty,
    data_url: Url,
    handshake: HandshakeMessage,
    mut shutdown_rx: oneshot::Receiver<()>,
    cols: u16,
    rows: u16,
    shared_token: SharedToken,
) -> Result<i32> {
    let mut bridge = Bridge::new(pty, cols, rows).await?;
    let mut reconnect_delay = Duration::from_secs(1);
    let max_reconnect_delay = Duration::from_secs(30);

    loop {
        // Get the current token for this connection attempt
        let token = shared_token.read().await.clone();

        // Connect to data websocket
        info!(terminal = %name, url = %data_url, "connecting to data websocket");

        match RelayConnection::connect(&data_url, handshake.clone(), Some(&token)).await {
            Ok(conn) => {
                reconnect_delay = Duration::from_secs(1); // Reset on successful connection
                let (tx, rx) = conn.into_receiver();

                // Run bridge with shutdown signal
                tokio::select! {
                    result = bridge.run(tx, rx) => {
                        match result {
                            Ok(Some(exit_code)) => {
                                info!(terminal = %name, exit_code, "terminal PTY exited");
                                return Ok(exit_code);
                            }
                            Ok(None) => {
                                // Data connection lost, but PTY may still be alive
                                warn!(terminal = %name, "data connection lost, attempting reconnect");
                            }
                            Err(e) => {
                                error!(terminal = %name, error = %e, "terminal bridge error");
                                // Try to reconnect
                                warn!(terminal = %name, "will attempt reconnect after error");
                            }
                        }
                    }

                    _ = &mut shutdown_rx => {
                        info!(terminal = %name, "terminal shutdown requested");
                        return Ok(0);
                    }
                }
            }
            Err(e) => {
                error!(terminal = %name, error = %e, "failed to connect to data websocket");
            }
        }

        // Check if PTY is still alive before reconnecting
        if !bridge.is_pty_alive().await {
            info!(terminal = %name, "PTY process has exited, not reconnecting");
            return Ok(1);
        }

        // Wait before reconnecting
        info!(terminal = %name, delay_ms = reconnect_delay.as_millis(), "waiting before reconnect");

        tokio::select! {
            _ = tokio::time::sleep(reconnect_delay) => {
                // Increase delay for next attempt (exponential backoff)
                reconnect_delay = std::cmp::min(reconnect_delay * 2, max_reconnect_delay);
            }
            _ = &mut shutdown_rx => {
                info!(terminal = %name, "terminal shutdown requested during reconnect wait");
                return Ok(0);
            }
        }
    }
}
