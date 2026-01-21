/**
 * Terminal client for relay-service.
 * Split view: left terminal (read/write) + right terminal (read-only mirror)
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

  // Get session ID
  const sessionId = getSessionId();
  if (!sessionId) {
    setStatus('error', 'No session ID');
    termLeft.writeln('\r\n\x1b[31mError: No session ID provided.\x1b[0m');
    termLeft.writeln('\r\nUsage:');
    termLeft.writeln('  /terminal/{sessionId}');
    termLeft.writeln('  /?session={sessionId}');
    return;
  }

  // Connect to WebSocket
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${sessionId}`;

  let ws = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;

  const textDecoder = new TextDecoder('utf-8', { fatal: false });

  function connect() {
    setStatus('connecting', 'Connecting...');
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      setStatus('connected', 'Connected');
      reconnectAttempts = 0;
      sendResize();
    };

    ws.onmessage = function(event) {
      if (event.data instanceof ArrayBuffer) {
        // Binary data - terminal output
        const text = textDecoder.decode(event.data, { stream: true });
        // Write to BOTH terminals
        termLeft.write(text);
        termRight.write(text);
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          handleJsonMessage(msg);
        } catch {
          // Plain text - write to both terminals
          termLeft.write(event.data);
          termRight.write(event.data);
        }
      }
    };

    ws.onclose = function(event) {
      setStatus('disconnected', 'Disconnected');

      if (event.code === 4404) {
        termLeft.writeln('\r\n\x1b[31mSession not found.\x1b[0m');
        return;
      }
      if (event.code === 4400) {
        termLeft.writeln('\r\n\x1b[33mSession not ready. Waiting for paircoded to connect...\x1b[0m');
      }

      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 10000);
        setStatus('connecting', `Reconnecting (${reconnectAttempts}/${maxReconnectAttempts})...`);
        setTimeout(connect, delay);
      } else {
        termLeft.writeln('\r\n\x1b[31mConnection lost. Refresh to retry.\x1b[0m');
      }
    };

    ws.onerror = function() {
      setStatus('error', 'Connection error');
    };
  }

  function handleJsonMessage(msg) {
    switch (msg.type) {
      case 'session':
        console.log('Session info:', msg);
        fitLeft.fit();
        fitRight.fit();
        sendResize();
        break;

      case 'exit':
        termLeft.writeln(`\r\n\x1b[33mProcess exited with code ${msg.code}\x1b[0m`);
        termRight.writeln(`\r\n\x1b[33mProcess exited with code ${msg.code}\x1b[0m`);
        setStatus('disconnected', 'Exited');
        break;

      case 'disconnect':
        termLeft.writeln(`\r\n\x1b[31mDisconnected: ${msg.reason}\x1b[0m`);
        termRight.writeln(`\r\n\x1b[31mDisconnected: ${msg.reason}\x1b[0m`);
        break;

      default:
        console.log('Unknown message:', msg);
    }
  }

  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Use left terminal dimensions (it's the primary)
      const dims = fitLeft.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  termLeft.onBinary(function(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: data }));
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
