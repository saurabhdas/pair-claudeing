/**
 * Session class representing a terminal sharing session.
 */

import type { WebSocket } from 'ws';
import type { HandshakeMessage } from '../protocol/index.js';
import { SessionState, type SessionData, type SessionInfo, type SessionOwner, type ControlHandshakeInfo, type Terminal, type TerminalInfo, type PendingTerminalRequest, type ClientState, type TerminalCreator } from './types.js';

// HandshakeMessage is used in setTerminalHandshake method
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('session');

export class Session implements SessionData {
  public readonly id: string;
  public state: SessionState;
  public readonly createdAt: Date;

  // Session owner (from JWT)
  public owner: SessionOwner | null = null;

  // Control connection from paircoded
  public controlWs: WebSocket | null = null;
  public controlHandshake: ControlHandshakeInfo | null = null;

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
   * Set the session owner (from JWT).
   */
  setOwner(owner: SessionOwner): void {
    this.owner = owner;
    log.info({ sessionId: this.id, owner }, 'session owner set');
  }

  /**
   * Check if a user is the owner of this session.
   */
  isOwner(userId: string): boolean {
    return this.owner !== null && this.owner.userId === userId;
  }

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
  setControlHandshake(handshake: ControlHandshakeInfo): void {
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
  createTerminal(name: string, cols: number, rows: number, createdBy: TerminalCreator | null = null): Terminal {
    const terminal: Terminal = {
      name,
      dataWs: null,
      cols,
      rows,
      interactiveClients: new Map(),
      mirrorClients: new Map(),
      handshake: null,
      createdBy,
    };
    this.terminals.set(name, terminal);

    if (this.state === SessionState.READY) {
      this.state = SessionState.ACTIVE;
    }

    log.info({ sessionId: this.id, terminalName: name, cols, rows, createdBy }, 'terminal created');
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
   * Returns the ClientState for requesting snapshots.
   */
  addInteractiveClient(terminalName: string, ws: WebSocket, snapshotId: string | null = null): ClientState | null {
    const terminal = this.terminals.get(terminalName);
    if (terminal) {
      const clientState: ClientState = {
        ws,
        needsSnapshot: snapshotId !== null,
        pendingSnapshotId: snapshotId,
        bufferedOutput: [],
      };
      terminal.interactiveClients.set(ws, clientState);
      log.debug({
        sessionId: this.id,
        terminalName,
        interactiveCount: terminal.interactiveClients.size,
        needsSnapshot: clientState.needsSnapshot,
      }, 'interactive client added');
      return clientState;
    }
    return null;
  }

  /**
   * Add a mirror browser client to a terminal.
   * Returns the ClientState for requesting snapshots.
   */
  addMirrorClient(terminalName: string, ws: WebSocket, snapshotId: string | null = null): ClientState | null {
    const terminal = this.terminals.get(terminalName);
    if (terminal) {
      const clientState: ClientState = {
        ws,
        needsSnapshot: snapshotId !== null,
        pendingSnapshotId: snapshotId,
        bufferedOutput: [],
      };
      terminal.mirrorClients.set(ws, clientState);
      log.debug({
        sessionId: this.id,
        terminalName,
        mirrorCount: terminal.mirrorClients.size,
        needsSnapshot: clientState.needsSnapshot,
      }, 'mirror client added');
      return clientState;
    }
    return null;
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
   * Get the ClientState for a websocket in a terminal.
   */
  getClientState(terminalName: string, ws: WebSocket): ClientState | undefined {
    const terminal = this.terminals.get(terminalName);
    if (!terminal) return undefined;
    return terminal.interactiveClients.get(ws) ?? terminal.mirrorClients.get(ws);
  }

  /**
   * Find a client by pending snapshot ID.
   */
  findClientBySnapshotId(terminalName: string, snapshotId: string): ClientState | undefined {
    const terminal = this.terminals.get(terminalName);
    if (!terminal) return undefined;

    for (const clientState of terminal.interactiveClients.values()) {
      if (clientState.pendingSnapshotId === snapshotId) {
        return clientState;
      }
    }
    for (const clientState of terminal.mirrorClients.values()) {
      if (clientState.pendingSnapshotId === snapshotId) {
        return clientState;
      }
    }
    return undefined;
  }

  /**
   * Get all clients (interactive + mirror) for a terminal.
   */
  getAllClients(terminalName: string): Map<WebSocket, ClientState> {
    const terminal = this.terminals.get(terminalName);
    if (!terminal) return new Map();
    const allClients = new Map<WebSocket, ClientState>();
    for (const [ws, state] of terminal.interactiveClients) {
      allClients.set(ws, state);
    }
    for (const [ws, state] of terminal.mirrorClients) {
      allClients.set(ws, state);
    }
    return allClients;
  }

  /**
   * Close a terminal.
   */
  closeTerminal(name: string): void {
    const terminal = this.terminals.get(name);
    if (!terminal) return;

    // Close all browser connections for this terminal
    for (const ws of terminal.interactiveClients.keys()) {
      try { ws.close(1000, 'Terminal closed'); } catch {}
    }
    for (const ws of terminal.mirrorClients.keys()) {
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
    log.debug({ sessionId: this.id, requestId: request.requestId }, 'pending request added');
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
      createdBy: t.createdBy,
    }));

    return {
      id: this.id,
      state: this.state,
      createdAt: this.createdAt.toISOString(),
      owner: this.owner,
      controlHandshake: this.controlHandshake,
      controlConnected: this.hasControl(),
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
