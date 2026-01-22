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
import type { SessionManager } from '../session/index.js';
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
  getAllJamPanelStates,
  getJamPendingInvitations,
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

type ClientMessage = PanelSelectMessage | AddSessionMessage | RemoveSessionMessage;

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
    panelStates?: JamPanelState[];
  }>;
  sessions: Array<{
    sessionId: string;
    addedBy: { userId: number; login: string };
    addedAt: string;
    isLive: boolean;
    state: string;
    terminals: Array<{ name: string }>;
    hostname?: string;
    workingDir?: string;
  }>;
  pendingInvitations: Array<{
    id: string;
    to: { id: number; login: string };
    from: { id: number; login: string; avatar_url: string };
    createdAt: string;
  }>;
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
  userId: number;
  login: string;
  panel: 'left' | 'right';
  sessionId: string | null;
  terminalName: string;
}

interface ErrorMessage {
  type: 'error';
  error: string;
  code: string;
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
  const panelStates = getAllJamPanelStates(jamId);
  const pendingInvitations = getJamPendingInvitations(jamId);

  // Enrich participants with online status and panel states
  const enrichedParticipants = participants.map(p => ({
    ...p,
    online: manager.isUserOnline(jamId, p.userId),
    panelStates: panelStates.get(p.userId) || [],
  }));

  // Enrich sessions with live status
  const enrichedSessions = sessions.map(s => {
    const liveSession = sessionManager.getSession(s.sessionId);
    return {
      ...s,
      isLive: !!liveSession,
      state: liveSession?.state || 'OFFLINE',
      terminals: liveSession ? Array.from(liveSession.terminals.values()).map(t => ({ name: t.name })) : [],
      hostname: liveSession?.controlHandshake?.hostname,
      workingDir: liveSession?.controlHandshake?.workingDir,
    };
  });

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
    pendingInvitations: pendingInvitations.map(inv => ({
      id: inv.id,
      to: inv.to,
      from: inv.from,
      createdAt: inv.createdAt,
    })),
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

    default:
      log.warn({ jamId, user: user.login, messageType: (message as any).type }, 'unknown message type');
  }
}

function handlePanelSelect(client: JamClient, message: PanelSelectMessage): void {
  const { jamId, user } = client;
  const { panel, sessionId, terminalName = 'main' } = message;

  // Validate panel
  if (panel !== 'left' && panel !== 'right') {
    manager.send(client, { type: 'error', error: 'Invalid panel', code: 'INVALID_PANEL' });
    return;
  }

  // Save panel state
  setJamPanelState(jamId, user.id, panel, sessionId, terminalName);

  log.debug({ jamId, user: user.login, panel, sessionId, terminalName }, 'panel state updated');

  // Broadcast to all participants
  const updateMessage: PanelStateUpdateMessage = {
    type: 'panel_state_update',
    userId: user.id,
    login: user.login,
    panel,
    sessionId,
    terminalName,
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

  // Add session
  const jamSession = addJamSession(jamId, sessionId, user.id, user.login);

  log.info({ jamId, sessionId, user: user.login }, 'session added to jam via WebSocket');

  // Broadcast to all participants
  const updateMessage: SessionPoolUpdateMessage = {
    type: 'session_pool_update',
    action: 'added',
    session: {
      ...jamSession,
      isLive: true,
      state: session.state,
      terminals: Array.from(session.terminals.values()).map(t => ({ name: t.name })),
      hostname: session.controlHandshake?.hostname,
      workingDir: session.controlHandshake?.workingDir,
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

// Export manager for external access (e.g., for notifying when sessions go offline)
export { manager as jamConnectionManager };
