//! Control connection handler for managing terminal lifecycle.
//!
//! The control connection is a JSON-based websocket that receives commands
//! from the relay to start/stop terminals.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async_with_config, tungstenite::{protocol::Message, http::Request}};
use tracing::{debug, error, info, warn};
use url::Url;

use crate::protocol::{ControlMessage, ControlResponse};

/// Events sent from the control connection to the main loop
#[derive(Debug)]
pub enum ControlEvent {
    /// Request to start a new terminal
    StartTerminal {
        #[allow(dead_code)] // Name is sent by relay but we use PID as terminal name now
        name: String,
        cols: u16,
        rows: u16,
        request_id: String,
    },
    /// Request to close a terminal
    CloseTerminal {
        name: String,
        signal: Option<i32>,
    },
    /// Control connection closed
    Disconnected {
        /// WebSocket close code if available
        close_code: Option<u16>,
        /// Whether this was a clean close (close frame received)
        clean: bool,
    },
}

/// Commands sent to the control connection
#[derive(Debug)]
pub enum ControlCommand {
    /// Send a terminal_started response
    TerminalStarted {
        name: String,
        request_id: String,
        success: bool,
        error: Option<String>,
    },
    /// Send a terminal_closed notification
    TerminalClosed {
        name: String,
        exit_code: i32,
    },
    /// Gracefully close the connection
    Shutdown,
}

/// Handle to the control connection
pub struct ControlConnection {
    /// Channel to send commands to the control connection
    command_tx: mpsc::Sender<ControlCommand>,
}

/// Handshake info to send to relay on control connection
pub struct HandshakeInfo {
    pub version: String,
    pub hostname: String,
    pub username: String,
    pub working_dir: String,
    pub relay_token: String,
}

impl ControlConnection {
    /// Connect to the relay's control endpoint and start the control loop
    pub async fn connect(
        url: &Url,
        handshake_info: HandshakeInfo,
    ) -> Result<(Self, mpsc::Receiver<ControlEvent>)> {
        info!(url = %url, "connecting to control endpoint");

        // Build request with Authorization header
        let request = Request::builder()
            .uri(url.as_str())
            .header("Authorization", format!("Bearer {}", handshake_info.relay_token))
            .header("Host", url.host_str().unwrap_or("localhost"))
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
            .body(())
            .context("failed to build WebSocket request")?;

        let (ws_stream, response) = connect_async_with_config(request, None, false)
            .await
            .context("failed to connect to control endpoint")?;

        info!(status = %response.status(), "connected to control endpoint");
        debug!(headers = ?response.headers(), "control connection response headers");

        let (mut ws_sink, mut ws_stream) = ws_stream.split();

        // Channels for communication
        let (event_tx, event_rx) = mpsc::channel::<ControlEvent>(64);
        let (command_tx, mut command_rx) = mpsc::channel::<ControlCommand>(64);

        // Send initial handshake
        let handshake = ControlResponse::ControlHandshake {
            version: handshake_info.version,
            hostname: handshake_info.hostname,
            username: handshake_info.username,
            working_dir: handshake_info.working_dir,
        };
        let handshake_json = handshake.encode()?;
        ws_sink
            .send(Message::Text(handshake_json))
            .await
            .context("failed to send control handshake")?;
        info!("Connected to relay");

        // Spawn task to handle control connection
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    // Handle incoming messages from relay
                    msg = ws_stream.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                match ControlMessage::parse_str(&text) {
                                    Ok(control_msg) => {
                                        let event = match control_msg {
                                            ControlMessage::StartTerminal { name, cols, rows, request_id } => {
                                                info!(name = %name, cols, rows, request_id = %request_id, "received start_terminal");
                                                ControlEvent::StartTerminal { name, cols, rows, request_id }
                                            }
                                            ControlMessage::CloseTerminal { name, signal } => {
                                                info!(name = %name, signal = ?signal, "received close_terminal");
                                                ControlEvent::CloseTerminal { name, signal }
                                            }
                                        };
                                        if event_tx.send(event).await.is_err() {
                                            debug!("event receiver dropped");
                                            break;
                                        }
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "failed to parse control message");
                                    }
                                }
                            }
                            Some(Ok(Message::Binary(data))) => {
                                match ControlMessage::parse(&data) {
                                    Ok(control_msg) => {
                                        let event = match control_msg {
                                            ControlMessage::StartTerminal { name, cols, rows, request_id } => {
                                                info!(name = %name, cols, rows, request_id = %request_id, "received start_terminal");
                                                ControlEvent::StartTerminal { name, cols, rows, request_id }
                                            }
                                            ControlMessage::CloseTerminal { name, signal } => {
                                                info!(name = %name, signal = ?signal, "received close_terminal");
                                                ControlEvent::CloseTerminal { name, signal }
                                            }
                                        };
                                        if event_tx.send(event).await.is_err() {
                                            debug!("event receiver dropped");
                                            break;
                                        }
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "failed to parse binary control message");
                                    }
                                }
                            }
                            Some(Ok(Message::Ping(_))) => {
                                debug!("received ping from control connection");
                            }
                            Some(Ok(Message::Pong(_))) => {
                                debug!("received pong from control connection");
                            }
                            Some(Ok(Message::Close(frame))) => {
                                let close_code = frame.as_ref().map(|f| f.code.into());
                                info!(frame = ?frame, "control connection closed by relay");
                                let _ = event_tx.send(ControlEvent::Disconnected {
                                    close_code,
                                    clean: true,
                                }).await;
                                break;
                            }
                            Some(Ok(Message::Frame(_))) => {
                                // Raw frame, ignore
                            }
                            Some(Err(e)) => {
                                error!(error = %e, "control connection error");
                                let _ = event_tx.send(ControlEvent::Disconnected {
                                    close_code: None,
                                    clean: false,
                                }).await;
                                break;
                            }
                            None => {
                                info!("control connection stream ended");
                                let _ = event_tx.send(ControlEvent::Disconnected {
                                    close_code: None,
                                    clean: false,
                                }).await;
                                break;
                            }
                        }
                    }

                    // Handle outgoing commands
                    cmd = command_rx.recv() => {
                        match cmd {
                            Some(ControlCommand::Shutdown) => {
                                info!("sending graceful shutdown close frame");
                                let close_frame = tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                    code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
                                    reason: "client shutdown".into(),
                                };
                                let _ = ws_sink.send(Message::Close(Some(close_frame))).await;
                                break;
                            }
                            Some(command) => {
                                let response = match command {
                                    ControlCommand::TerminalStarted { name, request_id, success, error } => {
                                        ControlResponse::TerminalStarted { name, request_id, success, error }
                                    }
                                    ControlCommand::TerminalClosed { name, exit_code } => {
                                        ControlResponse::TerminalClosed { name, exit_code }
                                    }
                                    ControlCommand::Shutdown => unreachable!(),
                                };
                                match response.encode() {
                                    Ok(json) => {
                                        if let Err(e) = ws_sink.send(Message::Text(json)).await {
                                            error!(error = %e, "failed to send control response");
                                            break;
                                        }
                                    }
                                    Err(e) => {
                                        error!(error = %e, "failed to encode control response");
                                    }
                                }
                            }
                            None => {
                                debug!("command channel closed");
                                break;
                            }
                        }
                    }
                }
            }

            debug!("control connection task finished");
        });

        Ok((
            ControlConnection { command_tx },
            event_rx,
        ))
    }

    /// Send a terminal_started response
    pub async fn terminal_started(
        &self,
        name: String,
        request_id: String,
        success: bool,
        error: Option<String>,
    ) -> Result<()> {
        self.command_tx
            .send(ControlCommand::TerminalStarted {
                name,
                request_id,
                success,
                error,
            })
            .await
            .map_err(|_| anyhow::anyhow!("control connection closed"))
    }

    /// Send a terminal_closed notification
    pub async fn terminal_closed(&self, name: String, exit_code: i32) -> Result<()> {
        self.command_tx
            .send(ControlCommand::TerminalClosed { name, exit_code })
            .await
            .map_err(|_| anyhow::anyhow!("control connection closed"))
    }

    /// Gracefully shutdown the control connection
    pub async fn shutdown(&self) {
        let _ = self.command_tx.send(ControlCommand::Shutdown).await;
    }
}

/// Reconnection manager with exponential backoff
pub struct ReconnectManager {
    base_delay: Duration,
    max_delay: Duration,
    current_attempt: u32,
}

impl ReconnectManager {
    pub fn new() -> Self {
        ReconnectManager {
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            current_attempt: 0,
        }
    }

    /// Get the next reconnection delay
    pub fn next_delay(&mut self) -> Duration {
        let delay = std::cmp::min(
            self.base_delay * 2u32.pow(self.current_attempt),
            self.max_delay,
        );
        self.current_attempt += 1;
        delay
    }

    /// Reset the attempt counter (call after successful connection)
    pub fn reset(&mut self) {
        self.current_attempt = 0;
    }

    /// Get the current attempt number
    pub fn attempts(&self) -> u32 {
        self.current_attempt
    }
}

impl Default for ReconnectManager {
    fn default() -> Self {
        Self::new()
    }
}
