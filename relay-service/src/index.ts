/**
 * Relay service entry point.
 */

import { loadConfig } from './config.js';
import { SessionManager } from './session/index.js';
import { createServer, startServer } from './server/index.js';
import { logger, createChildLogger } from './utils/logger.js';
import { initDatabase, closeDatabase } from './db/index.js';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info('starting relay service');

  // Load configuration
  const config = loadConfig();
  log.info({ config }, 'configuration loaded');

  // Initialize database
  initDatabase();

  // Create session manager
  const sessionManager = new SessionManager(config);

  // Set up periodic cleanup
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanup();
  }, 60000); // Every minute

  // Create and start server
  const server = await createServer({ config, sessionManager });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    clearInterval(cleanupInterval);

    try {
      await server.close();
      closeDatabase();
      log.info('server closed');
      process.exit(0);
    } catch (error) {
      log.error({ error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start server
  await startServer(server, config);
}

main().catch((error) => {
  logger.error({ error: error.message, stack: error.stack }, 'fatal error');
  console.error('Fatal error:', error);
  process.exit(1);
});
