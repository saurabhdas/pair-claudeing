/**
 * Fastify server setup with WebSocket support.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { SessionManager } from '../session/index.js';
import { handlePaircodedConnection } from '../websocket/paircoded-handler.js';
import { handleBrowserConnection } from '../websocket/browser-handler.js';
import { registerHttpRoutes } from './http-routes.js';
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

  // Terminal page route (serves index.html for /terminal/:sessionId)
  fastify.get('/terminal/:sessionId', async (request, reply) => {
    return reply.sendFile('index.html');
  });

  // Register HTTP routes
  await registerHttpRoutes(fastify, { sessionManager });

  // WebSocket route for paircoded connections
  fastify.get<{ Params: { sessionId: string } }>(
    '/ws/session/:sessionId',
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      log.info({ sessionId, remoteAddress: request.ip }, 'paircoded WebSocket connection');
      handlePaircodedConnection(socket, sessionId, { sessionManager });
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
    console.log(`  - Paircoded WebSocket: ws://${config.host}:${config.port}/ws/session/:sessionId`);
    console.log(`  - Browser WebSocket:   ws://${config.host}:${config.port}/ws/terminal/:sessionId`);
    console.log(`  - Health check:        http://${config.host}:${config.port}/api/health`);
  } catch (error) {
    log.error({ error }, 'failed to start server');
    throw error;
  }
}
