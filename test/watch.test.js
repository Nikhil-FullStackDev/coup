// Spectators: a late joiner (room full, or game already running) can watch with a public view, chat, and nothing else.
const test = require('node:test');
const assert = require('node:assert');
const server = require('../server.js');

let B;
test.before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); B = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.closeAllConnections?.(); server.close(); });

const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
// Reads an SSE stream: plain `data:` frames go to snaps, named events (chat) go to events.
async function stream(path) {
  const ctl = new AbortController();
  const res = await fetch(B + path, { signal: ctl.signal });
  const out = { status: res.status, snaps: [], events: [], stop: () => ctl.abort() };
  if (res.status !== 200) return out;
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await rd.read(); if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block), da = /^data: (.*)$/m.exec(block);
          if (!da) continue;
          if (ev) out.events.push({ event: ev[1], data: JSON.parse(da[1]) }); else out.snaps.push(JSON.parse(da[1]));
        }
      }
    } catch { /* aborted */ }
  })();
  return out;
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 15)); } return false; };

test('a late joiner can watch: public view, can chat, cannot play', async () => {
  const host = await post('/api/create', { name: 'Host' });
  assert.ok(host.code && host.token, 'room created');
  const room = { code: host.code, token: host.token };
  const hs = await stream(`/api/events?code=${room.code}&token=${room.token}`);
  assert.ok(await until(() => hs.snaps.length >= 1));

  // Fill every seat with bots.
  let seats = 1;
  for (;;) { const r = await post('/api/addbot', room); if (r.status !== 200) break; seats++; }
  assert.ok(seats >= 2, 'room fills up');

  // A full room refuses the join, and says watching is possible.
  const refused = await post('/api/join', { name: 'Late', code: room.code });
  assert.strictEqual(refused.status, 400);
  assert.strictEqual(refused.watch, true, 'refusal offers watching');

  // Watching from the lobby.
  const w = await post('/api/join', { name: 'Late', code: room.code, watch: true });
  assert.strictEqual(w.status, 200);
  assert.ok(w.token && w.token !== room.token && w.watch === true);
  const ws = await stream(`/api/events?code=${room.code}&token=${w.token}`);
  assert.strictEqual(ws.status, 200);
  assert.ok(await until(() => ws.snaps.length >= 1));
  const first = ws.snaps[0];
  assert.strictEqual(first.you, -1); assert.strictEqual(first.watch, true); assert.strictEqual(first.host, false);
  assert.strictEqual(first.game, null, 'no game yet');
  assert.strictEqual(first.lobby.length, seats);
  assert.ok(await until(() => hs.snaps.some(s => s.watching === 1)), 'players see that somebody is watching');

  // The game starts: the spectator gets the public view.
  assert.strictEqual((await post('/api/start', room)).status, 200);
  assert.ok(await until(() => ws.snaps.some(s => s.game)), 'spectator receives the game');
  const g = ws.snaps.filter(s => s.game).pop();
  assert.strictEqual(g.you, -1);
  const raw = JSON.stringify(g);
  assert.ok(!raw.includes(room.token) && !raw.includes(w.token), 'no tokens in a frame');

  // Joining after the start is refused (with the watch offer) but watching is still open.
  const late = await post('/api/join', { name: 'Later', code: room.code });
  assert.strictEqual(late.status, 400); assert.strictEqual(late.watch, true);
  const w2 = await post('/api/join', { name: 'Later', code: room.code, watch: true });
  assert.strictEqual(w2.status, 200);
  assert.ok(await until(() => hs.snaps.some(s => s.watching === 1)));

  // A spectator token is not a seat.
  const as = { code: room.code, token: w.token };
  for (const path of ['/api/move', '/api/start', '/api/restart', '/api/addbot', '/api/kick', '/api/replace', '/api/react', '/api/settings', '/api/lobby']) {
    const r = await post(path, { ...as, index: 1, move: {}, e: '👍' });
    assert.strictEqual(r.status, 403, `${path} must refuse a spectator (got ${r.status})`);
  }
  assert.strictEqual((await post('/api/ping', as)).status, 200, 'a spectator can ping (stay connected)');

  // Chat works, marked with an eye.
  assert.strictEqual((await post('/api/chat', { ...as, text: 'hello from the stands' })).status, 200);
  const cs = await stream(`/api/chat/events?code=${room.code}&token=${room.token}`);
  assert.ok(await until(() => cs.events.some(e => e.event === 'log' && e.data.some(m => m.text === 'hello from the stands' && /^👁 Late/.test(m.from)))), 'spectator chat is visible, labelled');
  cs.stop();

  // Leaving removes the spectator.
  assert.strictEqual((await post('/api/leave', as)).status, 200);
  assert.ok(await until(() => hs.snaps[hs.snaps.length - 1].watching === 0), 'the count drops when the spectator leaves');
  assert.strictEqual((await post('/api/ping', as)).status, 403, 'a spectator who left is no longer known');
  hs.stop(); ws.stop();
});

test('spectators are capped', async () => {
  const host = await post('/api/create', { name: 'Host' });
  let last;
  for (let i = 0; i < 31; i++) { server.buckets?.clear(); last = await post('/api/join', { name: 'W' + i, code: host.code, watch: true }); } // (joins are rate limited per IP)
  assert.strictEqual(last.status, 400, 'the 31st spectator is refused');
});
