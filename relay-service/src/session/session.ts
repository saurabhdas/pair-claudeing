/**
 * Session class representing a terminal sharing session.
 */

import type { WebSocket } from 'ws';
import type { HandshakeMessage } from '../protocol/index.js';
import { SessionState, type SessionData, type SessionInfo } from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('session');

export class Session implements SessionData {
  public readonly id: string;
  public state: SessionState;
  public readonly createdAt: Date;
  public paircodedWs: WebSocket | null = null;
  public handshake: HandshakeMessage | null = null;
  public browserConnections: Set<WebSocket> = new Set();
  public cols: number;
  public rows: number;
  public reconnectTimer: NodeJS.Timeout | null = null;

  constructor(id: string, defaultCols: number, defaultRows: number) {
    this.id = id;
    this.state = SessionState.PENDING;
    this.createdAt = new Date();
    this.cols = defaultCols;
    this.rows = defaultRows;
  }

  /**
   * Attach paircoded WebSocket connection.
   */
  setPaircodedConnection(ws: WebSocket): void {
    this.paircodedWs = ws;
    this.clearReconnectTimer();
    log.debug({ sessionId: this.id }, 'paircoded connected');
  }

  /**
   * Set handshake data from paircoded and mark session as ready.
   */
  setHandshake(handshake: HandshakeMessage): void {
    this.handshake = handshake;
    // Use terminal dimensions from handshake if provided
    if (handshake.cols) this.cols = handshake.cols;
    if (handshake.rows) this.rows = handshake.rows;

    if (this.state === SessionState.PENDING) {
      this.state = SessionState.READY;
      log.info({ sessionId: this.id, handshake }, 'session ready');
    }
  }

  /**
   * Add a browser connection.
   */
  addBrowserConnection(ws: WebSocket): void {
    this.browserConnections.add(ws);
    if (this.state === SessionState.READY) {
      this.state = SessionState.ACTIVE;
    }
    log.debug({ sessionId: this.id, browserCount: this.browserConnections.size }, 'browser connected');
  }

  /**
   * Remove a browser connection.
   */
  removeBrowserConnection(ws: WebSocket): void {
    this.browserConnections.delete(ws);
    if (this.browserConnections.size === 0 && this.state === SessionState.ACTIVE) {
      this.state = SessionState.READY;
    }
    log.debug({ sessionId: this.id, browserCount: this.browserConnections.size }, 'browser disconnected');
  }

  /**
   * Handle paircoded disconnect with optional reconnection window.
   */
  handlePaircodedDisconnect(reconnectTimeoutMs: number, onTimeout: () => void): void {
    this.paircodedWs = null;

    if (this.state === SessionState.CLOSED || this.state === SessionState.CLOSING) {
      return;
    }

    log.info({ sessionId: this.id, reconnectTimeoutMs }, 'paircoded disconnected, waiting for reconnect');

    this.reconnectTimer = setTimeout(() => {
      log.info({ sessionId: this.id }, 'paircoded reconnect timeout expired');
      onTimeout();
    }, reconnectTimeoutMs);
  }

  /**
   * Clear the reconnect timer.
   */
  clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Update terminal dimensions.
   */
  setDimensions(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * Check if session has paircoded connected.
   */
  hasPaircoded(): boolean {
    return this.paircodedWs !== null && this.paircodedWs.readyState === 1; // WebSocket.OPEN
  }

  /**
   * Check if session is ready for browser connections.
   */
  isReady(): boolean {
    return this.state === SessionState.READY || this.state === SessionState.ACTIVE;
  }

  /**
   * Get session info for API responses.
   */
  toInfo(): SessionInfo {
    return {
      id: this.id,
      state: this.state,
      createdAt: this.createdAt.toISOString(),
      handshake: this.handshake,
      browserCount: this.browserConnections.size,
      cols: this.cols,
      rows: this.rows,
    };
  }

  /**
   * Mark session as closing.
   */
  close(): void {
    this.state = SessionState.CLOSING;
    this.clearReconnectTimer();

    // Close all browser connections
    for (const ws of this.browserConnections) {
      try {
        ws.close(1000, 'Session closed');
      } catch {
        // Ignore close errors
      }
    }
    this.browserConnections.clear();

    // Close paircoded connection
    if (this.paircodedWs) {
      try {
        this.paircodedWs.close(1000, 'Session closed');
      } catch {
        // Ignore close errors
      }
      this.paircodedWs = null;
    }

    this.state = SessionState.CLOSED;
    log.info({ sessionId: this.id }, 'session closed');
  }
}
