//! Protocol message encoding and decoding for relay communication.
//!
//! ## Terminal Data Protocol (Binary, per-terminal websocket)
//!
//! **Server (Relay) → Client (paircoded):**
//! - `'0'` + data → Input to PTY (keystrokes)
//! - `'1'` + JSON → Resize terminal `{"cols": N, "rows": N}`
//! - `'2'` → Pause PTY output
//! - `'3'` → Resume PTY output
//!
//! **Client (paircoded) → Server (Relay):**
//! - `'0'` + data → PTY output
//! - `'1'` + JSON → Initial handshake / metadata
//! - `'2'` + exit code → PTY exited
//!
//! ## Control Protocol (JSON, control websocket)
//!
//! **Relay → Paircoded:**
//! - `{"type": "start_terminal", "name": "...", "cols": N, "rows": N, "requestId": "..."}`
//! - `{"type": "close_terminal", "name": "...", "signal": N}`
//!
//! **Paircoded → Relay:**
//! - `{"type": "control_handshake", "version": "..."}`
//! - `{"type": "terminal_started", "name": "...", "requestId": "...", "success": bool, "error": "..."}`
//! - `{"type": "terminal_closed", "name": "...", "exitCode": N}`

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

/// Message type prefixes for relay → client messages
pub mod relay_prefix {
    pub const INPUT: u8 = b'0';
    pub const RESIZE: u8 = b'1';
    pub const PAUSE: u8 = b'2';
    pub const RESUME: u8 = b'3';
}

/// Message type prefixes for client → relay messages
pub mod client_prefix {
    pub const OUTPUT: u8 = b'0';
    pub const HANDSHAKE: u8 = b'1';
    pub const EXIT: u8 = b'2';
}

/// Terminal resize dimensions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResizeMessage {
    pub cols: u16,
    pub rows: u16,
}

/// Handshake metadata sent to relay on connection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeMessage {
    pub version: String,
    pub shell: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
}

/// Messages received from the relay
#[derive(Debug)]
pub enum RelayMessage {
    /// Input data to send to PTY
    Input(Vec<u8>),
    /// Resize the terminal
    Resize(ResizeMessage),
    /// Pause PTY output
    Pause,
    /// Resume PTY output
    Resume,
}

/// Messages sent to the relay
#[derive(Debug)]
pub enum ClientMessage {
    /// PTY output data
    Output(Vec<u8>),
    /// Initial handshake
    Handshake(HandshakeMessage),
    /// PTY process exited
    Exit(i32),
}

impl RelayMessage {
    /// Parse a binary message from the relay
    pub fn parse(data: &[u8]) -> Result<Self> {
        if data.is_empty() {
            return Err(anyhow!("empty message"));
        }

        let prefix = data[0];
        let payload = &data[1..];

        match prefix {
            relay_prefix::INPUT => Ok(RelayMessage::Input(payload.to_vec())),
            relay_prefix::RESIZE => {
                let resize: ResizeMessage = serde_json::from_slice(payload)?;
                Ok(RelayMessage::Resize(resize))
            }
            relay_prefix::PAUSE => Ok(RelayMessage::Pause),
            relay_prefix::RESUME => Ok(RelayMessage::Resume),
            _ => Err(anyhow!("unknown message prefix: {}", prefix)),
        }
    }
}

impl ClientMessage {
    /// Encode a message to send to the relay
    pub fn encode(&self) -> Result<Vec<u8>> {
        match self {
            ClientMessage::Output(data) => {
                let mut msg = Vec::with_capacity(1 + data.len());
                msg.push(client_prefix::OUTPUT);
                msg.extend_from_slice(data);
                Ok(msg)
            }
            ClientMessage::Handshake(handshake) => {
                let json = serde_json::to_vec(handshake)?;
                let mut msg = Vec::with_capacity(1 + json.len());
                msg.push(client_prefix::HANDSHAKE);
                msg.extend_from_slice(&json);
                Ok(msg)
            }
            ClientMessage::Exit(code) => {
                let json = serde_json::to_vec(code)?;
                let mut msg = Vec::with_capacity(1 + json.len());
                msg.push(client_prefix::EXIT);
                msg.extend_from_slice(&json);
                Ok(msg)
            }
        }
    }
}

// ============================================================================
// Control Protocol Messages (JSON over control websocket)
// ============================================================================

/// Control messages received from the relay on the control connection
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    /// Request to start a new terminal
    StartTerminal {
        name: String,
        cols: u16,
        rows: u16,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    /// Request to close a terminal
    CloseTerminal {
        name: String,
        #[serde(default)]
        signal: Option<i32>,
    },
}

/// Control responses sent to the relay on the control connection
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponse {
    /// Initial handshake on control connection
    ControlHandshake {
        version: String,
    },
    /// Response to start_terminal request
    TerminalStarted {
        name: String,
        #[serde(rename = "requestId")]
        request_id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Notification that a terminal has closed
    TerminalClosed {
        name: String,
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
}

impl ControlMessage {
    /// Parse a JSON control message from the relay
    pub fn parse(data: &[u8]) -> Result<Self> {
        serde_json::from_slice(data).map_err(|e| anyhow!("failed to parse control message: {}", e))
    }

    /// Parse from a string
    pub fn parse_str(data: &str) -> Result<Self> {
        serde_json::from_str(data).map_err(|e| anyhow!("failed to parse control message: {}", e))
    }
}

impl ControlResponse {
    /// Encode a control response to JSON
    pub fn encode(&self) -> Result<String> {
        serde_json::to_string(self).map_err(|e| anyhow!("failed to encode control response: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_input() {
        let data = b"0hello";
        let msg = RelayMessage::parse(data).unwrap();
        match msg {
            RelayMessage::Input(d) => assert_eq!(d, b"hello"),
            _ => panic!("expected Input"),
        }
    }

    #[test]
    fn test_parse_resize() {
        let data = b"1{\"cols\":80,\"rows\":24}";
        let msg = RelayMessage::parse(data).unwrap();
        match msg {
            RelayMessage::Resize(r) => {
                assert_eq!(r.cols, 80);
                assert_eq!(r.rows, 24);
            }
            _ => panic!("expected Resize"),
        }
    }

    #[test]
    fn test_encode_output() {
        let msg = ClientMessage::Output(b"world".to_vec());
        let encoded = msg.encode().unwrap();
        assert_eq!(encoded[0], b'0');
        assert_eq!(&encoded[1..], b"world");
    }

    #[test]
    fn test_encode_handshake() {
        let msg = ClientMessage::Handshake(HandshakeMessage {
            version: "0.1.0".to_string(),
            shell: "/bin/bash".to_string(),
            cols: Some(80),
            rows: Some(24),
        });
        let encoded = msg.encode().unwrap();
        assert_eq!(encoded[0], b'1');
        let json: serde_json::Value = serde_json::from_slice(&encoded[1..]).unwrap();
        assert_eq!(json["version"], "0.1.0");
    }

    #[test]
    fn test_parse_control_start_terminal() {
        let json = r#"{"type":"start_terminal","name":"main","cols":80,"rows":24,"requestId":"abc123"}"#;
        let msg = ControlMessage::parse_str(json).unwrap();
        match msg {
            ControlMessage::StartTerminal { name, cols, rows, request_id } => {
                assert_eq!(name, "main");
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
                assert_eq!(request_id, "abc123");
            }
            _ => panic!("expected StartTerminal"),
        }
    }

    #[test]
    fn test_parse_control_close_terminal() {
        let json = r#"{"type":"close_terminal","name":"main","signal":15}"#;
        let msg = ControlMessage::parse_str(json).unwrap();
        match msg {
            ControlMessage::CloseTerminal { name, signal } => {
                assert_eq!(name, "main");
                assert_eq!(signal, Some(15));
            }
            _ => panic!("expected CloseTerminal"),
        }
    }

    #[test]
    fn test_encode_control_handshake() {
        let msg = ControlResponse::ControlHandshake {
            version: "1.0".to_string(),
        };
        let encoded = msg.encode().unwrap();
        let json: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(json["type"], "control_handshake");
        assert_eq!(json["version"], "1.0");
    }

    #[test]
    fn test_encode_terminal_started() {
        let msg = ControlResponse::TerminalStarted {
            name: "main".to_string(),
            request_id: "abc123".to_string(),
            success: true,
            error: None,
        };
        let encoded = msg.encode().unwrap();
        let json: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(json["type"], "terminal_started");
        assert_eq!(json["name"], "main");
        assert_eq!(json["requestId"], "abc123");
        assert_eq!(json["success"], true);
        assert!(json.get("error").is_none());
    }

    #[test]
    fn test_encode_terminal_closed() {
        let msg = ControlResponse::TerminalClosed {
            name: "main".to_string(),
            exit_code: 0,
        };
        let encoded = msg.encode().unwrap();
        let json: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(json["type"], "terminal_closed");
        assert_eq!(json["name"], "main");
        assert_eq!(json["exitCode"], 0);
    }
}
