/**
 * Message parsing and encoding functions for the relay protocol.
 */

import {
  RELAY_PREFIX,
  CLIENT_PREFIX,
  type ResizeMessage,
  type HandshakeMessage,
  type ParsedClientMessage,
} from './index.js';

/**
 * Parse a message received from paircoded (client).
 */
export function parseClientMessage(data: Buffer): ParsedClientMessage | null {
  if (data.length === 0) {
    return null;
  }

  const prefix = data[0];
  const payload = data.subarray(1);

  switch (prefix) {
    case CLIENT_PREFIX.OUTPUT:
      return { type: 'output', data: payload };

    case CLIENT_PREFIX.HANDSHAKE: {
      try {
        const json = JSON.parse(payload.toString('utf-8')) as HandshakeMessage;
        return { type: 'handshake', data: json };
      } catch {
        return null;
      }
    }

    case CLIENT_PREFIX.EXIT: {
      try {
        const code = JSON.parse(payload.toString('utf-8')) as number;
        return { type: 'exit', code };
      } catch {
        return null;
      }
    }

    default:
      return null;
  }
}

/**
 * Create a RESIZE message to send to paircoded.
 */
export function createResizeMessage(cols: number, rows: number): Buffer {
  const resize: ResizeMessage = { cols, rows };
  const json = JSON.stringify(resize);
  const buf = Buffer.alloc(1 + Buffer.byteLength(json, 'utf-8'));
  buf[0] = RELAY_PREFIX.RESIZE;
  buf.write(json, 1, 'utf-8');
  return buf;
}

/**
 * Create an INPUT message to send to paircoded (keystrokes).
 */
export function createInputMessage(data: Buffer | string): Buffer {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  const buf = Buffer.alloc(1 + payload.length);
  buf[0] = RELAY_PREFIX.INPUT;
  payload.copy(buf, 1);
  return buf;
}

/**
 * Create a PAUSE message to send to paircoded.
 */
export function createPauseMessage(): Buffer {
  return Buffer.from([RELAY_PREFIX.PAUSE]);
}

/**
 * Create a RESUME message to send to paircoded.
 */
export function createResumeMessage(): Buffer {
  return Buffer.from([RELAY_PREFIX.RESUME]);
}

/**
 * Create an OUTPUT message (for forwarding to browser).
 * The browser receives the raw OUTPUT data without the prefix.
 */
export function createBrowserOutputMessage(data: Buffer): Buffer {
  // Browser receives raw terminal data without protocol prefix
  return data;
}

// ============================================================================
// Control Protocol Message Functions
// ============================================================================

import type {
  ControlMessage,
  ControlResponse,
  StartTerminalMessage,
  CloseTerminalMessage,
  BrowserSetupMessage,
  SetupResponse,
} from './index.js';

/**
 * Create a start_terminal control message.
 */
export function createStartTerminalMessage(
  name: string,
  cols: number,
  rows: number,
  requestId: string
): StartTerminalMessage {
  return {
    type: 'start_terminal',
    name,
    cols,
    rows,
    requestId,
  };
}

/**
 * Create a close_terminal control message.
 */
export function createCloseTerminalMessage(
  name: string,
  signal?: number
): CloseTerminalMessage {
  return {
    type: 'close_terminal',
    name,
    signal,
  };
}

/**
 * Parse a control response from paircoded.
 */
export function parseControlResponse(data: string | Buffer): ControlResponse | null {
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
    const parsed = JSON.parse(text) as ControlResponse;

    if (!parsed.type) {
      return null;
    }

    switch (parsed.type) {
      case 'control_handshake':
      case 'terminal_started':
      case 'terminal_closed':
        return parsed;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Parse a browser setup message.
 */
export function parseBrowserSetupMessage(data: string | Buffer): BrowserSetupMessage | null {
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
    const parsed = JSON.parse(text) as BrowserSetupMessage;

    if (parsed.type !== 'setup') {
      return null;
    }

    if (parsed.action !== 'new' && parsed.action !== 'mirror') {
      return null;
    }

    if (!parsed.name || typeof parsed.name !== 'string') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Create a setup response message for browser.
 */
export function createSetupResponse(
  success: boolean,
  name: string,
  cols: number,
  rows: number,
  error?: string
): SetupResponse {
  const response: SetupResponse = {
    type: 'setup_response',
    success,
    name,
    cols,
    rows,
  };

  if (error) {
    response.error = error;
  }

  return response;
}
