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
 *
 * **paircoded → Relay:**
 * - `'0'` + data → PTY output
 * - `'1'` + JSON → Initial handshake / metadata
 * - `'2'` + exit code → PTY exited
 */

// Message type prefixes for relay → client (paircoded) messages
export const RELAY_PREFIX = {
  INPUT: 0x30,   // '0'
  RESIZE: 0x31,  // '1'
  PAUSE: 0x32,   // '2'
  RESUME: 0x33,  // '3'
} as const;

// Message type prefixes for client (paircoded) → relay messages
export const CLIENT_PREFIX = {
  OUTPUT: 0x30,    // '0'
  HANDSHAKE: 0x31, // '1'
  EXIT: 0x32,      // '2'
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

export type ClientMessageType = 'output' | 'handshake' | 'exit';

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

export type ParsedClientMessage = ParsedOutputMessage | ParsedHandshakeMessage | ParsedExitMessage;

export * from './messages.js';
