/**
 * Jam WebSocket handler for real-time state synchronization.
 *
 * Handles:
 * - Panel selection updates
 * - Session pool changes (add/remove)
 * - Participant join/leave notifications
 */

import type { WebSocket } from 'ws';
import { createChildLogger } from '../utils/logger.js';
import type { SessionManager, SessionClosedEvent, SessionOfflineEvent, SessionOnlineEvent, TerminalClosedEvent } from '../session/index.js';
import { createCloseTerminalMessage } from '../protocol/index.js';
import type { GitHubUser } from '../server/auth-routes.js';
import {
  getJam,
  isJamParticipant,
  getJamParticipants,
  getJamSessions,
  addJamSession,
  removeJamSession,
  isSessionInJam,
  setJamPanelState,
  getJamPanelStates,
  getJamPendingInvitations,
  markJamSessionClosed,
  markJamSessionOnline,
  type JamPanelState,
  type JamInvitation,
} from '../db/index.js';

const log = createChildLogger('jam-ws');

// ============================================================================
// Types
// ============================================================================

interface JamClient {
  ws: WebSocket;
  user: GitHubUser;
  jamId: string;
}

// Client → Server messages
interface PanelSelectMessage {
  type: 'panel_select';
  panel: 'left' | 'right';
  sessionId: string | null;
  terminalName?: string;
}

interface AddSessionMessage {
  type: 'add_session';
  sessionId: string;
}

interface RemoveSessionMessage {
  type: 'remove_session';
  sessionId: string;
}

interface CloseTerminalMessage {
  type: 'close_terminal';
  sessionId: string;
  terminalName: string;
}

type ClientMessage = PanelSelectMessage | AddSessionMessage | RemoveSessionMessage | CloseTerminalMessage;

// Server → Client messages
interface JamStateMessage {
  type: 'jam_state';
  jam: {
    id: string;
    owner: { id: number; login: string; avatar_url: string };
    createdAt: string;
    status: string;
  };
  participants: Array<{
    userId: number;
    login: string;
    avatar_url: string;
    role: string;
    joinedAt: string;
    online: boolean;
  }>;
  sessions: Array<{
    sessionId: string;
    addedBy: { userId: number; login: string };
    addedAt: string;
    isLive: boolean;
    state: string;
    terminals: Array<{ name: string; createdBy: { userId: string; username: string } | null }>;
    hostname?: string;
    workingDir?: string;
  }>;
  // User's own sessions (for "Your sessions" dropdown)
  userSessions: Array<{
    id: string;
    state: string;
    controlConnected: boolean;
    hostname?: string;
    workingDir?: string;
  }>;
  pendingInvitations: Array<{
    id: string;
    to: { id: number; login: string };
    from: { id: number; login: string; avatar_url: string };
    createdAt: string;
  }>;
  // Shared panel state (same view for all participants)
  panelStates: {
    left: { sessionId: string | null; terminalName: string } | null;
    right: { sessionId: string | null; terminalName: string } | null;
  };
}

interface ParticipantUpdateMessage {
  type: 'participant_update';
  action: 'joined' | 'left';
  participant: {
    userId: number;
    login: string;
    avatar_url: string;
    role: string;
  };
}

interface SessionPoolUpdateMessage {
  type: 'session_pool_update';
  action: 'added' | 'removed';
  session?: {
    sessionId: string;
    addedBy: { userId: number; login: string };
    addedAt: string;
    isLive: boolean;
    state: string;
    terminals: Array<{ name: string }>;
    hostname?: string;
    workingDir?: string;
  };
  sessionId?: string;
}

interface PanelStateUpdateMessage {
  type: 'panel_state_update';
  panel: 'left' | 'right';
  sessionId: string | null;
}

interface ErrorMessage {
  type: 'error';
  error: string;
  code: string;
}

interface SessionStatusUpdateMessage {
  type: 'session_status_update';
  sessionId: string;
  status: 'online' | 'offline' | 'closed';
  reason?: 'graceful' | 'timeout' | 'error';
  hostname?: string;
  workingDir?: string;
}

interface TerminalClosedUpdateMessage {
  type: 'terminal_closed_update';
  sessionId: string;
  terminalName: string;
  exitCode: number;
}

// ============================================================================
// Jam Connection Manager
// ============================================================================

class JamConnectionManager {
  // Map of jamId -> Set of clients
  private jams = new Map<string, Set<JamClient>>();

  addClient(jamId: string, client: JamClient): void {
    if (!this.jams.has(jamId)) {
      this.jams.set(jamId, new Set());
    }
    this.jams.get(jamId)!.add(client);
  }

  removeClient(jamId: string, client: JamClient): void {
    const clients = this.jams.get(jamId);
    if (clients) {
      clients.delete(client);
      if (clients.size === 0) {
        this.jams.delete(jamId);
      }
    }
  }

  getClients(jamId: string): Set<JamClient> {
    return this.jams.get(jamId) || new Set();
  }

  isUserOnline(jamId: string, userId: number): boolean {
    const clients = this.jams.get(jamId);
    if (!clients) return false;
    for (const client of clients) {
      if (client.user.id === userId) return true;
    }
    return false;
  }

  broadcast(jamId: string, message: object, exclude?: JamClient): void {
    const clients = this.jams.get(jamId);
    if (!clients) return;

    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client !== exclude && client.ws.readyState === 1) {
        client.ws.send(data);
      }
    }
  }

  send(client: JamClient, message: object): void {
    if (client.ws.readyState === 1) {
      client.ws.send(JSON.stringify(message));
    }
  }

  /** Get all active jam IDs and their connected clients */
  getAllJams(): Map<string, Set<JamClient>> {
    return this.jams;
  }
}

// Global manager instance
const manager = new JamConnectionManager();

// ============================================================================
// Handler
// ============================================================================

export interface JamHandlerOptions {
  sessionManager: SessionManager;
}

export function handleJamConnection(
  socket: WebSocket,
  jamId: string,
  user: GitHubUser,
  options: JamHandlerOptions
): void {
  const { sessionManager } = options;

  log.info({ jamId, user: user.login }, 'jam WebSocket connection');

  // Verify jam exists
  const jam = getJam(jamId);
  if (!jam) {
    socket.send(JSON.stringify({ type: 'error', error: 'Jam not found', code: 'JAM_NOT_FOUND' }));
    socket.close();
    return;
  }

  // Verify user is a participant
  if (!isJamParticipant(jamId, user.id)) {
    socket.send(JSON.stringify({ type: 'error', error: 'Not a participant', code: 'NOT_PARTICIPANT' }));
    socket.close();
    return;
  }

  const client: JamClient = { ws: socket, user, jamId };
  manager.addClient(jamId, client);

  // Notify others that user joined
  manager.broadcast(jamId, {
    type: 'participant_update',
    action: 'joined',
    participant: {
      userId: user.id,
      login: user.login,
      avatar_url: user.avatar_url,
      role: jam.owner.id === user.id ? 'owner' : 'participant',
    },
  } as ParticipantUpdateMessage, client);

  // Send initial state to the new client
  sendJamState(client, sessionManager);

  // Handle messages
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      handleMessage(client, message, sessionManager);
    } catch (error) {
      log.error({ error, jamId, user: user.login }, 'error handling jam message');
      manager.send(client, { type: 'error', error: 'Invalid message', code: 'INVALID_MESSAGE' });
    }
  });

  // Handle disconnect
  socket.on('close', () => {
    log.info({ jamId, user: user.login }, 'jam WebSocket disconnected');
    manager.removeClient(jamId, client);

    // Notify others that user left
    manager.broadcast(jamId, {
      type: 'participant_update',
      action: 'left',
      participant: {
        userId: user.id,
        login: user.login,
        avatar_url: user.avatar_url,
        role: jam.owner.id === user.id ? 'owner' : 'participant',
      },
    } as ParticipantUpdateMessage);
  });

  socket.on('error', (error) => {
    log.error({ error, jamId, user: user.login }, 'jam WebSocket error');
  });
}

function sendJamState(client: JamClient, sessionManager: SessionManager): void {
  const { jamId, user } = client;

  const jam = getJam(jamId)!;
  const participants = getJamParticipants(jamId);
  const sessions = getJamSessions(jamId);
  const panelStatesArray = getJamPanelStates(jamId);
  const pendingInvitations = getJamPendingInvitations(jamId);

  // Enrich participants with online status
  const enrichedParticipants = participants.map(p => ({
    ...p,
    online: manager.isUserOnline(jamId, p.userId),
  }));

  // Enrich sessions with live status
  const enrichedSessions = sessions.map(s => {
    const liveSession = sessionManager.getSession(s.sessionId);
    const controlConnected = liveSession?.hasControl() ?? false;

    // Determine state:
    // - If live and connected → use live session state
    // - If not connected:
    //   - If closed gracefully (Ctrl+C) → 'CLOSED' (gray dot)
    //   - Otherwise (timeout/error/kill) → 'OFFLINE' (red dot)
    let state: string;
    if (liveSession && controlConnected) {
      state = liveSession.state;
    } else if (s.closedGracefully) {
      state = 'CLOSED';
    } else {
      state = 'OFFLINE';
    }

    return {
      ...s,
      isLive: controlConnected,
      state,
      terminals: liveSession ? Array.from(liveSession.terminals.values()).map(t => ({
        name: t.name,
        createdBy: t.createdBy,
      })) : [],
      // Use live session info if available, otherwise fall back to stored DB values
      hostname: liveSession?.controlHandshake?.hostname || s.hostname,
      workingDir: liveSession?.controlHandshake?.workingDir || s.workingDir,
    };
  });

  // Get user's own sessions (for "Your sessions" dropdown)
  const allSessions = sessionManager.listSessions();
  const userSessions = allSessions
    .filter(s => s.owner?.userId === user.id.toString())
    .map(s => ({
      id: s.id,
      state: s.state,
      controlConnected: s.controlConnected,
      hostname: s.controlHandshake?.hostname,
      workingDir: s.controlHandshake?.workingDir,
    }));

  // Convert panel states array to object
  const leftState = panelStatesArray.find(p => p.panel === 'left');
  const rightState = panelStatesArray.find(p => p.panel === 'right');

  const stateMessage: JamStateMessage = {
    type: 'jam_state',
    jam: {
      id: jam.id,
      owner: jam.owner,
      createdAt: jam.createdAt,
      status: jam.status,
    },
    participants: enrichedParticipants,
    sessions: enrichedSessions,
    userSessions,
    pendingInvitations: pendingInvitations.map(inv => ({
      id: inv.id,
      to: inv.to,
      from: inv.from,
      createdAt: inv.createdAt,
    })),
    panelStates: {
      left: leftState ? { sessionId: leftState.sessionId, terminalName: leftState.terminalName } : null,
      right: rightState ? { sessionId: rightState.sessionId, terminalName: rightState.terminalName } : null,
    },
  };

  manager.send(client, stateMessage);
}

function handleMessage(
  client: JamClient,
  message: ClientMessage,
  sessionManager: SessionManager
): void {
  const { jamId, user } = client;

  switch (message.type) {
    case 'panel_select':
      handlePanelSelect(client, message);
      break;

    case 'add_session':
      handleAddSession(client, message, sessionManager);
      break;

    case 'remove_session':
      handleRemoveSession(client, message, sessionManager);
      break;

    case 'close_terminal':
      handleCloseTerminal(client, message, sessionManager);
      break;

    default:
      log.warn({ jamId, user: user.login, messageType: (message as any).type }, 'unknown message type');
  }
}

function handlePanelSelect(client: JamClient, message: PanelSelectMessage): void {
  const { jamId, user } = client;
  const { panel, sessionId } = message;
  // terminalName is no longer used - terminals are named by PID and assigned on connection

  // Validate panel
  if (panel !== 'left' && panel !== 'right') {
    manager.send(client, { type: 'error', error: 'Invalid panel', code: 'INVALID_PANEL' });
    return;
  }

  // Check access control
  const jam = getJam(jamId)!;
  const isOwner = jam.owner.id === user.id;

  // Solo mode: if only one user is connected, they can control both panels
  const clients = manager.getClients(jamId);
  const uniqueUsers = new Set<number>();
  for (const c of clients) {
    uniqueUsers.add(c.user.id);
  }
  const isSolo = uniqueUsers.size <= 1;

  if (!isSolo) {
    // Owner controls left panel, participants control right panel
    if (panel === 'left' && !isOwner) {
      manager.send(client, { type: 'error', error: 'Only the owner can change the left panel', code: 'NOT_OWNER' });
      return;
    }
    if (panel === 'right' && isOwner) {
      manager.send(client, { type: 'error', error: 'The owner cannot change the right panel', code: 'OWNER_CANNOT_CHANGE_RIGHT' });
      return;
    }
  }

  // Save shared panel state (terminalName stored as 'default' - actual name assigned on connection)
  setJamPanelState(jamId, panel, sessionId, 'default');

  log.debug({ jamId, user: user.login, panel, sessionId }, 'shared panel state updated');

  // Broadcast to all participants (including sender for confirmation)
  // terminalName is no longer broadcast - determined on connection
  const updateMessage: PanelStateUpdateMessage = {
    type: 'panel_state_update',
    panel,
    sessionId,
  };

  manager.broadcast(jamId, updateMessage);
}

function handleAddSession(
  client: JamClient,
  message: AddSessionMessage,
  sessionManager: SessionManager
): void {
  const { jamId, user } = client;
  const { sessionId } = message;

  // Verify session exists and user owns it
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    manager.send(client, { type: 'error', error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    return;
  }

  if (session.owner?.userId !== user.id.toString()) {
    manager.send(client, { type: 'error', error: 'Not the session owner', code: 'NOT_SESSION_OWNER' });
    return;
  }

  // Check if already in jam
  if (isSessionInJam(jamId, sessionId)) {
    manager.send(client, { type: 'error', error: 'Session already in jam', code: 'ALREADY_IN_JAM' });
    return;
  }

  // Add session (store hostname/workingDir in DB for persistence)
  const hostname = session.controlHandshake?.hostname;
  const workingDir = session.controlHandshake?.workingDir;
  const jamSession = addJamSession(jamId, sessionId, user.id, user.login, hostname, workingDir);

  log.info({ jamId, sessionId, user: user.login, hostname }, 'session added to jam via WebSocket');

  // Broadcast to all participants
  const updateMessage: SessionPoolUpdateMessage = {
    type: 'session_pool_update',
    action: 'added',
    session: {
      ...jamSession,
      isLive: true,
      state: session.state,
      terminals: Array.from(session.terminals.values()).map(t => ({ name: t.name })),
      hostname,
      workingDir,
    },
  };

  manager.broadcast(jamId, updateMessage);
}

function handleRemoveSession(
  client: JamClient,
  message: RemoveSessionMessage,
  sessionManager: SessionManager
): void {
  const { jamId, user } = client;
  const { sessionId } = message;

  // Get session info
  const sessions = getJamSessions(jamId);
  const sessionInfo = sessions.find(s => s.sessionId === sessionId);

  if (!sessionInfo) {
    manager.send(client, { type: 'error', error: 'Session not in jam', code: 'SESSION_NOT_IN_JAM' });
    return;
  }

  // Only the session adder or jam owner can remove
  const jam = getJam(jamId)!;
  if (sessionInfo.addedBy.userId !== user.id && jam.owner.id !== user.id) {
    manager.send(client, { type: 'error', error: 'Cannot remove this session', code: 'CANNOT_REMOVE' });
    return;
  }

  // Remove session
  removeJamSession(jamId, sessionId);

  log.info({ jamId, sessionId, user: user.login }, 'session removed from jam via WebSocket');

  // Broadcast to all participants
  const updateMessage: SessionPoolUpdateMessage = {
    type: 'session_pool_update',
    action: 'removed',
    sessionId,
  };

  manager.broadcast(jamId, updateMessage);
}

function handleCloseTerminal(
  client: JamClient,
  message: CloseTerminalMessage,
  sessionManager: SessionManager
): void {
  const { jamId, user } = client;
  const { sessionId, terminalName } = message;

  // Verify session exists
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    manager.send(client, { type: 'error', error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    return;
  }

  // Only the session owner can close terminals
  if (session.owner?.userId !== user.id.toString()) {
    manager.send(client, { type: 'error', error: 'Not the session owner', code: 'NOT_SESSION_OWNER' });
    return;
  }

  // Check if terminal exists
  const terminal = session.getTerminal(terminalName);
  if (!terminal) {
    manager.send(client, { type: 'error', error: 'Terminal not found', code: 'TERMINAL_NOT_FOUND' });
    return;
  }

  // Send close_terminal command to paircoded via control connection
  if (!session.hasControl()) {
    manager.send(client, { type: 'error', error: 'Session not connected', code: 'SESSION_NOT_CONNECTED' });
    return;
  }

  const closeMessage = createCloseTerminalMessage(terminalName);
  session.controlWs!.send(JSON.stringify(closeMessage));

  log.info({ jamId, sessionId, terminalName, user: user.login }, 'close_terminal sent to paircoded');
}

// ============================================================================
// Session Status Updates
// ============================================================================

/**
 * Find all jam IDs that should receive a session status update.
 * Includes jams that have the session in their pool OR where the owner is connected.
 */
function findJamsForSession(sessionId: string, ownerId: string | null): Set<string> {
  const activeJamIds = new Set<string>();
  const allJams = manager.getAllJams();

  log.debug({ sessionId, ownerId, jamCount: allJams.size }, 'finding jams for session');

  for (const [jamId, clients] of allJams.entries()) {
    // Check if session is in this jam's pool
    const inPool = isSessionInJam(jamId, sessionId);
    if (inPool) {
      log.debug({ jamId, sessionId }, 'session is in jam pool');
      activeJamIds.add(jamId);
    }

    // Check if session owner is connected to this jam
    if (ownerId) {
      for (const client of clients) {
        const clientUserId = client.user.id.toString();
        if (clientUserId === ownerId) {
          log.debug({ jamId, sessionId, ownerId, clientUserId }, 'owner is connected to jam');
          activeJamIds.add(jamId);
          break;
        }
      }
    }
  }

  log.debug({ sessionId, foundJams: Array.from(activeJamIds) }, 'found jams for session');
  return activeJamIds;
}

/**
 * Handle a session coming online (control connected and handshake received).
 */
function handleSessionOnline(event: SessionOnlineEvent): void {
  const { sessionId, ownerId, ownerUsername, hostname, workingDir } = event;

  log.info({ sessionId, ownerId, ownerUsername, hostname }, 'handling session online event');

  // Reset closed state in DB (in case session is reconnecting)
  markJamSessionOnline(sessionId);

  const statusMessage: SessionStatusUpdateMessage = {
    type: 'session_status_update',
    sessionId,
    status: 'online',
    hostname,
    workingDir,
  };

  const activeJamIds = findJamsForSession(sessionId, ownerId);

  log.info({ sessionId, jamCount: activeJamIds.size, jams: Array.from(activeJamIds) }, 'broadcasting session online');

  for (const jamId of activeJamIds) {
    log.info({ jamId, sessionId }, 'sending session_status_update (online) to jam');
    manager.broadcast(jamId, statusMessage);
  }
}

/**
 * Handle a session going offline (control disconnected, waiting for reconnect).
 */
function handleSessionOffline(event: SessionOfflineEvent): void {
  const { sessionId, ownerId, hostname, workingDir } = event;

  log.info({ sessionId, ownerId, hostname }, 'handling session offline event');

  const statusMessage: SessionStatusUpdateMessage = {
    type: 'session_status_update',
    sessionId,
    status: 'offline',
    hostname,
    workingDir,
  };

  const activeJamIds = findJamsForSession(sessionId, ownerId);

  log.info({ sessionId, jamCount: activeJamIds.size, jams: Array.from(activeJamIds) }, 'broadcasting session offline');

  for (const jamId of activeJamIds) {
    log.info({ jamId, sessionId }, 'sending session_status_update to jam');
    manager.broadcast(jamId, statusMessage);
  }
}

/**
 * Handle a session being closed. Broadcasts to:
 * - All jams that have this session in their pool
 * - All jams where the session owner is a participant (for their "Your sessions" list)
 *
 * Only graceful closes show as 'closed' (gray). Timeout/error show as 'offline' (red).
 */
function handleSessionClosed(event: SessionClosedEvent): void {
  const { sessionId, ownerId, hostname, workingDir, reason } = event;

  // Only graceful shutdown should show as "closed" (gray dot)
  // Timeout and error should show as "offline" (red dot) - same as network drop
  const status = reason === 'graceful' ? 'closed' : 'offline';

  // Persist the closed state in DB so it survives page refresh
  markJamSessionClosed(sessionId, reason === 'graceful');

  log.info({ sessionId, ownerId, reason, status }, 'broadcasting session closed to jams');

  const statusMessage: SessionStatusUpdateMessage = {
    type: 'session_status_update',
    sessionId,
    status,
    reason,
    hostname,
    workingDir,
  };

  const activeJamIds = findJamsForSession(sessionId, ownerId);

  for (const jamId of activeJamIds) {
    log.debug({ jamId, sessionId, status }, 'broadcasting session status update to jam');
    manager.broadcast(jamId, statusMessage);
  }
}

/**
 * Handle a terminal being closed/exited.
 * Broadcasts to all jams that have this session in their pool.
 */
function handleTerminalClosed(event: TerminalClosedEvent, sessionManager: SessionManager): void {
  const { sessionId, ownerId, terminalName, exitCode } = event;

  log.info({ sessionId, terminalName, exitCode }, 'broadcasting terminal closed to jams');

  const closedMessage: TerminalClosedUpdateMessage = {
    type: 'terminal_closed_update',
    sessionId,
    terminalName,
    exitCode,
  };

  const activeJamIds = findJamsForSession(sessionId, ownerId);

  for (const jamId of activeJamIds) {
    log.debug({ jamId, sessionId, terminalName }, 'broadcasting terminal_closed_update to jam');
    manager.broadcast(jamId, closedMessage);
  }
}

/**
 * Set up event listeners for session manager events.
 * Call this once during server initialization.
 */
export function setupSessionEventListeners(sessionManager: SessionManager): void {
  sessionManager.on('sessionOnline', (event: SessionOnlineEvent) => {
    handleSessionOnline(event);
  });

  sessionManager.on('sessionOffline', (event: SessionOfflineEvent) => {
    handleSessionOffline(event);
  });

  sessionManager.on('sessionClosed', (event: SessionClosedEvent) => {
    handleSessionClosed(event);
  });

  sessionManager.on('terminalClosed', (event: TerminalClosedEvent) => {
    handleTerminalClosed(event, sessionManager);
  });

  log.info('session event listeners registered');
}

// Export manager for external access (e.g., for notifying when sessions go offline)
export { manager as jamConnectionManager };
