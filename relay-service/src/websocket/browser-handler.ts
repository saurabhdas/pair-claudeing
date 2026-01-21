/**
 * WebSocket handler for browser client connections.
 */

import type { WebSocket, RawData } from 'ws';
import { createInputMessage, createResizeMessage } from '../protocol/index.js';
import { SessionManager, SessionState } from '../session/index.js';
import { SessionNotFoundError, SessionNotReadyError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('browser-handler');

export interface BrowserHandlerOptions {
  sessionManager: SessionManager;
}

interface BrowserMessage {
  type: 'input' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

export function handleBrowserConnection(
  ws: WebSocket,
  sessionId: string,
  options: BrowserHandlerOptions
): void {
  const { sessionManager } = options;

  // Get session
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    log.warn({ sessionId }, 'session not found for browser connection');
    ws.close(4404, 'Session not found');
    return;
  }

  // Check if session is ready
  if (!session.isReady()) {
    log.warn({ sessionId, state: session.state }, 'session not ready for browser connection');
    ws.close(4400, 'Session not ready');
    return;
  }

  // Add browser to session
  session.addBrowserConnection(ws);
  log.info({ sessionId, browserCount: session.browserConnections.size }, 'browser connected');

  // Send session info to browser
  const sessionInfo = {
    type: 'session',
    sessionId: session.id,
    cols: session.cols,
    rows: session.rows,
    shell: session.handshake?.shell,
    version: session.handshake?.version,
  };
  ws.send(JSON.stringify(sessionInfo));

  // Handle messages from browser
  ws.on('message', (data: RawData) => {
    handleBrowserMessage(ws, session, data);
  });

  // Handle connection close
  ws.on('close', (code, reason) => {
    log.info({ sessionId, code, reason: reason.toString() }, 'browser connection closed');
    session.removeBrowserConnection(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    log.error({ sessionId, error: error.message }, 'browser connection error');
  });
}

function handleBrowserMessage(
  browserWs: WebSocket,
  session: import('../session/session.js').Session,
  data: RawData
): void {
  const buffer = toBuffer(data);

  // Try to parse as JSON message
  try {
    const message = JSON.parse(buffer.toString('utf-8')) as BrowserMessage;
    handleStructuredMessage(session, message);
    return;
  } catch {
    // Not JSON - treat as raw input
  }

  // Forward raw input to paircoded
  forwardInputToPaircoded(session, buffer);
}

function handleStructuredMessage(
  session: import('../session/session.js').Session,
  message: BrowserMessage
): void {
  switch (message.type) {
    case 'input':
      if (message.data) {
        forwardInputToPaircoded(session, Buffer.from(message.data, 'utf-8'));
      }
      break;

    case 'resize':
      if (message.cols !== undefined && message.rows !== undefined) {
        handleResize(session, message.cols, message.rows);
      }
      break;

    default:
      log.warn({ sessionId: session.id, messageType: (message as any).type }, 'unknown browser message type');
  }
}

function forwardInputToPaircoded(
  session: import('../session/session.js').Session,
  data: Buffer
): void {
  if (!session.hasPaircoded()) {
    log.warn({ sessionId: session.id }, 'cannot forward input: paircoded not connected');
    return;
  }

  const inputMsg = createInputMessage(data);
  session.paircodedWs!.send(inputMsg);

  log.trace({ sessionId: session.id, bytes: data.length }, 'forwarded input to paircoded');
}

function handleResize(
  session: import('../session/session.js').Session,
  cols: number,
  rows: number
): void {
  log.debug({ sessionId: session.id, cols, rows }, 'browser resize request');

  // Update session dimensions
  session.setDimensions(cols, rows);

  // Forward resize to paircoded
  if (session.hasPaircoded()) {
    const resizeMsg = createResizeMessage(cols, rows);
    session.paircodedWs!.send(resizeMsg);
    log.debug({ sessionId: session.id, cols, rows }, 'forwarded resize to paircoded');
  }
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
