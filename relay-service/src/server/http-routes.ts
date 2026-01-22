/**
 * HTTP REST API routes for the relay service.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionManager } from '../session/index.js';
import { getUser } from './auth-routes.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('http-routes');

export interface HttpRoutesOptions {
  sessionManager: SessionManager;
}

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

export async function registerHttpRoutes(
  fastify: FastifyInstance,
  options: HttpRoutesOptions
): Promise<void> {
  const { sessionManager } = options;

  // Health check (public - for monitoring)
  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  // List all sessions (protected - admin only in future)
  fastify.get('/api/sessions', { preHandler: requireAuth }, async () => {
    const sessions = sessionManager.listSessions();
    return { sessions };
  });

  // List current user's sessions (protected)
  fastify.get('/api/my-sessions', { preHandler: requireAuth }, async (request) => {
    const user = getUser(request);
    if (!user) {
      return { sessions: [] };
    }

    const allSessions = sessionManager.listSessions();
    const mySessions = allSessions.filter(s => s.owner?.userId === user.id.toString());
    return { sessions: mySessions };
  });

  // List current user's closed sessions (protected)
  fastify.get('/api/my-closed-sessions', { preHandler: requireAuth }, async (request) => {
    const user = getUser(request);
    if (!user) {
      return { sessions: [] };
    }

    const closedSessions = sessionManager.listClosedSessions(user.id.toString());
    return { sessions: closedSessions };
  });

  // Get session info (protected)
  fastify.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = sessionManager.getSession(sessionId);

      if (!session) {
        return reply.status(404).send({
          error: 'Session not found',
          code: 'SESSION_NOT_FOUND',
          sessionId,
        });
      }

      return session.toInfo();
    }
  );

  // Create new session (protected)
  fastify.post<{ Body: { sessionId?: string } }>(
    '/api/sessions',
    { preHandler: requireAuth },
    async (request) => {
      const { sessionId } = request.body || {};
      const session = sessionManager.createSession(sessionId);

      log.info({ sessionId: session.id }, 'session created via API');

      return {
        sessionId: session.id,
        state: session.state,
        createdAt: session.createdAt.toISOString(),
        wsUrl: {
          paircoded: `/ws/session/${session.id}`,
          browser: `/ws/terminal/${session.id}`,
        },
      };
    }
  );

  // Delete session (protected)
  fastify.delete<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sessionId } = request.params;
      const deleted = sessionManager.deleteSession(sessionId);

      if (!deleted) {
        return reply.status(404).send({
          error: 'Session not found',
          code: 'SESSION_NOT_FOUND',
          sessionId,
        });
      }

      log.info({ sessionId }, 'session deleted via API');

      return { success: true, sessionId };
    }
  );
}
