/**
 * WebSocket handler for paircoded control connections.
 *
 * The control connection handles terminal lifecycle management:
 * - Receives control_handshake from paircoded
 * - Sends start_terminal when browser requests a new terminal
 * - Receives terminal_started when paircoded successfully starts a terminal
 * - Receives terminal_closed when a terminal exits
 */

import type { WebSocket, RawData } from 'ws';
import {
  parseControlResponse,
  createStartTerminalMessage,
  createSetupResponse,
} from '../protocol/index.js';
import { SessionManager, SessionState } from '../session/index.js';
import { createChildLogger } from '../utils/logger.js';
import { extractBearerToken, verifyToken } from '../server/jwt.js';
import type { Config } from '../config.js';

const log = createChildLogger('control-handler');

export interface ControlHandlerOptions {
  sessionManager: SessionManager;
  config: Config;
  authHeader?: string;
}

export function handleControlConnection(
  ws: WebSocket,
  sessionId: string,
  options: ControlHandlerOptions
): void {
  const { sessionManager, config, authHeader } = options;

  // Validate JWT token
  const token = extractBearerToken(authHeader);
  if (!token) {
    log.warn({ sessionId }, 'control connection rejected: missing authorization');
    ws.close(4401, 'Missing authorization');
    return;
  }

  const jwtPayload = verifyToken(token, config);
  if (!jwtPayload) {
    log.warn({ sessionId }, 'control connection rejected: invalid token');
    ws.close(4401, 'Invalid token');
    return;
  }

  log.info({ sessionId, userId: jwtPayload.sub, username: jwtPayload.username }, 'authenticated control connection');

  // Get or create session
  let session = sessionManager.getSession(sessionId);
  if (!session) {
    session = sessionManager.createSession(sessionId);
  }

  // Check if session already has an owner and if this user is the owner
  if (session.owner && !session.isOwner(jwtPayload.sub)) {
    log.warn({ sessionId, attemptedBy: jwtPayload.username, owner: session.owner.username }, 'control connection rejected: not the owner');
    ws.close(4403, 'Not the session owner');
    return;
  }

  // Check if session already has a control connection
  if (session.hasControl()) {
    log.warn({ sessionId }, 'session already has control connection');
    ws.close(4409, 'Session already connected');
    return;
  }

  // Set ownership if not already set
  if (!session.owner) {
    session.setOwner({ userId: jwtPayload.sub, username: jwtPayload.username });
  }

  // Attach control connection
  session.setControlConnection(ws);
  log.info({ sessionId, owner: jwtPayload.username }, 'control connection established');

  // Handle messages from paircoded
  ws.on('message', (data: RawData) => {
    handleControlMessage(session!, data, sessionManager);
  });

  // Handle connection close
  ws.on('close', (code, reason) => {
    const reasonStr = reason.toString();
    log.info({ sessionId, code, reason: reasonStr }, 'control connection closed');
    handleControlDisconnect(session!, sessionManager, code, reasonStr);
  });

  // Handle errors
  ws.on('error', (error) => {
    log.error({ sessionId, error: error.message }, 'control connection error');
  });
}

function handleControlMessage(
  session: import('../session/session.js').Session,
  data: RawData,
  sessionManager: SessionManager
): void {
  const buffer = toBuffer(data);
  const text = buffer.toString('utf-8');
  const message = parseControlResponse(text);

  if (!message) {
    log.warn({ sessionId: session.id, data: text }, 'invalid control message from paircoded');
    return;
  }

  switch (message.type) {
    case 'control_handshake':
      handleControlHandshake(session, message, sessionManager);
      break;

    case 'terminal_started':
      handleTerminalStarted(session, message);
      break;

    case 'terminal_closed':
      handleTerminalClosed(session, message);
      break;
  }
}

function handleControlHandshake(
  session: import('../session/session.js').Session,
  message: { type: 'control_handshake'; version: string; hostname?: string; username?: string; workingDir?: string },
  sessionManager: SessionManager
): void {
  log.info({ sessionId: session.id, version: message.version, hostname: message.hostname }, 'received control handshake');
  session.setControlHandshake({
    version: message.version,
    hostname: message.hostname,
    username: message.username,
    workingDir: message.workingDir,
  });

  // Notify that session is now online
  sessionManager.notifySessionOnline(session.id);
}

function handleTerminalStarted(
  session: import('../session/session.js').Session,
  message: { type: 'terminal_started'; name: string; requestId: string; success: boolean; error?: string }
): void {
  log.info({
    sessionId: session.id,
    terminalName: message.name,
    requestId: message.requestId,
    success: message.success,
    error: message.error,
  }, 'terminal started response');

  // Get the pending request
  const request = session.takePendingRequest(message.requestId);
  if (!request) {
    log.warn({ sessionId: session.id, requestId: message.requestId }, 'no pending request found');
    return;
  }

  if (message.success) {
    // Create the terminal in the session with the PID-based name from paircoded
    session.createTerminal(message.name, request.cols, request.rows);

    // Update browser's terminal name via callback (so subsequent messages use correct name)
    if (request.onTerminalNameAssigned) {
      request.onTerminalNameAssigned(message.name);
    }

    // Add the browser as an interactive client
    // No snapshot needed for first client since terminal is fresh
    session.addInteractiveClient(message.name, request.browserWs, null);

    // Send success response to browser with the actual terminal name (PID)
    const response = createSetupResponse(true, message.name, request.cols, request.rows);
    request.browserWs.send(JSON.stringify(response));
  } else {
    // Send failure response to browser
    const response = createSetupResponse(
      false,
      message.name,
      request.cols,
      request.rows,
      message.error || 'Failed to start terminal'
    );
    request.browserWs.send(JSON.stringify(response));
  }
}

function handleTerminalClosed(
  session: import('../session/session.js').Session,
  message: { type: 'terminal_closed'; name: string; exitCode: number }
): void {
  log.info({
    sessionId: session.id,
    terminalName: message.name,
    exitCode: message.exitCode,
  }, 'terminal closed');

  const terminal = session.getTerminal(message.name);
  if (terminal) {
    // Notify all clients
    const exitMessage = JSON.stringify({ type: 'exit', code: message.exitCode });
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
    session.closeTerminal(message.name);
  }
}

function handleControlDisconnect(
  session: import('../session/session.js').Session,
  sessionManager: SessionManager,
  closeCode: number,
  closeReason: string
): void {
  if (session.state === SessionState.CLOSED || session.state === SessionState.CLOSING) {
    return;
  }

  // Check if this was a graceful shutdown (close code 1000 with "client shutdown" reason)
  const isGracefulShutdown = closeCode === 1000 && closeReason === 'client shutdown';

  if (isGracefulShutdown) {
    // Graceful shutdown - immediately close session
    log.info({ sessionId: session.id }, 'graceful shutdown, closing session immediately');

    // Notify all terminal clients
    const disconnectMessage = JSON.stringify({ type: 'disconnect', reason: 'session_ended' });
    for (const terminal of session.terminals.values()) {
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
    }

    session.close();
    sessionManager.deleteSession(session.id, 'graceful');
  } else {
    // Network disconnect - wait for reconnection
    log.info({ sessionId: session.id, closeCode, closeReason }, 'network disconnect, waiting for reconnection');

    // Notify that session is offline (but not closed yet)
    sessionManager.notifySessionOffline(session.id);

    // Start reconnect timer
    session.handleControlDisconnect(
      sessionManager.paircodedReconnectTimeoutMs,
      () => {
        // Timeout expired - close session
        log.info({ sessionId: session.id }, 'control reconnect timeout, closing session');

        // Notify all terminal clients
        const disconnectMessage = JSON.stringify({ type: 'disconnect', reason: 'paircoded_timeout' });
        for (const terminal of session.terminals.values()) {
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
        }

        session.close();
        sessionManager.deleteSession(session.id, 'timeout');
      }
    );
  }
}

/**
 * Request paircoded to start a new terminal.
 */
export function requestStartTerminal(
  session: import('../session/session.js').Session,
  name: string,
  cols: number,
  rows: number,
  requestId: string
): boolean {
  if (!session.hasControl()) {
    return false;
  }

  const message = createStartTerminalMessage(name, cols, rows, requestId);
  session.controlWs!.send(JSON.stringify(message));

  log.debug({
    sessionId: session.id,
    terminalName: name,
    requestId,
    cols,
    rows,
  }, 'sent start_terminal request');

  return true;
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
