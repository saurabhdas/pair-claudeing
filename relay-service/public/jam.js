/**
 * Jam client for collaborative terminal sessions.
 *
 * URL format: /jam/<jamId>
 *
 * Features:
 * - Real-time participant presence
 * - Session pool management
 * - Panel selection with ownership-based input control
 */

(function() {
  'use strict';

  // =========================================================================
  // State
  // =========================================================================

  let currentUser = null;
  let jamId = null;
  let jamState = null;

  // WebSocket connections
  let jamWs = null;
  let leftTerminalWs = null;
  let rightTerminalWs = null;

  // Terminal instances
  let termLeft = null;
  let termRight = null;
  let fitLeft = null;
  let fitRight = null;

  // Panel state (terminalName is assigned dynamically when connecting)
  let leftSelection = { sessionId: null, terminalName: null };
  let rightSelection = { sessionId: null, terminalName: null };
  let leftSetupComplete = false;
  let rightSetupComplete = false;

  // User's own sessions (for dropdown display)
  let mySessions = [];
  let myClosedSessions = [];

  // Cache of session display info (persists even when session closes)
  const sessionInfoCache = new Map();

  const textDecoder = new TextDecoder('utf-8', { fatal: false });
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  // =========================================================================
  // Initialization
  // =========================================================================

  // Parse jam ID from URL
  const pathMatch = window.location.pathname.match(/\/jam\/([^\/]+)/);
  if (!pathMatch) {
    document.body.innerHTML = '<div style="padding:40px;color:#888;text-align:center;">Invalid URL. Expected /jam/&lt;jamId&gt;</div>';
    return;
  }
  jamId = pathMatch[1];
  document.getElementById('jam-id').textContent = jamId;

  // Check auth and load user
  fetch('/auth/status')
    .then(res => res.json())
    .then(data => {
      if (data.authenticated && data.user) {
        currentUser = data.user;
        document.getElementById('user-info').innerHTML = `
          <img src="${data.user.avatar_url}" alt="${data.user.login}">
          <span>${data.user.login}</span>
          <a href="#" onclick="logout(); return false;">logout</a>
        `;
        initJam();
      } else {
        window.location.href = `/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
      }
    })
    .catch(() => {
      window.location.href = '/login';
    });

  window.logout = function() {
    fetch('/auth/logout', { method: 'POST' })
      .then(() => window.location.href = '/')
      .catch(() => {});
  };

  function initJam() {
    // Create terminals
    createTerminals();

    // Connect to jam WebSocket
    connectJamWs();

    // Set up panel divider drag
    setupDivider();

    // Set up dropdown handlers
    setupDropdowns();

    // Set up modal handlers
    setupModals();

    // Note: User's sessions are now sent via WebSocket in jam_state
    // No polling needed - updates come via session_status_update messages
  }

  // Note: fetchMySessions() removed - sessions now come via WebSocket jam_state message
  // and updates via session_status_update messages

  // =========================================================================
  // UI Status
  // =========================================================================

  const statusEl = document.getElementById('status');
  function setStatus(status, text) {
    statusEl.className = status;
    statusEl.title = text;
  }

  // =========================================================================
  // Terminals
  // =========================================================================

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

  function createTerminals() {
    const leftContainer = document.getElementById('terminal-left');
    const rightContainer = document.getElementById('terminal-right');

    const leftResult = createTerminal(leftContainer);
    termLeft = leftResult.term;
    fitLeft = leftResult.fitAddon;

    const rightResult = createTerminal(rightContainer);
    termRight = rightResult.term;
    fitRight = rightResult.fitAddon;

    // Handle input
    termLeft.onData(function(data) {
      if (leftTerminalWs && leftTerminalWs.readyState === WebSocket.OPEN && leftSetupComplete && canEditPanel('left')) {
        leftTerminalWs.send(JSON.stringify({ type: 'input', data: data }));
      }
    });

    termRight.onData(function(data) {
      if (rightTerminalWs && rightTerminalWs.readyState === WebSocket.OPEN && rightSetupComplete && canEditPanel('right')) {
        rightTerminalWs.send(JSON.stringify({ type: 'input', data: data }));
      }
    });

    // Handle resize
    let resizeTimeout;
    window.addEventListener('resize', function() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(function() {
        fitLeft.fit();
        fitRight.fit();
        termLeft.scrollToBottom();
        termRight.scrollToBottom();

        if (leftSetupComplete && leftTerminalWs && leftTerminalWs.readyState === WebSocket.OPEN) {
          const dims = fitLeft.proposeDimensions();
          if (dims) {
            leftTerminalWs.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
          }
        }
        if (rightSetupComplete && rightTerminalWs && rightTerminalWs.readyState === WebSocket.OPEN) {
          const dims = fitRight.proposeDimensions();
          if (dims) {
            rightTerminalWs.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
          }
        }
      }, 100);
    });

    termLeft.writeln('Select a session from the dropdown above...');
    termRight.writeln('Select a session from the dropdown above...');
  }

  function canEditPanel(panel) {
    if (!jamState || !currentUser) return false;

    const selection = panel === 'left' ? leftSelection : rightSelection;
    if (!selection.sessionId) return false;

    // Find the session in the pool
    const session = jamState.sessions.find(s => s.sessionId === selection.sessionId);
    if (!session) return false;

    // Can edit if user added the session (owns it)
    return session.addedBy.userId === currentUser.id;
  }

  function updatePanelModes() {
    const leftMode = document.getElementById('mode-left');
    const rightMode = document.getElementById('mode-right');

    if (canEditPanel('left')) {
      leftMode.textContent = 'editable';
      leftMode.className = 'panel-mode editable';
    } else {
      leftMode.textContent = 'readonly';
      leftMode.className = 'panel-mode readonly';
    }

    if (canEditPanel('right')) {
      rightMode.textContent = 'editable';
      rightMode.className = 'panel-mode editable';
    } else {
      rightMode.textContent = 'readonly';
      rightMode.className = 'panel-mode readonly';
    }
  }

  // =========================================================================
  // Jam WebSocket
  // =========================================================================

  function connectJamWs() {
    setStatus('connecting', 'Connecting to jam...');

    const wsUrl = `${protocol}//${window.location.host}/ws/jam/${jamId}`;
    jamWs = new WebSocket(wsUrl);

    jamWs.onopen = function() {
      console.log('Jam WebSocket connected');
    };

    jamWs.onmessage = function(event) {
      try {
        const msg = JSON.parse(event.data);
        handleJamMessage(msg);
      } catch (error) {
        console.error('Failed to parse jam message:', error);
      }
    };

    jamWs.onclose = function(event) {
      console.log('Jam WebSocket closed:', event.code, event.reason);
      setStatus('disconnected', 'Disconnected');

      // Try to reconnect after 3 seconds
      setTimeout(connectJamWs, 3000);
    };

    jamWs.onerror = function(error) {
      console.error('Jam WebSocket error:', error);
    };
  }

  function handleJamMessage(msg) {
    switch (msg.type) {
      case 'jam_state':
        jamState = msg;
        setStatus('connected', 'Connected');

        // Update mySessions from WebSocket data
        mySessions = (msg.userSessions || []).map(s => ({
          id: s.id,
          state: s.state,
          controlConnected: s.controlConnected,
          controlHandshake: {
            hostname: s.hostname,
            workingDir: s.workingDir,
          },
        }));

        // Update session info cache
        mySessions.forEach(s => {
          const isLive = s.controlConnected && (s.state === 'READY' || s.state === 'ACTIVE');
          sessionInfoCache.set(s.id, {
            hostname: s.controlHandshake?.hostname || 'unknown',
            workingDir: s.controlHandshake?.workingDir || '',
            username: '',
            isLive: isLive,
            isOffline: !isLive && (s.state === 'READY' || s.state === 'ACTIVE'),
            isClosed: false,
          });
        });

        updateUI();
        break;

      case 'participant_update':
        handleParticipantUpdate(msg);
        break;

      case 'session_pool_update':
        handleSessionPoolUpdate(msg);
        break;

      case 'panel_state_update':
        handlePanelStateUpdate(msg);
        break;

      case 'session_status_update':
        handleSessionStatusUpdate(msg);
        break;

      case 'error':
        console.error('Jam error:', msg.error, msg.code);
        if (msg.code === 'JAM_NOT_FOUND' || msg.code === 'NOT_PARTICIPANT') {
          alert(msg.error);
          window.location.href = '/';
        } else if (msg.code === 'NOT_OWNER' || msg.code === 'OWNER_CANNOT_CHANGE_RIGHT') {
          // Panel access error - revert dropdown
          console.warn('Panel access denied:', msg.error);
        }
        break;

      default:
        console.log('Unknown jam message:', msg);
    }
  }

  function handleParticipantUpdate(msg) {
    if (!jamState) return;

    if (msg.action === 'joined') {
      // Update existing participant to online or add new one
      const existing = jamState.participants.find(p => p.userId === msg.participant.userId);
      if (existing) {
        existing.online = true;
      } else {
        jamState.participants.push({ ...msg.participant, online: true });
      }
    } else if (msg.action === 'left') {
      // Mark participant as offline
      const participant = jamState.participants.find(p => p.userId === msg.participant.userId);
      if (participant) {
        participant.online = false;
      }
    }

    updateParticipantsUI();
    updatePageTitle();
  }

  function handleSessionPoolUpdate(msg) {
    if (!jamState) return;

    if (msg.action === 'added' && msg.session) {
      // Check if already exists
      if (!jamState.sessions.find(s => s.sessionId === msg.session.sessionId)) {
        jamState.sessions.push(msg.session);
      }
    } else if (msg.action === 'removed' && msg.sessionId) {
      jamState.sessions = jamState.sessions.filter(s => s.sessionId !== msg.sessionId);

      // If removed session was selected, clear that panel locally
      // (the server should also broadcast a panel state update)
      if (leftSelection.sessionId === msg.sessionId) {
        applyPanelState('left', null);
      }
      if (rightSelection.sessionId === msg.sessionId) {
        applyPanelState('right', null);
      }
    }

    updateSessionDropdowns();
    updatePanelModes();
  }

  function handlePanelStateUpdate(msg) {
    // Shared panel state update - apply to local view
    if (!jamState) return;

    const { panel, sessionId } = msg;

    // Update local state
    if (!jamState.panelStates) {
      jamState.panelStates = { left: null, right: null };
    }
    jamState.panelStates[panel] = { sessionId };

    // Apply the change locally (switch terminal view)
    applyPanelState(panel, sessionId);
  }

  function handleSessionStatusUpdate(msg) {
    const { sessionId, status, reason, hostname, workingDir } = msg;

    console.log('Session status update:', msg);

    const isOnline = status === 'online';
    const isClosed = status === 'closed';
    const isOffline = status === 'offline';

    // Update session info cache
    const cached = sessionInfoCache.get(sessionId);
    if (cached) {
      cached.isLive = isOnline;
      cached.isClosed = isClosed;
      cached.isOffline = isOffline;
      if (hostname) cached.hostname = hostname;
      if (workingDir) cached.workingDir = workingDir;
      if (reason) cached.closedReason = reason;
    } else {
      // Create new cache entry with the info from the event
      sessionInfoCache.set(sessionId, {
        hostname: hostname || 'unknown',
        workingDir: workingDir || '',
        username: '',
        isLive: isOnline,
        isClosed: isClosed,
        isOffline: isOffline,
        closedReason: reason,
      });
    }

    // Update session in jam state if present
    if (jamState && jamState.sessions) {
      const jamSession = jamState.sessions.find(s => s.sessionId === sessionId);
      if (jamSession) {
        jamSession.isLive = isOnline;
        jamSession.state = isOnline ? 'READY' : (isClosed ? 'CLOSED' : 'OFFLINE');
        if (hostname) jamSession.hostname = hostname;
        if (workingDir) jamSession.workingDir = workingDir;
      }
    }

    // Update mySessions list
    const mySession = mySessions.find(s => s.id === sessionId);
    if (mySession) {
      mySession.state = isOnline ? 'READY' : (isClosed ? 'CLOSED' : 'OFFLINE');
    } else if (isOnline) {
      // New session came online - add to mySessions if it's ours
      // We'll need to fetch full details, but for now add basic info
      mySessions.push({
        id: sessionId,
        state: 'READY',
        controlHandshake: { hostname, workingDir },
      });
    }

    // If closed, move to closed sessions list
    if (isClosed) {
      mySessions = mySessions.filter(s => s.id !== sessionId);
      if (!myClosedSessions.find(s => s.id === sessionId)) {
        myClosedSessions.push({
          id: sessionId,
          hostname,
          workingDir,
          reason,
          closedAt: new Date().toISOString(),
        });
      }
    }

    // Update dropdowns to reflect new status
    updateSessionDropdowns();
    updatePanelModes();
  }

  // =========================================================================
  // Terminal WebSocket Connections
  // =========================================================================

  function connectTerminal(panel, sessionId, terminalName) {
    const isLeft = panel === 'left';
    const term = isLeft ? termLeft : termRight;
    const fitAddon = isLeft ? fitLeft : fitRight;

    // Close existing connection
    if (isLeft && leftTerminalWs) {
      leftTerminalWs.close();
      leftTerminalWs = null;
      leftSetupComplete = false;
    }
    if (!isLeft && rightTerminalWs) {
      rightTerminalWs.close();
      rightTerminalWs = null;
      rightSetupComplete = false;
    }

    if (!sessionId) {
      term.clear();
      term.writeln('Select a session from the dropdown above...');
      return;
    }

    term.clear();
    term.writeln(`Connecting to ${sessionId}...`);

    const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${sessionId}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    if (isLeft) {
      leftTerminalWs = ws;
    } else {
      rightTerminalWs = ws;
    }

    ws.onopen = function() {
      const dims = fitAddon.proposeDimensions();
      const isInteractive = canEditPanel(panel);

      // Determine action and terminal name
      let action, name;

      if (terminalName) {
        // Specific terminal requested - join it (as interactive or mirror)
        action = isInteractive ? 'new' : 'mirror';
        name = terminalName;
        console.log(`[${panel}] Connecting to specific terminal: ${name} (${action})`);
      } else if (isInteractive) {
        // No specific terminal, interactive user - start a new terminal
        action = 'new';
        name = 'new'; // Server will assign PID
        console.log(`[${panel}] Starting new terminal`);
      } else {
        // No specific terminal, mirror user - find first available
        action = 'mirror';
        const session = jamState?.sessions.find(s => s.sessionId === sessionId);
        if (session && session.terminals && session.terminals.length > 0) {
          name = session.terminals[0].name;
          console.log(`[${panel}] Mirroring first available terminal: ${name}`);
        } else {
          term.writeln('\r\n\x1b[33mNo active terminal to mirror. Waiting for session owner to connect...\x1b[0m');
          ws.close();
          return;
        }
      }

      const setupMsg = {
        type: 'setup',
        action: action,
        name: name,
        cols: dims ? dims.cols : 80,
        rows: dims ? dims.rows : 24,
      };
      ws.send(JSON.stringify(setupMsg));
      console.log(`[${panel}] Sent setup to ${sessionId}:`, setupMsg);
    };

    ws.onmessage = function(event) {
      if (event.data instanceof ArrayBuffer) {
        const text = textDecoder.decode(event.data, { stream: true });
        term.write(text);
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          handleTerminalMessage(msg, term, panel, isLeft);
        } catch {
          term.write(event.data);
        }
      }
    };

    ws.onclose = function(event) {
      console.log(`[${panel}] Terminal WebSocket closed:`, event.code, event.reason);
      if (event.code === 4404) {
        term.writeln('\r\n\x1b[31mSession not found.\x1b[0m');
      } else if (event.code === 4400) {
        term.writeln('\r\n\x1b[33mSession not ready. Waiting for paircoded to connect...\x1b[0m');
      }
    };

    ws.onerror = function(error) {
      console.error(`[${panel}] Terminal WebSocket error:`, error);
    };
  }

  function handleTerminalMessage(msg, term, panel, isLeft) {
    switch (msg.type) {
      case 'setup_response':
        console.log(`[${panel}] Setup response:`, msg);
        if (msg.success) {
          // Store the actual terminal name (PID) returned by the server
          const actualTerminalName = msg.name;
          const selection = isLeft ? leftSelection : rightSelection;
          const sessionId = selection.sessionId;

          if (isLeft) {
            leftSetupComplete = true;
            leftSelection.terminalName = actualTerminalName;
          } else {
            rightSetupComplete = true;
            rightSelection.terminalName = actualTerminalName;
          }
          console.log(`[${panel}] Terminal name assigned: ${actualTerminalName}`);

          // Update local jamState with the new terminal
          if (jamState && sessionId) {
            let session = jamState.sessions.find(s => s.sessionId === sessionId);

            // If session not in jam yet (timing issue), add it
            if (!session) {
              const mySession = mySessions.find(s => s.id === sessionId);
              if (mySession) {
                session = {
                  sessionId: sessionId,
                  addedBy: { userId: currentUser.id, login: currentUser.login },
                  terminals: [],
                  hostname: mySession.controlHandshake?.hostname,
                  workingDir: mySession.controlHandshake?.workingDir,
                  isLive: true,
                };
                jamState.sessions.push(session);
                console.log(`[${panel}] Added session ${sessionId} to jam state`);
              }
            }

            if (session) {
              if (!session.terminals) {
                session.terminals = [];
              }
              // Add terminal if not already present
              if (!session.terminals.find(t => t.name === actualTerminalName)) {
                session.terminals.push({ name: actualTerminalName });
                console.log(`[${panel}] Added terminal ${actualTerminalName} to session ${sessionId}`);
              }
            }
          }

          // Update dropdown button and menu to show the terminal
          updateDropdownButton(panel, sessionId);
          updateSessionDropdowns();

          term.clear();
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
        console.log(`[${panel}] Unknown terminal message:`, msg);
    }
  }

  // =========================================================================
  // UI Updates
  // =========================================================================

  function updateUI() {
    updatePageTitle();
    updateParticipantsUI();
    updateSessionDropdowns();
    updatePanelModes();
    updatePanelControls();
    applyInitialPanelStates();
  }

  function updatePageTitle() {
    if (!jamState || !currentUser) return;

    const otherParticipants = jamState.participants.filter(p => p.userId !== currentUser.id);
    const otherNames = otherParticipants.map(p => p.login);

    let withPart;
    if (otherNames.length === 0) {
      withPart = 'yourself';
    } else if (otherNames.length === 1) {
      withPart = otherNames[0];
    } else if (otherNames.length === 2) {
      withPart = `${otherNames[0]} and ${otherNames[1]}`;
    } else {
      withPart = `${otherNames.slice(0, -1).join(', ')}, and ${otherNames[otherNames.length - 1]}`;
    }

    document.title = `${jamId} · PairCode Jam with ${withPart}`;
  }

  function isOwner() {
    return jamState && currentUser && jamState.jam.owner.id === currentUser.id;
  }

  function updatePanelControls() {
    // Dropdown buttons handle their own disabled state via updateDropdownButton
    // Just refresh the dropdowns
    updateSessionDropdowns();
  }

  function applyInitialPanelStates() {
    if (!jamState || !jamState.panelStates) return;

    const { left, right } = jamState.panelStates;

    // On page load, try to connect to an EXISTING terminal, don't create new ones
    if (left && left.sessionId) {
      const session = jamState.sessions.find(s => s.sessionId === left.sessionId);
      if (session && session.terminals && session.terminals.length > 0) {
        // Connect to first existing terminal
        const terminalName = session.terminals[0].name;
        applyPanelStateWithTerminal('left', left.sessionId, terminalName);
      } else {
        // No terminal yet - just update the dropdown button, don't connect
        updateDropdownButton('left', left.sessionId);
      }
    }
    if (right && right.sessionId) {
      const session = jamState.sessions.find(s => s.sessionId === right.sessionId);
      if (session && session.terminals && session.terminals.length > 0) {
        // Connect to first existing terminal
        const terminalName = session.terminals[0].name;
        applyPanelStateWithTerminal('right', right.sessionId, terminalName);
      } else {
        // No terminal yet - just update the dropdown button, don't connect
        updateDropdownButton('right', right.sessionId);
      }
    }
  }

  function applyPanelStateWithTerminal(panel, sessionId, terminalName) {
    // Update local selection state with specific terminal
    if (panel === 'left') {
      leftSelection = { sessionId, terminalName };
    } else {
      rightSelection = { sessionId, terminalName };
    }

    // Update dropdown button
    updateDropdownButton(panel, sessionId);

    // Update panel mode display
    updatePanelModes();

    // Connect to the specific terminal
    connectTerminal(panel, sessionId, terminalName);
  }

  function applyPanelState(panel, sessionId) {
    // Update local selection state (terminalName is assigned on connection)
    if (panel === 'left') {
      leftSelection = { sessionId, terminalName: null };
    } else {
      rightSelection = { sessionId, terminalName: null };
    }

    // Update dropdown button to show current selection
    updateDropdownButton(panel, sessionId);

    // Update panel mode display
    updatePanelModes();

    // Connect to terminal (terminalName will be assigned by server for 'new' action)
    connectTerminal(panel, sessionId, null);
  }

  function updateParticipantsUI() {
    if (!jamState) return;

    const container = document.getElementById('participants');

    // Render participants
    const participantsHtml = jamState.participants.map(p => `
      <div class="participant ${p.online ? 'online' : 'offline'}">
        <img src="${p.avatar_url}" alt="${p.login}">
        <span>@${p.login}</span>
      </div>
    `).join('');

    // Render pending invitations
    const invitationsHtml = (jamState.pendingInvitations || []).map(inv => `
      <div class="participant invited" title="Invitation pending">
        <span>@${inv.to.login}</span>
      </div>
    `).join('');

    container.innerHTML = participantsHtml + invitationsHtml;
  }

  function updateSessionDropdowns() {
    updateDropdownButton('left', leftSelection.sessionId);
    updateDropdownButton('right', rightSelection.sessionId);
    updateDropdownMenu('left');
    updateDropdownMenu('right');
  }

  function formatWorkingDir(workingDir, username) {
    if (!workingDir) return '';

    // If username provided, try exact match first
    if (username) {
      const homePatterns = [
        `/home/${username}`,
        `/Users/${username}`,
      ];
      for (const pattern of homePatterns) {
        if (workingDir.startsWith(pattern)) {
          return '~' + workingDir.slice(pattern.length);
        }
      }
    }

    // Generic detection: /home/XXX/... or /Users/XXX/...
    const homeMatch = workingDir.match(/^(\/home\/[^\/]+|\/Users\/[^\/]+)(\/.*)?$/);
    if (homeMatch) {
      return '~' + (homeMatch[2] || '');
    }

    return workingDir;
  }

  function getSessionDisplayInfo(sessionId) {
    const jamSession = jamState?.sessions.find(s => s.sessionId === sessionId);
    const mySession = mySessions.find(s => s.id === sessionId);
    const cached = sessionInfoCache.get(sessionId);

    // Priority: jam session > my session > cache
    const hostname = jamSession?.hostname || mySession?.controlHandshake?.hostname || cached?.hostname || 'unknown';
    const workingDir = jamSession?.workingDir || mySession?.controlHandshake?.workingDir || cached?.workingDir || '';
    const username = mySession?.controlHandshake?.username || cached?.username || '';

    // Check if session is live (from jam state or my sessions)
    // Must check controlConnected - session can be in READY state but disconnected
    let isLive = jamSession?.isLive || (mySession?.controlConnected && (mySession?.state === 'READY' || mySession?.state === 'ACTIVE'));

    // Check if session is closed - from jam state, cache, or mySession
    // A session is closed if it's in the jam with state 'CLOSED', or marked closed in cache
    const isClosed = jamSession?.state === 'CLOSED' || cached?.isClosed || false;

    // Check if session is offline (control disconnected but not closed - waiting for reconnect)
    // Offline means: not live, not closed, but still exists
    const isOffline = !isLive && !isClosed && (jamSession || cached?.isOffline);

    // If offline or closed, ensure isLive is false
    if (isOffline || isClosed) {
      isLive = false;
    }

    // Shorten hostname (remove .local, .lan, etc.)
    const shortHostname = hostname.replace(/\.(local|lan|home|internal)$/i, '');

    return {
      hostname: shortHostname,
      workingDir: formatWorkingDir(workingDir, username),
      isLive,
      isOffline,
      isClosed,
    };
  }

  function updateDropdownButton(panel, sessionId) {
    const btn = document.getElementById(`dropdown-btn-${panel}`);
    const canControl = (panel === 'left' && isOwner()) || (panel === 'right' && !isOwner());

    btn.disabled = !canControl;

    if (!sessionId) {
      btn.innerHTML = `<span class="session-label">Select terminal...</span><span class="arrow">▼</span>`;
      return;
    }

    const info = getSessionDisplayInfo(sessionId);
    const statusClass = info.isClosed ? 'closed' : (info.isLive ? 'live' : 'offline');

    // Get the terminal name from selection
    const selection = panel === 'left' ? leftSelection : rightSelection;
    const terminalName = selection.terminalName;

    // Format: "PID xxx @ hostname" or "hostname" if no terminal yet
    let displayText;
    if (terminalName) {
      displayText = `PID ${terminalName} @ ${info.hostname}`;
    } else {
      displayText = info.hostname;
    }

    btn.innerHTML = `
      <span class="status-dot ${statusClass}"></span>
      <span class="session-label ${info.isClosed ? 'closed' : ''}">${displayText}</span>
      <span class="arrow">▼</span>
    `;
  }

  function updateDropdownMenu(panel) {
    const menu = document.getElementById(`dropdown-menu-${panel}`);
    if (!jamState) {
      menu.innerHTML = '<div class="session-dropdown-label">Loading...</div>';
      return;
    }

    const jamSessionIds = new Set(jamState.sessions.map(s => s.sessionId));

    // Build list: jam terminals first, then user's sessions not in jam
    let html = '';

    // Terminals in the jam (flatten sessions into terminals)
    const terminals = [];
    jamState.sessions.forEach(s => {
      const info = getSessionDisplayInfo(s.sessionId);
      if (s.terminals && s.terminals.length > 0) {
        // Add each terminal
        s.terminals.forEach(t => {
          terminals.push({
            sessionId: s.sessionId,
            terminalName: t.name,
            addedBy: s.addedBy,
            hostname: info.hostname || 'unknown',
            isLive: info.isLive,
            isClosed: info.isClosed,
            isOffline: info.isOffline,
          });
        });
      } else if (info.isLive) {
        // Session is live but no terminals yet - show as "waiting"
        terminals.push({
          sessionId: s.sessionId,
          terminalName: null,
          addedBy: s.addedBy,
          hostname: info.hostname || 'unknown',
          isLive: true,
          isClosed: false,
          isOffline: false,
          waiting: true,
        });
      }
    });

    if (terminals.length > 0) {
      html += '<div class="session-dropdown-label">In this jam</div>';
      const currentSelection = panel === 'left' ? leftSelection : rightSelection;

      terminals.forEach(t => {
        const isMine = t.addedBy.userId === currentUser.id;
        const statusClass = t.isClosed ? 'closed' : (t.isLive ? 'live' : 'offline');
        const isSelected = currentSelection.sessionId === t.sessionId && currentSelection.terminalName === t.terminalName;
        let itemClass = t.isClosed ? 'session-dropdown-item closed-session' : 'session-dropdown-item';
        if (isSelected) {
          itemClass += ' selected';
        }

        // Format: "@username: PID xxx" and "hostname" on second line
        const pidDisplay = t.terminalName ? `PID ${t.terminalName}` : 'waiting...';
        const canClick = t.terminalName !== null;
        const onClickAttr = canClick
          ? `onclick="selectTerminalFromDropdown('${panel}', '${t.sessionId}', '${t.terminalName}')"`
          : '';

        html += `
          <div class="${itemClass}${canClick ? '' : ' disabled'}" data-session-id="${t.sessionId}" ${onClickAttr}>
            <span class="status-dot ${statusClass}"></span>
            <div class="session-info">
              <div class="session-id">@${t.addedBy.login}: ${pidDisplay}</div>
              <div class="session-owner">${t.hostname}</div>
            </div>
            ${isMine ? `<button class="remove-btn" onclick="event.stopPropagation(); removeSessionFromJam('${t.sessionId}')" title="Remove from jam">×</button>` : ''}
          </div>
        `;
      });
    }

    // User's sessions (always show all - clicking adds a new terminal)
    const canControl = (panel === 'left' && isOwner()) || (panel === 'right' && !isOwner());

    if (canControl && mySessions.length > 0) {
      if (terminals.length > 0) {
        html += '<div class="session-dropdown-divider"></div>';
      }
      html += '<div class="session-dropdown-label">Your sessions (click to add terminal)</div>';
      mySessions.forEach(s => {
        const isLive = s.controlConnected && (s.state === 'READY' || s.state === 'ACTIVE');
        const hostname = s.controlHandshake?.hostname || 'unknown';
        const username = s.controlHandshake?.username || '';
        const workingDir = formatWorkingDir(s.controlHandshake?.workingDir, username) || '/';
        html += `
          <div class="session-dropdown-item not-in-jam" onclick="addAndSelectSession('${panel}', '${s.id}')">
            <span class="status-dot ${isLive ? 'live' : 'offline'}"></span>
            <div class="session-info">
              <div class="session-id">${hostname}</div>
              <div class="session-owner">${workingDir}</div>
            </div>
            <span class="add-hint">+ Add</span>
          </div>
        `;
      });
    }

    if (!html) {
      html = '<div class="session-dropdown-label">No sessions available</div>';
    }

    menu.innerHTML = html;
  }

  window.selectSessionFromDropdown = function(panel, sessionId) {
    closeAllDropdowns();
    selectSession(panel, sessionId);
  };

  window.selectTerminalFromDropdown = function(panel, sessionId, terminalName) {
    closeAllDropdowns();
    selectTerminal(panel, sessionId, terminalName);
  };

  window.addAndSelectSession = function(panel, sessionId) {
    closeAllDropdowns();
    // First add the session to the jam, then select it
    if (jamWs && jamWs.readyState === WebSocket.OPEN) {
      jamWs.send(JSON.stringify({
        type: 'add_session',
        sessionId
      }));
      // After adding, select it (the panel_state_update will apply it)
      // Small delay to let the add complete
      setTimeout(() => {
        selectSession(panel, sessionId);
      }, 100);
    }
  };

  window.removeSessionFromJam = function(sessionId) {
    if (jamWs && jamWs.readyState === WebSocket.OPEN) {
      jamWs.send(JSON.stringify({
        type: 'remove_session',
        sessionId
      }));
    }
  };

  // =========================================================================
  // Panel Selection
  // =========================================================================

  function setupDropdowns() {
    // Toggle dropdown on button click
    document.getElementById('dropdown-btn-left').addEventListener('click', function(e) {
      e.stopPropagation();
      toggleDropdown('left');
    });
    document.getElementById('dropdown-btn-right').addEventListener('click', function(e) {
      e.stopPropagation();
      toggleDropdown('right');
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', function() {
      closeAllDropdowns();
    });
  }

  function toggleDropdown(panel) {
    const dropdown = document.getElementById(`dropdown-${panel}`);
    const wasOpen = dropdown.classList.contains('open');

    closeAllDropdowns();

    if (!wasOpen) {
      // Check if user can control this panel
      const canControl = (panel === 'left' && isOwner()) || (panel === 'right' && !isOwner());
      if (!canControl) return;

      dropdown.classList.add('open');
    }
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.session-dropdown').forEach(d => d.classList.remove('open'));
  }

  function selectSession(panel, sessionId) {
    // Check permission locally (server will also validate)
    const owner = isOwner();
    const canChange = (panel === 'left' && owner) || (panel === 'right' && !owner);

    if (!canChange) {
      return;
    }

    // Send to server - the broadcast will apply the change to all clients
    // Terminal name is no longer sent - it's determined at connection time (PID-based)
    if (jamWs && jamWs.readyState === WebSocket.OPEN) {
      jamWs.send(JSON.stringify({
        type: 'panel_select',
        panel,
        sessionId,
      }));
    }
  }

  function selectTerminal(panel, sessionId, terminalName) {
    // Check permission locally
    const owner = isOwner();
    const canChange = (panel === 'left' && owner) || (panel === 'right' && !owner);

    if (!canChange) {
      return;
    }

    // Update local selection state with the specific terminal
    if (panel === 'left') {
      leftSelection = { sessionId, terminalName };
    } else {
      rightSelection = { sessionId, terminalName };
    }

    // Update dropdown button
    updateDropdownButton(panel, sessionId);

    // Update panel mode display
    updatePanelModes();

    // Connect to the specific terminal
    connectTerminal(panel, sessionId, terminalName);

    // Note: We don't broadcast panel_select here because terminal selection is local.
    // Each user can view different terminals. Only session addition is shared.
  }

  // =========================================================================
  // Panel Divider
  // =========================================================================

  function setupDivider() {
    const container = document.getElementById('terminals-container');
    const divider = document.getElementById('divider');
    const panelLeft = document.getElementById('panel-left');
    const panelRight = document.getElementById('panel-right');
    let isDragging = false;

    divider.addEventListener('mousedown', function(e) {
      isDragging = true;
      divider.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;

      const containerRect = container.getBoundingClientRect();
      const containerWidth = containerRect.width;
      const dividerWidth = divider.offsetWidth;
      const minWidth = 100;

      let leftWidth = e.clientX - containerRect.left;
      leftWidth = Math.max(minWidth, Math.min(leftWidth, containerWidth - minWidth - dividerWidth));

      const leftPercent = (leftWidth / containerWidth) * 100;
      const rightPercent = ((containerWidth - leftWidth - dividerWidth) / containerWidth) * 100;

      panelLeft.style.flex = 'none';
      panelRight.style.flex = 'none';
      panelLeft.style.width = leftPercent + '%';
      panelRight.style.width = rightPercent + '%';

      window.dispatchEvent(new Event('resize'));
    });

    document.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        divider.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  // =========================================================================
  // Modals
  // =========================================================================

  let inviteSearchTimeout = null;
  let recentInvitees = [];

  function setupModals() {
    document.getElementById('invite-btn').addEventListener('click', openInviteModal);

    // Close on overlay click
    document.getElementById('invite-modal').addEventListener('click', function(e) {
      if (e.target === this) closeInviteModal();
    });

    // Set up invite search
    const inviteSearch = document.getElementById('invite-search');
    inviteSearch.addEventListener('input', handleInviteSearch);
    inviteSearch.addEventListener('focus', handleInviteSearchFocus);

    // Load recent invitees from localStorage
    loadRecentInvitees();
  }

  function loadRecentInvitees() {
    try {
      const stored = localStorage.getItem('paircoded_recent_invitees');
      if (stored) {
        recentInvitees = JSON.parse(stored);
      }
    } catch (e) {
      recentInvitees = [];
    }
  }

  function saveRecentInvitee(user) {
    // Add to front, remove duplicates, limit to 10
    recentInvitees = recentInvitees.filter(u => u.id !== user.id);
    recentInvitees.unshift(user);
    recentInvitees = recentInvitees.slice(0, 10);
    try {
      localStorage.setItem('paircoded_recent_invitees', JSON.stringify(recentInvitees));
    } catch (e) {
      // Ignore storage errors
    }
  }

  function handleInviteSearchFocus() {
    const query = document.getElementById('invite-search').value.trim();
    if (query.length === 0) {
      showRecentInvitees();
    }
  }

  function handleInviteSearch() {
    const query = document.getElementById('invite-search').value.trim();

    if (inviteSearchTimeout) {
      clearTimeout(inviteSearchTimeout);
    }

    if (query.length === 0) {
      showRecentInvitees();
      return;
    }

    if (query.length < 2) {
      document.getElementById('invite-peers-list').innerHTML =
        '<div class="no-peers">Type at least 2 characters to search...</div>';
      return;
    }

    document.getElementById('invite-peers-list').innerHTML =
      '<div class="no-peers">Searching...</div>';

    inviteSearchTimeout = setTimeout(() => {
      searchGitHubUsers(query);
    }, 300);
  }

  function showRecentInvitees() {
    const list = document.getElementById('invite-peers-list');

    if (recentInvitees.length === 0) {
      list.innerHTML = '<div class="no-peers">Start typing to search GitHub users...</div>';
      return;
    }

    list.innerHTML = renderUserList(recentInvitees, 'Recent');
  }

  function searchGitHubUsers(query) {
    fetch(`/api/github/users?q=${encodeURIComponent(query)}`)
      .then(res => res.json())
      .then(data => {
        const list = document.getElementById('invite-peers-list');
        const users = data.users || [];

        if (users.length === 0) {
          list.innerHTML = '<div class="no-peers">No users found</div>';
          return;
        }

        // Filter out current user
        const filteredUsers = users.filter(u =>
          u.login.toLowerCase() !== currentUser.login.toLowerCase()
        );

        if (filteredUsers.length === 0) {
          list.innerHTML = '<div class="no-peers">No users found</div>';
          return;
        }

        list.innerHTML = renderUserList(filteredUsers);
      })
      .catch(err => {
        console.error('GitHub search failed:', err);
        document.getElementById('invite-peers-list').innerHTML =
          '<div class="no-peers">Search failed. Try again.</div>';
      });
  }

  function renderUserList(users, label) {
    const participantIds = new Set(jamState?.participants.map(p => p.userId) || []);
    const invitedLogins = new Set((jamState?.pendingInvitations || []).map(i => i.to.login.toLowerCase()));

    let html = '';
    if (label) {
      html += `<div style="font-size:11px;color:#666;padding:4px 8px;text-transform:uppercase;">${label}</div>`;
    }

    html += users.map(user => {
      const isMember = participantIds.has(user.id);
      const isInvited = invitedLogins.has(user.login.toLowerCase());
      const isUnavailable = isMember || isInvited;

      let statusLabel = '';
      if (isMember) {
        statusLabel = '<span class="status member">Member</span>';
      } else if (isInvited) {
        statusLabel = '<span class="status invited">Invited</span>';
      }

      if (isUnavailable) {
        return `
          <div class="modal-peer already-in">
            <img src="${user.avatar_url}" alt="${user.login}">
            <span>${user.login}</span>
            ${statusLabel}
          </div>
        `;
      }

      return `
        <div class="modal-peer" onclick="invitePeer('${user.login}', '${user.avatar_url}', ${user.id})">
          <img src="${user.avatar_url}" alt="${user.login}">
          <span>${user.login}</span>
        </div>
      `;
    }).join('');

    return html;
  }

  window.openInviteModal = function() {
    const modal = document.getElementById('invite-modal');
    const searchInput = document.getElementById('invite-search');

    // Clear search and show recent invitees
    searchInput.value = '';
    showRecentInvitees();

    modal.classList.add('visible');

    // Focus the search input
    setTimeout(() => searchInput.focus(), 100);
  };

  window.closeInviteModal = function() {
    document.getElementById('invite-modal').classList.remove('visible');
  };

  window.invitePeer = function(peerLogin, avatarUrl, userId) {
    // Save to recent invitees
    if (avatarUrl && userId) {
      saveRecentInvitee({ id: userId, login: peerLogin, avatar_url: avatarUrl });
    }

    fetch(`/api/jams/${jamId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerLogin })
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
        } else {
          // Add to local state for immediate UI update
          if (jamState && data.invitation) {
            if (!jamState.pendingInvitations) {
              jamState.pendingInvitations = [];
            }
            jamState.pendingInvitations.push({
              id: data.invitation.id,
              to: data.invitation.to,
              from: data.invitation.from,
              createdAt: data.invitation.createdAt,
            });
            updateParticipantsUI();
          }
          closeInviteModal();
        }
      })
      .catch(err => {
        console.error('Failed to send invitation:', err);
        alert('Failed to send invitation');
      });
  };

})();
