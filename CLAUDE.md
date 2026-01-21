# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **paircoded** system - a terminal sharing solution with two components:
- **paircoded** (Rust CLI): Hosts a local terminal and connects to a relay
- **relay-service** (TypeScript/Node.js): WebSocket relay that bridges paircoded clients to browsers

## Build & Run Commands

### Rust CLI (paircoded/)
```bash
cargo build                    # Build
cargo run -- <relay-url>       # Run with relay URL
cargo test                     # Run tests
cargo check                    # Fast type checking
```

### Relay Service (relay-service/)
```bash
pnpm install                   # Install dependencies
pnpm dev                       # Development mode with hot reload
pnpm build                     # Compile TypeScript
pnpm start                     # Run compiled version
pnpm test                      # Run tests
pnpm test:watch                # Watch mode tests
pnpm lint                      # Run ESLint
```

## Architecture

### Control-Connection Flow

```
1. paircoded connects → ws://.../ws/control/:sessionId (control only, no PTY)
2. Browser connects   → ws://.../ws/terminal/:sessionId
3. Browser sends setup: {type:'setup', action:'new', name:'main', cols, rows}
4. Relay requests terminal: start_terminal → paircoded via control
5. paircoded spawns PTY, connects → ws://.../ws/terminal-data/:sessionId/:name
6. Terminal data flows bidirectionally through the data connection
```

For mirroring:
```
Browser sends: {type:'setup', action:'mirror', name:'main'}
Relay adds browser to mirror clients (read-only, no input)
```

### Protocol

**Binary Protocol** (terminal data - prefix byte + payload):
- `0x30`: INPUT (keystrokes) / OUTPUT (terminal data)
- `0x31`: RESIZE / HANDSHAKE
- `0x32`: PAUSE / EXIT
- `0x33`: RESUME

**JSON Protocol** (control connection):
- `start_terminal`, `close_terminal` → paircoded
- `control_handshake`, `terminal_started`, `terminal_closed` ← paircoded

**Browser Setup Protocol**:
- `{type:'setup', action:'new'|'mirror', name:string}` → relay
- `{type:'setup_response', success:boolean, ...}` ← relay

### Key Components

**paircoded (Rust)**
- `main.rs`: Control-first startup, no PTY until browser requests
- `control.rs`: WebSocket control connection handler
- `terminal_manager.rs`: Manages multiple named terminals
- `bridge.rs`: Bidirectional PTY ↔ WebSocket relay
- `protocol.rs`: Message encoding/decoding

**relay-service (TypeScript)**
- `session/session.ts`: Session state machine (PENDING→READY→ACTIVE→CLOSED)
- `websocket/control-handler.ts`: Paircoded control connections
- `websocket/terminal-data-handler.ts`: Per-terminal binary data routing
- `websocket/browser-handler.ts`: Browser clients with setup message handling
- `protocol/`: Message types and parsing

### WebSocket Endpoints

- `ws://.../ws/control/:sessionId` - Paircoded control connection
- `ws://.../ws/terminal-data/:sessionId/:terminalName` - Paircoded terminal data
- `ws://.../ws/terminal/:sessionId` - Browser connections

### Session Lifecycle

1. **PENDING**: Session created, waiting for paircoded control connection
2. **READY**: Control connection established, can accept browser requests
3. **ACTIVE**: Has active terminals
4. **CLOSED**: Session ended

### Interactive vs Mirror Clients

- **Interactive**: Can send input and resize commands
- **Mirror**: Read-only, receives terminal output only
