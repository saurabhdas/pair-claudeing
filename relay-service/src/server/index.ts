/**
 * Fastify server setup with WebSocket support.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { SessionManager } from '../session/index.js';
import { handleBrowserConnection } from '../websocket/browser-handler.js';
import { handleControlConnection } from '../websocket/control-handler.js';
import { handleTerminalDataConnection } from '../websocket/terminal-data-handler.js';
import { handleJamConnection } from '../websocket/jam-handler.js';
import { registerHttpRoutes } from './http-routes.js';
import { registerAuthRoutes, getUser } from './auth-routes.js';
import { registerPeerRoutes } from './peer-routes.js';
import { registerJamRoutes } from './jam-routes.js';
import { createChildLogger } from '../utils/logger.js';
import type { Config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = createChildLogger('server');

export interface ServerOptions {
  config: Config;
  sessionManager: SessionManager;
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const { config, sessionManager } = options;

  const fastify = Fastify({
    logger: false, // We use pino directly
  });

  // Register cookie plugin
  await fastify.register(fastifyCookie, {
    secret: config.cookieSecret,
  });

  // Register WebSocket plugin
  await fastify.register(websocket, {
    options: {
      maxPayload: 1024 * 1024, // 1MB max payload
    },
  });

  // Register static file serving
  // Use process.cwd() to get project root
  const publicDir = path.join(process.cwd(), 'public');
  log.info({ publicDir }, 'serving static files from');
  await fastify.register(fastifyStatic, {
    root: publicDir,
  });

  // Register auth routes
  await registerAuthRoutes(fastify, { config });

  // Home page
  fastify.get('/', async (request, reply) => {
    return reply.sendFile('home.html');
  });

  // Login page
  fastify.get('/login', async (request, reply) => {
    return reply.sendFile('login.html');
  });

  // Terminal page route (serves index.html for split-view)
  // URL format: /terminal/<session1>:<terminal1>/<session2>:<terminal2>
  // If :terminalN is omitted, defaults to "main"
  // Requires authentication
  fastify.get('/terminal/:left/:right', async (request, reply) => {
    const user = getUser(request);
    if (!user) {
      // Redirect to login with return URL
      const returnTo = encodeURIComponent(request.url);
      return reply.redirect(`/login?returnTo=${returnTo}`);
    }
    return reply.sendFile('index.html');
  });

  // Jam page route
  // URL format: /jam/<jamId>
  // Requires authentication
  fastify.get('/jam/:jamId', async (request, reply) => {
    const user = getUser(request);
    if (!user) {
      const returnTo = encodeURIComponent(request.url);
      return reply.redirect(`/login?returnTo=${returnTo}`);
    }
    return reply.sendFile('jam.html');
  });

  // Register HTTP routes
  await registerHttpRoutes(fastify, { sessionManager });

  // Register peer routes
  await registerPeerRoutes(fastify, { sessionManager });

  // Register jam routes
  await registerJamRoutes(fastify, { sessionManager });

  // WebSocket route for paircoded CONTROL connections
  fastify.get<{ Params: { sessionId: string } }>(
    '/ws/control/:sessionId',
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      const authHeader = request.headers.authorization;
      log.info({ sessionId, remoteAddress: request.ip, hasAuth: !!authHeader }, 'paircoded control WebSocket connection');
      handleControlConnection(socket, sessionId, { sessionManager, config, authHeader });
    }
  );

  // WebSocket route for paircoded TERMINAL DATA connections
  fastify.get<{ Params: { sessionId: string; terminalName: string } }>(
    '/ws/terminal-data/:sessionId/:terminalName',
    { websocket: true },
    (socket, request) => {
      const { sessionId, terminalName } = request.params;
      const authHeader = request.headers.authorization;
      log.info({ sessionId, terminalName, remoteAddress: request.ip, hasAuth: !!authHeader }, 'terminal data WebSocket connection');
      handleTerminalDataConnection(socket, sessionId, terminalName, { sessionManager, config, authHeader });
    }
  );

  // WebSocket route for browser connections
  fastify.get<{ Params: { sessionId: string } }>(
    '/ws/terminal/:sessionId',
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      log.info({ sessionId, remoteAddress: request.ip }, 'browser WebSocket connection');
      handleBrowserConnection(socket, sessionId, { sessionManager });
    }
  );

  // WebSocket route for jam connections
  fastify.get<{ Params: { jamId: string } }>(
    '/ws/jam/:jamId',
    { websocket: true },
    (socket, request) => {
      const { jamId } = request.params;
      const user = getUser(request);
      log.info({ jamId, remoteAddress: request.ip, user: user?.login }, 'jam WebSocket connection');

      if (!user) {
        socket.send(JSON.stringify({ type: 'error', error: 'Not authenticated', code: 'NOT_AUTHENTICATED' }));
        socket.close();
        return;
      }

      handleJamConnection(socket, jamId, user, { sessionManager });
    }
  );

  // Error handler
  fastify.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    log.error({ error: error.message, stack: error.stack }, 'request error');
    reply.status(error.statusCode || 500).send({
      error: error.message,
      code: error.code || 'INTERNAL_ERROR',
    });
  });

  return fastify;
}

export async function startServer(
  fastify: FastifyInstance,
  config: Config
): Promise<void> {
  try {
    await fastify.listen({ port: config.port, host: config.host });
    log.info({ port: config.port, host: config.host }, 'relay service started');
    console.log(`Relay service listening on http://${config.host}:${config.port}`);
    console.log(`\nWebSocket endpoints:`);
    console.log(`  - Control:       ws://${config.host}:${config.port}/ws/control/:sessionId`);
    console.log(`  - Terminal Data: ws://${config.host}:${config.port}/ws/terminal-data/:sessionId/:terminalName`);
    console.log(`  - Browser:       ws://${config.host}:${config.port}/ws/terminal/:sessionId`);
    console.log(`\nHTTP endpoints:`);
    console.log(`  - Health:        http://${config.host}:${config.port}/api/health`);
    console.log(`  - Login:         http://${config.host}:${config.port}/login`);
    console.log(`  - Terminal page: http://${config.host}:${config.port}/terminal/:left/:right`);
    console.log(`                   Format: session1[:terminal1]/session2[:terminal2]`);
    if (config.github.clientId) {
      console.log(`\nGitHub OAuth: configured`);
    } else {
      console.log(`\nGitHub OAuth: not configured (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)`);
    }
  } catch (error) {
    log.error({ error }, 'failed to start server');
    throw error;
  }
}
