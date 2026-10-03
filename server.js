// Zero-dependency server: static files + online rooms (REST + Server-Sent Events).
// Node built-ins only: Render runs `node server.js` with no npm install step.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Coup = require('./public/game.js');
const { botMove, botReact } = require('./bot.js');

const PORT = process.env.PORT || 3000;
// No HOST: Node listens dual-stack where IPv6 exists and falls back to IPv4 elsewhere.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : undefined);
const PUBLIC = path.join(__dirname, 'public');
const NAMES = ['Ada', 'Bram', 'Cleo', 'Dax', 'Eve', 'Finn'];

// Tunables (exported so tests can shorten them).
const CFG = {
  MAX_PLAYERS: 6, MAX_ROOMS: 500, MAX_STREAMS: 3,
  BOT_DELAY: [900, 1800],
  TURN_MS: 60e3,           // a stalled decision (action / lose / exchange) auto-plays after this
  AWAY_MS: 45e3,           // a disconnected human gets safe moves (never a bluff) after this; phones drop streams on app switches
  HOST_AWAY_MS: 30e3,      // the host role passes to a connected human after this
  PING_MS: 15e3,
  EMPTY_ROOM_MS: 2 * 60e3, // room nobody ever connected to
  IDLE_ROOM_MS: 30 * 60e3, // room nobody has been connected to for this long
  TRUST_PROXY: !!process.env.RENDER,
};

const rooms = new Map();
const buckets = new Map(); // rate limiting, see allow()
const log = (...a) => console.error('[coup]', ...a);
// Timer callbacks must never take the process (and every in-memory room) down.
const safe = fn => (...a) => { try { return fn(...a); } catch (e) { log(e); } };

// ---------- static files: preloaded, precompressed, ETag + Cache-Control ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/;
const files = new Map();
function loadStatic(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { loadStatic(full); continue; }
    const type = MIME[path.extname(ent.name).toLowerCase()];
    if (!type) continue;
    const buf = fs.readFileSync(full);
    const tag = crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20);
    // Images get a week of caching; code/HTML revalidate every load (cheap 304) so deploys show up at once.
    const f = { type, buf, tag, cache: type.startsWith('image/') ? 'public, max-age=604800' : 'no-cache' };
    if (COMPRESSIBLE.test(type) && buf.length > 256) {
      const gz = zlib.gzipSync(buf, { level: 9 });
      const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
      if (gz.length < buf.length) f.gz = gz;
      if (br.length < buf.length) f.br = br;
    }
    files.set('/' + path.relative(PUBLIC, full).split(path.sep).join('/'), f);
  }
}
loadStatic(PUBLIC);

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let p;
  try { p = decodeURIComponent(pathname); } catch { return text(res, 400, 'Bad request'); }
  if (p.includes('\0')) return text(res, 400, 'Bad request');
  // Only files preloaded from public/ can be served, so no path can escape it.
  const f = files.get(p === '/' ? '/index.html' : p);
  if (!f) return text(res, 404, 'Not found');
  const ae = String(req.headers['accept-encoding'] || '');
  let body = f.buf, enc = '';
  if (f.br && /\bbr\b/.test(ae)) { body = f.br; enc = 'br'; } else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; enc = 'gzip'; }
  const etag = `"${f.tag}${enc ? '-' + enc : ''}"`;
  const h = { 'Content-Type': f.type, 'Cache-Control': f.cache, ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (f.gz || f.br) h.Vary = 'Accept-Encoding';
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some(t => t.trim().replace(/^W\//, '').replace(/-(br|gzip)"$/, '"') === `"${f.tag}"` || t.trim() === '*')) {
    res.writeHead(304, h); return res.end();
  }
  if (enc) h['Content-Encoding'] = enc;
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- rooms ----------
function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = n => String(n || '').replace(/[^\w \-']/g, '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Player';

function newRoom(hostName) {
  const now = Date.now();
  const room = {
    code: makeCode(), players: [], host: null, state: null, voice: '', windowSec: 10,
    created: now, lastSeen: now, everConnected: false, errors: 0,
    botTimer: null, botKey: '', reactKey: '', reactTimers: [],
  };
  room.host = addPlayer(room, hostName, false);
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name, bot) {
  const p = { name, bot, token: bot ? null : crypto.randomBytes(12).toString('hex'), streams: new Set(), offlineSince: Date.now() };
  room.players.push(p);
  return p;
}
const isConnected = p => p.bot || p.streams.size > 0;
const hasStreams = room => room.players.some(p => p.streams.size);
const endStreams = p => { p.streams.forEach(r => r.end()); p.streams.clear(); };
// Seats the server plays: bots, and humans who have been disconnected for a while.
// An absent human is never bluffed for: see Coup.safeMove and the window pass below.
const isAuto = (room, i, now) => {
  const p = room.players[i];
  return !!p && (p.bot || (!p.streams.size && p.offlineSince != null && now - p.offlineSince >= CFG.AWAY_MS));
};

function resetTimers(room) {
  clearTimeout(room.botTimer); room.botTimer = null; room.botKey = '';
  room.reactTimers.forEach(clearTimeout); room.reactTimers = []; room.reactKey = '';
}
function closeRoom(room) {
  resetTimers(room);
  room.players.forEach(endStreams);
  if (rooms.get(room.code) === room) rooms.delete(room.code);
}
// Hand a human seat to the bot logic for good (left the game / replaced by the host).
function makeBot(room, p) {
  endStreams(p);
  p.bot = true; p.token = null;
  if (!/ \(bot\)$/.test(p.name)) p.name += ' (bot)';
  const i = room.players.indexOf(p);
  if (room.state && room.state.players[i]) Object.assign(room.state.players[i], { bot: true, name: p.name });
}
function pickHost(room) {
  if (room.host && !room.host.bot && room.players.includes(room.host)) return;
  room.host = room.players.find(p => !p.bot && p.streams.size) || room.players.find(p => !p.bot) || null;
}
function checkHost(room, now) {
  const h = room.host;
  if (h && !h.bot && (h.streams.size || now - h.offlineSince < CFG.HOST_AWAY_MS)) return false;
  const next = room.players.find(p => !p.bot && p.streams.size);
  if (!next || next === h) return false;
  room.host = next;
  return true;
}

// ---------- snapshots ----------
// The room part is the same for everyone, so it is serialized once per broadcast.
function sharedJson(room) {
  return JSON.stringify({
    code: room.code, voice: room.voice, windowSec: room.windowSec,
    lobby: room.players.map(p => ({ name: p.name, bot: p.bot, connected: isConnected(p), host: p === room.host })),
  }).slice(1, -1);
}
function frame(room, i, shared) {
  const game = room.state ? JSON.stringify(Coup.view(room.state, i)) : 'null';
  return `data: {"you":${i},"host":${room.players[i] === room.host},${shared},"game":${game}}\n\n`;
}
function broadcast(room) {
  const shared = sharedJson(room);
  room.players.forEach((p, i) => {
    if (!p.streams.size) return;
    const data = frame(room, i, shared);
    p.streams.forEach(res => res.write(data));
  });
  drive(room);
}

// ---------- bots / autopilot ----------
// Re-arms timers only when what they wait on changes, so reconnect storms cannot starve bots.
function drive(room) {
  const s = room.state;
  if (!s || s.phase === 'over') { resetTimers(room); return; }
  const now = Date.now();
  if (s.phase === 'window') {
    const key = 'w' + s.stageNo;
    if (key === room.reactKey) return;
    clearTimeout(room.botTimer); room.botTimer = null; room.botKey = '';
    room.reactKey = key;
    room.reactTimers.forEach(clearTimeout);
    const span = s.windowMs * 0.75;
    room.reactTimers = s.players.filter(p => p.alive && isAuto(room, p.id, now)).map(p => {
      const away = !room.players[p.id].bot; // an absent human simply says "No"
      return setTimeout(safe(() => {
        if (room.state !== s || s.phase !== 'window' || 'w' + s.stageNo !== key) return;
        const m = away ? { type: 'pass' } : (botReact(s, p.id) || { type: 'pass' });
        if (!Coup.act(s, p.id, m).error) broadcast(room);
      }), away ? 400 : 1200 + Math.random() * Math.max(500, span - 1200));
    });
    return;
  }
  const auto = Coup.waitingOn(s).filter(i => isAuto(room, i, now));
  const key = s.seq + ':' + auto.join(',');
  if (key === room.botKey) return;
  room.botKey = key;
  clearTimeout(room.botTimer); room.botTimer = null;
  if (!auto.length) return;
  const seq = s.seq, id = auto[0];
  const [lo, hi] = CFG.BOT_DELAY;
  room.botTimer = setTimeout(safe(() => {
    room.botTimer = null;
    if (room.state !== s || s.seq !== seq || !Coup.waitingOn(s).includes(id)) return;
    // Bots play their AI; an absent human only gets the safe move (Income / forced Coup, first card,
    // keep the hand), so the server never claims a character on their behalf.
    const m = room.players[id].bot ? botMove(s, id) : Coup.safeMove(s, id);
    const r = m ? Coup.act(s, id, m) : { error: 'no move' };
    if (r.error) log('bot move rejected', r.error, JSON.stringify(m)); // the turn timer recovers
    else broadcast(room);
  }), lo + Math.random() * (hi - lo));
}

// Close expired windows, auto-play stalled decisions, hand over absent seats and hosts.
setInterval(() => {
  const now = Date.now();
  rooms.forEach(room => {
    try {
      const hostMoved = checkHost(room, now);
      if ((room.state && Coup.tick(room.state, now)) || hostMoved) broadcast(room);
      else drive(room);
    } catch (e) {
      log('room', room.code, e);
      if (++room.errors > 20) closeRoom(room);
    }
  });
}, 300).unref();

// One heartbeat for every open stream keeps proxies from closing idle connections.
setInterval(safe(() => {
  rooms.forEach(r => r.players.forEach(p => p.streams.forEach(res => res.write(': ping\n\n'))));
}), CFG.PING_MS).unref();

// Drop abandoned rooms and stale rate-limit buckets.
setInterval(safe(() => {
  const now = Date.now();
  rooms.forEach(r => {
    if (hasStreams(r)) { r.lastSeen = now; return; }
    const idle = now - r.lastSeen;
    if ((!r.everConnected && idle > CFG.EMPTY_ROOM_MS) || idle > CFG.IDLE_ROOM_MS) closeRoom(r);
  });
  buckets.forEach((b, k) => { if (now - b.t > b.cap * b.per) buckets.delete(k); });
}), 60e3).unref();

// When full, make room by evicting the stalest room nobody is connected to.
function makeSpace() {
  if (rooms.size < CFG.MAX_ROOMS) return true;
  let victim = null;
  rooms.forEach(r => { if (!hasStreams(r) && (!victim || r.lastSeen < victim.lastSeen)) victim = r; });
  if (victim) closeRoom(victim);
  return !!victim;
}

// ---------- HTTP helpers ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function text(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(msg) });
  res.end(msg);
}
function fail(res, e) {
  log(e);
  if (res.headersSent) { try { res.end(); } catch { /* socket gone */ } return; }
  json(res, 500, { error: 'Server error' });
}
// Resolves to a plain object, TOO_BIG, or null if the request broke off.
const TOO_BIG = Symbol('too big');
function readBody(req) {
  return new Promise(resolve => {
    let b = '', size = 0, done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    req.setEncoding('utf8');
    req.on('data', d => { size += d.length; if (size > 4096) fin(TOO_BIG); else b += d; });
    req.on('end', () => {
      let v = null;
      try { v = JSON.parse(b || '{}'); } catch { /* ignore */ }
      fin(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    });
    req.on('error', () => fin(null));
    req.on('close', () => fin(null));
  });
}
const findPlayer = (room, token) => (room && typeof token === 'string' && token ? room.players.find(p => p.token === token) : undefined);

// Per-IP token buckets for the unauthenticated endpoints.
function allow(req, kind, cap, per) {
  const xff = CFG.TRUST_PROXY && req.headers['x-forwarded-for'];
  const ip = (xff ? String(xff).split(',')[0].trim() : req.socket.remoteAddress) || '?';
  const k = kind + ' ' + ip, now = Date.now();
  let b = buckets.get(k);
  if (!b) buckets.set(k, b = { n: cap, t: now, cap, per });
  b.n = Math.min(cap, b.n + (now - b.t) / per); b.t = now;
  if (b.n < 1) return false;
  b.n -= 1;
  return true;
}

// ---------- API ----------
function events(req, res, url) {
  const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
  const p = findPlayer(room, url.searchParams.get('token'));
  if (!p) return json(res, 404, { error: 'Room not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const wasOffline = !p.streams.size;
  p.streams.add(res);
  if (p.streams.size > CFG.MAX_STREAMS) { const old = p.streams.values().next().value; p.streams.delete(old); old.end(); }
  p.offlineSince = null;
  room.everConnected = true; room.lastSeen = Date.now();
  res.on('close', safe(() => {
    if (!p.streams.delete(res) || p.streams.size) return;
    p.offlineSince = room.lastSeen = Date.now();
    if (rooms.get(room.code) === room && room.players.includes(p)) broadcast(room);
  }));
  // Presence changed: everyone needs the new "connected" flag. Otherwise only this client needs a snapshot.
  if (wasOffline) broadcast(room);
  else res.write(frame(room, room.players.indexOf(p), sharedJson(room)));
}

async function api(req, res, url) {
  if (url.pathname === '/api/events') return events(req, res, url);
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const b = await readBody(req);
  if (b === TOO_BIG) { res.setHeader('Connection', 'close'); return json(res, 413, { error: 'Request too large' }); }
  if (!b) return; // the client went away

  if (url.pathname === '/api/create') {
    if (!allow(req, 'create', 8, 15e3)) return json(res, 429, { error: 'Too many rooms created — try again in a minute' });
    if (!makeSpace()) return json(res, 503, { error: 'Server busy' });
    const room = newRoom(cleanName(b.name));
    return json(res, 200, { code: room.code, token: room.host.token });
  }
  const room = rooms.get(String(b.code || '').trim().toUpperCase());
  if (url.pathname === '/api/join') {
    if (!allow(req, 'join', 20, 3e3)) return json(res, 429, { error: 'Too many attempts — try again shortly' });
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (room.state) return json(res, 400, { error: 'Game already started' });
    if (room.players.length >= CFG.MAX_PLAYERS) return json(res, 400, { error: 'Room full' });
    const p = addPlayer(room, cleanName(b.name), false);
    pickHost(room);
    broadcast(room);
    return json(res, 200, { code: room.code, token: p.token });
  }
  if (!room) return json(res, 404, { error: 'Room not found' });
  const me = findPlayer(room, b.token);
  if (!me) return json(res, 403, { error: 'You are not in this room' });
  const idx = room.players.indexOf(me);

  if (url.pathname === '/api/ping') return json(res, 200, { ok: true });
  if (url.pathname === '/api/move') {
    if (!room.state) return json(res, 400, { error: 'Not started' });
    const r = Coup.act(room.state, idx, b.move && typeof b.move === 'object' ? b.move : {});
    if (r.error) return json(res, 400, r);
    broadcast(room);
    return json(res, 200, r);
  }
  if (url.pathname === '/api/leave') {
    if (room.state) makeBot(room, me); // the game goes on; a bot takes the seat
    else { endStreams(me); room.players.splice(idx, 1); }
    if (!room.players.some(p => !p.bot)) { closeRoom(room); return json(res, 200, { ok: true }); }
    if (room.host === me || !room.players.includes(room.host)) { room.host = null; pickHost(room); }
    broadcast(room);
    return json(res, 200, { ok: true });
  }
  // host-only below
  if (me !== room.host) return json(res, 403, { error: 'Host only' });
  const target = Number.isInteger(b.index) ? room.players[b.index] : undefined;
  if (url.pathname === '/api/addbot') {
    if (room.state || room.players.length >= CFG.MAX_PLAYERS) return json(res, 400, { error: 'Cannot add' });
    addPlayer(room, NAMES.find(n => !room.players.some(p => p.name === n + ' (bot)')) + ' (bot)', true);
  } else if (url.pathname === '/api/kick') {
    if (room.state || !target || target === me) return json(res, 400, { error: 'Cannot remove' });
    endStreams(target);
    room.players.splice(b.index, 1);
  } else if (url.pathname === '/api/start' || url.pathname === '/api/restart') {
    if (room.players.length < 2) return json(res, 400, { error: 'Need 2+ players' });
    resetTimers(room);
    room.state = Coup.create(room.players, { windowMs: room.windowSec * 1000, turnMs: CFG.TURN_MS });
  } else if (url.pathname === '/api/replace') { // hand a disconnected player over to a bot
    if (!target || target.bot || target === me || target.streams.size) return json(res, 400, { error: 'Cannot replace' });
    makeBot(room, target);
  } else if (url.pathname === '/api/settings') {
    if (room.state) return json(res, 400, { error: 'Game running' });
    if (b.voice !== undefined) {
      const v = String(b.voice).trim().slice(0, 300);
      if (v && !/^https?:\/\/[^\s"'<>]+$/i.test(v)) return json(res, 400, { error: 'Voice link must start with http(s)://' });
      room.voice = v;
    }
    if (b.windowSec !== undefined) room.windowSec = Math.min(30, Math.max(4, Math.round(Number(b.windowSec)) || 10));
  } else if (url.pathname === '/api/lobby') { // back to lobby after a game
    resetTimers(room);
    room.state = null;
  } else return json(res, 404, { error: 'Unknown' });
  broadcast(room);
  json(res, 200, { ok: true });
}

function route(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return text(res, 400, 'Bad request'); }
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(e => fail(res, e));
  serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  try { route(req, res); } catch (e) { fail(res, e); }
});
// For tests and tooling.
server.cfg = CFG;
server.rooms = rooms;
server.buckets = buckets;
server.closeRooms = () => rooms.forEach(closeRoom);

if (require.main === module) {
  // Last line of defence: log, keep serving. Rooms live in memory, so a crash would wipe every game.
  process.on('uncaughtException', e => log('uncaught', e));
  process.on('unhandledRejection', e => log('unhandled', e));
  // A listen failure (port taken, bad HOST) must end the process so the platform restarts it.
  server.once('error', e => { log('cannot listen', e.message); process.exit(1); });
  server.listen(PORT, HOST, () => console.log(`Coup on http://localhost:${PORT}`));
}
module.exports = server;
