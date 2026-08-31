const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');
const battlePool = require('./battle_pool.json');

const app = express();

// Health check (used by hosts like Render to know the service is alive).
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// List the background-music tracks so the client auto-discovers them.
// Drop any .mp3/.ogg/.m4a/.wav/.aac into public/music/ and it's picked up automatically.
app.get('/music', (req, res) => {
  try {
    const dir = path.join(__dirname, 'public', 'music');
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(mp3|ogg|m4a|wav|aac)$/i.test(f))
      .sort();
    res.json(files.map((f) => '/music/' + encodeURIComponent(f)));
  } catch (e) {
    res.json([]);
  }
});

// Expose the curated pool so players can browse all available Pokémon.
app.get('/pool', (req, res) => {
  res.json(battlePool.map((p) => ({ id: p.id, name: p.name, types: p.types, base: p.base })));
});

// Static files (mounted after the API routes above so /music isn't shadowed).
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ---------- Game constants ----------
const BUDGET = 30;
const TEAM_SIZE = 6;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const TURN_SECONDS = parseInt(process.env.TURN_SECONDS || '30', 10);
const REVEAL_SECONDS = parseFloat(process.env.REVEAL_SECONDS || '4');
const COUNTDOWN_MS = 3000; // pre-draft countdown before the first auction
const INTRO_MS = Math.round(parseFloat(process.env.INTRO_SECONDS || '4') * 1000); // pre-bid intro buffer

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

const rooms = new Map();

function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function newCode() { let c; do { c = randCode(); } while (rooms.has(c)); return c; }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rotateLeft(arr) {
  if (arr.length <= 1) return arr.slice();
  return arr.slice(1).concat(arr[0]);
}

function pickRevealed() {
  return shuffle(STAT_KEYS).slice(0, 2);
}

function buildRoster(numPlayers) {
  const pool = [...battlePool];
  const total = TEAM_SIZE * numPlayers;
  const roster = [];
  for (let i = 0; i < total; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const p = pool.splice(idx, 1)[0];
    roster.push({ id: p.id, name: p.name, types: p.types, base: p.base, revealedStats: pickRevealed(), won: null });
  }
  return roster;
}

function maxBidFor(room, i) {
  const owned = room.teams[i].length;
  if (owned >= TEAM_SIZE) return 0;
  return Math.max(0, room.budgets[i] - (TEAM_SIZE - owned - 1)); // keep $1 per remaining slot
}

function inAuction(room, i) { return !room.folded[i] && room.teams[i].length < TEAM_SIZE; }

function createRoom(playerId, name) {
  const code = newCode();
  const room = {
    code,
    maxPlayers: MAX_PLAYERS,
    players: [], // grows as people join (up to MAX_PLAYERS)
    state: 'waiting', // waiting | lobby | countdown | intro | auction | reveal | done | ended
    turnOrder: [],
    nextPos: 0,
    roster: [],
    currentIndex: 0,
    currentBid: 0,
    currentBidder: null,
    toAct: null,
    folded: [],
    deadline: null,
    lastWinner: null,
    lastAward: null,
    budgets: [],
    teams: [],
    turnTimer: null,
    revealTimer: null,
    countdownTimer: null,
    countdownEnd: null,
    introTimer: null,
    introEnd: null,
    introBidder: null,
    endedBy: null,
    lastActivity: Date.now(),
  };
  room.players.push({ id: playerId, name: name || 'Player 1', connected: true, socketId: null });
  rooms.set(code, room);
  return room;
}

function touch(room) { room.lastActivity = Date.now(); }

function clearTurnTimer(room) { if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; } }
function clearRevealTimer(room) { if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; } }
function clearCountdownTimer(room) { if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; } }
function clearIntroTimer(room) { if (room.introTimer) { clearTimeout(room.introTimer); room.introTimer = null; } }

function buildView(room, playerIndex) {
  const pokemon = room.roster.map((p, i) => {
    if (p.won) return { id: p.id, name: p.name, types: p.types, base: p.base, won: p.won };
    // Only the Pokémon currently on the block reveals its two stats (during
    // the pre-bid intro and the auction itself). Everything else stays hidden.
    if (i === room.currentIndex && (room.state === 'auction' || room.state === 'intro')) {
      return {
        revealed: p.revealedStats.map((k) => ({ key: k, label: STAT_LABELS[k], value: p.base[k] })),
        won: null,
      };
    }
    return { won: null, hidden: true };
  });
  return {
    state: room.state,
    code: room.code,
    numPlayers: room.players.length,
    playerIndex,
    players: room.players.map((pl) => (pl ? { name: pl.name, connected: pl.connected } : null)),
    turnOrder: room.turnOrder,
    budgets: room.budgets,
    teamSizes: room.teams.map((t) => t.length),
    maxBids: room.teams.map((_, i) => maxBidFor(room, i)),
    teams: room.teams.map((t) => t.map((p) => ({ id: p.id, name: p.name, types: p.types, base: p.base, price: p.won.price }))),
    pokemon,
    currentIndex: room.currentIndex,
    currentBid: room.currentBid,
    currentBidder: room.currentBidder,
    toAct: room.toAct,
    folded: room.folded,
    lastWinner: room.lastWinner,
    lastAward: room.lastAward,
    deadline: room.deadline,
    serverNow: Date.now(),
    turnSeconds: TURN_SECONDS,
    countdownEnd: room.countdownEnd,
    introEnd: room.introEnd,
    introBidder: room.introBidder,
    endedBy: room.endedBy,
  };
}

function broadcast(room) {
  // The view is identical for every player except `playerIndex`, so build it
  // once and reuse a shallow copy for each socket.
  const base = buildView(room, 0);
  room.players.forEach((p, i) => {
    if (p && p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('state', { ...base, playerIndex: i });
    }
  });
}

// Emit a lightweight "this player acted" event so everyone can show a popup.
function emitAction(room, action) {
  io.to(room.code).emit('action', action);
}

// ---------- Auction flow ----------
function award(room, winner, price) {
  const p = room.roster[room.currentIndex];
  p.won = { winner, price };
  room.budgets[winner] -= price;
  room.teams[winner].push(p);
  room.currentIndex += 1;
  room.lastWinner = winner;
  room.lastAward = { winner, price, pokemon: { id: p.id, name: p.name, types: p.types, base: p.base } };

  clearTurnTimer(room);
  clearRevealTimer(room);
  room.state = 'reveal';
  room.revealTimer = setTimeout(() => {
    if (room.state !== 'reveal') return;
    nextAuction(room);
    broadcast(room);
  }, REVEAL_SECONDS * 1000);
}

function resolveAuction(room) {
  const ins = [];
  for (let i = 0; i < room.players.length; i++) if (inAuction(room, i)) ins.push(i);
  if (ins.length !== 1) return false;
  const winner = ins[0];
  const price = (room.currentBidder === winner) ? Math.max(1, room.currentBid) : 1;
  award(room, winner, price);
  return true;
}

function nextInAuction(room) {
  const n = room.players.length;
  for (let s = 0; s < n; s++) {
    const pos = (room.nextPos + s) % n;
    const idx = room.turnOrder[pos];
    if (inAuction(room, idx)) {
      room.nextPos = (pos + 1) % n;
      return idx;
    }
  }
  return -1;
}

function setTurnTimer(room) {
  clearTurnTimer(room);
  const actor = room.toAct;
  room.deadline = Date.now() + TURN_SECONDS * 1000;
  room.turnTimer = setTimeout(() => {
    if (room.state !== 'auction' || room.toAct !== actor) return;
    const name = room.players[actor] ? room.players[actor].name : '?';
    if (room.currentBidder === null && room.currentBid === 0) {
      // Opening bidder must bid — auto-bid the $1 minimum on timeout.
      room.currentBid = 1;
      room.currentBidder = actor;
      touch(room);
      emitAction(room, { type: 'bid', player: actor, name, amount: 1, auto: true });
      advanceTurn(room);
    } else {
      room.folded[actor] = true; // timeout = fold
      touch(room);
      emitAction(room, { type: 'fold', player: actor, name, auto: true });
      if (!resolveAuction(room)) advanceTurn(room);
    }
    broadcast(room);
  }, TURN_SECONDS * 1000);
}

function advanceTurn(room) {
  clearTurnTimer(room);
  room.toAct = null;
  const n = room.players.length;
  for (let s = 0; s < n + 1; s++) {
    const idx = nextInAuction(room);
    if (idx === -1) {
      if (!resolveAuction(room)) room.state = 'done';
      return;
    }
    if (maxBidFor(room, idx) > room.currentBid) {
      room.toAct = idx;
      setTurnTimer(room);
      return;
    } else {
      // can't afford to raise → auto-fold (skip turn)
      room.folded[idx] = true;
      const name = room.players[idx] ? room.players[idx].name : '?';
      emitAction(room, { type: 'fold', player: idx, name, auto: true });
      if (resolveAuction(room)) return;
    }
  }
  if (!resolveAuction(room)) room.state = 'done';
}

function beginAuction(room) {
  room.currentBid = 0;
  room.currentBidder = null;
  room.folded = Array(room.players.length).fill(false);
  room.nextPos = 0;
  room.toAct = null;
  room.deadline = null;
  // Pre-bid intro: pick the opening bidder now so the intro can highlight them,
  // then transition into the timed bid after a short buffer.
  const opener = nextInAuction(room);
  if (opener === -1) { room.state = 'done'; return; }
  room.introBidder = opener;
  room.state = 'intro';
  room.introEnd = Date.now() + INTRO_MS;
  clearIntroTimer(room);
  room.introTimer = setTimeout(() => {
    if (room.state !== 'intro') return;
    room.state = 'auction';
    room.toAct = opener;
    room.introBidder = null;
    setTurnTimer(room);
    broadcast(room);
  }, INTRO_MS);
}

function startAuction(room) {
  room.roster = buildRoster(room.players.length);
  room.currentIndex = 0;
  room.currentBid = 0;
  room.currentBidder = null;
  room.budgets = Array(room.players.length).fill(BUDGET);
  room.teams = Array.from({ length: room.players.length }, () => []);
  room.lastWinner = null;
  room.lastAward = null;
  beginAuction(room);
}

function nextAuction(room) {
  if (room.currentIndex >= TEAM_SIZE * room.players.length) { room.state = 'done'; return; }
  // If only one player still has open slots, batch-award the rest at $1.
  const open = [];
  for (let i = 0; i < room.players.length; i++) if (room.teams[i].length < TEAM_SIZE) open.push(i);
  if (open.length === 1) {
    const p0 = open[0];
    while (room.currentIndex < TEAM_SIZE * room.players.length) {
      const p = room.roster[room.currentIndex];
      p.won = { winner: p0, price: 1 };
      room.budgets[p0] -= 1;
      room.teams[p0].push(p);
      room.currentIndex += 1;
    }
    room.lastWinner = p0;
    room.state = 'done';
    return;
  }
  // Rotate the turn order one step forward each round.
  room.turnOrder = rotateLeft(room.turnOrder);
  beginAuction(room);
}

function canStart(room) {
  return room.players.length >= MIN_PLAYERS && room.players.every((p) => p && p.connected);
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  socket.on('create', (payload, ack) => {
    try {
      const playerId = (payload && payload.playerId) || crypto.randomUUID();
      const name = (payload && payload.name) || '';
      const room = createRoom(playerId, name);
      room.players[0].socketId = socket.id;
      socket.data.roomCode = room.code;
      socket.data.playerIndex = 0;
      socket.join(room.code);
      if (ack) ack({ ok: true, code: room.code, playerIndex: 0, playerId });
      broadcast(room);
    } catch (e) {
      if (ack) ack({ ok: false, error: String(e) });
    }
  });

  socket.on('join', (payload, ack) => {
    try {
      const code = String((payload && payload.code) || '').toUpperCase().trim();
      const playerId = (payload && payload.playerId) || crypto.randomUUID();
      const name = (payload && payload.name) || '';
      const room = rooms.get(code);
      if (!room) { if (ack) ack({ ok: false, error: 'Room not found.' }); return; }
      if (room.state !== 'waiting' && room.state !== 'lobby') {
        if (ack) ack({ ok: false, error: 'This game has already started.' });
        return;
      }

      let playerIndex = room.players.findIndex((p) => p && p.id === playerId);
      let isNew = false;
      if (playerIndex === -1) {
        if (room.players.length >= room.maxPlayers) {
          if (ack) ack({ ok: false, error: 'This room is full.' });
          return;
        }
        room.players.push({ id: playerId, name: name || 'Player ' + (room.players.length + 1), connected: true, socketId: null });
        playerIndex = room.players.length - 1;
        isNew = true;
      }
      const pl = room.players[playerIndex];
      if (isNew && name) pl.name = name;
      pl.connected = true;
      pl.socketId = socket.id;
      socket.data.roomCode = code;
      socket.data.playerIndex = playerIndex;
      socket.join(code);

      if (isNew) {
        if (room.state === 'waiting' && canStart(room)) {
          room.turnOrder = shuffle(room.players.map((_, i) => i));
          room.state = 'lobby';
        } else if (room.state === 'lobby') {
          room.turnOrder = shuffle(room.players.map((_, i) => i));
        }
      }

      if (ack) ack({ ok: true, code, playerIndex, playerId });
      broadcast(room);
    } catch (e) {
      if (ack) ack({ ok: false, error: String(e) });
    }
  });

  socket.on('start', () => {
    const code = socket.data.roomCode;
    const idx = socket.data.playerIndex;
    const room = rooms.get(code);
    if (!room) return;
    if (idx !== 0) { socket.emit('error', 'Only the host can start the game.'); return; }
    if (room.state !== 'lobby') {
      if (room.state === 'waiting') socket.emit('error', 'Need at least 2 players to start.');
      return;
    }
    if (!canStart(room)) { socket.emit('error', 'Waiting for all players to join.'); return; }
    // 3-second pre-draft countdown so players can get ready.
    clearCountdownTimer(room);
    room.state = 'countdown';
    room.countdownEnd = Date.now() + COUNTDOWN_MS;
    room.countdownTimer = setTimeout(() => {
      if (room.state !== 'countdown') return;
      startAuction(room);
      broadcast(room);
    }, COUNTDOWN_MS);
    broadcast(room);
  });

  socket.on('bid', (amount) => {
    const code = socket.data.roomCode;
    const idx = socket.data.playerIndex;
    const room = rooms.get(code);
    if (!room || room.state !== 'auction') return;
    if (idx !== room.toAct) { socket.emit('error', 'Not your turn.'); return; }
    const amt = Number(amount);
    if (!Number.isInteger(amt)) { socket.emit('error', 'Bids must be whole numbers.'); return; }
    if (amt <= room.currentBid) { socket.emit('error', 'Bid must be higher than the current bid.'); return; }
    if (room.teams[idx].length >= TEAM_SIZE) { socket.emit('error', 'Your team is full.'); return; }
    if (amt > maxBidFor(room, idx)) { socket.emit('error', "You can't afford that (need to keep $1 per remaining slot)."); return; }

    room.currentBid = amt;
    room.currentBidder = idx;
    touch(room);
    emitAction(room, { type: 'bid', player: idx, name: room.players[idx].name, amount: amt });
    advanceTurn(room);
    broadcast(room);
  });

  socket.on('fold', () => {
    const code = socket.data.roomCode;
    const idx = socket.data.playerIndex;
    const room = rooms.get(code);
    if (!room || room.state !== 'auction') return;
    if (idx !== room.toAct) { socket.emit('error', 'Not your turn.'); return; }
    if (room.currentBidder === null && room.currentBid === 0) {
      socket.emit('error', 'You must open the bidding with a bid.');
      return;
    }
    room.folded[idx] = true;
    touch(room);
    emitAction(room, { type: 'fold', player: idx, name: room.players[idx].name });
    if (!resolveAuction(room)) advanceTurn(room);
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const idx = socket.data.playerIndex;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const pl = room.players[idx];
    if (pl && pl.socketId === socket.id) {
      pl.connected = false;
      pl.socketId = null;
      // If anyone leaves while the game is live, end it for everyone.
      const active = ['waiting', 'lobby', 'countdown', 'intro', 'auction', 'reveal'].includes(room.state);
      if (active) {
        room.state = 'ended';
        room.endedBy = pl.name;
        clearTurnTimer(room);
        clearRevealTimer(room);
        clearCountdownTimer(room);
        clearIntroTimer(room);
      }
      broadcast(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PokéBid running on :${PORT} (turn=${TURN_SECONDS}s, reveal=${REVEAL_SECONDS}s, intro=${INTRO_MS}ms)`);
});

// ---------- Room cleanup ----------
const IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.players.some((p) => p && p.connected);
    const idle = now - room.lastActivity > IDLE_MS;
    if (!anyConnected || idle) {
      clearTurnTimer(room);
      clearRevealTimer(room);
      clearCountdownTimer(room);
      clearIntroTimer(room);
      rooms.delete(code);
      console.log(`cleaned up room ${code}`);
    }
  }
}, 5 * 60 * 1000).unref();
