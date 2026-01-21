/**
 * Type definitions for session management.
 */

import type { WebSocket } from 'ws';
import type { HandshakeMessage } from '../protocol/index.js';

// HandshakeMessage is used by Terminal interface
// SessionOwner is used for tracking who owns a session

export enum SessionState {
  PENDING = 'PENDING',     // Created, waiting for paircoded control connection
  READY = 'READY',         // paircoded control connected, can accept terminal requests
  ACTIVE = 'ACTIVE',       // Has at least one active terminal
  CLOSING = 'CLOSING',     // Closing in progress
  CLOSED = 'CLOSED',       // Session ended
}

/**
 * State for tracking a browser client's snapshot/buffering status.
 */
export interface ClientState {
  ws: WebSocket;
  needsSnapshot: boolean;
  pendingSnapshotId: string | null;
  bufferedOutput: Buffer[];
}

/**
 * Represents a single terminal instance within a session.
 */
export interface Terminal {
  name: string;
  dataWs: WebSocket | null;
  cols: number;
  rows: number;
  interactiveClients: Map<WebSocket, ClientState>;
  mirrorClients: Map<WebSocket, ClientState>;
  handshake: HandshakeMessage | null;
}

/**
 * Pending terminal request waiting for paircoded to start the terminal.
 */
export interface PendingTerminalRequest {
  name: string;
  cols: number;
  rows: number;
  requestId: string;
  browserWs: WebSocket;
  createdAt: number;
}

/**
 * Session owner information from JWT.
 */
export interface SessionOwner {
  userId: string;     // GitHub user ID
  username: string;   // GitHub username
}

export interface SessionData {
  id: string;
  state: SessionState;
  createdAt: Date;

  // Session owner (from JWT when control connection established)
  owner: SessionOwner | null;

  // Control connection from paircoded
  controlWs: WebSocket | null;
  controlHandshake: ControlHandshakeInfo | null;

  // Named terminals
  terminals: Map<string, Terminal>;
  pendingTerminalRequests: Map<string, PendingTerminalRequest>;

  // Default terminal dimensions
  cols: number;
  rows: number;

  // Reconnection handling
  reconnectTimer: NodeJS.Timeout | null;
}

export interface TerminalInfo {
  name: string;
  cols: number;
  rows: number;
  interactiveCount: number;
  mirrorCount: number;
  hasDataConnection: boolean;
}

export interface ControlHandshakeInfo {
  version: string;
  hostname?: string;
  username?: string;
  workingDir?: string;
}

export interface SessionInfo {
  id: string;
  state: SessionState;
  createdAt: string;
  owner: SessionOwner | null;
  controlHandshake: ControlHandshakeInfo | null;
  cols: number;
  rows: number;
  terminals: TerminalInfo[];
}
