/**
 * Session manager for tracking and managing terminal sessions.
 */

import { v4 as uuidv4 } from 'uuid';
import { Session } from './session.js';
import { SessionState, type SessionInfo } from './types.js';
import { SessionNotFoundError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';
import type { Config } from '../config.js';

export { Session } from './session.js';
export { SessionState } from './types.js';
export type { SessionInfo, SessionData, SessionOwner, ControlHandshakeInfo, Terminal, TerminalInfo, PendingTerminalRequest, ClientState } from './types.js';

const log = createChildLogger('session-manager');

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Create a new session.
   */
  createSession(sessionId?: string): Session {
    const id = sessionId || uuidv4();

    if (this.sessions.has(id)) {
      // If session exists and is in a usable state, return it
      const existing = this.sessions.get(id)!;
      if (existing.state !== SessionState.CLOSED) {
        log.debug({ sessionId: id }, 'returning existing session');
        return existing;
      }
      // Otherwise, remove the closed session and create new one
      this.sessions.delete(id);
    }

    const session = new Session(id, this.config.defaultCols, this.config.defaultRows);
    this.sessions.set(id, session);
    log.info({ sessionId: id }, 'session created');
    return session;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get a session by ID, throwing if not found.
   */
  getSessionOrThrow(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }

  /**
   * Delete a session.
   */
  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.close();
      this.sessions.delete(sessionId);
      log.info({ sessionId }, 'session deleted');
      return true;
    }
    return false;
  }

  /**
   * List all active sessions.
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter(s => s.state !== SessionState.CLOSED)
      .map(s => s.toInfo());
  }

  /**
   * Get the total number of active sessions.
   */
  getSessionCount(): number {
    return Array.from(this.sessions.values())
      .filter(s => s.state !== SessionState.CLOSED)
      .length;
  }

  /**
   * Clean up old/expired sessions.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const age = now - session.createdAt.getTime();
      if (age > this.config.sessionTimeoutMs || session.state === SessionState.CLOSED) {
        session.close();
        this.sessions.delete(id);
        log.info({ sessionId: id, age }, 'session expired and removed');
      }
    }
  }

  /**
   * Get paircoded reconnect timeout.
   */
  get paircodedReconnectTimeoutMs(): number {
    return this.config.paircodedReconnectTimeoutMs;
  }
}
