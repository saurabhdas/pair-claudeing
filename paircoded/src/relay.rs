//! WebSocket client for connecting to the relay service.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async_with_config, tungstenite::{protocol::Message, http::Request}};
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
    /// Connect to the relay service with optional JWT authentication
    pub async fn connect(url: &Url, handshake: HandshakeMessage, token: Option<&str>) -> Result<Self> {
        info!(url = %url, has_token = token.is_some(), "connecting to relay");

        // Build request with optional Authorization header
        let mut request = Request::builder()
            .uri(url.as_str())
            .header("Host", url.host_str().unwrap_or("localhost"))
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key());

        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {}", token));
        }

        let request = request
            .body(())
            .context("failed to build WebSocket request")?;

        let (ws_stream, response) = connect_async_with_config(request, None, false)
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
            // Channel closed - send a graceful close frame
            info!("sending graceful close frame on data connection");
            let close_frame = tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "client shutdown".into(),
            };
            let _ = ws_sink.send(Message::Close(Some(close_frame))).await;
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
