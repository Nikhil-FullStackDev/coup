// HTTP + SSE tests against the real server on an ephemeral localhost port (no network needed).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const Coup = require('../public/game.js');
const server = require('../server.js');

const cfg = server.cfg, DEFAULTS = { ...cfg, BOT_DELAY: [...cfg.BOT_DELAY] };
let base = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test.before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.closeRooms(); server.closeAllConnections(); server.close(); });
test.beforeEach(() => { Object.assign(cfg, DEFAULTS, { BOT_DELAY: [...DEFAULTS.BOT_DELAY] }); server.buckets.clear(); });

// Raw GET so odd paths reach the server exactly as written.
function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + p, { headers, agent: false }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}
async function post(p, body) {
  const r = await fetch(base + '/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
// Minimal EventSource: collects snapshots, can wait for one that matches.
function sse(code, token) {
  const c = { msgs: [], waiters: [], ended: false };
  c.last = () => c.msgs[c.msgs.length - 1];
  c.ready = new Promise((resolve, reject) => {
    c.req = http.get(`${base}/api/events?code=${code}&token=${token}`, { agent: false }, res => {
      c.status = res.statusCode;
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) { c.msgs.push(JSON.parse(line.slice(6))); c.waiters = c.waiters.filter(w => !w()); }
        }
      });
      res.on('end', () => { c.ended = true; });
      res.on('close', () => { c.ended = true; });
      resolve(c);
    });
    c.req.on('error', e => (c.status ? (c.ended = true) : reject(e)));
  });
  c.waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const ok = () => { const m = c.last(); if (m && pred(m)) { clearTimeout(t); resolve(m); return true; } return false; };
    const t = setTimeout(() => { c.waiters = c.waiters.filter(w => w !== ok); reject(new Error('timed out; last=' + JSON.stringify(c.last()).slice(0, 300))); }, ms);
    if (!ok()) c.waiters.push(ok);
  });
  c.close = () => c.req.destroy();
  return c;
}
async function until(fn, ms = 3000, step = 20) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(step); }
  return fn();
}
async function room(n = 1) { // host + (n-1) bots
  const { body } = await post('create', { name: 'Host' });
  for (let i = 1; i < n; i++) await post('addbot', { code: body.code, token: body.token });
  return body;
}

// ---------- robustness ----------
test('malformed requests get 4xx and never take the server down', async () => {
  assert.strictEqual((await get('/%E0%A4%A')).status, 400);
  assert.strictEqual((await get('/a%00b')).status, 400);
  assert.strictEqual((await get('/../server.js')).status, 404);
  assert.strictEqual((await get('/%2e%2e/server.js')).status, 404);
  assert.strictEqual((await get('/..%2fserver.js')).status, 404);
  const raw = await new Promise(resolve => {
    const s = net.connect(server.address().port, '127.0.0.1', () => s.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'));
    let out = '';
    s.on('data', d => { out += d; s.end(); });
    s.on('close', () => resolve(out));
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  assert.strictEqual((await post('create', 'null')).status, 200, 'a JSON null body is treated as {}');
  assert.strictEqual((await post('move', '[1,2]')).status, 404);
  assert.strictEqual((await post('move', '{bad json')).status, 404);
  assert.strictEqual((await post('create', JSON.stringify({ name: 'x'.repeat(5000) }))).status, 413);
  assert.strictEqual((await get('/api/create')).status, 405);
  const h = await get('/healthz');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(JSON.parse(h.body).ok, true);
});

test('static files: compressed, cacheable, revalidated with ETag', async () => {
  const disk = fs.readFileSync(path.join(__dirname, '../public/app.js'));
  const br = await get('/app.js', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.strictEqual(br.status, 200);
  assert.strictEqual(br.headers['content-encoding'], 'br');
  assert.strictEqual(br.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.strictEqual(br.headers.vary, 'Accept-Encoding');
  assert.strictEqual(br.headers['cache-control'], 'no-cache');
  assert.ok(zlib.brotliDecompressSync(br.body).equals(disk));
  const gz = await get('/app.js', { 'Accept-Encoding': 'gzip' });
  assert.ok(zlib.gunzipSync(gz.body).equals(disk));
  const plain = await get('/app.js');
  assert.ok(plain.body.equals(disk));
  assert.strictEqual(+plain.headers['content-length'], disk.length);
  assert.strictEqual((await get('/app.js', { 'If-None-Match': br.headers.etag, 'Accept-Encoding': 'br' })).status, 304);
  assert.strictEqual((await get('/app.js', { 'If-None-Match': gz.headers.etag })).status, 304, 'any encoding of the same content matches');
  const idx = await get('/');
  assert.strictEqual(idx.headers['content-type'], 'text/html; charset=utf-8');
  const pic = await get('/img/duke.webp');
  assert.strictEqual(pic.headers['content-type'], 'image/webp');
  assert.match(pic.headers['cache-control'], /max-age=\d{5,}/);
  // every image the client references exists
  const app = disk.toString() + fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const refs = [...app.matchAll(/(img\/[\w-]+\.webp|[\w-]+\.(?:svg|png))/g)].map(m => m[1]);
  for (const c of [...Coup.CHARS, 'coup-card-back']) refs.push(`img/${c}.webp`);
  for (const r of new Set(refs)) assert.strictEqual((await get('/' + r)).status, 200, r);
});

// ---------- rooms ----------
test('kicking a player keeps every other client live (streams follow the player, not the index)', async () => {
  const host = await room();
  const alice = (await post('join', { code: host.code, name: 'Alice' })).body;
  const bob = (await post('join', { code: host.code, name: 'Bob' })).body;
  const [h, a, b] = await Promise.all([sse(host.code, host.token).ready, sse(host.code, alice.token).ready, sse(host.code, bob.token).ready]);
  await b.waitFor(m => m.lobby.length === 3 && m.lobby.every(p => p.connected));
  assert.strictEqual((await post('kick', { code: host.code, token: host.token, index: 1 })).status, 200);
  assert.ok(await until(() => a.ended), 'kicked player stream is closed');
  const bm = await b.waitFor(m => m.lobby.length === 2);
  assert.strictEqual(bm.you, 1);
  assert.ok(bm.lobby[1].connected, 'Bob still shows as connected');
  await post('addbot', { code: host.code, token: host.token });
  await post('start', { code: host.code, token: host.token });
  await h.waitFor(m => m.game && m.game.you === 0);
  await b.waitFor(m => m.game && m.game.you === 1);
  assert.strictEqual((await post('ping', { code: host.code, token: alice.token })).status, 403);
  [h, b].forEach(c => c.close());
});

test('host-only actions are enforced', async () => {
  const host = await room();
  const bob = (await post('join', { code: host.code, name: 'Bob' })).body;
  for (const p of ['start', 'addbot', 'kick', 'restart', 'settings', 'lobby', 'replace']) {
    const r = await post(p, { code: host.code, token: bob.token, index: 0 });
    assert.strictEqual(r.status, 403, p);
  }
  assert.strictEqual((await post('start', { code: host.code, token: 'nope' })).status, 403);
});

test('moves are validated: prototype actions and fractional exchange indexes are rejected', async () => {
  const host = await room(2);
  await post('start', { code: host.code, token: host.token });
  const s = server.rooms.get(host.code).state;
  const auth = m => post('move', { code: host.code, token: host.token, move: m });
  Object.assign(s, { turn: 0, phase: 'action', pending: null });
  for (const action of ['constructor', '__proto__', 'toString']) assert.strictEqual((await auth({ type: 'action', action })).status, 400);
  assert.strictEqual((await auth({ type: 'action', action: 'exchange' })).status, 200);
  Coup.tick(s, Date.now() + 1e6); // nobody challenged
  assert.strictEqual(s.phase, 'exchange');
  for (const keep of [[0.5, 1], [0, 0], ['0', '1'], [9, 1]]) assert.strictEqual((await auth({ type: 'keep', keep })).status, 400, JSON.stringify(keep));
  assert.strictEqual((await auth({ type: 'keep', keep: [0, 1] })).status, 200);
  const all = [...s.deck, ...s.players.flatMap(p => p.cards.map(c => c.c))];
  assert.strictEqual(all.length, 15);
  assert.ok(all.every(Boolean));
  assert.strictEqual((await get('/healthz')).status, 200);
});

test('reconnect storms cannot starve a bot of its turn', async () => {
  cfg.BOT_DELAY = [250, 300];
  const host = await room(2);
  await post('start', { code: host.code, token: host.token });
  const r = server.rooms.get(host.code), s = r.state;
  Object.assign(s, { turn: 1, phase: 'action', pending: null }); s.seq++;
  const seq0 = s.seq;
  let c = await sse(host.code, host.token).ready;
  const end = Date.now() + 1500;
  while (Date.now() < end && s.seq === seq0) { c.close(); await sleep(40); c = await sse(host.code, host.token).ready; await sleep(40); }
  c.close();
  assert.ok(s.seq > seq0, 'the bot moved despite constant reconnects');
});

test('a disconnected human is auto-played, and the host role moves to someone connected', async () => {
  cfg.AWAY_MS = 150; cfg.HOST_AWAY_MS = 200; cfg.BOT_DELAY = [20, 40];
  const host = await room();
  const bob = (await post('join', { code: host.code, name: 'Bob' })).body;
  const hc = await sse(host.code, host.token).ready;
  await hc.waitFor(m => m.lobby.length === 2);
  await post('start', { code: host.code, token: host.token });
  const s = server.rooms.get(host.code).state;
  Object.assign(s, { turn: 1, phase: 'action', pending: null }); s.seq++;
  s.players[1].coins = 3; // enough to (bluff an) Assassinate: an absent human must never be bluffed for
  const seq0 = s.seq;
  assert.ok(await until(() => s.seq > seq0, 2000), 'Bob (never connected) was played for');
  assert.match(s.log.join('\n'), /Bob takes Income/, 'an absent human only gets the safe move');
  assert.strictEqual(s.players[1].coins, 4);
  // host goes away; Bob connects and inherits the host role
  hc.close();
  const bc = await sse(host.code, bob.token).ready;
  await bc.waitFor(m => m.host === true && m.lobby[1].host, 3000);
  bc.close();
});

test('a stalled human decision is auto-played when the turn timer runs out', async () => {
  cfg.TURN_MS = 300;
  const host = await room(2);
  const hc = await sse(host.code, host.token).ready;
  await post('start', { code: host.code, token: host.token });
  const s = server.rooms.get(host.code).state;
  Object.assign(s, { turn: 0, phase: 'action', pending: null, decideBy: Date.now() + 300 });
  await hc.waitFor(m => m.game && m.game.log.some(l => /Host ran out of time/.test(l)), 3000);
  hc.close();
});

test('leaving: lobby seats are freed, game seats go to a bot, empty rooms close', async () => {
  const host = await room();
  const bob = (await post('join', { code: host.code, name: 'Bob' })).body;
  assert.strictEqual((await post('leave', { code: host.code, token: bob.token })).status, 200);
  assert.strictEqual(server.rooms.get(host.code).players.length, 1);
  const carl = (await post('join', { code: host.code, name: 'Carl' })).body;
  await post('start', { code: host.code, token: host.token });
  await post('leave', { code: host.code, token: host.token }); // host leaves mid-game
  const r = server.rooms.get(host.code);
  assert.strictEqual(r.players[0].bot, true);
  assert.strictEqual(r.state.players[0].bot, true);
  assert.strictEqual(r.host, r.players[1], 'Carl is the new host');
  await post('leave', { code: host.code, token: carl.token });
  assert.ok(!server.rooms.has(host.code), 'no humans left: room closed');
});

test('replace only takes over seats that are offline, and closes their stream', async () => {
  const host = await room();
  const bob = (await post('join', { code: host.code, name: 'Bob' })).body;
  const bc = await sse(host.code, bob.token).ready;
  await bc.waitFor(m => m.lobby[1].connected);
  await post('start', { code: host.code, token: host.token });
  assert.strictEqual((await post('replace', { code: host.code, token: host.token, index: 1 })).status, 400);
  bc.close();
  assert.ok(await until(() => !server.rooms.get(host.code).players[1].streams.size));
  assert.strictEqual((await post('replace', { code: host.code, token: host.token, index: 1 })).status, 200);
  assert.strictEqual((await post('ping', { code: host.code, token: bob.token })).status, 403);
});

test('room creation is rate limited and a full server evicts abandoned rooms', async () => {
  cfg.MAX_ROOMS = server.rooms.size + 2;
  for (let i = 0; i < 4; i++) assert.strictEqual((await post('create', { name: 'R' + i })).status, 200);
  assert.ok(server.rooms.size <= cfg.MAX_ROOMS);
  server.buckets.clear();
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post('create', { name: 'S' })).status);
  assert.ok(codes.slice(0, 8).every(c => c === 200));
  assert.strictEqual(codes[codes.length - 1], 429);
});

test('event stream: unknown seats get 404, known ones a retry hint and a snapshot', async () => {
  const host = await room();
  const bad = await sse(host.code, 'nope').ready;
  assert.strictEqual(bad.status, 404);
  const c = await sse(host.code.toLowerCase(), host.token).ready;
  const m = await c.waitFor(x => x.code === host.code);
  assert.strictEqual(m.host, true);
  assert.strictEqual(m.game, null);
  c.close();
});
