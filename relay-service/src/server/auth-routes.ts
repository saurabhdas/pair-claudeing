/**
 * GitHub OAuth authentication routes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import { createChildLogger } from '../utils/logger.js';
import type { Config } from '../config.js';
import { createToken } from './jwt.js';

const log = createChildLogger('auth');

// In-memory store for OAuth state (prevents CSRF)
const oauthStates = new Map<string, { createdAt: number; returnTo?: string }>();

// In-memory session store (maps session ID to user info)
// In production, use Redis or a database
const sessions = new Map<string, GitHubUser>();

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface AuthRoutesOptions {
  config: Config;
}

// Clean up expired OAuth states (older than 10 minutes)
function cleanupStates() {
  const now = Date.now();
  for (const [state, data] of oauthStates) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      oauthStates.delete(state);
    }
  }
}

// Periodically clean up states
setInterval(cleanupStates, 60 * 1000);

export async function registerAuthRoutes(
  fastify: FastifyInstance,
  options: AuthRoutesOptions
): Promise<void> {
  const { config } = options;

  // Check if GitHub OAuth is configured
  const isConfigured = config.github.clientId && config.github.clientSecret;

  // Redirect to GitHub OAuth
  fastify.get('/auth/github', async (request, reply) => {
    if (!isConfigured) {
      return reply.status(500).send({
        error: 'GitHub OAuth not configured',
        code: 'OAUTH_NOT_CONFIGURED',
      });
    }

    // Generate state for CSRF protection
    const state = randomBytes(16).toString('hex');
    const returnTo = (request.query as { returnTo?: string }).returnTo;
    oauthStates.set(state, { createdAt: Date.now(), returnTo });

    const params = new URLSearchParams({
      client_id: config.github.clientId,
      redirect_uri: config.github.callbackUrl,
      scope: 'read:user',
      state,
    });

    const githubAuthUrl = `https://github.com/login/oauth/authorize?${params}`;
    log.info({ returnTo }, 'redirecting to GitHub OAuth');

    return reply.redirect(githubAuthUrl);
  });

  // GitHub OAuth callback
  fastify.get('/auth/github/callback', async (request, reply) => {
    if (!isConfigured) {
      return reply.status(500).send({
        error: 'GitHub OAuth not configured',
        code: 'OAUTH_NOT_CONFIGURED',
      });
    }

    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      return reply.status(400).send({
        error: 'Missing code or state',
        code: 'INVALID_CALLBACK',
      });
    }

    // Verify state
    const stateData = oauthStates.get(state);
    if (!stateData) {
      return reply.status(400).send({
        error: 'Invalid or expired state',
        code: 'INVALID_STATE',
      });
    }
    oauthStates.delete(state);

    try {
      // Exchange code for access token
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: config.github.clientId,
          client_secret: config.github.clientSecret,
          code,
        }),
      });

      const tokenData = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        log.error({ error: tokenData.error }, 'failed to exchange code for token');
        return reply.status(400).send({
          error: tokenData.error_description || 'Failed to get access token',
          code: 'TOKEN_EXCHANGE_FAILED',
        });
      }

      // Get user info
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!userResponse.ok) {
        log.error({ status: userResponse.status }, 'failed to get user info');
        return reply.status(400).send({
          error: 'Failed to get user info',
          code: 'USER_INFO_FAILED',
        });
      }

      const user = (await userResponse.json()) as GitHubUser;

      // Create session
      const sessionId = randomBytes(32).toString('hex');
      sessions.set(sessionId, {
        id: user.id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
      });

      log.info({ userId: user.id, login: user.login }, 'user authenticated');

      // Set session cookie
      reply.setCookie('session', sessionId, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60, // 7 days
      });

      // Redirect to original destination or home
      const returnTo = stateData.returnTo || '/';
      return reply.redirect(returnTo);
    } catch (error) {
      log.error({ error }, 'OAuth callback error');
      return reply.status(500).send({
        error: 'Authentication failed',
        code: 'AUTH_FAILED',
      });
    }
  });

  // Get current user
  fastify.get('/auth/me', async (request, reply) => {
    const user = getUser(request);
    if (!user) {
      return reply.status(401).send({
        error: 'Not authenticated',
        code: 'NOT_AUTHENTICATED',
      });
    }
    return user;
  });

  // Logout
  fastify.post('/auth/logout', async (request, reply) => {
    const sessionId = request.cookies.session;
    if (sessionId) {
      sessions.delete(sessionId);
    }

    reply.clearCookie('session', { path: '/' });
    return { success: true };
  });

  // Auth status (for frontend to check without 401)
  fastify.get('/auth/status', async (request) => {
    const user = getUser(request);
    return {
      authenticated: !!user,
      user: user || null,
    };
  });

  // Exchange GitHub token for relay JWT (for CLI authentication)
  fastify.post('/api/auth/token', async (request, reply) => {
    const body = request.body as { github_token?: string };

    if (!body.github_token) {
      return reply.status(400).send({
        error: 'Missing github_token',
        code: 'MISSING_TOKEN',
      });
    }

    try {
      // Validate the GitHub token by fetching user info
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${body.github_token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'paircoded-relay',
        },
      });

      if (!userResponse.ok) {
        log.warn({ status: userResponse.status }, 'invalid GitHub token');
        return reply.status(401).send({
          error: 'Invalid GitHub token',
          code: 'INVALID_GITHUB_TOKEN',
        });
      }

      const user = (await userResponse.json()) as GitHubUser;

      // Create relay JWT
      const { token, expiresIn } = createToken(user.id, user.login, config);

      log.info({ userId: user.id, login: user.login }, 'issued relay JWT for CLI');

      return {
        token,
        expiresIn,
        user: {
          id: user.id,
          login: user.login,
          name: user.name,
          avatar_url: user.avatar_url,
        },
      };
    } catch (error) {
      log.error({ error }, 'failed to validate GitHub token');
      return reply.status(500).send({
        error: 'Failed to validate token',
        code: 'VALIDATION_FAILED',
      });
    }
  });
}

/**
 * Get the authenticated user from a request.
 */
export function getUser(request: FastifyRequest): GitHubUser | null {
  const sessionId = request.cookies.session;
  if (!sessionId) {
    return null;
  }
  return sessions.get(sessionId) || null;
}

/**
 * Require authentication middleware.
 */
export function requireAuth(request: FastifyRequest, reply: FastifyReply): GitHubUser {
  const user = getUser(request);
  if (!user) {
    reply.status(401).send({
      error: 'Not authenticated',
      code: 'NOT_AUTHENTICATED',
    });
    throw new Error('Not authenticated');
  }
  return user;
}
