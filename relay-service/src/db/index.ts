/**
 * SQLite database for persistent storage.
 *
 * Stores:
 * - Peers: users that you frequently pair with
 * - Jams: shared workspaces for collaboration
 * - Jam participants, sessions, and panel state
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('db');

// Database instance
let db: Database.Database | null = null;

// ============================================================================
// Types
// ============================================================================

export interface PeerRow {
  id: number;
  user_id: number;
  peer_id: number;
  peer_login: string;
  peer_avatar_url: string;
  added_at: string;
}

// Jam types
export interface JamRow {
  id: string;
  owner_id: number;
  owner_login: string;
  owner_avatar_url: string;
  created_at: string;
  status: 'active' | 'archived';
}

export interface JamParticipantRow {
  jam_id: string;
  user_id: number;
  user_login: string;
  user_avatar_url: string;
  role: 'owner' | 'participant';
  joined_at: string;
}

export interface JamSessionRow {
  jam_id: string;
  session_id: string;
  added_by_user_id: number;
  added_by_login: string;
  added_at: string;
}

export interface JamPanelStateRow {
  jam_id: string;
  user_id: number;
  panel: 'left' | 'right';
  session_id: string | null;
  terminal_name: string;
}

export interface JamInvitationRow {
  id: string;
  jam_id: string;
  from_id: number;
  from_login: string;
  from_avatar_url: string;
  to_id: number;
  to_login: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the database.
 * @param dbPath Path to the SQLite database file. Defaults to ./data/paircoded.db
 */
export function initDatabase(dbPath?: string): Database.Database {
  if (db) {
    return db;
  }

  const resolvedPath = dbPath || path.join(process.cwd(), 'data', 'paircoded.db');

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  import('node:fs').then(fs => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  log.info({ path: resolvedPath }, 'initializing database');

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Create tables
  createTables(db);

  log.info('database initialized');

  return db;
}

/**
 * Get the database instance.
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    log.info('database closed');
  }
}

// ============================================================================
// Schema
// ============================================================================

function createTables(database: Database.Database): void {
  // Peers table
  database.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      peer_id INTEGER NOT NULL,
      peer_login TEXT NOT NULL,
      peer_avatar_url TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, peer_id)
    )
  `);

  // Jams table
  database.exec(`
    CREATE TABLE IF NOT EXISTS jams (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      owner_login TEXT NOT NULL,
      owner_avatar_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);

  // Jam participants table
  database.exec(`
    CREATE TABLE IF NOT EXISTS jam_participants (
      jam_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      user_login TEXT NOT NULL,
      user_avatar_url TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'participant',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(jam_id, user_id)
    )
  `);

  // Jam sessions table (sessions in the pool)
  database.exec(`
    CREATE TABLE IF NOT EXISTS jam_sessions (
      jam_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      added_by_user_id INTEGER NOT NULL,
      added_by_login TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(jam_id, session_id)
    )
  `);

  // Jam panel state (persisted for reconnection)
  database.exec(`
    CREATE TABLE IF NOT EXISTS jam_panel_state (
      jam_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      panel TEXT NOT NULL,
      session_id TEXT,
      terminal_name TEXT NOT NULL DEFAULT 'main',
      UNIQUE(jam_id, user_id, panel)
    )
  `);

  // Jam invitations table
  database.exec(`
    CREATE TABLE IF NOT EXISTS jam_invitations (
      id TEXT PRIMARY KEY,
      jam_id TEXT NOT NULL,
      from_id INTEGER NOT NULL,
      from_login TEXT NOT NULL,
      from_avatar_url TEXT NOT NULL,
      to_id INTEGER NOT NULL,
      to_login TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Create indexes
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_peers_user_id ON peers(user_id);
    CREATE INDEX IF NOT EXISTS idx_jams_owner_id ON jams(owner_id);
    CREATE INDEX IF NOT EXISTS idx_jam_participants_jam_id ON jam_participants(jam_id);
    CREATE INDEX IF NOT EXISTS idx_jam_participants_user_id ON jam_participants(user_id);
    CREATE INDEX IF NOT EXISTS idx_jam_sessions_jam_id ON jam_sessions(jam_id);
    CREATE INDEX IF NOT EXISTS idx_jam_panel_state_jam_id ON jam_panel_state(jam_id);
    CREATE INDEX IF NOT EXISTS idx_jam_invitations_to_id ON jam_invitations(to_id);
    CREATE INDEX IF NOT EXISTS idx_jam_invitations_jam_id ON jam_invitations(jam_id);
  `);
}

// ============================================================================
// Peer Operations
// ============================================================================

export interface PeerInfo {
  id: number;
  login: string;
  avatar_url: string;
  addedAt: string;
}

/**
 * Get all peers for a user.
 */
export function getPeers(userId: number): PeerInfo[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT peer_id, peer_login, peer_avatar_url, added_at
    FROM peers
    WHERE user_id = ?
    ORDER BY peer_login
  `);

  const rows = stmt.all(userId) as Array<{
    peer_id: number;
    peer_login: string;
    peer_avatar_url: string;
    added_at: string;
  }>;

  return rows.map(row => ({
    id: row.peer_id,
    login: row.peer_login,
    avatar_url: row.peer_avatar_url,
    addedAt: row.added_at,
  }));
}

/**
 * Add a peer for a user.
 */
export function addPeer(
  userId: number,
  peerId: number,
  peerLogin: string,
  peerAvatarUrl: string
): PeerInfo {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO peers (user_id, peer_id, peer_login, peer_avatar_url, added_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, peer_id) DO UPDATE SET
      peer_login = excluded.peer_login,
      peer_avatar_url = excluded.peer_avatar_url
  `);

  stmt.run(userId, peerId, peerLogin, peerAvatarUrl);

  return {
    id: peerId,
    login: peerLogin,
    avatar_url: peerAvatarUrl,
    addedAt: new Date().toISOString(),
  };
}

/**
 * Remove a peer for a user.
 */
export function removePeer(userId: number, peerLogin: string): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    DELETE FROM peers
    WHERE user_id = ? AND peer_login = ?
  `);

  const result = stmt.run(userId, peerLogin);
  return result.changes > 0;
}

/**
 * Check if a user has a specific peer.
 */
export function hasPeer(userId: number, peerLogin: string): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT 1 FROM peers
    WHERE user_id = ? AND peer_login = ?
  `);

  const row = stmt.get(userId, peerLogin);
  return !!row;
}

/**
 * Get a peer by login.
 */
export function getPeerByLogin(userId: number, peerLogin: string): PeerInfo | null {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT peer_id, peer_login, peer_avatar_url, added_at
    FROM peers
    WHERE user_id = ? AND peer_login = ?
  `);

  const row = stmt.get(userId, peerLogin) as {
    peer_id: number;
    peer_login: string;
    peer_avatar_url: string;
    added_at: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.peer_id,
    login: row.peer_login,
    avatar_url: row.peer_avatar_url,
    addedAt: row.added_at,
  };
}

// ============================================================================
// Jam Operations
// ============================================================================

export interface Jam {
  id: string;
  owner: {
    id: number;
    login: string;
    avatar_url: string;
  };
  createdAt: string;
  status: 'active' | 'archived';
}

export interface JamParticipant {
  userId: number;
  login: string;
  avatar_url: string;
  role: 'owner' | 'participant';
  joinedAt: string;
}

export interface JamSession {
  sessionId: string;
  addedBy: {
    userId: number;
    login: string;
  };
  addedAt: string;
}

export interface JamPanelState {
  panel: 'left' | 'right';
  sessionId: string | null;
  terminalName: string;
}

export interface JamInvitation {
  id: string;
  jamId: string;
  from: {
    id: number;
    login: string;
    avatar_url: string;
  };
  to: {
    id: number;
    login: string;
  };
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}

/**
 * Create a new jam.
 */
export function createJam(
  jamId: string,
  ownerId: number,
  ownerLogin: string,
  ownerAvatarUrl: string
): Jam {
  const database = getDatabase();

  // Create the jam
  const jamStmt = database.prepare(`
    INSERT INTO jams (id, owner_id, owner_login, owner_avatar_url, created_at, status)
    VALUES (?, ?, ?, ?, datetime('now'), 'active')
  `);
  jamStmt.run(jamId, ownerId, ownerLogin, ownerAvatarUrl);

  // Add owner as a participant
  const participantStmt = database.prepare(`
    INSERT INTO jam_participants (jam_id, user_id, user_login, user_avatar_url, role, joined_at)
    VALUES (?, ?, ?, ?, 'owner', datetime('now'))
  `);
  participantStmt.run(jamId, ownerId, ownerLogin, ownerAvatarUrl);

  return {
    id: jamId,
    owner: {
      id: ownerId,
      login: ownerLogin,
      avatar_url: ownerAvatarUrl,
    },
    createdAt: new Date().toISOString(),
    status: 'active',
  };
}

/**
 * Get a jam by ID.
 */
export function getJam(jamId: string): Jam | null {
  const database = getDatabase();
  const stmt = database.prepare(`SELECT * FROM jams WHERE id = ?`);
  const row = stmt.get(jamId) as JamRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    owner: {
      id: row.owner_id,
      login: row.owner_login,
      avatar_url: row.owner_avatar_url,
    },
    createdAt: row.created_at,
    status: row.status,
  };
}

/**
 * Get all jams for a user (owned + participating).
 */
export function getUserJams(userId: number): { owned: Jam[]; participating: Jam[] } {
  const database = getDatabase();

  // Get owned jams
  const ownedStmt = database.prepare(`
    SELECT * FROM jams WHERE owner_id = ? AND status = 'active' ORDER BY created_at DESC
  `);
  const ownedRows = ownedStmt.all(userId) as JamRow[];

  // Get participating jams (excluding owned)
  const participatingStmt = database.prepare(`
    SELECT j.* FROM jams j
    JOIN jam_participants p ON j.id = p.jam_id
    WHERE p.user_id = ? AND j.owner_id != ? AND j.status = 'active'
    ORDER BY j.created_at DESC
  `);
  const participatingRows = participatingStmt.all(userId, userId) as JamRow[];

  const rowToJam = (row: JamRow): Jam => ({
    id: row.id,
    owner: {
      id: row.owner_id,
      login: row.owner_login,
      avatar_url: row.owner_avatar_url,
    },
    createdAt: row.created_at,
    status: row.status,
  });

  return {
    owned: ownedRows.map(rowToJam),
    participating: participatingRows.map(rowToJam),
  };
}

/**
 * Archive a jam (soft delete).
 */
export function archiveJam(jamId: string, userId: number): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE jams SET status = 'archived' WHERE id = ? AND owner_id = ?
  `);
  const result = stmt.run(jamId, userId);
  return result.changes > 0;
}

/**
 * Check if user is a participant in a jam.
 */
export function isJamParticipant(jamId: string, userId: number): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT 1 FROM jam_participants WHERE jam_id = ? AND user_id = ?
  `);
  return !!stmt.get(jamId, userId);
}

/**
 * Get participants of a jam.
 */
export function getJamParticipants(jamId: string): JamParticipant[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM jam_participants WHERE jam_id = ? ORDER BY joined_at
  `);
  const rows = stmt.all(jamId) as JamParticipantRow[];

  return rows.map(row => ({
    userId: row.user_id,
    login: row.user_login,
    avatar_url: row.user_avatar_url,
    role: row.role,
    joinedAt: row.joined_at,
  }));
}

/**
 * Add a participant to a jam.
 */
export function addJamParticipant(
  jamId: string,
  userId: number,
  userLogin: string,
  userAvatarUrl: string
): JamParticipant {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO jam_participants (jam_id, user_id, user_login, user_avatar_url, role, joined_at)
    VALUES (?, ?, ?, ?, 'participant', datetime('now'))
    ON CONFLICT(jam_id, user_id) DO UPDATE SET
      user_login = excluded.user_login,
      user_avatar_url = excluded.user_avatar_url
  `);
  stmt.run(jamId, userId, userLogin, userAvatarUrl);

  return {
    userId,
    login: userLogin,
    avatar_url: userAvatarUrl,
    role: 'participant',
    joinedAt: new Date().toISOString(),
  };
}

/**
 * Remove a participant from a jam.
 */
export function removeJamParticipant(jamId: string, userId: number): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    DELETE FROM jam_participants WHERE jam_id = ? AND user_id = ? AND role != 'owner'
  `);
  const result = stmt.run(jamId, userId);
  return result.changes > 0;
}

// ============================================================================
// Jam Session Pool Operations
// ============================================================================

/**
 * Get sessions in a jam.
 */
export function getJamSessions(jamId: string): JamSession[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM jam_sessions WHERE jam_id = ? ORDER BY added_at
  `);
  const rows = stmt.all(jamId) as JamSessionRow[];

  return rows.map(row => ({
    sessionId: row.session_id,
    addedBy: {
      userId: row.added_by_user_id,
      login: row.added_by_login,
    },
    addedAt: row.added_at,
  }));
}

/**
 * Add a session to a jam's pool.
 */
export function addJamSession(
  jamId: string,
  sessionId: string,
  addedByUserId: number,
  addedByLogin: string
): JamSession {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO jam_sessions (jam_id, session_id, added_by_user_id, added_by_login, added_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(jam_id, session_id) DO NOTHING
  `);
  stmt.run(jamId, sessionId, addedByUserId, addedByLogin);

  return {
    sessionId,
    addedBy: {
      userId: addedByUserId,
      login: addedByLogin,
    },
    addedAt: new Date().toISOString(),
  };
}

/**
 * Remove a session from a jam's pool.
 */
export function removeJamSession(jamId: string, sessionId: string): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    DELETE FROM jam_sessions WHERE jam_id = ? AND session_id = ?
  `);
  const result = stmt.run(jamId, sessionId);
  return result.changes > 0;
}

/**
 * Check if a session is in a jam's pool.
 */
export function isSessionInJam(jamId: string, sessionId: string): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT 1 FROM jam_sessions WHERE jam_id = ? AND session_id = ?
  `);
  return !!stmt.get(jamId, sessionId);
}

// ============================================================================
// Jam Panel State Operations
// ============================================================================

/**
 * Get panel state for a user in a jam.
 */
export function getJamPanelState(jamId: string, userId: number): JamPanelState[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM jam_panel_state WHERE jam_id = ? AND user_id = ?
  `);
  const rows = stmt.all(jamId, userId) as JamPanelStateRow[];

  return rows.map(row => ({
    panel: row.panel,
    sessionId: row.session_id,
    terminalName: row.terminal_name,
  }));
}

/**
 * Set panel state for a user in a jam.
 */
export function setJamPanelState(
  jamId: string,
  userId: number,
  panel: 'left' | 'right',
  sessionId: string | null,
  terminalName: string = 'main'
): JamPanelState {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO jam_panel_state (jam_id, user_id, panel, session_id, terminal_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jam_id, user_id, panel) DO UPDATE SET
      session_id = excluded.session_id,
      terminal_name = excluded.terminal_name
  `);
  stmt.run(jamId, userId, panel, sessionId, terminalName);

  return { panel, sessionId, terminalName };
}

/**
 * Get all panel states for a jam (for broadcasting).
 */
export function getAllJamPanelStates(jamId: string): Map<number, JamPanelState[]> {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM jam_panel_state WHERE jam_id = ?
  `);
  const rows = stmt.all(jamId) as JamPanelStateRow[];

  const statesByUser = new Map<number, JamPanelState[]>();
  for (const row of rows) {
    if (!statesByUser.has(row.user_id)) {
      statesByUser.set(row.user_id, []);
    }
    statesByUser.get(row.user_id)!.push({
      panel: row.panel,
      sessionId: row.session_id,
      terminalName: row.terminal_name,
    });
  }

  return statesByUser;
}

// ============================================================================
// Jam Invitation Operations
// ============================================================================

/**
 * Create a jam invitation.
 */
export function createJamInvitation(invitation: JamInvitation): JamInvitation {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO jam_invitations (id, jam_id, from_id, from_login, from_avatar_url, to_id, to_login, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  stmt.run(
    invitation.id,
    invitation.jamId,
    invitation.from.id,
    invitation.from.login,
    invitation.from.avatar_url,
    invitation.to.id,
    invitation.to.login,
    invitation.status
  );

  return invitation;
}

/**
 * Get a jam invitation by ID.
 */
export function getJamInvitation(invitationId: string): JamInvitation | null {
  const database = getDatabase();
  const stmt = database.prepare(`SELECT * FROM jam_invitations WHERE id = ?`);
  const row = stmt.get(invitationId) as JamInvitationRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    jamId: row.jam_id,
    from: {
      id: row.from_id,
      login: row.from_login,
      avatar_url: row.from_avatar_url,
    },
    to: {
      id: row.to_id,
      login: row.to_login,
    },
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Get pending jam invitations for a user.
 */
export function getPendingJamInvitations(userId: number): JamInvitation[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM jam_invitations
    WHERE to_id = ? AND status = 'pending'
    ORDER BY created_at DESC
  `);

  const rows = stmt.all(userId) as JamInvitationRow[];
  return rows.map(row => ({
    id: row.id,
    jamId: row.jam_id,
    from: {
      id: row.from_id,
      login: row.from_login,
      avatar_url: row.from_avatar_url,
    },
    to: {
      id: row.to_id,
      login: row.to_login,
    },
    status: row.status,
    createdAt: row.created_at,
  }));
}

/**
 * Get pending invitations for a jam (outgoing invitations).
 */
export function getJamPendingInvitations(jamId: string): JamInvitation[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM jam_invitations
    WHERE jam_id = ? AND status = 'pending'
    ORDER BY created_at DESC
  `);

  const rows = stmt.all(jamId) as JamInvitationRow[];
  return rows.map(row => ({
    id: row.id,
    jamId: row.jam_id,
    from: {
      id: row.from_id,
      login: row.from_login,
      avatar_url: row.from_avatar_url,
    },
    to: {
      id: row.to_id,
      login: row.to_login,
    },
    status: row.status,
    createdAt: row.created_at,
  }));
}

/**
 * Check if a jam invitation already exists.
 */
export function hasJamInvitation(jamId: string, toLogin: string): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT 1 FROM jam_invitations
    WHERE jam_id = ? AND to_login = ? AND status = 'pending'
  `);
  return !!stmt.get(jamId, toLogin);
}

/**
 * Update jam invitation status.
 */
export function updateJamInvitationStatus(
  invitationId: string,
  status: 'accepted' | 'declined'
): boolean {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE jam_invitations SET status = ? WHERE id = ?
  `);
  const result = stmt.run(status, invitationId);
  return result.changes > 0;
}

/**
 * Clean up old jam invitations (older than 7 days).
 */
export function cleanupOldJamInvitations(): number {
  const database = getDatabase();
  const stmt = database.prepare(`
    DELETE FROM jam_invitations
    WHERE created_at < datetime('now', '-7 days')
  `);
  const result = stmt.run();
  return result.changes;
}
