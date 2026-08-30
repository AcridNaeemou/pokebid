const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const battlePool = require('./battle_pool.json');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Expose the curated pool so players can browse all available Pokémon.
app.get('/pool', (req, res) => {
  res.json(battlePool.map((p) => ({ id: p.id, name: p.name, types: p.types, base: p.base })));
});

// Health check (used by hosts like Render to know the service is alive).
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});
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

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABELS = { hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed' };

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

function createRoom(playerId, name, numPlayers) {
  const code = newCode();
  const room = {
    code,
    numPlayers,
    players: Array(numPlayers).fill(null),
    state: 'waiting', // waiting | lobby | auction | reveal | done
    turnOrder: [],
    nextPos: 0,
    roster: [],
    currentIndex: 0,
    currentBid: 0,
    currentBidder: null,
    toAct: null,
    folded: Array(numPlayers).fill(false),
    deadline: null,
    lastWinner: null,
    lastAward: null,
    budgets: Array(numPlayers).fill(BUDGET),
    teams: Array.from({ length: numPlayers }, () => []),
    turnTimer: null,
    revealTimer: null,
    lastActivity: Date.now(),
  };
  room.players[0] = { id: playerId, name: name || 'Player 1', connected: true, socketId: null };
  rooms.set(code, room);
  return room;
}

function touch(room) { room.lastActivity = Date.now(); }

function clearTurnTimer(room) { if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; } }
function clearRevealTimer(room) { if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; } }

function buildView(room, playerIndex) {
  const pokemon = room.roster.map((p, i) => {
    if (p.won) return { id: p.id, name: p.name, types: p.types, base: p.base, won: p.won };
    // Only the Pokémon currently on auction reveals its two stats.
    // Everything else is fully hidden until someone wins it.
    if (i === room.currentIndex && room.state === 'auction') {
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
    numPlayers: room.numPlayers,
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
    revealSeconds: REVEAL_SECONDS,
  };
}

function broadcast(room) {
  room.players.forEach((p, i) => {
    if (p && p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('state', buildView(room, i));
    }
  });
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
  for (let i = 0; i < room.numPlayers; i++) if (inAuction(room, i)) ins.push(i);
  if (ins.length !== 1) return false;
  const winner = ins[0];
  const price = (room.currentBidder === winner) ? Math.max(1, room.currentBid) : 1;
  award(room, winner, price);
  return true;
}

function nextInAuction(room) {
  const n = room.numPlayers;
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
    if (room.currentBidder === null && room.currentBid === 0) {
      // Opening bidder must bid — auto-bid the $1 minimum on timeout.
      room.currentBid = 1;
      room.currentBidder = actor;
      touch(room);
      advanceTurn(room);
    } else {
      room.folded[actor] = true; // timeout = fold (bid nothing, forfeit the mon)
      touch(room);
      if (!resolveAuction(room)) advanceTurn(room);
    }
    broadcast(room);
  }, TURN_SECONDS * 1000);
}

function advanceTurn(room) {
  clearTurnTimer(room);
  room.toAct = null;
  const n = room.numPlayers;
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
      if (resolveAuction(room)) return;
    }
  }
  if (!resolveAuction(room)) room.state = 'done';
}

function beginAuction(room) {
  room.currentBid = 0;
  room.currentBidder = null;
  room.folded = Array(room.numPlayers).fill(false);
  room.nextPos = 0;
  room.toAct = null;
  room.deadline = null;
  room.state = 'auction';
  advanceTurn(room);
}

function startAuction(room) {
  room.roster = buildRoster(room.numPlayers);
  room.currentIndex = 0;
  room.currentBid = 0;
  room.currentBidder = null;
  room.budgets = Array(room.numPlayers).fill(BUDGET);
  room.teams = Array.from({ length: room.numPlayers }, () => []);
  room.lastWinner = null;
  room.lastAward = null;
  beginAuction(room);
}

function nextAuction(room) {
  if (room.currentIndex >= TEAM_SIZE * room.numPlayers) { room.state = 'done'; return; }
  // If only one player still has open slots, batch-award the rest at $1.
  const open = [];
  for (let i = 0; i < room.numPlayers; i++) if (room.teams[i].length < TEAM_SIZE) open.push(i);
  if (open.length === 1) {
    const p0 = open[0];
    while (room.currentIndex < TEAM_SIZE * room.numPlayers) {
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
  // Rotate the turn order one step forward each round, e.g.
  // (B, C, A, D) -> (C, A, D, B) -> (A, D, B, C) -> ...
  room.turnOrder = rotateLeft(room.turnOrder);
  beginAuction(room);
}

function allJoined(room) {
  return room.players.every((p) => p && p.connected);
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  socket.on('create', (payload, ack) => {
    try {
      const playerId = (payload && payload.playerId) || crypto.randomUUID();
      const name = (payload && payload.name) || '';
      let num = parseInt(payload && payload.numPlayers, 10);
      if (!Number.isFinite(num) || num < MIN_PLAYERS || num > MAX_PLAYERS) num = 2;
      const room = createRoom(playerId, name, num);
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

      let playerIndex = -1;
      let isNew = false;
      for (let i = 0; i < room.numPlayers; i++) {
        if (room.players[i] && room.players[i].id === playerId) { playerIndex = i; break; }
      }
      if (playerIndex === -1) {
        const empty = room.players.findIndex((p) => !p);
        if (empty === -1) { if (ack) ack({ ok: false, error: 'This room is full.' }); return; }
        room.players[empty] = { id: playerId, name: name || 'Player ' + (empty + 1), connected: true, socketId: null };
        playerIndex = empty;
        isNew = true;
      }
      const pl = room.players[playerIndex];
      if (isNew && name) pl.name = name;
      pl.connected = true;
      pl.socketId = socket.id;
      socket.data.roomCode = code;
      socket.data.playerIndex = playerIndex;
      socket.join(code);

      if (room.state === 'waiting' && allJoined(room)) {
        room.turnOrder = shuffle(room.players.map((_, i) => i));
        room.state = 'lobby';
      }

      if (ack) ack({ ok: true, code, playerIndex, playerId });
      broadcast(room);
    } catch (e) {
      if (ack) ack({ ok: false, error: String(e) });
    }
  });

  socket.on('start', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.state !== 'lobby') return;
    if (!allJoined(room)) { socket.emit('error', 'Waiting for all players to join.'); return; }
    startAuction(room);
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
      broadcast(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PokéBid running on :${PORT} (turn=${TURN_SECONDS}s, reveal=${REVEAL_SECONDS}s)`);
});

// ---------- Room cleanup ----------
// Remove rooms that have no connected players (orphaned) or have been idle
// for a long time, so a shared server doesn't leak memory over time.
const IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.players.some((p) => p && p.connected);
    const idle = now - room.lastActivity > IDLE_MS;
    if (!anyConnected || idle) {
      clearTurnTimer(room);
      clearRevealTimer(room);
      rooms.delete(code);
      console.log(`cleaned up room ${code}`);
    }
  }
}, 5 * 60 * 1000).unref();
