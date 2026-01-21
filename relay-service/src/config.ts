/**
 * Configuration management for the relay service.
 */

export interface Config {
  port: number;
  host: string;
  defaultCols: number;
  defaultRows: number;
  sessionTimeoutMs: number;
  paircodedReconnectTimeoutMs: number;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '8080', 10),
    host: process.env.HOST || '0.0.0.0',
    defaultCols: parseInt(process.env.DEFAULT_COLS || '80', 10),
    defaultRows: parseInt(process.env.DEFAULT_ROWS || '24', 10),
    sessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS || '3600000', 10), // 1 hour
    paircodedReconnectTimeoutMs: parseInt(process.env.PAIRCODED_RECONNECT_TIMEOUT_MS || '30000', 10), // 30s
  };
}
