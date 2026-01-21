/**
 * JWT utilities for CLI authentication.
 */

import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('jwt');

export interface JwtPayload {
  sub: string;        // GitHub user ID (as string)
  username: string;   // GitHub username
  iat?: number;       // Issued at
  exp?: number;       // Expiration
}

export interface TokenResult {
  token: string;
  expiresIn: string;
}

/**
 * Create a JWT for a validated GitHub user.
 */
export function createToken(
  userId: number,
  username: string,
  config: Config
): TokenResult {
  const payload: JwtPayload = {
    sub: userId.toString(),
    username,
  };

  const token = jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });

  log.info({ userId, username }, 'created JWT token');

  return {
    token,
    expiresIn: config.jwtExpiresIn,
  };
}

/**
 * Verify and decode a JWT token.
 * Returns null if invalid or expired.
 */
export function verifyToken(token: string, config: Config): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      log.debug('token expired');
    } else if (error instanceof jwt.JsonWebTokenError) {
      log.debug({ error: (error as Error).message }, 'invalid token');
    }
    return null;
  }
}

/**
 * Extract token from Authorization header.
 * Expects: "Bearer <token>"
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}
