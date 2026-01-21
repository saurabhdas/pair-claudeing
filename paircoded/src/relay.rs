//! WebSocket client for connecting to the relay service.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{debug, error, info, warn};
use url::Url;

use crate::protocol::{ClientMessage, HandshakeMessage, RelayMessage};

/// Relay connection state
pub struct RelayConnection {
    /// Channel to send messages to the relay
    tx: mpsc::Sender<ClientMessage>,
    /// Channel to receive messages from the relay
    rx: mpsc::Receiver<RelayMessage>,
}

impl RelayConnection {
    /// Connect to the relay service
    pub async fn connect(url: &Url, handshake: HandshakeMessage) -> Result<Self> {
        info!(url = %url, "connecting to relay");

        let (ws_stream, response) = connect_async(url.as_str())
            .await
            .context("failed to connect to relay")?;

        info!(status = %response.status(), "connected to relay");
        debug!(headers = ?response.headers(), "relay response headers");

        let (mut ws_sink, mut ws_stream) = ws_stream.split();

        // Channels for communication
        let (tx_to_relay, mut rx_from_bridge) = mpsc::channel::<ClientMessage>(64);
        let (tx_to_bridge, rx_from_relay) = mpsc::channel::<RelayMessage>(64);

        // Send handshake
        let handshake_msg = ClientMessage::Handshake(handshake);
        let encoded = handshake_msg.encode()?;
        ws_sink
            .send(Message::Binary(encoded))
            .await
            .context("failed to send handshake")?;
        info!("sent handshake to relay");

        // Spawn task to forward messages from bridge to relay
        tokio::spawn(async move {
            while let Some(msg) = rx_from_bridge.recv().await {
                match msg.encode() {
                    Ok(encoded) => {
                        if let Err(e) = ws_sink.send(Message::Binary(encoded)).await {
                            error!(error = %e, "failed to send to relay");
                            break;
                        }
                    }
                    Err(e) => {
                        error!(error = %e, "failed to encode message");
                    }
                }
            }
            debug!("relay send task finished");
        });

        // Spawn task to forward messages from relay to bridge
        tokio::spawn(async move {
            while let Some(result) = ws_stream.next().await {
                match result {
                    Ok(Message::Binary(data)) => {
                        match RelayMessage::parse(&data) {
                            Ok(msg) => {
                                if tx_to_bridge.send(msg).await.is_err() {
                                    debug!("bridge receiver dropped");
                                    break;
                                }
                            }
                            Err(e) => {
                                warn!(error = %e, "failed to parse relay message");
                            }
                        }
                    }
                    Ok(Message::Text(text)) => {
                        // Try to parse text as binary (some relays might send text)
                        match RelayMessage::parse(text.as_bytes()) {
                            Ok(msg) => {
                                if tx_to_bridge.send(msg).await.is_err() {
                                    debug!("bridge receiver dropped");
                                    break;
                                }
                            }
                            Err(e) => {
                                warn!(error = %e, "failed to parse relay text message");
                            }
                        }
                    }
                    Ok(Message::Ping(data)) => {
                        debug!("received ping from relay");
                        // Pong is handled automatically by tungstenite
                        let _ = data;
                    }
                    Ok(Message::Pong(_)) => {
                        debug!("received pong from relay");
                    }
                    Ok(Message::Close(frame)) => {
                        info!(frame = ?frame, "relay closed connection");
                        break;
                    }
                    Ok(Message::Frame(_)) => {
                        // Raw frame, ignore
                    }
                    Err(e) => {
                        error!(error = %e, "websocket error");
                        break;
                    }
                }
            }
            debug!("relay receive task finished");
        });

        Ok(RelayConnection {
            tx: tx_to_relay,
            rx: rx_from_relay,
        })
    }

    /// Send a message to the relay
    #[allow(dead_code)]
    pub async fn send(&self, msg: ClientMessage) -> Result<()> {
        self.tx
            .send(msg)
            .await
            .map_err(|_| anyhow::anyhow!("relay connection closed"))
    }

    /// Receive a message from the relay
    #[allow(dead_code)]
    pub async fn recv(&mut self) -> Option<RelayMessage> {
        self.rx.recv().await
    }

    /// Get the receiver for consuming messages
    pub fn into_receiver(self) -> (mpsc::Sender<ClientMessage>, mpsc::Receiver<RelayMessage>) {
        (self.tx, self.rx)
    }
}

/// Reconnection manager with exponential backoff
pub struct ReconnectManager {
    base_delay_ms: u64,
    max_delay_ms: u64,
    max_attempts: u32,
    current_attempt: u32,
}

impl ReconnectManager {
    pub fn new(max_attempts: u32) -> Self {
        ReconnectManager {
            base_delay_ms: 1000,
            max_delay_ms: 60000, // 1 minute max
            max_attempts,
            current_attempt: 0,
        }
    }

    /// Get the next reconnection delay, or None if max attempts reached
    pub fn next_delay(&mut self) -> Option<std::time::Duration> {
        if self.max_attempts > 0 && self.current_attempt >= self.max_attempts {
            return None;
        }

        let delay = std::cmp::min(
            self.base_delay_ms * 2u64.pow(self.current_attempt),
            self.max_delay_ms,
        );

        self.current_attempt += 1;
        Some(std::time::Duration::from_millis(delay))
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
