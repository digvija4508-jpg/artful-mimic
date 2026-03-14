/**
 * Room Manager - Modular UI Orchestrator
 * Restored with high-fidelity logic from Restore Point 7.5
 */

const params = new URLSearchParams(location.search);
let roomCode = location.pathname.split('/room/')[1]?.toUpperCase();
let myPlayerId = params.get('pid') || localStorage.getItem('pid');
let myUsername = params.get('name') || localStorage.getItem('username') || 'Artist';

const socket = io();

// ── Shared State ─────────────────────────────────────────────────────────────
let allPlayers = [];
let playerStatusMap = {};
let currentPhase = 'lobby';
let timerInterval = null;
let timerSeconds = 0;
let timerTotal = 0;
let currentInk = 100;

// ── Audio Helpers ────────────────────────────────────────────────────────────
function playSFX(id) {
  const el = document.getElementById(`sfx-${id}`);
  if (el) {
    el.currentTime = 0;
    el.play().catch(e => console.warn('Audio blocked:', e));
  }
}

// Global click sound
document.addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target.closest('.btn') || e.target.closest('.lobby-btn')) {
    playSFX('click');
  }
});

const musicEl = document.getElementById('bg-music');
socket.on('music-update', ({ currentMusic, musicPlaying }) => {
  if (musicEl) {
    if (musicEl.src !== window.location.origin + currentMusic.url) {
      musicEl.src = currentMusic.url;
    }
    if (musicPlaying) {
      musicEl.play().catch(e => console.warn('Music play blocked:', e));
    } else {
      musicEl.pause();
    }
  }
  const select = document.getElementById('music-select');
  if (select) select.value = currentMusic.url;
});

// ── UI Helpers ───────────────────────────────────────────────────────────────
function updateInkBottle(pct) {
  const fill = document.querySelector('.ink-bottle-fill');
  if (fill) fill.style.height = pct + '%';
}

function toast(msg) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function animateValue(obj, start, end, duration) {
  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    obj.innerHTML = Math.floor(progress * (end - start) + start);
    if (progress < 1) {
      window.requestAnimationFrame(step);
    } else {
      obj.innerHTML = end; 
    }
  };
  window.requestAnimationFrame(step);
}

function startTimer(seconds, text) {
  clearInterval(timerInterval);
  timerSeconds = seconds;
  timerTotal = seconds;
  
  const barContainer = document.getElementById('ink-bar-container');
  const barText = document.getElementById('ink-bar-text');
  const barFill = document.getElementById('ink-bar-fill');
  const well = document.getElementById('global-timer-well');
  const wellText = document.getElementById('global-timer-text');

  if (barContainer) barContainer.classList.remove('hidden');
  if (barText) barText.textContent = text;
  if (well) {
    well.classList.remove('hidden');
    well.classList.remove('hurry');
  }

  timerInterval = setInterval(() => {
    timerSeconds--;
    if (barFill) {
      const pct = (timerSeconds / timerTotal) * 100;
      barFill.style.width = pct + '%';
    }
    if (wellText) wellText.textContent = timerSeconds < 10 ? '0' + timerSeconds : timerSeconds;
    
    if (timerSeconds <= 5 && well) well.classList.add('hurry');

    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      if (barContainer) barContainer.classList.add('hidden');
      if (well) well.classList.add('hidden');
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  const bar = document.getElementById('ink-bar-container');
  const well = document.getElementById('global-timer-well');
  if (bar) bar.classList.add('hidden');
  if (well) well.classList.add('hidden');
}

// ── Phase Loader ─────────────────────────────────────────────────────────────
async function loadPhase(phaseName, data = {}) {
  const container = document.getElementById('phase-container');
  if (!container) return;

  // Background control: Only home and lobby have background
  if (phaseName === 'lobby') {
    document.body.classList.remove('game-mode');
  } else {
    document.body.classList.add('game-mode');
  }

  try {
    const resp = await fetch(`/views/${phaseName}.html`);
    if (!resp.ok) throw new Error(`Fetch failed`);
    
    const html = await resp.text();
    container.innerHTML = html;
    
    if (phaseInitializers[phaseName]) {
      phaseInitializers[phaseName](data);
    }
  } catch (err) {
    console.error(`❌ Failed to load phase ${phaseName}:`, err);
  }
}

// ── Phase Specific Logic ──────────────────────────────────────────────────
const phaseInitializers = {
  lobby(data) {
    const rcDisplay = document.getElementById('room-code-display');
    if (rcDisplay) rcDisplay.textContent = roomCode;
    
    renderPlayersPanel(allPlayers);
    checkHostControls(allPlayers);
    
    const startBtn = document.getElementById('start-btn');
    if (startBtn) {
      startBtn.onclick = () => socket.emit('start-game', { roomCode, playerId: myPlayerId });
    }
    
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) {
      readyBtn.onclick = () => {
        socket.emit('ready-up', { roomCode, playerId: myPlayerId });
        readyBtn.disabled = true;
        readyBtn.textContent = 'Waiting...';
      };
    }
    
    const select = document.getElementById('music-select');
    if (select) {
      select.onchange = () => socket.emit('change-music', { roomCode, playerId: myPlayerId, musicIndex: select.selectedIndex });
      document.getElementById('music-play-btn').onclick = () => socket.emit('toggle-music', { roomCode, playerId: myPlayerId, playing: true });
      document.getElementById('music-pause-btn').onclick = () => socket.emit('toggle-music', { roomCode, playerId: myPlayerId, playing: false });
    }
  },

  drawing(data) {
    const canvas = document.getElementById('drawing-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const history = [];
    setupCanvas(canvas, ctx, history, 'draw-toolbar');
    
    document.getElementById('drawing-undo-btn').onclick = () => undoCanvas(canvas, ctx, history);
    
    const submitBtn = document.getElementById('drawing-submit-btn');
    submitBtn.onclick = () => {
      const dataUrl = canvas.toDataURL('image/png');
      socket.emit('submit-drawing', { roomCode, playerId: myPlayerId, dataUrl });
      submitBtn.disabled = true;
      submitBtn.textContent = 'submitted!';
      stopTimer();
      loadPhase('waiting');
    };
    
    const promptEl = document.getElementById('drawing-prompt-text');
    if (promptEl && (data.prompt || document.body.dataset.pendingPrompt)) {
      promptEl.textContent = data.prompt || document.body.dataset.pendingPrompt;
    }
    startTimer(data.duration || 90, 'draw the prompt');
    document.getElementById('ink-bottle-hud').classList.remove('hidden');
    currentInk = 100;
    updateInkBottle(100);
  },

  observe(data) {
    const img = document.getElementById('observe-img');
    const area = document.getElementById('observe-canvas-area');
    if (img) img.src = data.dataUrl || '';
    
    const roundNum = data.round || 1;
    document.getElementById('observe-main-text').textContent = roundNum > 1 ? 'observe again' : 'observe the drawing';
    document.getElementById('observe-sub-text').textContent = roundNum > 1 ? `round ${roundNum}: remember it well!` : 'try to remember as much as possible';
    
    startTimer(data.duration || 10, '');
    if (area) setTimeout(() => area.classList.add('obs-hidden-overlay'), 2500);
  },

  copying(data) {
    const canvas = document.getElementById('copying-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const history = [];
    setupCanvas(canvas, ctx, history, 'copy-toolbar');
    
    document.getElementById('copying-undo-btn').onclick = () => undoCanvas(canvas, ctx, history);
    
    const submitBtn = document.getElementById('copying-submit-btn');
    submitBtn.onclick = () => {
      const dataUrl = canvas.toDataURL('image/png');
      socket.emit('submit-copy', { roomCode, playerId: myPlayerId, dataUrl });
      submitBtn.disabled = true;
      submitBtn.textContent = 'submitted!';
      stopTimer();
      loadPhase('waiting');
    };
    
    startTimer(data.duration || 90, 'copy the drawing');
    document.getElementById('ink-bottle-hud').classList.remove('hidden');
    currentInk = 100;
    updateInkBottle(100);
  },

  voting(data) {
    buildVotingUI(data.set, data.participants);
    startTimer(data.duration || 20, 'pick the drawing made by the original creator');
    document.getElementById('ink-bottle-hud').classList.add('hidden');
  },

  reveal(data) {
    buildRevealUI(data.set, data.results);
    startTimer(data.duration || 8, 'look at the results!');
  },

  scores(data) {
    buildScoresUI(data.players, data.isFinal);
    startTimer(data.duration || 15, 'next round starting soon');
  },

  scoreboard(data) {
    buildFinalScoresUI(data.players);
    const duration = data.duration || 5;
    startTimer(duration, 'final winner reveal...');
    
    // Progress Bar & Countdown logic
    const progressFill = document.getElementById('scoreboard-progress-fill');
    const timerNum = document.getElementById('scoreboard-timer-num');
    if (progressFill && timerNum) {
      let timeLeft = duration;
      const step = 0.1;
      const interval = setInterval(() => {
        timeLeft -= step;
        if (timeLeft <= 0) {
          clearInterval(interval);
          timeLeft = 0;
        }
        if (progressFill) progressFill.style.width = (timeLeft / duration * 100) + '%';
        if (timerNum) timerNum.textContent = Math.ceil(timeLeft);
      }, step * 1000);
    }

    const hostCtrls = document.getElementById('host-scoreboard-controls');
    const backBtn = document.getElementById('scoreboard-back-to-lobby-btn');
    // Show for everyone as per user request
    if (hostCtrls) hostCtrls.classList.remove('hidden');
    if (backBtn) {
      backBtn.onclick = () => {
        socket.emit('back-to-lobby', { roomCode, playerId: myPlayerId });
      };
    }
  },

  ended(data) {
    stopTimer();
    const winner = data.players[0];
    if (winner) {
      const nameDisp = document.getElementById('winner-name-display');
      const ptsDisp = document.getElementById('winner-points-display');
      if (nameDisp) nameDisp.textContent = winner.username;
      if (ptsDisp) ptsDisp.textContent = `${winner.score.toLocaleString()} points`;
    }

    const hostCtrls = document.getElementById('host-ended-controls');
    const backBtn = document.getElementById('back-to-lobby-btn');
    // Show for everyone as per user request
    if (hostCtrls) hostCtrls.classList.remove('hidden');
    if (backBtn) {
      backBtn.onclick = () => {
        socket.emit('back-to-lobby', { roomCode, playerId: myPlayerId });
      };
    }
  },

  waiting() {
    stopTimer();
    document.getElementById('ink-bottle-hud').classList.add('hidden');
  }
};

// ── Drawing Engine ───────────────────────────────────────────────────────────
function setupCanvas(canvas, ctx, historyArr, toolbarId) {
  let drawing = false;
  let currentPath = [];
  let currentColor = '#1A1A1A';
  let currentSize = 10;

  const tb = document.getElementById(toolbarId);
  if (tb) {
    const colorBtns = tb.querySelectorAll('.color-btn, .tool-eraser');
    colorBtns.forEach(btn => {
      btn.onclick = () => {
        colorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = btn.dataset.color;
      };
    });
    const sizeBtns = tb.querySelectorAll('.tool-size');
    sizeBtns.forEach(btn => {
      btn.onclick = () => {
        sizeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSize = parseInt(btn.dataset.size, 10);
      };
    });
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
  }

  function doStroke(e) {
    if (!drawing || currentInk <= 0) return;
    const [nx, ny] = getPos(e);
    const prev = currentPath.points[currentPath.points.length - 1];
    if (prev) {
      const dx = nx - prev[0];
      const dy = ny - prev[1];
      const dist = Math.sqrt(dx*dx + dy*dy);
      currentInk -= dist * 0.04;
      if (currentInk < 0) currentInk = 0;
      updateInkBottle(currentInk);
    }
    ctx.lineTo(nx, ny);
    ctx.stroke();
    currentPath.points.push([nx, ny]);
  }

  function endStroke() {
    if (!drawing) return;
    drawing = false;
    ctx.closePath();
    if (currentPath && currentPath.points.length > 0) {
      historyArr.push(currentPath);
      currentPath = null;
    }
  }

  canvas.addEventListener('mousedown', startStroke);
  window.addEventListener('mousemove', doStroke);
  window.addEventListener('mouseup', endStroke);

  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); startStroke(e); }, { passive: false });
  window.addEventListener('touchmove', (e) => { if (drawing) e.preventDefault(); doStroke(e); }, { passive: false });
  window.addEventListener('touchend', endStroke);
}

function undoCanvas(canvas, ctx, historyArr) {
  historyArr.pop();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  historyArr.forEach(stroke => {
    if (stroke.type === 'clear') { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    stroke.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt[0], pt[1]) : ctx.lineTo(pt[0], pt[1]));
    ctx.stroke();
  });
}

// ── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', () => {
  if (roomCode && myPlayerId) socket.emit('rejoin', { roomCode, playerId: myPlayerId });
  else if (roomCode) socket.emit('join-room', { roomCode, username: myUsername });
});

socket.on('room-joined', ({ roomCode: rc, playerId, room }) => {
  roomCode = rc;
  myPlayerId = playerId;
  localStorage.setItem('pid', playerId);
  localStorage.setItem('username', myUsername);
  
  if (room.phase === 'lobby' || !room.phase) loadPhase('lobby');
  else loadPhase(room.phase, room.payload);

  if (room.players) renderPlayersPanel(room.players);
  checkHostControls(room.players);
});

socket.on('player-list', (players) => {
  renderPlayersPanel(players);
  checkHostControls(players);
});

socket.on('phase-change', async (data) => {
  const { phase, duration } = data;
  currentPhase = phase;
  
  if (phase !== 'results' && phase !== 'ended') {
    playerStatusMap = {};
    allPlayers.forEach(p => playerStatusMap[p.id] = (phase === 'drawing' || phase === 'copying' || phase === 'voting') ? 'Drawing...' : '');
    renderPlayersPanel(allPlayers);
  }

  stopTimer();

  if (phase === 'drawing') {
    await loadPhase('draw_transition', data);
    startTimer(5, 'game starts in...');
    setTimeout(async () => {
      await loadPhase('prompt_reveal', data);
      let count = 5; // Sync with 7.5 duration
      const intv = setInterval(async () => {
        count--;
        if (count > 0) {
          const cd = document.getElementById('reveal-cd-num');
          if (cd) cd.textContent = count;
        } else {
          clearInterval(intv);
          await loadPhase('drawing', data);
        }
      }, 1000);
    }, 5000);
  } else if (phase === 'observe') {
    await loadPhase('observe', data);
    setTimeout(async () => {
      await loadPhase('copy_transition', data);
      let count = 5; // Sync with 7.5
      const cdBig = document.getElementById('copy-countdown-big');
      if (cdBig) cdBig.textContent = count;
      const intv = setInterval(async () => {
        count--;
        if (count > 0) { if (cdBig) cdBig.textContent = count; }
        else {
          clearInterval(intv);
          await loadPhase('copying', data);
        }
      }, 1000);
    }, (duration || 10) * 1000);
  } else if (phase === 'vote_set') loadPhase('voting', data);
  else if (phase === 'reveal_set') loadPhase('reveal', data);
  else if (phase === 'results') {
    if (data.isFinal) loadPhase('scoreboard', data);
    else loadPhase('scores', data);
  }
  else if (phase === 'ended') loadPhase('ended', data);
  else if (phase === 'final-round') loadPhase('final_round', data);
});

socket.on('your-prompt', (data) => {
  document.body.dataset.pendingPrompt = data.prompt;
  const el = document.getElementById('drawing-prompt-text');
  if (el) el.textContent = data.prompt;
});

// ── Gallery & Scoreboards ────────────────────────────────────────────────────
function buildVotingUI(set, participants) {
  const container = document.getElementById('voting-cards');
  const noticeContainer = document.getElementById('voting-participation-notice-container');
  if (!container || !set) return;
  document.getElementById('voting-prompt-title').textContent = set.prompt;
  const isMySet = participants && participants.includes(myPlayerId);
  container.innerHTML = '';
  if (noticeContainer) noticeContainer.innerHTML = '';

  if (isMySet && noticeContainer) {
    const msg = document.createElement('div');
    msg.style.cssText = "display: inline-block; font-family: 'Gochi Hand', cursive; font-size: 1.2rem; background: rgba(0,0,0,0.05); padding: 10px 20px; border-radius: 8px; font-weight: 700; border: 1px dashed #000;";
    msg.textContent = "You participated in this set. You can see the drawings but cannot vote.";
    noticeContainer.appendChild(msg);
  }

  set.entries.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'vote-card' + (isMySet ? ' disabled-card' : '');
    card.innerHTML = `<img src="${entry.dataUrl || '/logo.png'}" class="vote-card-img" alt="Artwork"><div class="vote-card-label">${isMySet ? 'view only' : 'pick me!'}</div>`;
    if (!isMySet) {
      card.onclick = () => {
        container.querySelectorAll('.vote-selection-badge').forEach(b => b.remove());
        const b = document.createElement('div');
        b.className = 'vote-selection-badge';
        b.textContent = myUsername;
        card.appendChild(b);
        socket.emit('submit-vote', { roomCode, playerId: myPlayerId, choices: { [set.originalOwnerId]: entry.playerId } });
        toast("Vote submitted!");
      };
    }
    container.appendChild(card);
  });
}

function buildRevealUI(set, results) {
  const container = document.getElementById('reveal-cards');
  if (!container || !set) return;
  document.getElementById('reveal-prompt-title').textContent = set.prompt;
  
  const voterMap = {};
  results?.voterChoices?.forEach(vc => {
    if (!voterMap[vc.chosenPlayerId]) voterMap[vc.chosenPlayerId] = [];
    voterMap[vc.chosenPlayerId].push(vc.voterName);
  });

  set.entries.forEach(entry => {
    // CRITICAL: The server sends isOriginal flag. We strictly respect it.
    const isOrig = entry.isOriginal === true;
    const card = document.createElement('div');
    card.className = 'reveal-card polaroid' + (isOrig ? ' original-card' : '');
    card.innerHTML = `
      <div class="reveal-voter-row">${(voterMap[entry.playerId] || []).map(n => `<div class="reveal-voter-badge-box">${n}</div>`).join('')}</div>
      <div class="reveal-card-header">${isOrig ? 'ORIGINAL' : 'COPY'}</div>
      <img src="${entry.dataUrl || '/logo.png'}" class="reveal-card-img" alt="Artwork">
      <div class="reveal-stamp ${isOrig ? 'original' : 'copy'}">${isOrig ? 'Original' : 'Copy'}</div>
      <div class="reveal-card-footer">by ${entry.username || 'Artist'}</div>
    `;
    container.appendChild(card);
  });
}

function buildScoresUI(players, isFinal) {
  const list = document.getElementById('scores-list');
  if (!list) return;
  const oldPlayers = [...allPlayers].sort((a,b) => (b.score || 0) - (a.score || 0));
  list.innerHTML = '';
  list.style.position = 'relative';
  list.style.height = (players.length * 45) + 'px';

  const rows = new Map();
  players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'score-row' + (p.id === myPlayerId ? ' me-row' : '');
    row.style.cssText = `position:absolute; width:100%; transition:all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1); top:${(oldPlayers.findIndex(op => op.id === p.id) === -1 ? i : oldPlayers.findIndex(op => op.id === p.id)) * 45}px;`;
    row.innerHTML = `<div class="score-row-bullet"><span>•</span><span>${p.username}</span></div><div class="score-val">${allPlayers.find(op => op.id === p.id)?.score || 0}</div>`;
    list.appendChild(row);
    rows.set(p.id, row);
  });

  setTimeout(() => {
    const sorted = [...players].sort((a,b) => (b.score || 0) - (a.score || 0));
    sorted.forEach((p, rank) => {
      const row = rows.get(p.id);
      if (row) {
        row.style.top = (rank * 45) + 'px';
        const valEl = row.querySelector('.score-val');
        const oldScore = allPlayers.find(op => op.id === p.id)?.score || 0;
        if (p.score > oldScore) animateValue(valEl, oldScore, p.score, 1500);
        else valEl.textContent = p.score;
      }
    });
    allPlayers = players;
  }, 500);
}

function buildFinalScoresUI(players) {
  const list = document.getElementById('final-scores-list');
  if (list) {
    list.innerHTML = players.map(p => {
      const isHost = p.isHost || p.is_host;
      return `<div class="score-row ${p.id === myPlayerId ? 'me-row' : ''}">
        <div class="score-row-bullet">
          <span>${isHost ? '👑' : '•'}</span>
          <span>${p.username}</span>
        </div>
        <div>${p.score}</div>
      </div>`;
    }).join('');
  }
}

// ── UI Components ────────────────────────────────────────────────────────────
function renderPlayersPanel(players) {
  const sidebar = document.getElementById('players-panel-list');
  if (sidebar) {
    sidebar.innerHTML = players.map(p => `
      <div class="panel-player-name ${p.id === myPlayerId ? 'me' : ''}">
        <span>${(p.isHost || p.is_host) ? '👑' : ''} ${p.username}</span>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="panel-score-val" data-pid="${p.id}" style="font-size:0.9rem; color:#ffd700; font-weight:900;">${p.score || 0}</span>
          <span class="panel-status ${playerStatusMap[p.id]?.toLowerCase() === 'done' ? 'done' : ''}">${playerStatusMap[p.id] || ''}</span>
        </div>
      </div>
    `).join('');
    players.forEach(p => {
      const old = allPlayers.find(op => op.id === p.id);
      if (old && p.score > old.score) animateValue(sidebar.querySelector(`.panel-score-val[data-pid="${p.id}"]`), old.score, p.score, 1000);
    });
  }

  const lobbyList = document.getElementById('lobby-players-list');
  if (lobbyList) {
    lobbyList.innerHTML = '';
    players.forEach((p, i) => {
      const b = document.createElement('div');
      b.className = 'lobby-player-bubble' + (p.id === myPlayerId ? ' me-bubble' : '');
      b.innerHTML = `${(p.isHost || p.is_host) ? '👑 ' : ''}${p.username}${p.id === myPlayerId ? ' (you)' : ''}`;
      b.style.transform = `rotate(${(i % 2 === 0 ? 1 : -1) * (Math.random() * 5)}deg)`;
      lobbyList.appendChild(b);
    });
  }
  allPlayers = players;
}

function checkHostControls(players) {
  const me = players.find(p => p.id === myPlayerId);
  const isHost = me && (me.isHost || me.is_host);
  const hostCtrls = document.getElementById('host-controls');
  if (hostCtrls) {
    if (isHost) hostCtrls.classList.remove('hidden');
    else hostCtrls.classList.add('hidden');
  }
  
  const startBtn = document.getElementById('start-btn');
  if (startBtn && isHost) {
    const minPlayers = 2;
    const allReady = players.every(p => p.isReady || p.is_ready);
    if (players.length >= minPlayers && allReady) {
      startBtn.disabled = false;
      startBtn.classList.add('btn-pulse');
      startBtn.title = "Start Game";
    } else {
      startBtn.disabled = true;
      startBtn.classList.remove('btn-pulse');
      if (players.length < minPlayers) startBtn.title = `Need ${minPlayers} players to start (Current: ${players.length})`;
      else startBtn.title = "Waiting for all players to be ready";
    }
  }

  const readyBtn = document.getElementById('ready-btn');
  if (readyBtn) {
    if (isHost) {
      readyBtn.textContent = 'HOST';
      readyBtn.disabled = true;
    } else {
      readyBtn.textContent = 'READY UP';
      readyBtn.disabled = false;
    }
  }
}

// ── Volume Control ─────────────────────────────────────────
function initVolumeControl() {
  const slider = document.getElementById('volume-slider');
  const bgMusic = document.getElementById('bg-music');
  if (slider && bgMusic) {
    slider.oninput = (e) => {
      bgMusic.volume = e.target.value / 100;
    };
    // Default 50%
    bgMusic.volume = 0.5;
    slider.value = 50;
  }
}

// ── Hud Initialization ─────────────────────────────────────
const playersPanel = document.getElementById('players-panel');
const playersToggle = document.getElementById('players-panel-toggle');
if (playersToggle && playersPanel) {
  playersToggle.onclick = () => {
    playersPanel.classList.toggle('minimized');
    playersToggle.textContent = playersPanel.classList.contains('minimized') ? '➕' : '➖';
  };
}
