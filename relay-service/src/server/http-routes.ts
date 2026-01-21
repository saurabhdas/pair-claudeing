/**
 * HTTP REST API routes for the relay service.
 */

import type { FastifyInstance } from 'fastify';
import { SessionManager } from '../session/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('http-routes');

export interface HttpRoutesOptions {
  sessionManager: SessionManager;
}

export async function registerHttpRoutes(
  fastify: FastifyInstance,
  options: HttpRoutesOptions
): Promise<void> {
  const { sessionManager } = options;

  // Health check
  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      sessions: sessionManager.getSessionCount(),
    };
  });

  // List all sessions
  fastify.get('/api/sessions', async () => {
    const sessions = sessionManager.listSessions();
    return { sessions };
  });

  // Get session info
  fastify.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
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
  });

  // Create new session
  fastify.post<{ Body: { sessionId?: string } }>('/api/sessions', async (request) => {
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
  });

  // Delete session
  fastify.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
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
  });
}
