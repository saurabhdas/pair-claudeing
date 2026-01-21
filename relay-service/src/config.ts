/**
 * Configuration management for the relay service.
 */

import { randomBytes } from 'crypto';

export interface Config {
  port: number;
  host: string;
  defaultCols: number;
  defaultRows: number;
  sessionTimeoutMs: number;
  paircodedReconnectTimeoutMs: number;
  github: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  };
  cookieSecret: string;
  baseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
}

export function loadConfig(): Config {
  const port = parseInt(process.env.PORT || '8080', 10);
  const host = process.env.HOST || '0.0.0.0';
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

  return {
    port,
    host,
    defaultCols: parseInt(process.env.DEFAULT_COLS || '80', 10),
    defaultRows: parseInt(process.env.DEFAULT_ROWS || '24', 10),
    sessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS || '3600000', 10), // 1 hour
    paircodedReconnectTimeoutMs: parseInt(process.env.PAIRCODED_RECONNECT_TIMEOUT_MS || '30000', 10), // 30s
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      callbackUrl: `${baseUrl}/auth/github/callback`,
    },
    cookieSecret: process.env.COOKIE_SECRET || 'dev-secret-change-in-production',
    baseUrl,
    jwtSecret: process.env.JWT_SECRET || randomBytes(32).toString('hex'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  };
}
