/**
 * Type definitions for session management.
 */

import type { WebSocket } from 'ws';
import type { HandshakeMessage } from '../protocol/index.js';

export enum SessionState {
  PENDING = 'PENDING',     // Created, waiting for paircoded connection
  READY = 'READY',         // paircoded connected, waiting for browser
  ACTIVE = 'ACTIVE',       // Both paircoded and browser connected
  CLOSING = 'CLOSING',     // Closing in progress
  CLOSED = 'CLOSED',       // Session ended
}

export interface SessionData {
  id: string;
  state: SessionState;
  createdAt: Date;

  // Paircoded connection
  paircodedWs: WebSocket | null;
  handshake: HandshakeMessage | null;

  // Browser connections (can have multiple viewers)
  browserConnections: Set<WebSocket>;

  // Terminal dimensions
  cols: number;
  rows: number;

  // Reconnection handling
  reconnectTimer: NodeJS.Timeout | null;
}

export interface SessionInfo {
  id: string;
  state: SessionState;
  createdAt: string;
  handshake: HandshakeMessage | null;
  browserCount: number;
  cols: number;
  rows: number;
}
