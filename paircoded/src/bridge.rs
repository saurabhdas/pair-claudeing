//! Bridge that connects PTY ↔ WebSocket relay.
//!
//! Handles bidirectional communication between the local PTY and the remote relay,
//! including input/output forwarding, resize events, and flow control.

use anyhow::Result;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::protocol::{ClientMessage, HandshakeMessage, RelayMessage};
use crate::pty::AsyncPty;
use crate::relay::RelayConnection;

/// Bridge connecting PTY to relay
pub struct Bridge {
    pty: AsyncPty,
    pty_rx: mpsc::Receiver<Vec<u8>>,
    paused: bool,
}

impl Bridge {
    /// Create a new bridge with the given PTY
    ///
    /// Starts the PTY reader immediately.
    pub async fn new(pty: AsyncPty) -> Result<Self> {
        let pty_rx = pty.start_reader().await?;
        Ok(Bridge {
            pty,
            pty_rx,
            paused: false,
        })
    }

    /// Run the bridge with the given relay connection
    ///
    /// This method handles:
    /// - Forwarding PTY output to relay
    /// - Forwarding relay input to PTY
    /// - Handling resize events
    /// - Flow control (pause/resume)
    ///
    /// Returns:
    /// - Ok(Some(code)) if the PTY process exited
    /// - Ok(None) if the relay disconnected (PTY still alive)
    /// - Err if a fatal error occurred
    pub async fn run(
        &mut self,
        relay_tx: mpsc::Sender<ClientMessage>,
        mut relay_rx: mpsc::Receiver<RelayMessage>,
    ) -> Result<Option<i32>> {
        // Buffer for paused output
        let mut output_buffer: Vec<Vec<u8>> = Vec::new();

        loop {
            tokio::select! {
                // Handle PTY output
                pty_result = self.pty_rx.recv() => {
                    match pty_result {
                        Some(data) => {
                            if self.paused {
                                // Buffer output while paused
                                output_buffer.push(data);
                                debug!(buffered = output_buffer.len(), "buffering PTY output (paused)");
                            } else {
                                // Send output to relay
                                let msg = ClientMessage::Output(data);
                                if relay_tx.send(msg).await.is_err() {
                                    warn!("relay connection lost");
                                    return Ok(None);
                                }
                            }
                        }
                        None => {
                            // PTY reader closed - process likely exited
                            info!("PTY channel closed");
                            break;
                        }
                    }
                }

                // Handle relay messages
                relay_result = relay_rx.recv() => {
                    match relay_result {
                        Some(msg) => {
                            match msg {
                                RelayMessage::Input(data) => {
                                    // Forward input to PTY
                                    if let Err(e) = self.pty.write(&data).await {
                                        error!(error = %e, "failed to write to PTY");
                                    }
                                }

                                RelayMessage::Resize(size) => {
                                    info!(cols = size.cols, rows = size.rows, "resize requested");
                                    if let Err(e) = self.pty.resize(size.cols, size.rows).await {
                                        error!(error = %e, "failed to resize PTY");
                                    }
                                }

                                RelayMessage::Pause => {
                                    info!("pausing PTY output");
                                    self.paused = true;
                                }

                                RelayMessage::Resume => {
                                    info!("resuming PTY output");
                                    self.paused = false;

                                    // Flush buffered output
                                    for data in output_buffer.drain(..) {
                                        let msg = ClientMessage::Output(data);
                                        if relay_tx.send(msg).await.is_err() {
                                            warn!("relay connection lost while flushing buffer");
                                            return Ok(None);
                                        }
                                    }
                                }
                            }
                        }
                        None => {
                            // Relay connection closed - need to reconnect
                            warn!("relay channel closed, will reconnect");
                            return Ok(None);
                        }
                    }
                }
            }

            // Check if PTY process has exited
            match self.pty.try_wait().await {
                Ok(Some(status)) => {
                    let code = if status.success() { 0 } else { 1 };
                    info!(exit_code = code, "PTY process exited");

                    // Notify relay
                    let _ = relay_tx.send(ClientMessage::Exit(code)).await;
                    return Ok(Some(code));
                }
                Ok(None) => {
                    // Still running
                }
                Err(e) => {
                    error!(error = %e, "failed to check PTY status");
                }
            }
        }

        Ok(None)
    }
}

/// Run the full bridge lifecycle with reconnection support
pub async fn run_bridge_loop(
    pty: AsyncPty,
    relay_url: &url::Url,
    handshake: HandshakeMessage,
    reconnect: bool,
    max_reconnects: u32,
) -> Result<i32> {
    use crate::relay::ReconnectManager;

    let mut bridge = Bridge::new(pty).await?;
    let mut reconnect_mgr = ReconnectManager::new(max_reconnects);

    loop {
        // Connect to relay
        match RelayConnection::connect(relay_url, handshake.clone()).await {
            Ok(conn) => {
                reconnect_mgr.reset();
                let (tx, rx) = conn.into_receiver();

                // Run bridge until disconnection or PTY exit
                match bridge.run(tx, rx).await {
                    Ok(Some(exit_code)) => {
                        // PTY exited
                        return Ok(exit_code);
                    }
                    Ok(None) => {
                        // Relay disconnected
                        if !reconnect {
                            warn!("relay disconnected, not reconnecting");
                            return Ok(1);
                        }
                        warn!("relay disconnected, will reconnect");
                    }
                    Err(e) => {
                        error!(error = %e, "bridge error");
                        if !reconnect {
                            return Err(e);
                        }
                    }
                }
            }
            Err(e) => {
                error!(error = %e, "failed to connect to relay");
                if !reconnect {
                    return Err(e);
                }
            }
        }

        // Wait before reconnecting
        if let Some(delay) = reconnect_mgr.next_delay() {
            info!(
                delay_ms = delay.as_millis(),
                attempt = reconnect_mgr.attempts(),
                "waiting before reconnect"
            );
            tokio::time::sleep(delay).await;
        } else {
            error!("max reconnection attempts reached");
            return Ok(1);
        }
    }
}
