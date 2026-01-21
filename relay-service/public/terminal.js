/**
 * Terminal client for relay-service.
 * Split view: left terminal (interactive) + right terminal (read-only mirror)
 *
 * New Architecture:
 * - Left panel opens websocket, sends setup {action: 'new', name: 'main'}
 * - Right panel opens websocket, sends setup {action: 'mirror', name: 'main'}
 * - Each panel has its own websocket connection
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

  // Get terminal name from query param (default: 'main')
  function getTerminalName() {
    const params = new URLSearchParams(window.location.search);
    return params.get('terminal') || params.get('name') || 'main';
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

  // Create left terminal (read/write)
  const leftContainer = document.getElementById('terminal-left');
  const { term: termLeft, fitAddon: fitLeft } = createTerminal(leftContainer, false);

  // Create right terminal (read-only mirror)
  const rightContainer = document.getElementById('terminal-right');
  const { term: termRight, fitAddon: fitRight } = createTerminal(rightContainer, true);

  // Get session ID and terminal name
  const sessionId = getSessionId();
  const terminalName = getTerminalName();

  if (!sessionId) {
    setStatus('error', 'No session ID');
    termLeft.writeln('\r\n\x1b[31mError: No session ID provided.\x1b[0m');
    termLeft.writeln('\r\nUsage:');
    termLeft.writeln('  /terminal/{sessionId}');
    termLeft.writeln('  /?session={sessionId}');
    return;
  }

  // WebSocket URL
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${sessionId}`;

  // Connection state
  let wsLeft = null;      // Interactive connection (left panel)
  let wsRight = null;     // Mirror connection (right panel)
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  let setupComplete = false;

  const textDecoder = new TextDecoder('utf-8', { fatal: false });

  /**
   * Create a websocket connection for a terminal panel.
   * @param {string} action - 'new' for interactive, 'mirror' for read-only
   * @param {Terminal} term - The xterm.js terminal instance
   * @param {FitAddon} fitAddon - The fit addon for this terminal
   * @param {boolean} isInteractive - Whether this connection can send input
   */
  function createConnection(action, term, fitAddon, isInteractive) {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      // Send setup message
      const dims = fitAddon.proposeDimensions();
      const setupMsg = {
        type: 'setup',
        action: action,
        name: terminalName,
        cols: dims ? dims.cols : 80,
        rows: dims ? dims.rows : 24,
      };
      ws.send(JSON.stringify(setupMsg));
      console.log(`Sent setup (${action}):`, setupMsg);
    };

    ws.onmessage = function(event) {
      if (event.data instanceof ArrayBuffer) {
        // Binary data - terminal output
        const text = textDecoder.decode(event.data, { stream: true });
        term.write(text);
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          handleJsonMessage(msg, term, isInteractive);
        } catch {
          // Plain text - write to terminal
          term.write(event.data);
        }
      }
    };

    ws.onclose = function(event) {
      console.log(`WebSocket closed (${action}):`, event.code, event.reason);

      if (isInteractive) {
        handleInteractiveClose(event, term);
      }
    };

    ws.onerror = function(error) {
      console.error(`WebSocket error (${action}):`, error);
      if (isInteractive) {
        setStatus('error', 'Connection error');
      }
    };

    return ws;
  }

  function handleJsonMessage(msg, term, isInteractive) {
    switch (msg.type) {
      case 'setup_response':
        console.log('Setup response:', msg);
        if (msg.success) {
          if (isInteractive) {
            setStatus('connected', 'Connected');
            setupComplete = true;
            reconnectAttempts = 0;
            // Now connect the mirror
            if (!wsRight) {
              wsRight = createConnection('mirror', termRight, fitRight, false);
            }
          }
        } else {
          term.writeln(`\r\n\x1b[31mSetup failed: ${msg.error || 'Unknown error'}\x1b[0m`);
          if (isInteractive) {
            setStatus('error', 'Setup failed');
          }
        }
        break;

      case 'session':
        // Legacy session info message
        console.log('Session info (legacy):', msg);
        if (isInteractive) {
          setStatus('connected', 'Connected');
          setupComplete = true;
          reconnectAttempts = 0;
        }
        break;

      case 'exit':
        term.writeln(`\r\n\x1b[33mProcess exited with code ${msg.code}\x1b[0m`);
        if (isInteractive) {
          setStatus('disconnected', 'Exited');
        }
        break;

      case 'disconnect':
        term.writeln(`\r\n\x1b[31mDisconnected: ${msg.reason}\x1b[0m`);
        break;

      default:
        console.log('Unknown message:', msg);
    }
  }

  function handleInteractiveClose(event, term) {
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

    setupComplete = false;

    // Start with interactive connection (left panel)
    wsLeft = createConnection('new', termLeft, fitLeft, true);
  }

  function sendResize() {
    if (wsLeft && wsLeft.readyState === WebSocket.OPEN && setupComplete) {
      const dims = fitLeft.proposeDimensions();
      if (dims) {
        wsLeft.send(JSON.stringify({
          type: 'resize',
          cols: dims.cols,
          rows: dims.rows,
        }));
        console.log('Sent resize:', dims.cols, 'x', dims.rows);

        // Sync right terminal to same dimensions
        termRight.resize(dims.cols, dims.rows);
      }
    }
  }

  // Handle terminal input - only from LEFT terminal
  termLeft.onData(function(data) {
    if (wsLeft && wsLeft.readyState === WebSocket.OPEN && setupComplete) {
      wsLeft.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  termLeft.onBinary(function(data) {
    if (wsLeft && wsLeft.readyState === WebSocket.OPEN && setupComplete) {
      wsLeft.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  // Handle window resize
  let resizeTimeout;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function() {
      fitLeft.fit();
      fitRight.fit();
      sendResize();
    }, 100);
  });

  // Start connection
  connect();
  termLeft.focus();
})();
