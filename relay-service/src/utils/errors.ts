/**
 * Custom error types for the relay service.
 */

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export class SessionNotFoundError extends RelayError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND', 404);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionNotReadyError extends RelayError {
  constructor(sessionId: string) {
    super(`Session not ready: ${sessionId}`, 'SESSION_NOT_READY', 400);
    this.name = 'SessionNotReadyError';
  }
}

export class SessionAlreadyConnectedError extends RelayError {
  constructor(sessionId: string) {
    super(`Session already has a paircoded connection: ${sessionId}`, 'SESSION_ALREADY_CONNECTED', 409);
    this.name = 'SessionAlreadyConnectedError';
  }
}

export class InvalidMessageError extends RelayError {
  constructor(message: string) {
    super(message, 'INVALID_MESSAGE', 400);
    this.name = 'InvalidMessageError';
  }
}
