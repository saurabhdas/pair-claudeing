/**
 * Session class representing a terminal sharing session.
 */

import type { WebSocket } from 'ws';
import type { HandshakeMessage } from '../protocol/index.js';
import { SessionState, type SessionData, type SessionInfo, type Terminal, type TerminalInfo, type PendingTerminalRequest } from './types.js';

// HandshakeMessage is used in setTerminalHandshake method
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('session');

export class Session implements SessionData {
  public readonly id: string;
  public state: SessionState;
  public readonly createdAt: Date;

  // Control connection from paircoded
  public controlWs: WebSocket | null = null;
  public controlHandshake: { version: string } | null = null;

  // Named terminals
  public terminals: Map<string, Terminal> = new Map();
  public pendingTerminalRequests: Map<string, PendingTerminalRequest> = new Map();

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

  // ============================================================================
  // Control Connection Methods
  // ============================================================================

  /**
   * Set the control connection from paircoded.
   */
  setControlConnection(ws: WebSocket): void {
    this.controlWs = ws;
    this.clearReconnectTimer();
    log.debug({ sessionId: this.id }, 'paircoded control connection established');
  }

  /**
   * Set control handshake data.
   */
  setControlHandshake(handshake: { version: string }): void {
    this.controlHandshake = handshake;
    if (this.state === SessionState.PENDING) {
      this.state = SessionState.READY;
      log.info({ sessionId: this.id, handshake }, 'session ready (control connected)');
    }
  }

  /**
   * Check if control connection is active.
   */
  hasControl(): boolean {
    return this.controlWs !== null && this.controlWs.readyState === 1;
  }

  // ============================================================================
  // Terminal Management Methods
  // ============================================================================

  /**
   * Create a new terminal (called when paircoded starts a terminal).
   */
  createTerminal(name: string, cols: number, rows: number): Terminal {
    const terminal: Terminal = {
      name,
      dataWs: null,
      cols,
      rows,
      interactiveClients: new Set(),
      mirrorClients: new Set(),
      handshake: null,
    };
    this.terminals.set(name, terminal);

    if (this.state === SessionState.READY) {
      this.state = SessionState.ACTIVE;
    }

    log.info({ sessionId: this.id, terminalName: name, cols, rows }, 'terminal created');
    return terminal;
  }

  /**
   * Get a terminal by name.
   */
  getTerminal(name: string): Terminal | undefined {
    return this.terminals.get(name);
  }

  /**
   * Set the data websocket for a terminal.
   */
  setTerminalDataConnection(name: string, ws: WebSocket): void {
    const terminal = this.terminals.get(name);
    if (terminal) {
      terminal.dataWs = ws;
      log.debug({ sessionId: this.id, terminalName: name }, 'terminal data connection established');
    }
  }

  /**
   * Set handshake for a terminal (from data connection).
   */
  setTerminalHandshake(name: string, handshake: HandshakeMessage): void {
    const terminal = this.terminals.get(name);
    if (terminal) {
      terminal.handshake = handshake;
      if (handshake.cols) terminal.cols = handshake.cols;
      if (handshake.rows) terminal.rows = handshake.rows;
      log.debug({ sessionId: this.id, terminalName: name, handshake }, 'terminal handshake received');
    }
  }

  /**
   * Add an interactive browser client to a terminal.
   */
  addInteractiveClient(terminalName: string, ws: WebSocket): void {
    const terminal = this.terminals.get(terminalName);
    if (terminal) {
      terminal.interactiveClients.add(ws);
      log.debug({
        sessionId: this.id,
        terminalName,
        interactiveCount: terminal.interactiveClients.size,
      }, 'interactive client added');
    }
  }

  /**
   * Add a mirror browser client to a terminal.
   */
  addMirrorClient(terminalName: string, ws: WebSocket): void {
    const terminal = this.terminals.get(terminalName);
    if (terminal) {
      terminal.mirrorClients.add(ws);
      log.debug({
        sessionId: this.id,
        terminalName,
        mirrorCount: terminal.mirrorClients.size,
      }, 'mirror client added');
    }
  }

  /**
   * Remove a browser client from a terminal.
   */
  removeClient(terminalName: string, ws: WebSocket): void {
    const terminal = this.terminals.get(terminalName);
    if (terminal) {
      terminal.interactiveClients.delete(ws);
      terminal.mirrorClients.delete(ws);
      log.debug({
        sessionId: this.id,
        terminalName,
        interactiveCount: terminal.interactiveClients.size,
        mirrorCount: terminal.mirrorClients.size,
      }, 'client removed');
    }
  }

  /**
   * Get all clients (interactive + mirror) for a terminal.
   */
  getAllClients(terminalName: string): Set<WebSocket> {
    const terminal = this.terminals.get(terminalName);
    if (!terminal) return new Set();
    return new Set([...terminal.interactiveClients, ...terminal.mirrorClients]);
  }

  /**
   * Close a terminal.
   */
  closeTerminal(name: string): void {
    const terminal = this.terminals.get(name);
    if (!terminal) return;

    // Close all browser connections for this terminal
    for (const ws of terminal.interactiveClients) {
      try { ws.close(1000, 'Terminal closed'); } catch {}
    }
    for (const ws of terminal.mirrorClients) {
      try { ws.close(1000, 'Terminal closed'); } catch {}
    }

    // Close data connection
    if (terminal.dataWs) {
      try { terminal.dataWs.close(1000, 'Terminal closed'); } catch {}
    }

    this.terminals.delete(name);
    log.info({ sessionId: this.id, terminalName: name }, 'terminal closed');

    // Update state if no more terminals
    if (this.terminals.size === 0 && this.state === SessionState.ACTIVE) {
      this.state = SessionState.READY;
    }
  }

  /**
   * Check if a terminal has a data connection.
   */
  hasTerminalData(name: string): boolean {
    const terminal = this.terminals.get(name);
    return terminal?.dataWs !== null && terminal?.dataWs?.readyState === 1;
  }

  // ============================================================================
  // Pending Request Management
  // ============================================================================

  /**
   * Add a pending terminal request.
   */
  addPendingRequest(request: PendingTerminalRequest): void {
    this.pendingTerminalRequests.set(request.requestId, request);
    log.debug({ sessionId: this.id, requestId: request.requestId, terminalName: request.name }, 'pending request added');
  }

  /**
   * Get and remove a pending request.
   */
  takePendingRequest(requestId: string): PendingTerminalRequest | undefined {
    const request = this.pendingTerminalRequests.get(requestId);
    if (request) {
      this.pendingTerminalRequests.delete(requestId);
    }
    return request;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

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
   * Check if session is ready for browser connections.
   */
  isReady(): boolean {
    return this.state === SessionState.READY || this.state === SessionState.ACTIVE;
  }

  /**
   * Get session info for API responses.
   */
  toInfo(): SessionInfo {
    const terminalInfos: TerminalInfo[] = Array.from(this.terminals.values()).map(t => ({
      name: t.name,
      cols: t.cols,
      rows: t.rows,
      interactiveCount: t.interactiveClients.size,
      mirrorCount: t.mirrorClients.size,
      hasDataConnection: t.dataWs !== null && t.dataWs.readyState === 1,
    }));

    return {
      id: this.id,
      state: this.state,
      createdAt: this.createdAt.toISOString(),
      controlHandshake: this.controlHandshake,
      cols: this.cols,
      rows: this.rows,
      terminals: terminalInfos,
    };
  }

  /**
   * Handle control connection disconnect.
   */
  handleControlDisconnect(reconnectTimeoutMs: number, onTimeout: () => void): void {
    this.controlWs = null;

    if (this.state === SessionState.CLOSED || this.state === SessionState.CLOSING) {
      return;
    }

    log.info({ sessionId: this.id, reconnectTimeoutMs }, 'control connection lost, waiting for reconnect');

    this.reconnectTimer = setTimeout(() => {
      log.info({ sessionId: this.id }, 'control reconnect timeout expired');
      onTimeout();
    }, reconnectTimeoutMs);
  }

  /**
   * Mark session as closing.
   */
  close(): void {
    this.state = SessionState.CLOSING;
    this.clearReconnectTimer();

    // Close all terminals
    for (const [name] of this.terminals) {
      this.closeTerminal(name);
    }

    // Close control connection
    if (this.controlWs) {
      try {
        this.controlWs.close(1000, 'Session closed');
      } catch {
        // Ignore close errors
      }
      this.controlWs = null;
    }

    this.state = SessionState.CLOSED;
    log.info({ sessionId: this.id }, 'session closed');
  }
}
