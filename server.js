// Zero-dependency server: static files + online rooms (REST + Server-Sent Events).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Coup = require('./public/game.js');
const { botMove, botReact } = require('./bot.js');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '::');
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const MAX_PLAYERS = 6, MAX_ROOMS = 200, BOT_DELAY = [900, 1800];
const NAMES = ['Ada', 'Bram', 'Cleo', 'Dax', 'Eve', 'Finn'];

const rooms = new Map();

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = n => String(n || '').replace(/[^\w \-']/g, '').trim().slice(0, 14) || 'Player';

function newRoom(hostName) {
  const room = { code: makeCode(), players: [], state: null, streams: new Map(), touched: Date.now(), botTimer: null, reactKey: '', reactTimers: [], voice: '', windowSec: 10 };
  addPlayer(room, hostName, false);
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name, bot) {
  const p = { name, bot, token: bot ? null : crypto.randomBytes(8).toString('hex') };
  room.players.push(p);
  return p;
}

function snapshot(room, idx) {
  return {
    code: room.code, you: idx, host: idx === 0,
    lobby: room.players.map((p, i) => ({ name: p.name, bot: p.bot, connected: p.bot || room.streams.has(i) })),
    voice: room.voice, windowSec: room.windowSec,
    game: room.state ? Coup.view(room.state, idx) : null,
  };
}
function broadcast(room) {
  room.touched = Date.now();
  room.streams.forEach((set, idx) => {
    const data = `data: ${JSON.stringify(snapshot(room, idx))}\n\n`;
    set.forEach(res => res.write(data));
  });
  scheduleBots(room);
}

function scheduleBots(room) {
  clearTimeout(room.botTimer);
  const s = room.state;
  if (!s || s.phase === 'over') return;
  if (s.phase === 'window') {
    const key = s.stageNo + ':' + s.turn;
    if (key === room.reactKey) return;
    room.reactKey = key;
    room.reactTimers.forEach(clearTimeout);
    const span = s.windowMs * 0.75;
    room.reactTimers = s.players.filter(p => p.bot && p.alive).map(p => setTimeout(() => {
      if (room.state !== s || s.phase !== 'window' || s.stageNo + ':' + s.turn !== key) return;
      const m = botReact(s, p.id) || { type: 'pass' };
      if (!Coup.act(s, p.id, m).error) broadcast(room);
    }, 1200 + Math.random() * Math.max(500, span - 1200)));
    return;
  }
  const bots = Coup.waitingOn(s).filter(i => room.players[i].bot);
  if (!bots.length) return;
  const delay = BOT_DELAY[0] + Math.random() * (BOT_DELAY[1] - BOT_DELAY[0]);
  room.botTimer = setTimeout(() => {
    const id = bots[Math.floor(Math.random() * bots.length)];
    if (!Coup.waitingOn(s).includes(id)) return broadcast(room);
    const m = botMove(s, id);
    if (m) Coup.act(s, id, m);
    broadcast(room);
  }, delay);
}

// Close expired challenge/block windows.
setInterval(() => {
  rooms.forEach(room => { if (room.state && Coup.tick(room.state, Date.now())) broadcast(room); });
}, 300).unref();

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const auth = (room, token) => room ? room.players.findIndex(p => p.token && p.token === token) : -1;

async function api(req, res, url) {
  if (url.pathname === '/api/events') {
    const room = rooms.get(String(url.searchParams.get('code')).toUpperCase());
    const idx = auth(room, url.searchParams.get('token'));
    if (idx < 0) return json(res, 404, { error: 'Room not found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (!room.streams.has(idx)) room.streams.set(idx, new Set());
    room.streams.get(idx).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      const set = room.streams.get(idx);
      if (set) { set.delete(res); if (!set.size) room.streams.delete(idx); }
      broadcast(room);
    });
    broadcast(room);
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const b = await readBody(req);

  if (url.pathname === '/api/create') {
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Server busy' });
    const room = newRoom(cleanName(b.name));
    return json(res, 200, { code: room.code, token: room.players[0].token });
  }
  const room = rooms.get(String(b.code || '').toUpperCase());
  if (!room) return json(res, 404, { error: 'Room not found' });

  if (url.pathname === '/api/join') {
    if (room.state) return json(res, 400, { error: 'Game already started' });
    if (room.players.length >= MAX_PLAYERS) return json(res, 400, { error: 'Room full' });
    const p = addPlayer(room, cleanName(b.name), false);
    broadcast(room);
    return json(res, 200, { code: room.code, token: p.token });
  }
  const me = auth(room, b.token);
  if (me < 0) return json(res, 403, { error: 'Bad token' });

  if (url.pathname === '/api/move') {
    if (!room.state) return json(res, 400, { error: 'Not started' });
    const r = Coup.act(room.state, me, b.move || {});
    if (r.error) return json(res, 400, r);
    broadcast(room);
    return json(res, 200, r);
  }
  // host-only below
  if (me !== 0) return json(res, 403, { error: 'Host only' });
  if (url.pathname === '/api/addbot') {
    if (room.state || room.players.length >= MAX_PLAYERS) return json(res, 400, { error: 'Cannot add' });
    addPlayer(room, NAMES.filter(n => !room.players.some(p => p.name === n + ' (bot)'))[0] + ' (bot)', true);
  } else if (url.pathname === '/api/kick') {
    const i = Number(b.index);
    if (room.state || !(i > 0 && i < room.players.length)) return json(res, 400, { error: 'Cannot remove' });
    room.streams.get(i)?.forEach(r => r.end());
    room.players.splice(i, 1);
    room.streams.clear(); // clients reconnect with their new index
  } else if (url.pathname === '/api/start') {
    if (room.players.length < 2) return json(res, 400, { error: 'Need 2+ players' });
    room.state = Coup.create(room.players, { windowMs: room.windowSec * 1000 }); room.reactKey = '';
  } else if (url.pathname === '/api/replace') { // hand a disconnected player over to a bot
    const i = Number(b.index), p = room.players[i];
    if (!p || p.bot || i === 0) return json(res, 400, { error: 'Cannot replace' });
    p.bot = true; p.token = null; p.name += ' (bot)';
    if (room.state) room.state.players[i].bot = true, room.state.players[i].name = p.name;
  } else if (url.pathname === '/api/settings') {
    if (room.state) return json(res, 400, { error: 'Game running' });
    if (b.voice !== undefined) {
      const v = String(b.voice).trim().slice(0, 300);
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) return json(res, 400, { error: 'Voice link must start with http(s)://' });
      room.voice = v;
    }
    if (b.windowSec !== undefined) room.windowSec = Math.min(30, Math.max(4, Math.round(Number(b.windowSec)) || 10));
  } else if (url.pathname === '/api/lobby') { // back to lobby after game
    room.state = null;
  } else return json(res, 404, { error: 'Unknown' });
  broadcast(room);
  json(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(() => json(res, 500, { error: 'Server error' }));
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

setInterval(() => {
  const now = Date.now();
  rooms.forEach((r, c) => { if (now - r.touched > 3 * 3600e3 && !r.streams.size) { clearTimeout(r.botTimer); rooms.delete(c); } });
}, 600e3).unref();

if (require.main === module) server.listen(PORT, HOST, () => console.log(`Coup on http://localhost:${PORT}`));
module.exports = server;
