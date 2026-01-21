/**
 * Protocol constants and message types for relay communication.
 *
 * Follows a ttyd-inspired binary protocol:
 *
 * **Relay → paircoded:**
 * - `'0'` + data → Input to PTY (keystrokes)
 * - `'1'` + JSON → Resize terminal `{"cols": N, "rows": N}`
 * - `'2'` → Pause PTY output
 * - `'3'` → Resume PTY output
 * - `'4'` + JSON → Request snapshot `{"requestId": "..."}`
 *
 * **paircoded → Relay:**
 * - `'0'` + data → PTY output
 * - `'1'` + JSON → Initial handshake / metadata
 * - `'2'` + exit code → PTY exited
 * - `'3'` + JSON → Snapshot response `{"requestId": "...", "screen": "...", ...}`
 */

// Message type prefixes for relay → client (paircoded) messages
export const RELAY_PREFIX = {
  INPUT: 0x30,   // '0'
  RESIZE: 0x31,  // '1'
  PAUSE: 0x32,   // '2'
  RESUME: 0x33,  // '3'
  REQUEST_SNAPSHOT: 0x34, // '4'
} as const;

// Message type prefixes for client (paircoded) → relay messages
export const CLIENT_PREFIX = {
  OUTPUT: 0x30,    // '0'
  HANDSHAKE: 0x31, // '1'
  EXIT: 0x32,      // '2'
  SNAPSHOT: 0x33,  // '3'
} as const;

export interface ResizeMessage {
  cols: number;
  rows: number;
}

export interface HandshakeMessage {
  version: string;
  shell: string;
  cols?: number;
  rows?: number;
}

export type ClientMessageType = 'output' | 'handshake' | 'exit' | 'snapshot';

export interface ParsedOutputMessage {
  type: 'output';
  data: Buffer;
}

export interface ParsedHandshakeMessage {
  type: 'handshake';
  data: HandshakeMessage;
}

export interface ParsedExitMessage {
  type: 'exit';
  code: number;
}

export interface ParsedSnapshotMessage {
  type: 'snapshot';
  requestId: string;
  screen: Buffer;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
}

export type ParsedClientMessage = ParsedOutputMessage | ParsedHandshakeMessage | ParsedExitMessage | ParsedSnapshotMessage;

// ============================================================================
// Control Protocol Types (JSON over control websocket)
// ============================================================================

/**
 * Control messages sent to paircoded on the control connection.
 */
export interface StartTerminalMessage {
  type: 'start_terminal';
  name: string;
  cols: number;
  rows: number;
  requestId: string;
}

export interface CloseTerminalMessage {
  type: 'close_terminal';
  name: string;
  signal?: number;
}

export type ControlMessage = StartTerminalMessage | CloseTerminalMessage;

/**
 * Control responses received from paircoded on the control connection.
 */
export interface ControlHandshakeResponse {
  type: 'control_handshake';
  version: string;
}

export interface TerminalStartedResponse {
  type: 'terminal_started';
  name: string;
  requestId: string;
  success: boolean;
  error?: string;
}

export interface TerminalClosedResponse {
  type: 'terminal_closed';
  name: string;
  exitCode: number;
}

export type ControlResponse = ControlHandshakeResponse | TerminalStartedResponse | TerminalClosedResponse;

/**
 * Browser setup messages (browser -> relay).
 */
export interface BrowserSetupMessage {
  type: 'setup';
  action: 'new' | 'mirror';
  name: string;
  cols?: number;
  rows?: number;
}

/**
 * Setup response sent to browser after setup is processed.
 */
export interface SetupResponse {
  type: 'setup_response';
  success: boolean;
  name: string;
  cols: number;
  rows: number;
  error?: string;
}

export * from './messages.js';
