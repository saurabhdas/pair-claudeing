/**
 * WebSocket handler for browser client connections.
 *
 * Browser connects and sends setup message to create or mirror a terminal:
 * - {action: 'new', name: 'main'} - Create interactive terminal
 * - {action: 'mirror', name: 'main'} - Mirror existing terminal (read-only)
 */

import type { WebSocket, RawData } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  createInputMessage,
  createResizeMessage,
  parseBrowserSetupMessage,
  createSetupResponse,
  createRequestSnapshotMessage,
} from '../protocol/index.js';
import { SessionManager, SessionState } from '../session/index.js';
import { requestStartTerminal } from './control-handler.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('browser-handler');

const SETUP_TIMEOUT_MS = 10000; // 10 seconds to receive setup message

export interface BrowserHandlerOptions {
  sessionManager: SessionManager;
}

interface BrowserMessage {
  type: 'input' | 'resize' | 'setup';
  data?: string;
  cols?: number;
  rows?: number;
  action?: 'new' | 'mirror';
  name?: string;
}

// Track browser connection state
interface BrowserConnectionState {
  sessionId: string;
  terminalName: string | null;
  isSetupComplete: boolean;
  isInteractive: boolean; // true for interactive, false for mirror
}

const connectionStates = new WeakMap<WebSocket, BrowserConnectionState>();

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

  // Check if session has control connection
  if (!session.hasControl()) {
    log.warn({ sessionId }, 'session not ready: no control connection');
    ws.close(4400, 'Session not ready');
    return;
  }

  // Initialize connection state
  const state: BrowserConnectionState = {
    sessionId,
    terminalName: null,
    isSetupComplete: false,
    isInteractive: true,
  };
  connectionStates.set(ws, state);

  log.info({ sessionId }, 'browser connected (waiting for setup message)');

  // Set timeout for setup message
  const setupTimeout = setTimeout(() => {
    if (!state.isSetupComplete) {
      log.warn({ sessionId }, 'browser setup timeout');
      ws.close(4408, 'Setup timeout');
    }
  }, SETUP_TIMEOUT_MS);

  // Handle first message as setup
  const setupHandler = (data: RawData) => {
    clearTimeout(setupTimeout);
    ws.off('message', setupHandler);

    const setupMsg = parseBrowserSetupMessage(toBuffer(data));
    if (setupMsg) {
      handleSetupMessage(ws, session, setupMsg, state, sessionManager);

      // After setup, handle subsequent messages normally
      ws.on('message', (data: RawData) => {
        handleBrowserMessage(ws, session, data, state);
      });
    } else {
      // Invalid setup message
      log.warn({ sessionId }, 'invalid setup message received');
      ws.close(4400, 'Invalid setup message');
    }
  };

  ws.on('message', setupHandler);

  // Handle connection close
  ws.on('close', (code, reason) => {
    log.info({ sessionId, terminalName: state.terminalName, code, reason: reason.toString() }, 'browser connection closed');

    if (state.terminalName) {
      session.removeClient(state.terminalName, ws);
    }
  });

  // Handle errors
  ws.on('error', (error) => {
    log.error({ sessionId, error: error.message }, 'browser connection error');
  });
}

function handleSetupMessage(
  ws: WebSocket,
  session: import('../session/session.js').Session,
  setupMsg: import('../protocol/index.js').BrowserSetupMessage,
  state: BrowserConnectionState,
  sessionManager: SessionManager
): void {
  const { action, name, cols = session.cols, rows = session.rows, createdBy } = setupMsg;

  log.info({
    sessionId: session.id,
    action,
    terminalName: name,
    cols,
    rows,
  }, 'received setup message');

  if (action === 'new') {
    // Check if terminal already exists
    const existingTerminal = session.getTerminal(name);
    if (existingTerminal) {
      // Terminal exists - add as interactive client
      state.terminalName = name;
      state.isInteractive = true;
      state.isSetupComplete = true;

      // Request snapshot for initial state
      const snapshotId = uuidv4();
      session.addInteractiveClient(name, ws, snapshotId);

      // Send snapshot request to paircoded via data websocket
      if (existingTerminal.dataWs && existingTerminal.dataWs.readyState === 1) {
        const snapshotReq = createRequestSnapshotMessage(snapshotId);
        existingTerminal.dataWs.send(snapshotReq);
        log.debug({ sessionId: session.id, terminalName: name, snapshotId }, 'requested snapshot for joining client');
      } else {
        log.warn({ sessionId: session.id, terminalName: name }, 'no data connection to request snapshot');
      }

      const response = createSetupResponse(true, name, existingTerminal.cols, existingTerminal.rows);
      ws.send(JSON.stringify(response));

      log.info({ sessionId: session.id, terminalName: name }, 'joined existing terminal as interactive');
      return;
    }

    // Request paircoded to start new terminal
    const requestId = uuidv4();

    // Store pending request with callback to update state when we get the actual terminal name (PID)
    session.addPendingRequest({
      cols,
      rows,
      requestId,
      browserWs: ws,
      createdAt: Date.now(),
      onTerminalNameAssigned: (actualName: string) => {
        state.terminalName = actualName;
        state.isSetupComplete = true;
        log.debug({ sessionId: session.id, actualName }, 'terminal name assigned via callback');
      },
      createdBy: createdBy ? { userId: createdBy.userId, username: createdBy.username } : null,
    });

    state.isInteractive = true;

    // Send request to paircoded (name is ignored, PID will be used)
    const sent = requestStartTerminal(session, name, cols, rows, requestId);
    if (!sent) {
      // Control connection not available
      session.takePendingRequest(requestId);
      const response = createSetupResponse(false, name, cols, rows, 'Control connection not available');
      ws.send(JSON.stringify(response));
      log.warn({ sessionId: session.id, terminalName: name }, 'failed to request terminal: no control connection');
    } else {
      // Wait for terminal_started response from control handler
      log.debug({ sessionId: session.id, terminalName: name, requestId }, 'waiting for terminal_started');
    }
  } else if (action === 'mirror') {
    // Mirror an existing terminal
    const terminal = session.getTerminal(name);
    if (!terminal) {
      const response = createSetupResponse(false, name, cols, rows, 'Terminal not found');
      ws.send(JSON.stringify(response));
      log.warn({ sessionId: session.id, terminalName: name }, 'mirror request for non-existent terminal');
      return;
    }

    state.terminalName = name;
    state.isInteractive = false;
    state.isSetupComplete = true;

    // Request snapshot for initial state
    const snapshotId = uuidv4();
    session.addMirrorClient(name, ws, snapshotId);

    // Send snapshot request to paircoded via data websocket
    if (terminal.dataWs && terminal.dataWs.readyState === 1) {
      const snapshotReq = createRequestSnapshotMessage(snapshotId);
      terminal.dataWs.send(snapshotReq);
      log.debug({ sessionId: session.id, terminalName: name, snapshotId }, 'requested snapshot for mirror client');
    } else {
      log.warn({ sessionId: session.id, terminalName: name }, 'no data connection to request snapshot');
    }

    const response = createSetupResponse(true, name, terminal.cols, terminal.rows);
    ws.send(JSON.stringify(response));

    log.info({ sessionId: session.id, terminalName: name }, 'browser connected as mirror');
  }
}

function handleBrowserMessage(
  browserWs: WebSocket,
  session: import('../session/session.js').Session,
  data: RawData,
  state: BrowserConnectionState
): void {
  const buffer = toBuffer(data);

  // Try to parse as JSON message
  try {
    const message = JSON.parse(buffer.toString('utf-8')) as BrowserMessage;
    handleStructuredMessage(session, message, state);
    return;
  } catch {
    // Not JSON - treat as raw input
  }

  // Forward raw input
  forwardInput(session, buffer, state);
}

function handleStructuredMessage(
  session: import('../session/session.js').Session,
  message: BrowserMessage,
  state: BrowserConnectionState
): void {
  switch (message.type) {
    case 'input':
      if (message.data) {
        // Only interactive clients can send input
        if (!state.isInteractive) {
          log.trace({ sessionId: session.id }, 'ignoring input from mirror client');
          return;
        }
        forwardInput(session, Buffer.from(message.data, 'utf-8'), state);
      }
      break;

    case 'resize':
      if (message.cols !== undefined && message.rows !== undefined) {
        // Only interactive clients can resize
        if (!state.isInteractive) {
          log.trace({ sessionId: session.id }, 'ignoring resize from mirror client');
          return;
        }
        handleResize(session, message.cols, message.rows, state);
      }
      break;

    default:
      log.warn({ sessionId: session.id, messageType: (message as any).type }, 'unknown browser message type');
  }
}

function forwardInput(
  session: import('../session/session.js').Session,
  data: Buffer,
  state: BrowserConnectionState
): void {
  // Only interactive clients can send input
  if (!state.isInteractive || !state.terminalName) {
    return;
  }

  const terminal = session.getTerminal(state.terminalName);
  if (!terminal?.dataWs || terminal.dataWs.readyState !== 1) {
    log.warn({ sessionId: session.id, terminalName: state.terminalName }, 'cannot forward input: terminal data connection not ready');
    return;
  }

  const inputMsg = createInputMessage(data);
  terminal.dataWs.send(inputMsg);
  log.trace({ sessionId: session.id, terminalName: state.terminalName, bytes: data.length }, 'forwarded input to terminal');
}

function handleResize(
  session: import('../session/session.js').Session,
  cols: number,
  rows: number,
  state: BrowserConnectionState
): void {
  // Only interactive clients can resize
  if (!state.isInteractive || !state.terminalName) {
    return;
  }

  const terminal = session.getTerminal(state.terminalName);
  if (terminal) {
    terminal.cols = cols;
    terminal.rows = rows;

    if (terminal.dataWs && terminal.dataWs.readyState === 1) {
      const resizeMsg = createResizeMessage(cols, rows);
      terminal.dataWs.send(resizeMsg);
      log.debug({ sessionId: session.id, terminalName: state.terminalName, cols, rows }, 'forwarded resize to terminal');
    }
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
