
  // ══════════════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════════════
  const params = new URLSearchParams(location.search);
  let roomCode = location.pathname.split('/room/')[1]?.toUpperCase();
  let myPlayerId = params.get('pid') || localStorage.getItem('pid');
  let myUsername = params.get('name') || localStorage.getItem('username') || 'Artist';

  const socket = io();

  let timerInterval = null;
  let timerSeconds = 0;
  let timerTotal = 0;
  let currentPhase = 'lobby';
  let currentGallery = null;
  let currentGalleryIndex = 0; // which prompt set we're voting on
  let myVotes = {};  // originalOwnerId → chosenPlayerId
  let allPlayers = [];
  let drawingStrokeHistory = [];  // for undo
  let copyingStrokeHistory = [];

  // ── Canvas refs ──
  const drawCanvas = document.getElementById('drawing-canvas');
  const drawCtx = drawCanvas.getContext('2d');
  const copyCanvas = document.getElementById('copying-canvas');
  const copyCtx = copyCanvas.getContext('2d');

  // ══════════════════════════════════════════════
  //  VIEWS
  // ══════════════════════════════════════════════
  const ALL_VIEWS = [
    'view-lobby','view-draw-transition','view-prompt-reveal','view-drawing',
    'view-waiting','view-observe','view-copy-transition',
    'view-copying','view-vote-transition','view-voting',
    'view-reveal','view-scores','view-final-round','view-ended'
  ];

  function showView(id) {
    ALL_VIEWS.forEach(v => document.getElementById(v).classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
    currentPhase = id;
  }

  // ══════════════════════════════════════════════
  //  TIMER / INK BAR
  // ══════════════════════════════════════════════
  function startTimer(seconds, labelText) {
    clearInterval(timerInterval);
    timerSeconds = seconds;
    timerTotal = seconds;
    const bar = document.getElementById('ink-bar-container');
    const fill = document.getElementById('ink-bar-fill');
    const text = document.getElementById('ink-bar-text');
    
    bar.classList.remove('hidden');
    fill.style.width = '100%';
    text.textContent = labelText || '';
    
    timerInterval = setInterval(() => {
      timerSeconds--;
      const pct = Math.max(0, (timerSeconds / timerTotal) * 100);
      fill.style.width = pct + '%';
      if (timerSeconds <= 0) {
        clearInterval(timerInterval);
        fill.style.width = '0%';
      }
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    document.getElementById('ink-bar-container').classList.add('hidden');
  }

  // ═══════════════════════════  // ══════════════════════════════════════════════
  //  CANVAS DRAWING (with tools)
  // ══════════════════════════════════════════════
  function setupCanvas(canvas, ctx, historyArr, toolbarId) {
    let drawing = false;
    let currentPath = [];
    let currentColor = '#1A1A1A';
    let currentSize = 10;

    const tb = document.getElementById(toolbarId);
    if (tb) {
      // Color buttons & Eraser
      const colorBtns = tb.querySelectorAll('.color-btn, .tool-eraser');
      colorBtns.forEach(btn => {
        btn.onclick = () => {
          colorBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentColor = btn.dataset.color;
        };
      });
      // Size buttons
      const sizeBtns = tb.querySelectorAll('.tool-size');
      sizeBtns.forEach(btn => {
        btn.onclick = () => {
          sizeBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentSize = parseInt(btn.dataset.size, 10);
        };
      });
      // Clear button
      const clearBtn = tb.querySelector('.tool-clear');
      if (clearBtn) {
        clearBtn.onclick = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          historyArr.push({ type: 'clear' });
        };
      }
    }

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
    }

    function startStroke(e) {
      drawing = true;
      currentPath = { points: [], color: currentColor, size: currentSize };
      ctx.beginPath();
      ctx.strokeStyle = currentColor;
      ctx.lineWidth = currentSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const [x, y] = getPos(e);
      ctx.moveTo(x, y);
      currentPath.points.push([x, y]);
      e.preventDefault();
    }

    function doStroke(e) {
      if (!drawing) return;
      const [x, y] = getPos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      currentPath.points.push([x, y]);
      e.preventDefault();
    }

    function endStroke(e) {
      if (!drawing) return;
      drawing = false;
      if (currentPath.points.length > 0) historyArr.push({...currentPath});
      e.preventDefault();
    }

    canvas.addEventListener('mousedown', startStroke);
    canvas.addEventListener('mousemove', doStroke);
    canvas.addEventListener('mouseup', endStroke);
    canvas.addEventListener('touchstart', startStroke, { passive: false });
    canvas.addEventListener('touchmove', doStroke, { passive: false });
    canvas.addEventListener('touchend', endStroke, { passive: false });
  }

  function undoCanvas(canvas, ctx, historyArr) {
    historyArr.pop();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    historyArr.forEach(stroke => {
      if (stroke.type === 'clear') {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      ctx.beginPath();
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      stroke.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt[0], pt[1]) : ctx.lineTo(pt[0], pt[1]));
      ctx.stroke();
    });
  }

  setupCanvas(drawCanvas, drawCtx, drawingStrokeHistory, 'draw-toolbar');
  setupCanvas(copyCanvas, copyCtx, copyingStrokeHistory, 'copy-toolbar');

  document.getElementById('drawing-undo-btn').onclick = () => undoCanvas(drawCanvas, drawCtx, drawingStrokeHistory);
  document.getElementById('copying-undo-btn').onclick = () => undoCanvas(copyCanvas, copyCtx, copyingStrokeHistory);

  // ══════════════════════════════════════════════
  //  VOTES / GALLERY STATE
  // ══════════════════════════════════════════════
  // We vote on one prompt at a time (currentGalleryIndex)
  // After voting on all, we send all votes

  function buildVotingUI() {
    if (!currentGallery || currentGallery.length === 0) return;
    const set = currentGallery[currentGalleryIndex];
    if (!set) return;

    document.getElementById('voting-prompt-title').textContent = set.prompt;
    
    const container = document.getElementById('voting-cards');
    container.innerHTML = '';

    set.entries.forEach(entry => {
      const card = document.createElement('div');
      card.className = 'vote-card';
      card.dataset.playerId = entry.playerId;

      const voterNames = document.createElement('div');
      voterNames.className = 'vote-voter-names';
      card.appendChild(voterNames);

      const img = document.createElement('img');
      img.className = 'vote-card-img';
      img.src = entry.dataUrl || '';
      img.alt = 'block drawing';
      card.appendChild(img);

      const lbl = document.createElement('div');
      lbl.className = 'vote-card-label';
      lbl.textContent = 'block drawing';
      card.insertBefore(lbl, voterNames);

      card.onclick = () => {
        // Can't vote for your own drawing
        if (entry.playerId === myPlayerId) {
          toast('You cannot vote for your own drawing!');
          return;
        }

        container.querySelectorAll('.vote-card-img').forEach(i => i.classList.remove('selected'));
        img.classList.add('selected');
        myVotes[set.originalOwnerId] = entry.playerId;

        // After a short delay, advance to next prompt or submit
        setTimeout(() => {
          if (currentGalleryIndex + 1 < currentGallery.length) {
            currentGalleryIndex++;
            buildVotingUI();
          } else {
            // All voted — submit
            socket.emit('submit-vote', { roomCode, playerId: myPlayerId, choices: myVotes });
            showView('view-waiting-copy'); // show a brief wait
            document.getElementById('view-waiting-copy').querySelector('h1').textContent = 'waiting for other voters';
          }
        }, 600);
      };

      container.appendChild(card);
    });
  }

  // ══════════════════════════════════════════════
  //  REVEAL UI
  // ══════════════════════════════════════════════
  function buildRevealUI(gallery, voteResults) {
    // Show one prompt set at a time
    const revealContainer = document.getElementById('reveal-cards');
    revealContainer.innerHTML = '';

    // For now show all prompts scrollable
    gallery.forEach(set => {
      document.getElementById('reveal-prompt-title').textContent = set.prompt;

      const voterMap = {}; // playerId → [voterNames]
      if (voteResults && voteResults[set.originalOwnerId]) {
        voteResults[set.originalOwnerId].voterChoices.forEach(vc => {
          if (!voterMap[vc.chosenPlayerId]) voterMap[vc.chosenPlayerId] = [];
          voterMap[vc.chosenPlayerId].push(vc.voterName);
        });
      }

      set.entries.forEach(entry => {
        const card = document.createElement('div');
        card.className = 'reveal-card';

        // Voter bubbles at top
        const voterRow = document.createElement('div');
        voterRow.className = 'reveal-voter-row';
        (voterMap[entry.playerId] || []).forEach(name => {
          const b = document.createElement('span');
          b.className = 'reveal-voter-bubble';
          b.style.position = 'relative'; 
          b.textContent = name;
          if (entry.isOriginal) {
            const pts = document.createElement('span');
            pts.className = 'floating-pts';
            pts.textContent = '+100';
            b.appendChild(pts);
          }
          voterRow.appendChild(b);
        });
        card.appendChild(voterRow);

        const img = document.createElement('img');
        img.className = 'reveal-card-img';
        img.src = entry.dataUrl || '';
        img.alt = 'block drawing';
        if (entry.isOriginal) img.classList.add('original-highlight');
        card.appendChild(img);

        const typeLabel = document.createElement('div');
        typeLabel.className = 'reveal-card-type-label ' + (entry.isOriginal ? 'reveal-original-badge' : 'reveal-copy-badge');
        typeLabel.textContent = entry.isOriginal ? 'original' : 'copy';
        card.appendChild(typeLabel);

        const artistLabel = document.createElement('div');
        artistLabel.className = 'reveal-card-artist';
        artistLabel.textContent = entry.username || '';
        card.appendChild(artistLabel);

        revealContainer.appendChild(card);
      });
    });
  }

  // ══════════════════════════════════════════════
  //  SCORES UI
  // ══════════════════════════════════════════════
  function buildScoresUI(players, isFinal) {
    document.getElementById('scores-header').textContent = isFinal ? 'final scores' : 'scores';
    const list = document.getElementById('scores-list');
    list.innerHTML = '';
    players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'score-row' + (p.id === myPlayerId ? ' me-row' : '');
      const nameEl = document.createElement('div');
      nameEl.className = 'score-row-bullet';
      nameEl.innerHTML = `<span>•</span><span>${p.username}</span>`;
      const scoreEl = document.createElement('div');
      scoreEl.textContent = p.score || 0;
      row.appendChild(nameEl);
      row.appendChild(scoreEl);
      list.appendChild(row);
    });
  }

  function buildFinalScoresUI(players) {
    const list = document.getElementById('final-scores-list');
    list.innerHTML = '';
    players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'score-row' + (p.id === myPlayerId ? ' me-row' : '');
      const nameEl = document.createElement('div');
      nameEl.className = 'score-row-bullet';
      nameEl.innerHTML = `<span>•</span><span>${p.username}</span>`;
      const scoreEl = document.createElement('div');
      scoreEl.textContent = p.score || 0;
      row.appendChild(nameEl);
      row.appendChild(scoreEl);
      list.appendChild(row);
    });
  }

  function renderPlayersPanel(players) {
    console.log('👥 Rendering players:', players.length);
    allPlayers = players;
    
    // 1. Lobby Starburst List
    const lobbyList = document.getElementById('lobby-players-list');
    if (lobbyList) {
      lobbyList.innerHTML = '';
      players.forEach((p, i) => {
        const bubble = document.createElement('div');
        bubble.className = 'lobby-player-bubble';
        if (p.id === myPlayerId) bubble.classList.add('me-bubble');
        
        // Host indicator
        const isH = p.isHost || p.is_host;
        bubble.innerHTML = `${isH ? '👑 ' : ''}${p.username}${p.id === myPlayerId ? ' (you)' : ''}`;
        
        // Random slight rotation for "sketchy" feel
        const rot = (i % 2 === 0 ? 1 : -1) * (Math.random() * 5);
        bubble.style.transform = `rotate(${rot}deg)`;
        lobbyList.appendChild(bubble);
      });
    }

    // 2. Sidebar Panel List (Roblox style)
    const panelList = document.getElementById('players-panel-list');
    if (panelList) {
      panelList.innerHTML = '';
      players.forEach(p => {
        const row = document.createElement('div');
        row.className = 'panel-player-name' + (p.id === myPlayerId ? ' me' : '');
        
        const isH = p.isHost || p.is_host;
        row.innerHTML = `
          <span>${isH ? '👑 ' : ''}${p.username}${p.id === myPlayerId ? ' (you)' : ''}</span>
          <span class="panel-status ${playerStatusMap[p.id]?.toLowerCase() === 'done' ? 'done' : ''}">
            ${playerStatusMap[p.id] || ''}
          </span>
        `;
        panelList.appendChild(row);
      });
    }
  }

  function checkHostControls(playersOrRoom) {
    if (!playersOrRoom) return;
    const players = Array.isArray(playersOrRoom) ? playersOrRoom : playersOrRoom.players;
    if (!players) return;

    const me = players.find(p => p.id === myPlayerId);
    console.log('🧐 Host check: myPlayerId =', myPlayerId);
    console.log('🧐 Host check: found me =', me);
    if (me) console.log('🧐 Host check: me.is_host =', me.is_host, 'me.isHost =', me.isHost);

    const isHost = me && (me.isHost || me.is_host);
    const hostCtrls = document.getElementById('host-controls');
    const readyBtn = document.getElementById('ready-btn');

    if (isHost) {
      console.log('👑 UI: Showing Host Controls');
      hostCtrls.classList.remove('hidden');
      readyBtn.textContent = 'HOST';
      readyBtn.disabled = true;
      readyBtn.style.background = '#1A1A1A';
      readyBtn.style.color = '#fff';
    } else {
      console.log('👤 UI: Showing Player Controls');
      hostCtrls.classList.add('hidden');
      readyBtn.textContent = 'READY UP';
      readyBtn.disabled = false;
      readyBtn.style.background = '#27ae60';
      readyBtn.style.color = '#fff';
    }
  }

  // ══════════════════════════════════════════════
  //  SOCKET EVENTS
  // ══════════════════════════════════════════════

  socket.on('room-joined', ({ roomCode: rc, playerId, room }) => {
    roomCode = rc;
    myPlayerId = playerId;
    localStorage.setItem('pid', playerId);
    localStorage.setItem('roomCode', rc);
    localStorage.setItem('username', myUsername);
    document.getElementById('room-code-display').textContent = rc;
    showView('view-lobby');

    if (room && room.players) renderPlayersPanel(room.players);
    checkHostControls(room);
  });

  socket.on('player-list', (players) => {
    console.log('📡 player-list received:', players.length, 'players');
    renderPlayersPanel(players);
    checkHostControls(players);
  });

  socket.on('error', ({ message }) => toast('❌ ' + message));

  socket.on('rejoin-failed', ({ roomCode }) => {
    console.warn(`⚠️ Rejoin failed for ${roomCode}, joining as fresh player.`);
    const name = myUsername || 'Artist';
    socket.emit('join-room', { roomCode, username: name });
  });

  socket.on('player-status', ({ playerId, status }) => {
    playerStatusMap[playerId] = status;
    renderPlayersPanel(allPlayers);
  });

  socket.on('phase-change', (data) => {
    const { phase, duration, round, totalRounds, pointsBase } = data;

    // reset HUD statuses
    if (phase !== 'results' && phase !== 'ended') {
      playerStatusMap = {};
      allPlayers.forEach(p => playerStatusMap[p.id] = (phase === 'drawing' || phase === 'copying' || phase === 'voting') ? (phase === 'voting' ? 'Voting...' : 'Drawing...') : '');
      renderPlayersPanel(allPlayers);
    }

    switch (phase) {
      case 'drawing': {
        autoSubDrawing = false;
        const pts = pointsBase || 100;
        document.getElementById('draw-pts-orig-label').textContent = pts + ' points';
        document.getElementById('draw-pts-orig-label2').textContent = pts + ' points';
        
        // Reset Fake Drawing Animation
        const fakeSvg = document.getElementById('fake-draw-svg');
        if (fakeSvg) {
          fakeSvg.style.animation = 'none';
          fakeSvg.offsetHeight; // trigger reflow
          fakeSvg.style.animation = null;
          // reset inner paths
          fakeSvg.querySelectorAll('.fd-path').forEach(p => {
            p.style.animation = 'none';
            p.offsetHeight;
            p.style.animation = null;
          });
        }

        document.getElementById('draw-trans-text').style.display = 'flex';
        fakeSvg.style.display = 'block';
        document.getElementById('draw-trans-countdown').classList.add('hidden');
        showView('view-draw-transition');
        
        // 5-second timer for Knowledge Phase
        startTimer(5, 'game starts in...');

        setTimeout(() => {
           const promptText = document.getElementById('drawing-prompt-text').textContent;
           document.getElementById('reveal-prompt-text').textContent = '"' + promptText + '"';
           document.getElementById('reveal-cd-num').textContent = '3';
           showView('view-prompt-reveal');
           
           let count = 3;
           const intv = setInterval(() => {
             count--;
             if (count > 0) {
               document.getElementById('reveal-cd-num').textContent = count;
             } else {
               clearInterval(intv);
               drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
               drawingStrokeHistory.length = 0;
               document.getElementById('drawing-submit-btn').disabled = false;
               document.getElementById('drawing-submit-btn').textContent = 'submit';
               showView('view-drawing');
               startTimer(duration || 90, 'draw the prompt');
             }
           }, 1000);
        }, 5000); // 5 second transition
        break;
      }

      case 'observe': {
        const area = document.getElementById('observe-canvas-area');
        area.classList.remove('obs-hidden-overlay');
        
        const img = document.getElementById('observe-img');
        img.src = data.dataUrl || '';
        img.onerror = () => { img.src = ''; };
        
        const roundNum = round || 1;
        document.getElementById('observe-main-text').textContent = roundNum > 1 ? 'observe again' : 'observe the drawing';
        document.getElementById('observe-sub-text').textContent = roundNum > 1 ? `round ${roundNum}: remember it well!` : 'try to remember as much as possible';
        
        showView('view-observe');
        startTimer(duration || 10, '');
        
        // After 2.5s, hide the overlay to let them see the drawing clearly
        setTimeout(() => {
          area.classList.add('obs-hidden-overlay');
        }, 2500);
        
        // After observe, show copy transition
        setTimeout(() => {
          // Show copy transition splash
          const copyPts = (pointsBase || 100) / 2;
          document.getElementById('copy-pts-label').textContent = copyPts + ' points';
          showView('view-copy-transition');
          stopTimer();

          // Then canvas
          setTimeout(() => {
            copyCtx.clearRect(0, 0, copyCanvas.width, copyCanvas.height);
            copyingStrokeHistory.length = 0;
            document.getElementById('copying-submit-btn').disabled = false;
            document.getElementById('copying-submit-btn').textContent = 'submit';
            showView('view-copying');
            startTimer(90, 'copy the drawing');
          }, 2500);
        }, (duration || 10) * 1000);
        break;
      }

      case 'copying': {
        autoSubCopy = false;
        // Fallback: if we get copying directly
        if (currentPhase !== 'view-copying') {
          copyCtx.clearRect(0, 0, copyCanvas.width, copyCanvas.height);
          copyingStrokeHistory.length = 0;
          document.getElementById('copying-submit-btn').disabled = false;
          showView('view-copying');
          startTimer(duration || 90, 'copy the drawing');
        }
        break;
      }

      case 'voting': {
        const { gallery } = data;
        currentGallery = gallery;
        currentGalleryIndex = 0;
        myVotes = {};

        // Brief transition first
        showView('view-vote-transition');
        stopTimer();
        setTimeout(() => {
          showView('view-voting');
          buildVotingUI();
          startTimer(duration || 30, 'pick the drawing made by the original creator');
        }, 2500);
        break;
      }

      case 'results': {
        const { gallery, voteResults, players, isFinal, round: r } = data;
        currentGallery = gallery;
        stopTimer();

        // First show reveal
        buildRevealUI(gallery || [], voteResults || {});
        showView('view-reveal');

        // After 8 seconds show scores
        setTimeout(() => {
          buildScoresUI(players || [], isFinal);
          showView('view-scores');
        }, 8000);
        break;
      }

      case 'final-round': {
        stopTimer();
        showView('view-final-round');
        break;
      }

      case 'ended': {
        const { players: finalPlayers } = data;
        stopTimer();
        buildFinalScoresUI(finalPlayers || []);
        showView('view-ended');
        break;
      }
    }
  });

  socket.on('your-prompt', ({ prompt }) => {
    document.getElementById('drawing-prompt-text').textContent = prompt;
  });

  socket.on('sync-state', ({ phase, round, prompt, dataUrl, gallery }) => {
    console.log(`🔄 Sync State: phase=${phase}, round=${round}`);
    if (prompt) document.getElementById('drawing-prompt-text').textContent = prompt;
    // Handle page reload mid-game
    if (phase === 'drawing') showView('view-drawing');
    else if (phase === 'observe') showView('view-observe');
    else if (phase === 'copying') showView('view-copying');
    else if (phase === 'results') {
       // if we reloaded during results, we might need to trigger buildRevealUI
       // but typically results only last 15s, so we might just wait for phase-change
    }
    else if (phase === 'voting' && gallery) {
      currentGallery = gallery;
      currentGalleryIndex = 0;
      myVotes = {};
      showView('view-voting');
      buildVotingUI();
    }
    else if (phase === 'lobby' || !phase) showView('view-lobby');
  });

  // ══════════════════════════════════════════════
  //  BUTTONS
  // ══════════════════════════════════════════════
  document.getElementById('start-btn').onclick = () => {
    socket.emit('start-game', { roomCode, playerId: myPlayerId });
  };

  document.getElementById('ready-btn').onclick = () => {
    socket.emit('ready-up', { roomCode, playerId: myPlayerId });
    document.getElementById('ready-btn').disabled = true;
    document.getElementById('ready-btn').textContent = 'Waiting...';
  };

  document.getElementById('drawing-submit-btn').onclick = () => {
    const dataUrl = drawCanvas.toDataURL('image/png');
    socket.emit('submit-drawing', { roomCode, playerId: myPlayerId, dataUrl });
    document.getElementById('drawing-submit-btn').disabled = true;
    document.getElementById('drawing-submit-btn').textContent = 'submitted!';
    stopTimer();
    showView('view-waiting');
  };

  document.getElementById('copying-submit-btn').onclick = () => {
    const dataUrl = copyCanvas.toDataURL('image/png');
    socket.emit('submit-copy', { roomCode, playerId: myPlayerId, dataUrl });
    document.getElementById('copying-submit-btn').disabled = true;
    document.getElementById('copying-submit-btn').textContent = 'submitted!';
    stopTimer();
    showView('view-waiting');
  };

  // ══════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════
  function checkHostControls(room) {
    if (!room) return;
    const me = (room.players || []).find(p => p.id === myPlayerId);
    if (me && (me.isHost || me.is_host)) {
      document.getElementById('host-controls').classList.remove('hidden');
      document.getElementById('ready-btn').textContent = 'Host';
      document.getElementById('ready-btn').disabled = true;
    }
  }

  // Join or rejoin
  socket.on('connect', () => {
    console.log(`🔌 Connected to server as ${socket.id}`);
    if (roomCode && myPlayerId) {
      console.log(`🔄 Attempting to rejoin ${roomCode} with PID ${myPlayerId}`);
      socket.emit('rejoin', { roomCode, playerId: myPlayerId });
      showView('view-lobby');
    } else if (roomCode) {
      console.log(`👤 Joining ${roomCode} as fresh player`);
      const name = myUsername || 'Artist';
      socket.emit('join-room', { roomCode, username: name });
    }
  });

  socket.on('disconnect', () => {
    console.warn('🔌 Disconnected from server');
  });

  // Auto timer-out: if timer hits 0 and still in drawing, auto-submit
  let autoSubDrawing = false;
  let autoSubCopy = false;
  setInterval(() => {
    if (timerSeconds <= 0) {
      if (currentPhase === 'view-drawing' && !autoSubDrawing) {
        autoSubDrawing = true;
        document.getElementById('drawing-submit-btn').click();
      }
      if (currentPhase === 'view-copying' && !autoSubCopy) {
        autoSubCopy = true;
        document.getElementById('copying-submit-btn').click();
      }
    }
  }, 1000);
  