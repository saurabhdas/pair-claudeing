/**
 * Terminal client for relay-service.
 * Split view: left terminal + right terminal
 *
 * URL parameters:
 * - left: terminal name for left panel (default: 'main')
 * - right: terminal name for right panel (default: mirror of left)
 * - terminal/name: single terminal name (legacy, uses mirror for right)
 *
 * Examples:
 * - /terminal/session123?left=main&right=other  - Two different terminals
 * - /terminal/session123?left=main              - Left interactive, right mirrors left
 * - /terminal/session123                        - Both use 'main' (left interactive, right mirror)
 */

(function() {
  'use strict';

  // Get session ID from URL path or query param
  function getSessionId() {
    const pathMatch = window.location.pathname.match(/\/terminal\/([^\/]+)/);
    if (pathMatch) return pathMatch[1];
    const params = new URLSearchParams(window.location.search);
    return params.get('session') || params.get('sessionId');
  }

  // Get terminal names from query params
  function getTerminalNames() {
    const params = new URLSearchParams(window.location.search);

    // New format: ?left=name1&right=name2
    const left = params.get('left');
    const right = params.get('right');

    if (left && right) {
      return { left, right, rightIsMirror: left === right };
    }

    if (left) {
      // Only left specified - right mirrors left
      return { left, right: left, rightIsMirror: true };
    }

    // Legacy format: ?terminal=name or ?name=name
    const single = params.get('terminal') || params.get('name') || 'main';
    return { left: single, right: single, rightIsMirror: true };
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
    fontFamily: 'MesloLGS NF',
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
  function createTerminal(container, isReadOnly) {
    const config = { ...termConfig };
    if (isReadOnly) {
      config.disableStdin = true;
      config.cursorBlink = false;
    }

    const term = new Terminal(config);

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

  // Get session ID and terminal names
  const sessionId = getSessionId();
  const terminalNames = getTerminalNames();

  // Create left terminal (always interactive)
  const leftContainer = document.getElementById('terminal-left');
  const { term: termLeft, fitAddon: fitLeft } = createTerminal(leftContainer, false);

  // Create right terminal (interactive if different name, read-only if mirror)
  const rightContainer = document.getElementById('terminal-right');
  const { term: termRight, fitAddon: fitRight } = createTerminal(rightContainer, terminalNames.rightIsMirror);

  if (!sessionId) {
    setStatus('error', 'No session ID');
    termLeft.writeln('\r\n\x1b[31mError: No session ID provided.\x1b[0m');
    termLeft.writeln('\r\nUsage:');
    termLeft.writeln('  /terminal/{sessionId}');
    termLeft.writeln('  /terminal/{sessionId}?left=term1&right=term2');
    termLeft.writeln('  /?session={sessionId}');
    return;
  }

  // Display terminal names
  console.log('Terminal names:', terminalNames);

  // WebSocket URL
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${sessionId}`;

  // Connection state
  let wsLeft = null;
  let wsRight = null;
  let leftSetupComplete = false;
  let rightSetupComplete = false;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;

  const textDecoder = new TextDecoder('utf-8', { fatal: false });

  /**
   * Create a websocket connection for a terminal panel.
   * @param {string} terminalName - Name of the terminal to connect to
   * @param {string} action - 'new' for interactive, 'mirror' for read-only
   * @param {Terminal} term - The xterm.js terminal instance
   * @param {FitAddon} fitAddon - The fit addon for this terminal
   * @param {string} side - 'left' or 'right' for logging
   * @param {function} onSetupComplete - Callback when setup succeeds
   */
  function createConnection(terminalName, action, term, fitAddon, side, onSetupComplete) {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      const dims = fitAddon.proposeDimensions();
      const setupMsg = {
        type: 'setup',
        action: action,
        name: terminalName,
        cols: dims ? dims.cols : 80,
        rows: dims ? dims.rows : 24,
      };
      ws.send(JSON.stringify(setupMsg));
      console.log(`[${side}] Sent setup (${action}, ${terminalName}):`, setupMsg);
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
      if (side === 'left') {
        handleLeftClose(event, term);
      }
    };

    ws.onerror = function(error) {
      console.error(`[${side}] WebSocket error:`, error);
      if (side === 'left') {
        setStatus('error', 'Connection error');
      }
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
          if (side === 'left') {
            setStatus('error', 'Setup failed');
          }
        }
        break;

      case 'exit':
        term.writeln(`\r\n\x1b[33mProcess exited with code ${msg.code}\x1b[0m`);
        if (side === 'left') {
          setStatus('disconnected', 'Exited');
        }
        break;

      case 'disconnect':
        term.writeln(`\r\n\x1b[31mDisconnected: ${msg.reason}\x1b[0m`);
        break;

      default:
        console.log(`[${side}] Unknown message:`, msg);
    }
  }

  function handleLeftClose(event, term) {
    setStatus('disconnected', 'Disconnected');

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

    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
      setStatus('connecting', `Reconnecting (${reconnectAttempts}/${maxReconnectAttempts})...`);
      setTimeout(connect, delay);
    } else {
      term.writeln('\r\n\x1b[31mConnection lost. Refresh to retry.\x1b[0m');
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

    // Connect left panel (always 'new' - interactive)
    wsLeft = createConnection(
      terminalNames.left,
      'new',
      termLeft,
      fitLeft,
      'left',
      function() {
        leftSetupComplete = true;
        reconnectAttempts = 0;
        updateStatus();

        // Connect right panel after left succeeds
        const rightAction = terminalNames.rightIsMirror ? 'mirror' : 'new';
        wsRight = createConnection(
          terminalNames.right,
          rightAction,
          termRight,
          fitRight,
          'right',
          function() {
            rightSetupComplete = true;
            updateStatus();
          }
        );
      }
    );
  }

  function updateStatus() {
    if (leftSetupComplete && rightSetupComplete) {
      if (terminalNames.left === terminalNames.right) {
        setStatus('connected', `Connected: ${terminalNames.left}`);
      } else {
        setStatus('connected', `Connected: ${terminalNames.left} | ${terminalNames.right}`);
      }
    } else if (leftSetupComplete) {
      setStatus('connected', `Connected: ${terminalNames.left} (right pending...)`);
    }
  }

  function sendResize(ws, fitAddon, terminalName) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: dims.cols,
          rows: dims.rows,
        }));
        console.log(`Sent resize for ${terminalName}:`, dims.cols, 'x', dims.rows);
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

  // Handle terminal input from RIGHT terminal (only if not a mirror)
  if (!terminalNames.rightIsMirror) {
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
  }

  // Handle window resize
  let resizeTimeout;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function() {
      fitLeft.fit();
      fitRight.fit();

      if (leftSetupComplete) {
        sendResize(wsLeft, fitLeft, terminalNames.left);
      }

      // Only send resize for right if it's a different terminal (not a mirror)
      if (rightSetupComplete && !terminalNames.rightIsMirror) {
        sendResize(wsRight, fitRight, terminalNames.right);
      }
    }, 100);
  });

  // Start connection
  connect();
  termLeft.focus();
})();
