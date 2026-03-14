require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─── Supabase Setup ──────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('🔗 Supabase connected');
} else {
  console.warn('⚠️ SUPABASE_URL/KEY missing. Running in in-memory MOCK mode.');
}

// ─── Global Error Handling ──────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('🔥 CRITICAL: Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Dynamic Routing ─────────────────────────────────────────────────────────
// Serve room.html for any /room/:code path
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// ─── In-Memory Fallback (Mock) ────────────────────────────────────────────────
const mockRooms = {}; // roomCode → Room
const gameTimers = {};
const DEFAULT_MUSIC = [
  { name: "Crystal Dream", url: "/assets/sounds/AXIS1249_01_Crystal Dream_Full.mp3" },
  { name: "Purely Pizzicato", url: "/assets/sounds/AXIS1232_06_Purely Pizzicato_Full.mp3" },
  { name: "Tinsel Time", url: "/assets/sounds/AXIS1196_08_Tinsel Time_Full.mp3" }
];

function clearRoomTimers(roomCode) {
  if (gameTimers[roomCode]) {
    gameTimers[roomCode].forEach(t => clearTimeout(t));
    delete gameTimers[roomCode];
  }
}

// ─── Data & Prompts ──────────────────────────────────────────────────────────
const PROMPTS = [
  "Pikachu in a courtroom", "SpongeBob doing taxes", "Mickey Mouse as a villain",
  "Darth Vader eating cereal", "Shrek at the Oscars", "Sonic the Hedgehog sleeping",
  "Batman buying groceries", "Elsa riding a skateboard", "Gollum at the gym",
  "Dora the Explorer as a CEO", "Iron Man doing yoga", "Thanos at a birthday party",
  "Mario working at McDonald's", "The Hulk knitting", "Winnie the Pooh in space",
  "Gandalf at Starbucks", "Yoda playing tennis", "Minions at the museum",
  "Captain America doing laundry", "Simba at a job interview", "Dumbledore at the DMV",
  "Elmo at a heavy metal concert", "Buzz Lightyear at the dentist", "Goku paying bills",
  "Naruto taking an exam", "Tom and Jerry at a library", "Panda from Kung Fu Panda cooking",
  "The Joker at a comedy club", "Moana in Antarctica", "Wall-E in a mansion",
  "Stitch at a wedding", "Deadpool teaching kindergarten", "Thor doing laundry",
  "Optimus Prime at a traffic light", "Scooby Doo solving a math problem"
];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function randomColor() {
  const colors = ['#7c3aed','#06b6d4','#f59e0b','#10b981','#ef4444','#ec4899','#3b82f6','#84cc16'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Helper Functions ────────────────────────────────────────────────────────
async function getRoomData(roomCode) {
  if (supabase) {
    const { data, error } = await supabase.from('rooms').select('*').eq('code', roomCode).single();
    if (error) return null;
    return data;
  }
  return mockRooms[roomCode] || null;
}

async function getPlayersInRoom(roomCode) {
  if (supabase) {
    const { data, error } = await supabase.from('players').select('*').eq('room_code', roomCode);
    if (error) return [];
    return data;
  }
  return mockRooms[roomCode] ? mockRooms[roomCode].players : [];
}

async function getActivePlayersInRoom(roomCode) {
  const players = await getPlayersInRoom(roomCode);
  const connectedSockets = Array.from(io.sockets.adapter.rooms.get(roomCode) || []);
  // If we are in MOCK mode, we can trust the current connection list.
  // In Supabase mode, we might need a more complex 'heartbeat' or just use the current socket room members.
  return players.filter(p => connectedSockets.includes(p.socket_id));
}

function getPublicRoom(room, players) {
  return {
    code: room.code || room.roomCode,
    phase: room.phase,
    round: room.round,
    totalRounds: room.total_rounds || room.totalRounds,
    players: players.map(p => ({
      id: p.id, username: p.username, color: p.color,
      isHost: p.is_host || p.isHost, isReady: p.is_ready || p.isReady, score: p.score,
    })),
    chatMessages: (room.chatMessages || []).slice(-50),
    currentMusic: room.currentMusic || DEFAULT_MUSIC[0],
    musicPlaying: room.musicPlaying ?? true,
  };
}

// ─── Game Flow ────────────────────────────────────────────────────────────────

async function startDrawingPhase(roomCode) {
  clearRoomTimers(roomCode);
  const players = await getPlayersInRoom(roomCode);
  const room = await getRoomData(roomCode);
  const round = (room.round || 0) + 1;
  const totalRounds = room.total_rounds || 3;
  const isFinalRound = round === totalRounds;
  const pointsBase = isFinalRound ? 200 : 100; // double in final round
  
  const phaseData = {
    phase: 'drawing',
    drawings: {},
    copies: {},
    votes: {},
    prompts: {},
    pointsBase
  };

  const usedPrompts = new Set();
  players.forEach(p => {
    let prompt;
    do { prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)]; }
    while (usedPrompts.has(prompt) && usedPrompts.size < PROMPTS.length);
    usedPrompts.add(prompt);
    phaseData.prompts[p.id] = prompt;
  });

  if (supabase) {
    await supabase.from('rooms').update({ phase: 'drawing', round, payload: phaseData }).eq('code', roomCode);
  } else {
    mockRooms[roomCode].phase = 'drawing';
    mockRooms[roomCode].round = round;
    mockRooms[roomCode].payload = phaseData;
  }

  io.to(roomCode).emit('phase-change', { phase: 'drawing', duration: 90, round, totalRounds, pointsBase });
  players.forEach(p => {
    io.to(p.socket_id).emit('your-prompt', { prompt: phaseData.prompts[p.id] });
  });

  const t = setTimeout(() => startObservePhase(roomCode), 90 * 1000);
  gameTimers[roomCode] = [t];
}

async function startObservePhase(roomCode) {
  clearRoomTimers(roomCode);
  const room = await getRoomData(roomCode);
  const players = await getPlayersInRoom(roomCode);
  const payload = room.payload || {};

  // Assign copy targets
  const playerIds = shuffle(players.map(p => p.id));
  payload.copyAssignments = {};
  playerIds.forEach((id, idx) => {
    payload.copyAssignments[id] = playerIds[(idx + 1) % playerIds.length];
  });

  if (supabase) {
    await supabase.from('rooms').update({ phase: 'observe', payload }).eq('code', roomCode);
  } else {
    mockRooms[roomCode].phase = 'observe';
    mockRooms[roomCode].payload = payload;
  }

  // Send each player the drawing they need to observe (their copy target's drawing)
  const round = room.round || 1;
  players.forEach(p => {
    const targetId = payload.copyAssignments[p.id];
    const targetDrawing = payload.drawings[targetId];
    io.to(p.socket_id).emit('phase-change', {
      phase: 'observe',
      duration: 10,
      dataUrl: targetDrawing ? targetDrawing.dataUrl : null,
      round
    });
  });

  const t = setTimeout(() => startCopyPhase(roomCode), 10 * 1000);
  gameTimers[roomCode] = [t];
}

async function startCopyPhase(roomCode) {
  clearRoomTimers(roomCode);
  const room = await getRoomData(roomCode);
  const round = room.round || 1;

  if (supabase) {
    await supabase.from('rooms').update({ phase: 'copying' }).eq('code', roomCode);
  } else {
    mockRooms[roomCode].phase = 'copying';
  }

  // Copy phase: blank canvas — players draw from memory
  io.to(roomCode).emit('phase-change', { 
    phase: 'copying', 
    duration: 90,
    round
  });

  const t = setTimeout(() => startVotingPhase(roomCode), 90 * 1000);
  gameTimers[roomCode] = [t];
}

async function startVotingPhase(roomCode) {
  clearRoomTimers(roomCode);
  const room = await getRoomData(roomCode);
  const players = await getPlayersInRoom(roomCode);
  const payload = room.payload || {};
  const round = room.round || 1;

  const gallery = players.map(originalOwner => {
    const copies = players
      .filter(p => payload.copies[p.id] && payload.copies[p.id].originalOwnerId === originalOwner.id)
      .map(p => ({
        playerId: p.id,
        username: p.username,
        dataUrl: payload.copies[p.id].dataUrl
      }));
    const originalOwnerPlayer = players.find(p => p.id === originalOwner.id);
    return {
      originalOwnerId: originalOwner.id,
      originalOwnerName: originalOwnerPlayer ? originalOwnerPlayer.username : '?',
      prompt: payload.prompts[originalOwner.id],
      entries: shuffle([
        { 
          playerId: originalOwner.id, 
          username: originalOwner.username,
          dataUrl: payload.drawings[originalOwner.id]?.dataUrl, 
          isOriginal: true 
        },
        ...copies.map(c => ({ 
          playerId: c.playerId, 
          username: c.username,
          dataUrl: c.dataUrl, 
          isOriginal: false 
        }))
      ]),
    };
  });

  payload.gallery = gallery;
  if (supabase) {
    await supabase.from('rooms').update({ phase: 'voting', payload }).eq('code', roomCode);
  } else {
    mockRooms[roomCode].phase = 'voting';
    mockRooms[roomCode].payload = payload;
  }

  io.to(roomCode).emit('phase-change', { phase: 'voting', duration: 30, gallery, round });

  const t = setTimeout(() => finaliseVotesAndResults(roomCode), 30 * 1000);
  gameTimers[roomCode] = [t];
}

async function finaliseVotesAndResults(roomCode) {
  clearRoomTimers(roomCode);
  const room = await getRoomData(roomCode);
  const players = await getPlayersInRoom(roomCode);
  const payload = room.payload || {};
  const round = room.round || 1;
  const totalRounds = room.total_rounds || 3;
  // Points: 100 for picking original, 100 for original owner per picker, 50 for copy per picker
  // In final round, server already set pointsBase=200, so use that
  const pts = payload.pointsBase || 100;
  const copyPts = Math.floor(pts / 2); // 50 normally, 100 in final round

  const scoreDeltas = {};
  players.forEach(p => scoreDeltas[p.id] = 0);

  const voteResults = {};
  players.forEach(orig => {
     voteResults[orig.id] = { 
       originalOwnerId: orig.id, 
       prompt: payload.prompts[orig.id], 
       voterChoices: [] 
     };
  });

  Object.entries(payload.votes || {}).forEach(([voterId, choices]) => {
     Object.entries(choices).forEach(([originalOwnerId, chosenPlayerId]) => {
        if (voterId === originalOwnerId) return;
        if (!voteResults[originalOwnerId]) return;
        
        const voter = players.find(p => p.id === voterId);
        voteResults[originalOwnerId].voterChoices.push({ 
           voterId, 
           chosenPlayerId, 
           voterName: voter ? voter.username : 'Unknown'
        });

        if (chosenPlayerId === originalOwnerId) {
           // Correct — voter and original owner both get pts
           scoreDeltas[voterId] = (scoreDeltas[voterId] || 0) + pts;
           scoreDeltas[originalOwnerId] = (scoreDeltas[originalOwnerId] || 0) + pts;
        } else {
           // Wrong — copy owner gets half points
           scoreDeltas[chosenPlayerId] = (scoreDeltas[chosenPlayerId] || 0) + copyPts;
        }
     });
  });

  // Update scores in mock/db
  for (const p of players) {
     const newScore = (p.score || 0) + (scoreDeltas[p.id] || 0);
     if (supabase) {
        await supabase.from('players').update({ score: newScore }).eq('id', p.id);
     } else {
        p.score = newScore;
     }
  }

  const isFinal = round >= totalRounds;

  if (supabase) {
     await supabase.from('rooms').update({ phase: 'results' }).eq('code', roomCode);
  } else {
     mockRooms[roomCode].phase = 'results';
  }

  const updatedPlayers2 = await getPlayersInRoom(roomCode);
  const sortedUpdatedPlayers = updatedPlayers2
    .map(p => ({ id: p.id, username: p.username, score: p.score || 0 }))
    .sort((a,b) => b.score - a.score);

  io.to(roomCode).emit('phase-change', {
     phase: 'results',
     duration: 15,
     scoreDeltas,
     voteResults,
     players: sortedUpdatedPlayers,
     gallery: payload.gallery,
     isFinal,
     round
  });

  const t = setTimeout(() => advanceRound(roomCode), 15 * 1000);
  gameTimers[roomCode] = [t];
}

async function advanceRound(roomCode) {
   const room = await getRoomData(roomCode);
   const totalRounds = room.total_rounds || 3;
   const currentRound = room.round || 0;

   if (currentRound >= totalRounds) {
      // Game over
      const players = await getPlayersInRoom(roomCode);
      const sortedPlayers = players
        .map(p => ({ id: p.id, username: p.username, color: p.color, score: p.score || 0 }))
        .sort((a,b) => b.score - a.score);

      if (supabase) {
         await supabase.from('rooms').update({ phase: 'ended' }).eq('code', roomCode);
      } else {
         mockRooms[roomCode].phase = 'ended';
      }

      io.to(roomCode).emit('phase-change', { phase: 'ended', players: sortedPlayers });
   } else if (currentRound + 1 === totalRounds) {
      // About to start final round — show yellow splash
      if (supabase) {
         await supabase.from('rooms').update({ phase: 'final-round' }).eq('code', roomCode);
      } else {
         mockRooms[roomCode].phase = 'final-round';
      }
      io.to(roomCode).emit('phase-change', { phase: 'final-round', duration: 4 });
      const t = setTimeout(() => startDrawingPhase(roomCode), 4 * 1000);
      gameTimers[roomCode] = [t];
   } else {
      startDrawingPhase(roomCode);
   }
}

// ─── Socket Events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);

  socket.on('start-game', async ({ roomCode, playerId }) => {
     const code = roomCode.toUpperCase();
     const room = await getRoomData(code);
     if (!room) return;
     
     // Check if host
     const players = await getPlayersInRoom(code);
     const player = players.find(p => p.id === playerId);
     if (!player || !(player.is_host || player.isHost)) return;

     console.log(`🚀 Host ${player.username} started the game in ${code}`);
     startDrawingPhase(code);
  });

  socket.on('submit-drawing', async ({ roomCode, playerId, dataUrl }) => {
     const room = await getRoomData(roomCode);
     if (!room || room.phase !== 'drawing') return;
     const payload = room.payload || {};
     payload.drawings[playerId] = { dataUrl };
     io.to(roomCode).emit('player-status', { playerId, status: 'done' });
     
     if (supabase) {
        await supabase.from('rooms').update({ payload }).eq('code', roomCode);
     }
     
     // Check if all submitted
     const activePlayers = await getActivePlayersInRoom(roomCode);
     console.log(`📝 Submission from ${playerId}. Active: ${activePlayers.length}, Submitted: ${Object.keys(payload.drawings).length}`);
     
     if (activePlayers.every(p => payload.drawings[p.id])) {
        console.log(`🚀 All drawings submitted in ${roomCode}. Starting transitions.`);
         startObservePhase(roomCode);
     }
  });

  socket.on('submit-copy', async ({ roomCode, playerId, dataUrl }) => {
     const room = await getRoomData(roomCode);
     if (!room || room.phase !== 'copying') return;
     const payload = room.payload || {};
     payload.copies[playerId] = { dataUrl, originalOwnerId: payload.copyAssignments ? payload.copyAssignments[playerId] : null };
     io.to(roomCode).emit('player-status', { playerId, status: 'done' });

     if (supabase) {
        await supabase.from('rooms').update({ payload }).eq('code', roomCode);
     }

     const activePlayers = await getActivePlayersInRoom(roomCode);
     if (activePlayers.every(p => payload.copies[p.id])) {
        startVotingPhase(roomCode);
     }
  });

  socket.on('submit-vote', async ({ roomCode, playerId, choices }) => {
     const room = await getRoomData(roomCode);
     if (!room || room.phase !== 'voting') return;
     const payload = room.payload || {};
     payload.votes[playerId] = choices;
     io.to(roomCode).emit('player-status', { playerId, status: 'done' });

     if (supabase) {
        await supabase.from('rooms').update({ payload }).eq('code', roomCode);
     }

     const activePlayers = await getActivePlayersInRoom(roomCode);
     if (activePlayers.every(p => payload.votes[p.id])) {
        finaliseVotesAndResults(roomCode);
     }
  });

  socket.on('create-room', async ({ username }) => {
    console.log(`🏠 Room create request: ${username} (Socket: ${socket.id})`);
    const code = generateRoomCode();
    const playerId = uuidv4();
    const color = randomColor();

    const roomObj = {
      code: code,
      phase: 'lobby',
      round: 0,
      total_rounds: 3,
      host_id: playerId,
      drawings: {},
      copies: {},
      votes: {},
      prompts: {},
      chatMessages: [],
      currentMusic: DEFAULT_MUSIC[0],
      musicPlaying: true
    };

    const playerObj = {
      id: playerId,
      room_code: code,
      username: username,
      color: color,
      score: 0,
      is_host: true,
      is_ready: true,
      socket_id: socket.id
    };

    if (supabase) {
      await supabase.from('rooms').insert([roomObj]);
      await supabase.from('players').insert([playerObj]);
    } else {
      mockRooms[code] = { ...roomObj, players: [playerObj] };
    }

    socket.join(code);
    socket.emit('room-joined', { roomCode: code, playerId, room: getPublicRoom(roomObj, [playerObj]) });
  });

  socket.on('join-room', async ({ roomCode, username }) => {
    const code = roomCode.toUpperCase();
    console.log(`👤 Join request: ${username} to ${code}`);
    const room = await getRoomData(code);
    if (!room) { 
      console.log(`❌ Join failed: Room ${code} not found`);
      socket.emit('error', { message: 'Room not found.' }); 
      return; 
    }
    if (room.phase !== 'lobby') { socket.emit('error', { message: 'Game already in progress.' }); return; }

    const players = await getPlayersInRoom(code);
    if (players.length >= 10) { socket.emit('error', { message: 'Room is full.' }); return; }

    const playerId = uuidv4();
    const isFirst = players.length === 0;
    const playerObj = {
      id: playerId,
      room_code: code,
      username: username,
      color: randomColor(),
      score: 0,
      is_host: isFirst,
      is_ready: isFirst,
      socket_id: socket.id
    };

    if (supabase) {
      await supabase.from('players').insert([playerObj]);
    } else {
      mockRooms[code].players.push(playerObj);
    }

    socket.join(code);
    socket.emit('room-joined', { roomCode: code, playerId, room: getPublicRoom(room, [...players, playerObj]) });
    
    // Notify others
    const updatedPlayers = await getPlayersInRoom(code);
    console.log(`✅ ${username} joined ${code}. Total: ${updatedPlayers.length}`);
    io.to(code).emit('player-list', updatedPlayers.map(p => ({
      id: p.id, username: p.username, color: p.color, 
      isHost: p.is_host || p.isHost, isReady: p.is_ready || p.isReady, score: p.score
    })));
  });

  socket.on('draw-stroke', ({ roomCode, stroke }) => {
    socket.to(roomCode.toUpperCase()).emit('draw-stroke', stroke);
  });

  socket.on('rejoin', async ({ roomCode, playerId }) => {
    if (!roomCode || !playerId) return;
    const code = roomCode.toUpperCase();
    console.log(`🔄 Rejoin request: Player ${playerId} in ${code}`);
    const room = await getRoomData(code);
    const players = await getPlayersInRoom(code);
    const player = players.find(p => p.id === playerId);

    if (room && player) {
      player.socket_id = socket.id;
      if (supabase) {
        await supabase.from('players').update({ socket_id: socket.id }).eq('id', playerId);
      }
      socket.join(code);
      console.log(`✅ Rejoin success: ${player.username} in ${code} (Socket: ${socket.id})`);
      
      const list = players.map(p => ({
        id: p.id, username: p.username, color: p.color, 
        isHost: p.is_host || p.isHost, isReady: p.is_ready || p.isReady, score: p.score
      }));
      
      // Specifically tell them they joined as host if they are
      socket.emit('room-joined', { roomCode: code, playerId, room: getPublicRoom(room, players) });
      socket.emit('player-list', list);
      
      const payload = room.payload || {};
      socket.emit('sync-state', { 
         phase: room.phase, 
         round: room.round,
         prompt: payload.prompts ? payload.prompts[playerId] : null,
         dataUrl: (room.phase === 'copying' && payload.copyAssignments) ? (payload.drawings[payload.copyAssignments[playerId]]?.dataUrl) : null,
         gallery: payload.gallery
      });
    } else {
      console.log(`❌ Rejoin failed: Player ${playerId} not in ${code}`);
      socket.emit('rejoin-failed', { roomCode: code });
    }
  });

  socket.on('ready-up', async ({ roomCode, playerId }) => {
    const code = roomCode.toUpperCase();
    const players = await getPlayersInRoom(code);
    const player = players.find(p => p.id === playerId);
    if (!player || player.is_host || player.isHost) return;

    const newReady = !(player.is_ready || player.isReady);
    if (supabase) {
      await supabase.from('players').update({ is_ready: newReady }).eq('id', playerId);
    } else {
      player.isReady = newReady;
    }

    const updatedPlayers = await getPlayersInRoom(code);
    io.to(code).emit('player-list', updatedPlayers.map(p => ({
      id: p.id, username: p.username, color: p.color, 
      isHost: p.is_host || p.isHost, isReady: p.is_ready || p.isReady, score: p.score
    })));
  });

  socket.on('chat-message', async ({ roomCode, playerId, text }) => {
    const code = roomCode.toUpperCase();
    const players = await getPlayersInRoom(code);
    const player = players.find(p => p.id === playerId);
    if (!player || !text.trim()) return;

    const msg = { 
        playerId, 
        username: player.username, 
        color: player.color, 
        text: text.slice(0, 200), 
        timestamp: Date.now() 
    };
    
    io.to(code).emit('chat-message', msg);
  });

  socket.on('change-music', async ({ roomCode, playerId, musicIndex }) => {
    const code = roomCode.toUpperCase();
    const room = await getRoomData(code);
    const players = await getPlayersInRoom(code);
    const player = players.find(p => p.id === playerId);
    if (!player || !(player.is_host || player.isHost)) return;
    
    const music = DEFAULT_MUSIC[musicIndex % DEFAULT_MUSIC.length];
    if (supabase) {
      await supabase.from('rooms').update({ payload: { ...room.payload, currentMusic: music } }).eq('code', code);
    } else {
      mockRooms[code].currentMusic = music;
    }
    io.to(code).emit('music-update', { currentMusic: music, musicPlaying: room.musicPlaying ?? true });
  });

  socket.on('toggle-music', async ({ roomCode, playerId, playing }) => {
    const code = roomCode.toUpperCase();
    const room = await getRoomData(code);
    const players = await getPlayersInRoom(code);
    const player = players.find(p => p.id === playerId);
    if (!player || !(player.is_host || player.isHost)) return;
    
    if (supabase) {
      // update logic
    } else {
      mockRooms[code].musicPlaying = playing;
    }
    io.to(code).emit('music-update', { currentMusic: room.currentMusic || DEFAULT_MUSIC[0], musicPlaying: playing });
  });

  socket.on('disconnect', async () => {
    // Basic cleanup: in a production app with Supabase, you might keep them in the DB
    // but mark them as offline. For now, we'll just handle the event.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Copyright Artist refactored on port ${PORT}`));
