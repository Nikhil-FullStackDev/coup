// Chat inside a real room of this game: two seated players talk, strangers cannot, and chat leaves the game alone.
const test = require('node:test');
const assert = require('node:assert');
const server = require('../server.js');

let B;
test.before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); B = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.closeAllConnections?.(); server.close(); });

const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
async function listen(code, token) {
  const ctl = new AbortController();
  const res = await fetch(`${B}/api/chat/events?code=${code}&token=${token}`, { signal: ctl.signal });
  const out = { status: res.status, events: [], stop: () => ctl.abort() };
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
          if (ev && da) out.events.push({ event: ev[1], data: JSON.parse(da[1]) });
        }
      }
    } catch { /* aborted */ }
  })();
  return out;
}
const until = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 15)); } return false; };

test('chat works between two seated players of this game', async () => {
  const host = await post('/api/create', { name: 'Host' });
  assert.ok(host.code && host.token, 'room created');
  const guest = await post('/api/join', { name: 'Guest', code: host.code });
  assert.ok(guest.token, 'guest joined');
  const a = await listen(host.code, host.token), b = await listen(host.code, guest.token);
  assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200);
  assert.ok(await until(() => a.events.some(e => e.event === 'hello') && b.events.some(e => e.event === 'hello')));

  assert.strictEqual((await post('/api/chat', { code: host.code, token: host.token, text: 'hello from host' })).status, 200);
  assert.ok(await until(() => b.events.some(e => e.event === 'msg' && e.data.text === 'hello from host')), 'guest receives it');
  assert.strictEqual((await post('/api/chat', { code: host.code, token: guest.token, emote: '🔥' })).status, 200);
  assert.ok(await until(() => a.events.some(e => e.event === 'msg' && e.data.emote === '🔥')), 'host receives the emote');
  const m = a.events.find(e => e.event === 'msg' && e.data.emote === '🔥').data;
  assert.strictEqual(m.from, 'Guest');
  assert.strictEqual((await post('/api/chat', { code: host.code, token: guest.token, emote: 'not-an-emote' })).status, 400);

  // strangers: no stream, no posting; and the game itself still answers
  assert.strictEqual((await listen(host.code, 'bogus-token')).status, 404);
  assert.strictEqual((await post('/api/chat', { code: host.code, token: 'bogus-token', text: 'let me in' })).status, 403);
  assert.strictEqual((await fetch(B + '/healthz')).status, 200);

  // a player who joins later gets the history
  const late = await post('/api/join', { name: 'Late', code: host.code });
  if (late.token) {
    const c = await listen(host.code, late.token);
    assert.ok(await until(() => c.events.some(e => e.event === 'log')));
    assert.ok(c.events.find(e => e.event === 'log').data.length >= 2, 'history replayed to a late joiner');
    c.stop();
  }
  a.stop(); b.stop();
});
