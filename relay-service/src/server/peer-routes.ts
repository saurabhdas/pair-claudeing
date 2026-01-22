/**
 * Peer management routes.
 *
 * Peers are users that you frequently pair with.
 * They can be invited to jams.
 *
 * Data is persisted in SQLite database.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getUser, type GitHubUser } from './auth-routes.js';
import { createChildLogger } from '../utils/logger.js';
import type { SessionManager } from '../session/index.js';
import {
  getPeers,
  addPeer,
  removePeer,
  type PeerInfo,
} from '../db/index.js';

const log = createChildLogger('peers');

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

export interface PeerRoutesOptions {
  sessionManager: SessionManager;
}

export async function registerPeerRoutes(
  fastify: FastifyInstance,
  options: PeerRoutesOptions
): Promise<void> {
  // ==========================================================================
  // Peer Management
  // ==========================================================================

  // Get user's peers
  fastify.get('/api/peers', { preHandler: requireAuth }, async (request) => {
    const user = getUser(request)!;
    const peers = getPeers(user.id);
    return { peers };
  });

  // Add a peer by GitHub username
  fastify.post<{ Body: { username: string } }>(
    '/api/peers',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { username } = request.body || {};

      if (!username) {
        return reply.status(400).send({
          error: 'Missing username',
          code: 'MISSING_USERNAME',
        });
      }

      // Can't add yourself
      if (username.toLowerCase() === user.login.toLowerCase()) {
        return reply.status(400).send({
          error: 'Cannot add yourself as a peer',
          code: 'CANNOT_ADD_SELF',
        });
      }

      try {
        // Fetch GitHub user info
        const response = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
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
          log.warn({ status: response.status, username }, 'failed to fetch GitHub user');
          return reply.status(502).send({
            error: 'Failed to fetch GitHub user',
            code: 'GITHUB_API_ERROR',
          });
        }

        const ghUser = (await response.json()) as GitHubUser;

        const peer = addPeer(user.id, ghUser.id, ghUser.login, ghUser.avatar_url);
        log.info({ userId: user.id, peer: peer.login }, 'peer added');

        return { peer };
      } catch (error) {
        log.error({ error, username }, 'error adding peer');
        return reply.status(500).send({
          error: 'Failed to add peer',
          code: 'ADD_PEER_FAILED',
        });
      }
    }
  );

  // Remove a peer
  fastify.delete<{ Params: { username: string } }>(
    '/api/peers/:username',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { username } = request.params;

      const removed = removePeer(user.id, username);
      if (!removed) {
        return reply.status(404).send({
          error: 'Peer not found',
          code: 'PEER_NOT_FOUND',
        });
      }

      log.info({ userId: user.id, peer: username }, 'peer removed');
      return { success: true };
    }
  );

  // ==========================================================================
  // GitHub User Search (for autocomplete)
  // ==========================================================================

  fastify.get<{ Querystring: { q: string } }>(
    '/api/github/users',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { q } = request.query;

      if (!q || q.length < 2) {
        return { users: [] };
      }

      try {
        const response = await fetch(
          `https://api.github.com/search/users?q=${encodeURIComponent(q)}&per_page=10`,
          {
            headers: {
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'paircoded-relay',
            },
          }
        );

        if (!response.ok) {
          log.warn({ status: response.status, query: q }, 'GitHub user search failed');
          return reply.status(502).send({
            error: 'GitHub search failed',
            code: 'GITHUB_SEARCH_FAILED',
          });
        }

        const data = (await response.json()) as {
          items: Array<{ id: number; login: string; avatar_url: string }>;
        };

        const users = data.items.map((u) => ({
          id: u.id,
          login: u.login,
          avatar_url: u.avatar_url,
        }));

        return { users };
      } catch (error) {
        log.error({ error, query: q }, 'error searching GitHub users');
        return reply.status(500).send({
          error: 'Search failed',
          code: 'SEARCH_FAILED',
        });
      }
    }
  );
}
