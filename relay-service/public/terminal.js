/**
 * Terminal client for relay-service with cross-session split view.
 *
 * URL format: /terminal/<session1>:<terminal1>/<session2>:<terminal2>
 * If :terminalN is omitted, defaults to "main"
 *
 * Examples:
 * - /terminal/curious-panda/fancy-elephant         - Two sessions, both using "main" terminal
 * - /terminal/session1:term-a/session2:term-b      - Two sessions with specific terminals
 * - /terminal/session1/session1                    - Same session on both sides
 */

(function() {
  'use strict';

  /**
   * Parse a panel segment from URL path.
   * Format: "sessionId" or "sessionId:terminalName"
   * @param {string} segment - URL path segment
   * @returns {{ sessionId: string, terminalName: string }}
   */
  function parsePanelSegment(segment) {
    if (!segment) {
      return null;
    }
    const colonIndex = segment.indexOf(':');
    if (colonIndex === -1) {
      return { sessionId: segment, terminalName: 'main' };
    }
    return {
      sessionId: segment.substring(0, colonIndex),
      terminalName: segment.substring(colonIndex + 1) || 'main',
    };
  }

  /**
   * Parse URL to get left and right panel configurations.
   * URL format: /terminal/<left>/<right>
   * @returns {{ left: { sessionId: string, terminalName: string }, right: { sessionId: string, terminalName: string } } | null}
   */
  function parseUrl() {
    const pathMatch = window.location.pathname.match(/\/terminal\/([^\/]+)\/([^\/]+)/);
    if (!pathMatch) {
      return null;
    }

    const left = parsePanelSegment(pathMatch[1]);
    const right = parsePanelSegment(pathMatch[2]);

    if (!left || !right) {
      return null;
    }

    return { left, right };
  }

  // Status indicator
  const statusEl = document.getElementById('status');
  function setStatus(status, text) {
    statusEl.className = status;
    statusEl.textContent = text;
  }

  // Terminal configuration
  const termConfig = {
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 14,
    fontFamily: 'MesloLGS NF, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace',
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    lineHeight: 1.0,
    letterSpacing: 0,
    scrollback: 10000,
    convertEol: false,
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#d4d4d4',
      cursorAccent: '#1e1e1e',
      selectionBackground: '#264f78',
      selectionForeground: '#ffffff',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5',
    },
  };

  // Create a terminal with addons
  function createTerminal(container) {
    const term = new Terminal(termConfig);

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(webLinksAddon);

    const unicode11Addon = new Unicode11Addon.Unicode11Addon();
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = '11';

    term.open(container);
    fitAddon.fit();

    return { term, fitAddon };
  }

  // Parse URL
  const config = parseUrl();

  // Create terminals
  const leftContainer = document.getElementById('terminal-left');
  const { term: termLeft, fitAddon: fitLeft } = createTerminal(leftContainer);

  const rightContainer = document.getElementById('terminal-right');
  const { term: termRight, fitAddon: fitRight } = createTerminal(rightContainer);

  // Update panel headers
  function updatePanelHeaders() {
    const leftHeader = document.querySelector('.panel:first-child .panel-header');
    const rightHeader = document.querySelector('.panel:last-child .panel-header');

    if (config) {
      leftHeader.textContent = `${config.left.sessionId}:${config.left.terminalName}`;
      rightHeader.textContent = `${config.right.sessionId}:${config.right.terminalName}`;
    }
  }

  if (!config) {
    setStatus('error', 'Invalid URL');
    termLeft.writeln('\r\n\x1b[31mError: Invalid URL format.\x1b[0m');
    termLeft.writeln('\r\nExpected: /terminal/<session1>/<session2>');
    termLeft.writeln('          /terminal/<session1>:<terminal1>/<session2>:<terminal2>');
    termLeft.writeln('\r\nExamples:');
    termLeft.writeln('  /terminal/curious-panda/fancy-elephant');
    termLeft.writeln('  /terminal/session1:main/session2:main');
    return;
  }

  updatePanelHeaders();
  console.log('Panel config:', config);

  // Connection state
  let wsLeft = null;
  let wsRight = null;
  let leftSetupComplete = false;
  let rightSetupComplete = false;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;

  const textDecoder = new TextDecoder('utf-8', { fatal: false });
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  /**
   * Create a websocket connection for a terminal panel.
   * @param {string} sessionId - Session ID to connect to
   * @param {string} terminalName - Terminal name within the session
   * @param {Terminal} term - The xterm.js terminal instance
   * @param {FitAddon} fitAddon - The fit addon for this terminal
   * @param {string} side - 'left' or 'right' for logging
   * @param {function} onSetupComplete - Callback when setup succeeds
   */
  function createConnection(sessionId, terminalName, term, fitAddon, side, onSetupComplete) {
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${sessionId}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      const dims = fitAddon.proposeDimensions();
      const setupMsg = {
        type: 'setup',
        action: 'new',
        name: terminalName,
        cols: dims ? dims.cols : 80,
        rows: dims ? dims.rows : 24,
      };
      ws.send(JSON.stringify(setupMsg));
      console.log(`[${side}] Sent setup to ${sessionId}:`, setupMsg);
    };

    ws.onmessage = function(event) {
      if (event.data instanceof ArrayBuffer) {
        const text = textDecoder.decode(event.data, { stream: true });
        term.write(text);
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          handleJsonMessage(msg, term, side, onSetupComplete);
        } catch {
          term.write(event.data);
        }
      }
    };

    ws.onclose = function(event) {
      console.log(`[${side}] WebSocket closed:`, event.code, event.reason);
      handleClose(event, term, side);
    };

    ws.onerror = function(error) {
      console.error(`[${side}] WebSocket error:`, error);
    };

    return ws;
  }

  function handleJsonMessage(msg, term, side, onSetupComplete) {
    switch (msg.type) {
      case 'setup_response':
        console.log(`[${side}] Setup response:`, msg);
        if (msg.success) {
          if (onSetupComplete) onSetupComplete();
        } else {
          term.writeln(`\r\n\x1b[31mSetup failed: ${msg.error || 'Unknown error'}\x1b[0m`);
        }
        break;

      case 'exit':
        term.writeln(`\r\n\x1b[33mProcess exited with code ${msg.code}\x1b[0m`);
        break;

      case 'disconnect':
        term.writeln(`\r\n\x1b[31mDisconnected: ${msg.reason}\x1b[0m`);
        break;

      default:
        console.log(`[${side}] Unknown message:`, msg);
    }
  }

  function handleClose(event, term, side) {
    if (event.code === 4404) {
      term.writeln('\r\n\x1b[31mSession not found.\x1b[0m');
      return;
    }
    if (event.code === 4400) {
      term.writeln('\r\n\x1b[33mSession not ready. Waiting for paircoded to connect...\x1b[0m');
    }
    if (event.code === 4408) {
      term.writeln('\r\n\x1b[31mSetup timeout.\x1b[0m');
    }

    // Only reconnect from left side to avoid double reconnects
    if (side === 'left' && reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
      setStatus('connecting', `Reconnecting (${reconnectAttempts}/${maxReconnectAttempts})...`);
      setTimeout(connect, delay);
    } else if (side === 'left') {
      term.writeln('\r\n\x1b[31mConnection lost. Refresh to retry.\x1b[0m');
      setStatus('disconnected', 'Disconnected');
    }
  }

  function connect() {
    setStatus('connecting', 'Connecting...');

    // Close existing connections
    if (wsLeft) {
      wsLeft.close();
      wsLeft = null;
    }
    if (wsRight) {
      wsRight.close();
      wsRight = null;
    }

    leftSetupComplete = false;
    rightSetupComplete = false;

    // Connect both panels in parallel
    wsLeft = createConnection(
      config.left.sessionId,
      config.left.terminalName,
      termLeft,
      fitLeft,
      'left',
      function() {
        leftSetupComplete = true;
        reconnectAttempts = 0;
        updateStatus();
      }
    );

    wsRight = createConnection(
      config.right.sessionId,
      config.right.terminalName,
      termRight,
      fitRight,
      'right',
      function() {
        rightSetupComplete = true;
        updateStatus();
      }
    );
  }

  function updateStatus() {
    const leftLabel = `${config.left.sessionId}:${config.left.terminalName}`;
    const rightLabel = `${config.right.sessionId}:${config.right.terminalName}`;

    if (leftSetupComplete && rightSetupComplete) {
      setStatus('connected', `Connected`);
    } else if (leftSetupComplete || rightSetupComplete) {
      const pending = !leftSetupComplete ? 'left' : 'right';
      setStatus('connecting', `${pending} pending...`);
    }
  }

  function sendResize(ws, fitAddon) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: dims.cols,
          rows: dims.rows,
        }));
      }
    }
  }

  // Handle terminal input from LEFT terminal
  termLeft.onData(function(data) {
    if (wsLeft && wsLeft.readyState === WebSocket.OPEN && leftSetupComplete) {
      wsLeft.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  termLeft.onBinary(function(data) {
    if (wsLeft && wsLeft.readyState === WebSocket.OPEN && leftSetupComplete) {
      wsLeft.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  // Handle terminal input from RIGHT terminal
  termRight.onData(function(data) {
    if (wsRight && wsRight.readyState === WebSocket.OPEN && rightSetupComplete) {
      wsRight.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  termRight.onBinary(function(data) {
    if (wsRight && wsRight.readyState === WebSocket.OPEN && rightSetupComplete) {
      wsRight.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  // Handle window resize
  let resizeTimeout;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function() {
      fitLeft.fit();
      fitRight.fit();
      termLeft.scrollToBottom();
      termRight.scrollToBottom();

      if (leftSetupComplete) {
        sendResize(wsLeft, fitLeft);
      }
      if (rightSetupComplete) {
        sendResize(wsRight, fitRight);
      }
    }, 100);
  });

  // Start connection
  connect();
  termLeft.focus();
})();
