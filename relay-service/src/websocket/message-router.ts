/**
 * Message routing utilities for WebSocket communication.
 */

import type { WebSocket } from 'ws';
import type { Session } from '../session/session.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('message-router');

/**
 * Broadcast a message to all browser connections in a session.
 */
export function broadcastToBrowsers(session: Session, data: Buffer | string): number {
  let sent = 0;
  const message = typeof data === 'string' ? data : data;

  for (const browserWs of session.browserConnections) {
    if (browserWs.readyState === 1) { // WebSocket.OPEN
      browserWs.send(message);
      sent++;
    }
  }

  return sent;
}

/**
 * Send a message to paircoded.
 */
export function sendToPaircoded(session: Session, data: Buffer): boolean {
  if (!session.paircodedWs || session.paircodedWs.readyState !== 1) {
    return false;
  }

  session.paircodedWs.send(data);
  return true;
}

/**
 * Close all connections in a session with a reason.
 */
export function closeAllConnections(session: Session, code: number, reason: string): void {
  // Close browser connections
  for (const browserWs of session.browserConnections) {
    try {
      browserWs.close(code, reason);
    } catch {
      // Ignore errors
    }
  }

  // Close paircoded connection
  if (session.paircodedWs) {
    try {
      session.paircodedWs.close(code, reason);
    } catch {
      // Ignore errors
    }
  }

  log.debug({ sessionId: session.id, code, reason }, 'closed all connections');
}
