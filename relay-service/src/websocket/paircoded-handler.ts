/**
 * WebSocket handler for paircoded CLI connections.
 */

import type { WebSocket, RawData } from 'ws';
import { parseClientMessage, createResizeMessage } from '../protocol/index.js';
import { SessionManager, Session, SessionState } from '../session/index.js';
import { SessionAlreadyConnectedError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('paircoded-handler');

export interface PaircodedHandlerOptions {
  sessionManager: SessionManager;
}

export function handlePaircodedConnection(
  ws: WebSocket,
  sessionId: string,
  options: PaircodedHandlerOptions
): void {
  const { sessionManager } = options;

  // Get or create session
  let session = sessionManager.getSession(sessionId);
  if (!session) {
    session = sessionManager.createSession(sessionId);
  }

  // Check if session already has a paircoded connection
  if (session.hasPaircoded()) {
    log.warn({ sessionId }, 'session already has paircoded connection');
    ws.close(4409, 'Session already connected');
    return;
  }

  // Attach paircoded connection
  session.setPaircodedConnection(ws);
  log.info({ sessionId }, 'paircoded connection established');

  // Handle messages from paircoded
  ws.on('message', (data: RawData) => {
    handlePaircodedMessage(session!, data);
  });

  // Handle connection close
  ws.on('close', (code, reason) => {
    log.info({ sessionId, code, reason: reason.toString() }, 'paircoded connection closed');
    handlePaircodedDisconnect(session!, sessionManager);
  });

  // Handle errors
  ws.on('error', (error) => {
    log.error({ sessionId, error: error.message }, 'paircoded connection error');
  });
}

function handlePaircodedMessage(session: Session, data: RawData): void {
  const buffer = toBuffer(data);
  const message = parseClientMessage(buffer);

  if (!message) {
    log.warn({ sessionId: session.id }, 'invalid message from paircoded');
    return;
  }

  switch (message.type) {
    case 'handshake':
      handleHandshake(session, message.data);
      break;

    case 'output':
      handleOutput(session, message.data);
      break;

    case 'exit':
      handleExit(session, message.code);
      break;
  }
}

function handleHandshake(session: Session, handshake: import('../protocol/index.js').HandshakeMessage): void {
  log.info({ sessionId: session.id, handshake }, 'received handshake from paircoded');

  session.setHandshake(handshake);

  // Send initial resize to paircoded
  if (session.paircodedWs) {
    const resizeMsg = createResizeMessage(session.cols, session.rows);
    session.paircodedWs.send(resizeMsg);
    log.debug({ sessionId: session.id, cols: session.cols, rows: session.rows }, 'sent resize to paircoded');
  }
}

function handleOutput(session: Session, data: Buffer): void {
  // Forward output to all connected browsers
  for (const browserWs of session.browserConnections) {
    if (browserWs.readyState === 1) { // WebSocket.OPEN
      browserWs.send(data);
    }
  }

  log.trace({
    sessionId: session.id,
    bytes: data.length,
    browsers: session.browserConnections.size,
  }, 'forwarded output to browsers');
}

function handleExit(session: Session, code: number): void {
  log.info({ sessionId: session.id, exitCode: code }, 'paircoded process exited');

  // Notify all browsers
  const exitMessage = JSON.stringify({ type: 'exit', code });
  for (const browserWs of session.browserConnections) {
    if (browserWs.readyState === 1) {
      browserWs.send(exitMessage);
    }
  }

  // Close the session
  session.close();
}

function handlePaircodedDisconnect(session: Session, sessionManager: SessionManager): void {
  if (session.state === SessionState.CLOSED || session.state === SessionState.CLOSING) {
    return;
  }

  // Start reconnect timer
  session.handlePaircodedDisconnect(
    sessionManager.paircodedReconnectTimeoutMs,
    () => {
      // Timeout expired - close session
      log.info({ sessionId: session.id }, 'paircoded reconnect timeout, closing session');

      // Notify browsers
      const disconnectMessage = JSON.stringify({ type: 'disconnect', reason: 'paircoded_timeout' });
      for (const browserWs of session.browserConnections) {
        if (browserWs.readyState === 1) {
          browserWs.send(disconnectMessage);
        }
      }

      session.close();
      sessionManager.deleteSession(session.id);
    }
  );
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
