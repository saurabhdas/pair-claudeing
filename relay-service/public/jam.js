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

  // Panel state
  let leftSelection = { sessionId: null, terminalName: 'main' };
  let rightSelection = { sessionId: null, terminalName: 'main' };
  let leftSetupComplete = false;
  let rightSetupComplete = false;

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

    // Set up panel selection handlers
    setupPanelSelectors();

    // Set up modal handlers
    setupModals();
  }

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

      case 'error':
        console.error('Jam error:', msg.error, msg.code);
        if (msg.code === 'JAM_NOT_FOUND' || msg.code === 'NOT_PARTICIPANT') {
          alert(msg.error);
          window.location.href = '/';
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
        jamState.participants.push({ ...msg.participant, online: true, panelStates: [] });
      }
    } else if (msg.action === 'left') {
      // Mark participant as offline
      const participant = jamState.participants.find(p => p.userId === msg.participant.userId);
      if (participant) {
        participant.online = false;
      }
    }

    updateParticipantsUI();
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

      // If removed session was selected, clear selection
      if (leftSelection.sessionId === msg.sessionId) {
        selectSession('left', null, 'main');
      }
      if (rightSelection.sessionId === msg.sessionId) {
        selectSession('right', null, 'main');
      }
    }

    updateSessionDropdowns();
    updatePanelModes();
  }

  function handlePanelStateUpdate(msg) {
    // Update panel state in jam state for the user
    if (!jamState) return;

    const participant = jamState.participants.find(p => p.userId === msg.userId);
    if (participant) {
      if (!participant.panelStates) participant.panelStates = [];
      const existing = participant.panelStates.find(s => s.panel === msg.panel);
      if (existing) {
        existing.sessionId = msg.sessionId;
        existing.terminalName = msg.terminalName;
      } else {
        participant.panelStates.push({
          panel: msg.panel,
          sessionId: msg.sessionId,
          terminalName: msg.terminalName,
        });
      }
    }
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
    term.writeln(`Connecting to ${sessionId}:${terminalName}...`);

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
      const setupMsg = {
        type: 'setup',
        action: canEditPanel(panel) ? 'new' : 'mirror',
        name: terminalName,
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
          if (isLeft) {
            leftSetupComplete = true;
          } else {
            rightSetupComplete = true;
          }
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
    updateParticipantsUI();
    updateSessionDropdowns();
    updatePanelModes();
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
    if (!jamState) return;

    const leftSelect = document.getElementById('select-left');
    const rightSelect = document.getElementById('select-right');

    const renderOptions = (select, currentSessionId) => {
      const currentValue = currentSessionId || '';
      select.innerHTML = '<option value="">Select session...</option>' +
        jamState.sessions.map(s => {
          const owner = s.addedBy.login;
          const status = s.isLive ? '' : ' (offline)';
          const selected = s.sessionId === currentValue ? 'selected' : '';
          return `<option value="${s.sessionId}" ${selected}>${s.sessionId} (@${owner})${status}</option>`;
        }).join('');
    };

    renderOptions(leftSelect, leftSelection.sessionId);
    renderOptions(rightSelect, rightSelection.sessionId);
  }

  // =========================================================================
  // Panel Selection
  // =========================================================================

  function setupPanelSelectors() {
    const leftSelect = document.getElementById('select-left');
    const rightSelect = document.getElementById('select-right');

    leftSelect.addEventListener('change', function() {
      selectSession('left', this.value || null, 'main');
    });

    rightSelect.addEventListener('change', function() {
      selectSession('right', this.value || null, 'main');
    });
  }

  function selectSession(panel, sessionId, terminalName) {
    if (panel === 'left') {
      leftSelection = { sessionId, terminalName };
    } else {
      rightSelection = { sessionId, terminalName };
    }

    // Update panel mode display
    updatePanelModes();

    // Connect to terminal
    connectTerminal(panel, sessionId, terminalName);

    // Notify jam WebSocket of panel selection
    if (jamWs && jamWs.readyState === WebSocket.OPEN) {
      jamWs.send(JSON.stringify({
        type: 'panel_select',
        panel,
        sessionId,
        terminalName,
      }));
    }
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
    document.getElementById('add-session-btn').addEventListener('click', openAddSessionModal);

    // Close on overlay click
    document.getElementById('invite-modal').addEventListener('click', function(e) {
      if (e.target === this) closeInviteModal();
    });
    document.getElementById('add-session-modal').addEventListener('click', function(e) {
      if (e.target === this) closeAddSessionModal();
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

  window.openAddSessionModal = function() {
    const modal = document.getElementById('add-session-modal');
    const list = document.getElementById('add-session-list');

    list.innerHTML = '<div class="no-peers">Loading...</div>';
    modal.classList.add('visible');

    // Fetch user's sessions
    fetch('/api/my-sessions')
      .then(res => res.json())
      .then(data => {
        const sessions = data.sessions || [];

        if (sessions.length === 0) {
          list.innerHTML = '<div class="no-peers">No active sessions. Start paircoded to create a session.</div>';
          return;
        }

        // Filter out sessions already in the jam
        const existingIds = new Set(jamState?.sessions.map(s => s.sessionId) || []);
        const availableSessions = sessions.filter(s => !existingIds.has(s.id));

        if (availableSessions.length === 0) {
          list.innerHTML = '<div class="no-peers">All your sessions are already in this jam.</div>';
          return;
        }

        list.innerHTML = availableSessions.map(session => `
          <div class="modal-peer" onclick="addSessionToJam('${session.id}')">
            <span style="font-family:monospace;">${session.id}</span>
            <span style="color:#888;margin-left:8px;">${session.state}</span>
          </div>
        `).join('');
      })
      .catch(err => {
        console.error('Failed to load sessions:', err);
        list.innerHTML = '<div class="no-peers">Failed to load sessions.</div>';
      });
  };

  window.closeAddSessionModal = function() {
    document.getElementById('add-session-modal').classList.remove('visible');
  };

  window.addSessionToJam = function(sessionId) {
    // Use WebSocket for real-time update
    if (jamWs && jamWs.readyState === WebSocket.OPEN) {
      jamWs.send(JSON.stringify({
        type: 'add_session',
        sessionId
      }));
      closeAddSessionModal();
    } else {
      // Fallback to REST
      fetch(`/api/jams/${jamId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      })
        .then(res => res.json())
        .then(data => {
          if (data.error) {
            alert(data.error);
          } else {
            closeAddSessionModal();
          }
        })
        .catch(err => {
          console.error('Failed to add session:', err);
          alert('Failed to add session');
        });
    }
  };
})();
