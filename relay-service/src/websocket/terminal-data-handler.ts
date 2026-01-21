/**
 * WebSocket handler for terminal data connections from paircoded.
 *
 * Each terminal has its own data websocket that handles:
 * - PTY output from paircoded -> forwarded to all browser clients
 * - Input from browser clients -> forwarded to paircoded
 * - Handshake with terminal dimensions
 */

import type { WebSocket, RawData } from 'ws';
import { parseClientMessage, createResizeMessage, type ParsedSnapshotMessage } from '../protocol/index.js';
import { SessionManager, Session, SessionState, type ClientState } from '../session/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('terminal-data-handler');

export interface TerminalDataHandlerOptions {
  sessionManager: SessionManager;
}

export function handleTerminalDataConnection(
  ws: WebSocket,
  sessionId: string,
  terminalName: string,
  options: TerminalDataHandlerOptions
): void {
  const { sessionManager } = options;

  // Get session
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    log.warn({ sessionId, terminalName }, 'session not found for terminal data connection');
    ws.close(4404, 'Session not found');
    return;
  }

  // Get or create the terminal
  let terminal = session.getTerminal(terminalName);
  if (!terminal) {
    // Terminal might be created by control handler already
    log.warn({ sessionId, terminalName }, 'terminal not found, creating');
    terminal = session.createTerminal(terminalName, session.cols, session.rows);
  }

  // Set data connection
  session.setTerminalDataConnection(terminalName, ws);
  log.info({ sessionId, terminalName }, 'terminal data connection established');

  // Handle messages from paircoded
  ws.on('message', (data: RawData) => {
    handleDataMessage(session, terminalName, data);
  });

  // Handle connection close
  ws.on('close', (code, reason) => {
    log.info({ sessionId, terminalName, code, reason: reason.toString() }, 'terminal data connection closed');
    handleDataDisconnect(session, terminalName);
  });

  // Handle errors
  ws.on('error', (error) => {
    log.error({ sessionId, terminalName, error: error.message }, 'terminal data connection error');
  });
}

function handleDataMessage(
  session: Session,
  terminalName: string,
  data: RawData
): void {
  const buffer = toBuffer(data);
  const message = parseClientMessage(buffer);

  if (!message) {
    log.warn({ sessionId: session.id, terminalName }, 'invalid message from paircoded data connection');
    return;
  }

  switch (message.type) {
    case 'handshake':
      handleHandshake(session, terminalName, message.data);
      break;

    case 'output':
      handleOutput(session, terminalName, message.data);
      break;

    case 'exit':
      handleExit(session, terminalName, message.code);
      break;

    case 'snapshot':
      handleSnapshot(session, terminalName, message);
      break;
  }
}

function handleHandshake(
  session: Session,
  terminalName: string,
  handshake: import('../protocol/index.js').HandshakeMessage
): void {
  log.info({ sessionId: session.id, terminalName, handshake }, 'received terminal handshake');

  session.setTerminalHandshake(terminalName, handshake);

  // Send initial resize to paircoded
  const terminal = session.getTerminal(terminalName);
  if (terminal?.dataWs && terminal.dataWs.readyState === 1) {
    const resizeMsg = createResizeMessage(terminal.cols, terminal.rows);
    terminal.dataWs.send(resizeMsg);
    log.debug({ sessionId: session.id, terminalName, cols: terminal.cols, rows: terminal.rows }, 'sent resize to terminal');
  }
}

function handleOutput(session: Session, terminalName: string, data: Buffer): void {
  const terminal = session.getTerminal(terminalName);
  if (!terminal) return;

  // Forward output to all connected clients (interactive + mirror)
  // But buffer for clients waiting for snapshots
  const allClients = session.getAllClients(terminalName);
  let sentCount = 0;
  let bufferedCount = 0;

  for (const [browserWs, clientState] of allClients) {
    if (browserWs.readyState !== 1) { // Not WebSocket.OPEN
      continue;
    }

    if (clientState.needsSnapshot) {
      // Buffer output for this client until snapshot arrives
      clientState.bufferedOutput.push(Buffer.from(data));
      bufferedCount++;
    } else {
      // Send immediately
      browserWs.send(data);
      sentCount++;
    }
  }

  log.trace({
    sessionId: session.id,
    terminalName,
    bytes: data.length,
    sentCount,
    bufferedCount,
  }, 'forwarded output to clients');
}

function handleSnapshot(
  session: Session,
  terminalName: string,
  snapshot: ParsedSnapshotMessage
): void {
  log.debug({
    sessionId: session.id,
    terminalName,
    requestId: snapshot.requestId,
    screenBytes: snapshot.screen.length,
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursorX: snapshot.cursorX,
    cursorY: snapshot.cursorY,
  }, 'received terminal snapshot');

  // Find the client waiting for this snapshot
  const clientState = session.findClientBySnapshotId(terminalName, snapshot.requestId);
  if (!clientState) {
    log.warn({
      sessionId: session.id,
      terminalName,
      requestId: snapshot.requestId,
    }, 'no client found waiting for snapshot');
    return;
  }

  const ws = clientState.ws;
  if (ws.readyState !== 1) { // Not WebSocket.OPEN
    log.warn({ sessionId: session.id, terminalName }, 'client disconnected before receiving snapshot');
    return;
  }

  // Send snapshot screen data to the client
  ws.send(snapshot.screen);

  log.debug({
    sessionId: session.id,
    terminalName,
    requestId: snapshot.requestId,
    bufferedChunks: clientState.bufferedOutput.length,
  }, 'sent snapshot to client, flushing buffered output');

  // Flush buffered output to the client
  for (const bufferedData of clientState.bufferedOutput) {
    if (ws.readyState === 1) {
      ws.send(bufferedData);
    }
  }

  // Clear state - client is now in sync
  clientState.needsSnapshot = false;
  clientState.pendingSnapshotId = null;
  clientState.bufferedOutput = [];
}

function handleExit(session: Session, terminalName: string, code: number): void {
  log.info({ sessionId: session.id, terminalName, exitCode: code }, 'terminal process exited');

  const terminal = session.getTerminal(terminalName);
  if (!terminal) return;

  // Notify all clients
  const exitMessage = JSON.stringify({ type: 'exit', code });
  for (const ws of terminal.interactiveClients.keys()) {
    if (ws.readyState === 1) {
      ws.send(exitMessage);
    }
  }
  for (const ws of terminal.mirrorClients.keys()) {
    if (ws.readyState === 1) {
      ws.send(exitMessage);
    }
  }

  // Close the terminal
  session.closeTerminal(terminalName);
}

function handleDataDisconnect(session: Session, terminalName: string): void {
  if (session.state === SessionState.CLOSED || session.state === SessionState.CLOSING) {
    return;
  }

  const terminal = session.getTerminal(terminalName);
  if (!terminal) return;

  // Notify clients
  const disconnectMessage = JSON.stringify({ type: 'disconnect', reason: 'data_connection_lost' });
  for (const ws of terminal.interactiveClients.keys()) {
    if (ws.readyState === 1) {
      ws.send(disconnectMessage);
    }
  }
  for (const ws of terminal.mirrorClients.keys()) {
    if (ws.readyState === 1) {
      ws.send(disconnectMessage);
    }
  }

  // Close terminal
  session.closeTerminal(terminalName);
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}
