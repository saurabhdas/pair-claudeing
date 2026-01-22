/**
 * Session manager for tracking and managing terminal sessions.
 */

import { EventEmitter } from 'node:events';
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

/** Event emitted when a session is closed */
export interface SessionClosedEvent {
  sessionId: string;
  ownerId: string | null;
  hostname?: string;
  workingDir?: string;
  reason: 'graceful' | 'timeout' | 'error';
}

/** Event emitted when a session goes offline (control disconnected, waiting for reconnect) */
export interface SessionOfflineEvent {
  sessionId: string;
  ownerId: string | null;
  hostname?: string;
  workingDir?: string;
}

/** Event emitted when a session comes online (control connected and handshake received) */
export interface SessionOnlineEvent {
  sessionId: string;
  ownerId: string | null;
  ownerUsername: string | null;
  hostname?: string;
  workingDir?: string;
}

/** Info about a closed session */
export interface ClosedSessionInfo {
  id: string;
  owner: { userId: string; username: string } | null;
  hostname?: string;
  workingDir?: string;
  closedAt: string;
  reason: 'graceful' | 'timeout' | 'error';
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private closedSessions: ClosedSessionInfo[] = [];
  private config: Config;
  private readonly maxClosedSessions = 50; // Keep last 50 closed sessions

  constructor(config: Config) {
    super();
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
  deleteSession(sessionId: string, reason: 'graceful' | 'timeout' | 'error' = 'timeout'): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Add to closed sessions list
      this.addClosedSession(session, reason);

      // Emit event before closing
      const closedEvent: SessionClosedEvent = {
        sessionId: session.id,
        ownerId: session.owner?.userId || null,
        hostname: session.controlHandshake?.hostname,
        workingDir: session.controlHandshake?.workingDir,
        reason,
      };
      this.emit('sessionClosed', closedEvent);

      session.close();
      this.sessions.delete(sessionId);
      log.info({ sessionId, reason }, 'session deleted');
      return true;
    }
    return false;
  }

  /**
   * Add a session to the closed sessions list.
   */
  private addClosedSession(session: Session, reason: 'graceful' | 'timeout' | 'error'): void {
    const closedInfo: ClosedSessionInfo = {
      id: session.id,
      owner: session.owner,
      hostname: session.controlHandshake?.hostname,
      workingDir: session.controlHandshake?.workingDir,
      closedAt: new Date().toISOString(),
      reason,
    };
    this.closedSessions.unshift(closedInfo);
    // Keep only the last N closed sessions
    if (this.closedSessions.length > this.maxClosedSessions) {
      this.closedSessions = this.closedSessions.slice(0, this.maxClosedSessions);
    }
  }

  /**
   * List closed sessions for a specific user.
   */
  listClosedSessions(userId?: string): ClosedSessionInfo[] {
    if (userId) {
      return this.closedSessions.filter(s => s.owner?.userId === userId);
    }
    return [...this.closedSessions];
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

  /**
   * Notify that a session has gone offline (control disconnected, waiting for reconnect).
   */
  notifySessionOffline(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const offlineEvent: SessionOfflineEvent = {
      sessionId: session.id,
      ownerId: session.owner?.userId || null,
      hostname: session.controlHandshake?.hostname,
      workingDir: session.controlHandshake?.workingDir,
    };
    this.emit('sessionOffline', offlineEvent);
    log.info({ sessionId }, 'session offline event emitted');
  }

  /**
   * Notify that a session has come online (control connected and ready).
   */
  notifySessionOnline(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const onlineEvent: SessionOnlineEvent = {
      sessionId: session.id,
      ownerId: session.owner?.userId || null,
      ownerUsername: session.owner?.username || null,
      hostname: session.controlHandshake?.hostname,
      workingDir: session.controlHandshake?.workingDir,
    };
    this.emit('sessionOnline', onlineEvent);
    log.info({ sessionId, hostname: onlineEvent.hostname }, 'session online event emitted');
  }
}
