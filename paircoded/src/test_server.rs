//! Test server for paircoded - speaks the relay protocol.
//!
//! Usage: cargo run --bin test-server [PORT]
//!
//! Default port is 8080.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};

/// Message prefixes from client (paircoded)
mod client_prefix {
    pub const OUTPUT: u8 = b'0';
    pub const HANDSHAKE: u8 = b'1';
    pub const EXIT: u8 = b'2';
}

/// Message prefixes to client (from relay/server)
mod server_prefix {
    pub const INPUT: u8 = b'0';
    pub const RESIZE: u8 = b'1';
    #[allow(dead_code)]
    pub const PAUSE: u8 = b'2';
    #[allow(dead_code)]
    pub const RESUME: u8 = b'3';
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HandshakeMessage {
    version: String,
    shell: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Serialize)]
struct ResizeMessage {
    cols: u16,
    rows: u16,
}

fn parse_client_message(data: &[u8]) -> String {
    if data.is_empty() {
        return "Empty message".to_string();
    }

    let prefix = data[0];
    let payload = &data[1..];

    match prefix {
        client_prefix::OUTPUT => {
            let text = String::from_utf8_lossy(payload);
            format!("OUTPUT: {:?}", text)
        }
        client_prefix::HANDSHAKE => {
            match serde_json::from_slice::<HandshakeMessage>(payload) {
                Ok(hs) => format!("HANDSHAKE: {:?}", hs),
                Err(e) => format!("HANDSHAKE (parse error: {}): {:?}", e, payload),
            }
        }
        client_prefix::EXIT => {
            match serde_json::from_slice::<i32>(payload) {
                Ok(code) => format!("EXIT: code={}", code),
                Err(_) => format!("EXIT: {:?}", payload),
            }
        }
        _ => format!("UNKNOWN({}): {:?}", prefix, payload),
    }
}

fn create_resize_message(cols: u16, rows: u16) -> Vec<u8> {
    let resize = ResizeMessage { cols, rows };
    let json = serde_json::to_vec(&resize).unwrap();
    let mut msg = Vec::with_capacity(1 + json.len());
    msg.push(server_prefix::RESIZE);
    msg.extend_from_slice(&json);
    msg
}

fn create_input_message(input: &str) -> Vec<u8> {
    let mut msg = Vec::with_capacity(1 + input.len());
    msg.push(server_prefix::INPUT);
    msg.extend_from_slice(input.as_bytes());
    msg
}

async fn handle_connection(stream: TcpStream, addr: SocketAddr) {
    println!("\n[{}] New connection", addr);

    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[{}] WebSocket handshake failed: {}", addr, e);
            return;
        }
    };

    println!("[{}] WebSocket connection established", addr);

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // Wait for handshake from client
    println!("[{}] Waiting for handshake...", addr);
    if let Some(Ok(msg)) = ws_stream.next().await {
        match msg {
            Message::Binary(data) => {
                println!("[{}] Received: {}", addr, parse_client_message(&data));
            }
            Message::Text(text) => {
                println!("[{}] Received: {}", addr, parse_client_message(text.as_bytes()));
            }
            other => {
                println!("[{}] Received non-data message: {:?}", addr, other);
            }
        }
    }

    // Send resize to 80x20
    println!("[{}] Sending resize to 80x20", addr);
    let resize_msg = create_resize_message(80, 20);
    if let Err(e) = ws_sink.send(Message::Binary(resize_msg)).await {
        eprintln!("[{}] Failed to send resize: {}", addr, e);
        return;
    }

    // Spawn task to read and print output
    let addr_clone = addr;
    let read_task = tokio::spawn(async move {
        while let Some(result) = ws_stream.next().await {
            match result {
                Ok(Message::Binary(data)) => {
                    println!("[{}] Received: {}", addr_clone, parse_client_message(&data));
                }
                Ok(Message::Text(text)) => {
                    println!("[{}] Received: {}", addr_clone, parse_client_message(text.as_bytes()));
                }
                Ok(Message::Close(frame)) => {
                    println!("[{}] Connection closed: {:?}", addr_clone, frame);
                    break;
                }
                Ok(other) => {
                    println!("[{}] Received: {:?}", addr_clone, other);
                }
                Err(e) => {
                    eprintln!("[{}] Read error: {}", addr_clone, e);
                    break;
                }
            }
        }
    });

    // Wait a bit for shell to initialize
    sleep(Duration::from_millis(500)).await;

    // Send "pwd" command
    println!("\n[{}] Sending command: pwd", addr);
    let pwd_msg = create_input_message("pwd\n");
    if let Err(e) = ws_sink.send(Message::Binary(pwd_msg)).await {
        eprintln!("[{}] Failed to send pwd: {}", addr, e);
        return;
    }

    // Wait for output
    sleep(Duration::from_millis(1000)).await;

    // Send "ls" command
    println!("\n[{}] Sending command: ls", addr);
    let ls_msg = create_input_message("ls\n");
    if let Err(e) = ws_sink.send(Message::Binary(ls_msg)).await {
        eprintln!("[{}] Failed to send ls: {}", addr, e);
        return;
    }

    // Wait for output, then send exit
    sleep(Duration::from_millis(1000)).await;

    // Send "exit" to close the shell
    println!("\n[{}] Sending command: exit", addr);
    let exit_msg = create_input_message("exit\n");
    if let Err(e) = ws_sink.send(Message::Binary(exit_msg)).await {
        eprintln!("[{}] Failed to send exit: {}", addr, e);
    }

    // Wait for read task to finish
    let _ = read_task.await;
    println!("[{}] Connection handler finished", addr);
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);

    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind");

    println!("Test server listening on ws://{}", addr);
    println!("Run paircoded with: cargo run --bin paircoded -- ws://{}", addr);
    println!("\nWaiting for connections...\n");

    while let Ok((stream, addr)) = listener.accept().await {
        tokio::spawn(handle_connection(stream, addr));
    }
}
