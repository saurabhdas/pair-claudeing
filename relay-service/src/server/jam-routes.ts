/**
 * Jam management routes.
 *
 * Jams are shared workspaces where users collaborate on terminal sessions.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getUser, type GitHubUser } from './auth-routes.js';
import { createChildLogger } from '../utils/logger.js';
import { generateFriendlyId } from '../utils/friendly-id.js';
import type { SessionManager } from '../session/index.js';
import {
  createJam,
  getJam,
  getUserJams,
  archiveJam,
  isJamParticipant,
  getJamParticipants,
  addJamParticipant,
  getJamSessions,
  addJamSession,
  removeJamSession,
  isSessionInJam,
  getPeerByLogin,
  createJamInvitation,
  getJamInvitation,
  getPendingJamInvitations,
  hasJamInvitation,
  updateJamInvitationStatus,
  cleanupOldJamInvitations,
  type JamInvitation,
} from '../db/index.js';

const log = createChildLogger('jams');

// Auth check hook for protected routes
async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const user = getUser(request);
  if (!user) {
    return reply.status(401).send({
      error: 'Not authenticated',
      code: 'NOT_AUTHENTICATED',
    });
  }
}

export interface JamRoutesOptions {
  sessionManager: SessionManager;
}

export async function registerJamRoutes(
  fastify: FastifyInstance,
  options: JamRoutesOptions
): Promise<void> {
  const { sessionManager } = options;

  // ==========================================================================
  // Jam CRUD
  // ==========================================================================

  // Create a new jam
  fastify.post('/api/jams', { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;

    // Generate a unique friendly ID
    let jamId = generateFriendlyId();

    // Ensure uniqueness (very unlikely to collide, but check anyway)
    let attempts = 0;
    while (getJam(jamId) && attempts < 10) {
      jamId = generateFriendlyId();
      attempts++;
    }

    if (attempts >= 10) {
      return reply.status(500).send({
        error: 'Failed to generate unique jam ID',
        code: 'ID_GENERATION_FAILED',
      });
    }

    const jam = createJam(jamId, user.id, user.login, user.avatar_url);
    log.info({ jamId, owner: user.login }, 'jam created');

    return { jam };
  });

  // List user's jams
  fastify.get('/api/jams', { preHandler: requireAuth }, async (request) => {
    const user = getUser(request)!;
    const jams = getUserJams(user.id);
    return jams;
  });

  // Get jam details
  fastify.get<{ Params: { jamId: string } }>(
    '/api/jams/:jamId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { jamId } = request.params;

      const jam = getJam(jamId);
      if (!jam) {
        return reply.status(404).send({
          error: 'Jam not found',
          code: 'JAM_NOT_FOUND',
        });
      }

      // Check if user is a participant
      if (!isJamParticipant(jamId, user.id)) {
        return reply.status(403).send({
          error: 'Not a participant',
          code: 'NOT_PARTICIPANT',
        });
      }

      const participants = getJamParticipants(jamId);
      const sessions = getJamSessions(jamId);

      // Enrich sessions with live status from session manager
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

      return {
        jam,
        participants,
        sessions: enrichedSessions,
      };
    }
  );

  // Archive (delete) a jam
  fastify.delete<{ Params: { jamId: string } }>(
    '/api/jams/:jamId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { jamId } = request.params;

      const jam = getJam(jamId);
      if (!jam) {
        return reply.status(404).send({
          error: 'Jam not found',
          code: 'JAM_NOT_FOUND',
        });
      }

      if (jam.owner.id !== user.id) {
        return reply.status(403).send({
          error: 'Not the jam owner',
          code: 'NOT_OWNER',
        });
      }

      archiveJam(jamId, user.id);
      log.info({ jamId, owner: user.login }, 'jam archived');

      return { success: true };
    }
  );

  // ==========================================================================
  // Jam Invitations
  // ==========================================================================

  // Invite a user to a jam (any GitHub user)
  fastify.post<{ Params: { jamId: string }; Body: { peerLogin: string } }>(
    '/api/jams/:jamId/invite',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { jamId } = request.params;
      const { peerLogin } = request.body || {};

      if (!peerLogin) {
        return reply.status(400).send({
          error: 'Missing peerLogin',
          code: 'MISSING_PEER',
        });
      }

      // Can't invite yourself
      if (peerLogin.toLowerCase() === user.login.toLowerCase()) {
        return reply.status(400).send({
          error: 'Cannot invite yourself',
          code: 'CANNOT_INVITE_SELF',
        });
      }

      // Verify jam exists and user is a participant
      const jam = getJam(jamId);
      if (!jam) {
        return reply.status(404).send({
          error: 'Jam not found',
          code: 'JAM_NOT_FOUND',
        });
      }

      if (!isJamParticipant(jamId, user.id)) {
        return reply.status(403).send({
          error: 'Not a participant',
          code: 'NOT_PARTICIPANT',
        });
      }

      // Check for existing pending invitation
      if (hasJamInvitation(jamId, peerLogin)) {
        return reply.status(400).send({
          error: 'Invitation already sent',
          code: 'ALREADY_INVITED',
        });
      }

      // Try to find in peer list first, otherwise fetch from GitHub
      let inviteeId: number;
      let inviteeLogin: string;

      const peer = getPeerByLogin(user.id, peerLogin);
      if (peer) {
        inviteeId = peer.id;
        inviteeLogin = peer.login;

        // Check if peer is already in the jam
        if (isJamParticipant(jamId, peer.id)) {
          return reply.status(400).send({
            error: 'Already a participant',
            code: 'ALREADY_PARTICIPANT',
          });
        }
      } else {
        // Fetch from GitHub API
        try {
          const response = await fetch(`https://api.github.com/users/${encodeURIComponent(peerLogin)}`, {
            headers: {
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'paircoded-relay',
            },
          });

          if (response.status === 404) {
            return reply.status(404).send({
              error: 'GitHub user not found',
              code: 'USER_NOT_FOUND',
            });
          }

          if (!response.ok) {
            log.warn({ status: response.status, peerLogin }, 'failed to fetch GitHub user for invite');
            return reply.status(502).send({
              error: 'Failed to verify GitHub user',
              code: 'GITHUB_API_ERROR',
            });
          }

          const ghUser = (await response.json()) as { id: number; login: string };
          inviteeId = ghUser.id;
          inviteeLogin = ghUser.login;

          // Check if this user is already in the jam
          if (isJamParticipant(jamId, inviteeId)) {
            return reply.status(400).send({
              error: 'Already a participant',
              code: 'ALREADY_PARTICIPANT',
            });
          }
        } catch (error) {
          log.error({ error, peerLogin }, 'error fetching GitHub user for invite');
          return reply.status(500).send({
            error: 'Failed to verify GitHub user',
            code: 'GITHUB_FETCH_FAILED',
          });
        }
      }

      // Create invitation
      const invitation: JamInvitation = {
        id: `${jamId}-${inviteeId}-${Date.now()}`,
        jamId,
        from: {
          id: user.id,
          login: user.login,
          avatar_url: user.avatar_url,
        },
        to: {
          id: inviteeId,
          login: inviteeLogin,
        },
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      createJamInvitation(invitation);
      log.info({ from: user.login, to: inviteeLogin, jamId }, 'jam invitation sent');

      return { invitation };
    }
  );

  // Get pending jam invitations for current user
  fastify.get('/api/jam-invitations', { preHandler: requireAuth }, async (request) => {
    const user = getUser(request)!;
    const invitations = getPendingJamInvitations(user.id);

    // Enrich with jam info
    const enrichedInvitations = invitations.map(inv => {
      const jam = getJam(inv.jamId);
      return {
        ...inv,
        jam: jam ? { id: jam.id, owner: jam.owner } : null,
      };
    });

    return { invitations: enrichedInvitations };
  });

  // Accept a jam invitation
  fastify.post<{ Params: { id: string } }>(
    '/api/jam-invitations/:id/accept',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { id } = request.params;

      const invitation = getJamInvitation(id);
      if (!invitation) {
        return reply.status(404).send({
          error: 'Invitation not found',
          code: 'NOT_FOUND',
        });
      }

      if (invitation.to.id !== user.id) {
        return reply.status(403).send({
          error: 'Not your invitation',
          code: 'NOT_YOURS',
        });
      }

      if (invitation.status !== 'pending') {
        return reply.status(400).send({
          error: 'Invitation already responded',
          code: 'ALREADY_RESPONDED',
        });
      }

      // Add user to jam participants
      addJamParticipant(invitation.jamId, user.id, user.login, user.avatar_url);
      updateJamInvitationStatus(id, 'accepted');

      log.info({ invitationId: id, user: user.login, jamId: invitation.jamId }, 'jam invitation accepted');

      return {
        success: true,
        jamId: invitation.jamId,
      };
    }
  );

  // Decline a jam invitation
  fastify.post<{ Params: { id: string } }>(
    '/api/jam-invitations/:id/decline',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { id } = request.params;

      const invitation = getJamInvitation(id);
      if (!invitation) {
        return reply.status(404).send({
          error: 'Invitation not found',
          code: 'NOT_FOUND',
        });
      }

      if (invitation.to.id !== user.id) {
        return reply.status(403).send({
          error: 'Not your invitation',
          code: 'NOT_YOURS',
        });
      }

      if (invitation.status !== 'pending') {
        return reply.status(400).send({
          error: 'Invitation already responded',
          code: 'ALREADY_RESPONDED',
        });
      }

      updateJamInvitationStatus(id, 'declined');
      log.info({ invitationId: id, user: user.login }, 'jam invitation declined');

      return { success: true };
    }
  );

  // ==========================================================================
  // Jam Sessions Pool
  // ==========================================================================

  // List sessions in a jam
  fastify.get<{ Params: { jamId: string } }>(
    '/api/jams/:jamId/sessions',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { jamId } = request.params;

      if (!isJamParticipant(jamId, user.id)) {
        return reply.status(403).send({
          error: 'Not a participant',
          code: 'NOT_PARTICIPANT',
        });
      }

      const sessions = getJamSessions(jamId);

      // Enrich with live status
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

      return { sessions: enrichedSessions };
    }
  );

  // Add a session to a jam
  fastify.post<{ Params: { jamId: string }; Body: { sessionId: string } }>(
    '/api/jams/:jamId/sessions',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { jamId } = request.params;
      const { sessionId } = request.body || {};

      if (!sessionId) {
        return reply.status(400).send({
          error: 'Missing sessionId',
          code: 'MISSING_SESSION_ID',
        });
      }

      if (!isJamParticipant(jamId, user.id)) {
        return reply.status(403).send({
          error: 'Not a participant',
          code: 'NOT_PARTICIPANT',
        });
      }

      // Verify session exists and user owns it
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({
          error: 'Session not found',
          code: 'SESSION_NOT_FOUND',
        });
      }

      if (session.owner?.userId !== user.id.toString()) {
        return reply.status(403).send({
          error: 'Not the session owner',
          code: 'NOT_SESSION_OWNER',
        });
      }

      // Check if session is already in jam
      if (isSessionInJam(jamId, sessionId)) {
        return reply.status(400).send({
          error: 'Session already in jam',
          code: 'ALREADY_IN_JAM',
        });
      }

      const jamSession = addJamSession(jamId, sessionId, user.id, user.login);
      log.info({ jamId, sessionId, user: user.login }, 'session added to jam');

      return {
        session: {
          ...jamSession,
          isLive: true,
          state: session.state,
          terminals: Array.from(session.terminals.values()).map(t => ({ name: t.name })),
          hostname: session.controlHandshake?.hostname,
          workingDir: session.controlHandshake?.workingDir,
        },
      };
    }
  );

  // Remove a session from a jam
  fastify.delete<{ Params: { jamId: string; sessionId: string } }>(
    '/api/jams/:jamId/sessions/:sessionId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { jamId, sessionId } = request.params;

      if (!isJamParticipant(jamId, user.id)) {
        return reply.status(403).send({
          error: 'Not a participant',
          code: 'NOT_PARTICIPANT',
        });
      }

      // Check if the session was added by this user (or user is jam owner)
      const jam = getJam(jamId);
      const sessions = getJamSessions(jamId);
      const sessionInfo = sessions.find(s => s.sessionId === sessionId);

      if (!sessionInfo) {
        return reply.status(404).send({
          error: 'Session not in jam',
          code: 'SESSION_NOT_IN_JAM',
        });
      }

      // Only the session adder or jam owner can remove
      if (sessionInfo.addedBy.userId !== user.id && jam?.owner.id !== user.id) {
        return reply.status(403).send({
          error: 'Cannot remove this session',
          code: 'CANNOT_REMOVE',
        });
      }

      removeJamSession(jamId, sessionId);
      log.info({ jamId, sessionId, user: user.login }, 'session removed from jam');

      return { success: true };
    }
  );

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  // Clean up old invitations periodically
  setInterval(() => {
    const deleted = cleanupOldJamInvitations();
    if (deleted > 0) {
      log.info({ deleted }, 'cleaned up old jam invitations');
    }
  }, 60 * 60 * 1000); // Run every hour
}
