// Unit tests for the shared chat module (chat-server.js): auth, validation, rate limit, history, fan-out.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const createChat = require('../chat-server.js');

const rooms = new Map();
const room = { players: [{ name: 'Ann', token: 'tok-ann' }, { name: 'Bo', token: 'tok-bo' }] };
rooms.set('ABCD', room);
const chat = createChat({
  room: code => rooms.get(code),
  who: (r, token) => (r.players.find(p => p.token === token) || {}).name || null,
  burst: 3, perSec: 0.0001, // tiny refill so the rate limit is easy to hit
});
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (chat.handle(req, res, url)) return;
  res.writeHead(404); res.end();
});
let B;
test.before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); B = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.closeAllConnections?.(); server.close(); });

const post = (b) => fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, ...(await r.json()) }));

// One long-lived stream that collects events.
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
const until = async (fn, ms = 1500) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 15)); } return false; };

test('strangers cannot read or write; seated players can', async () => {
  assert.strictEqual((await listen('ABCD', 'nope')).status, 404);
  assert.strictEqual((await listen('ZZZZ', 'tok-ann')).status, 404);
  assert.strictEqual((await post({ code: 'ABCD', token: 'nope', text: 'hi' })).status, 403);
  assert.strictEqual((await post({ code: 'ABCD', text: 'hi' })).status, 403);
  assert.strictEqual((await post({ code: 'abcd', token: 'tok-ann', text: 'lowercase code works' })).status, 200);
});

test('messages reach every seat with a stable per-player key; new joiners get the history', async () => {
  const a = await listen('ABCD', 'tok-ann'), b = await listen('ABCD', 'tok-bo');
  assert.ok(await until(() => a.events.some(e => e.event === 'log') && b.events.some(e => e.event === 'log')));
  const helloA = a.events.find(e => e.event === 'hello').data, helloB = b.events.find(e => e.event === 'hello').data;
  assert.notStrictEqual(helloA.you, helloB.you);
  assert.ok(!JSON.stringify(helloA).includes('tok-ann'), 'the token is never echoed');
  assert.deepStrictEqual(a.events.find(e => e.event === 'log').data.map(m => m.text), ['lowercase code works'], 'history replay');
  assert.strictEqual((await post({ code: 'ABCD', token: 'tok-bo', text: '  hello   there  ' })).status, 200);
  assert.ok(await until(() => a.events.some(e => e.event === 'msg') && b.events.some(e => e.event === 'msg')));
  const m = a.events.find(e => e.event === 'msg').data;
  assert.strictEqual(m.text, 'hello there'); assert.strictEqual(m.from, 'Bo'); assert.strictEqual(m.key, helloB.you);
  assert.ok(m.n >= 2 && m.at > 0);
  a.stop(); b.stop();
});

test('validation: emote whitelist, empty text, length cap, control and bidi characters', async () => {
  const fresh = { players: [{ name: 'Cy', token: 'tok-cy' }] };
  rooms.set('WXYZ', fresh);
  const c = createChat({ room: code => rooms.get(code), who: (r, t) => (r.players.find(p => p.token === t) || {}).name || null, burst: 100 });
  const long = 'x'.repeat(500);
  const r1 = c.add(fresh, 'k', 'Cy', { text: long }); assert.strictEqual(r1.msg.text.length, 200);
  assert.strictEqual(c.add(fresh, 'k', 'Cy', { text: '   ' }).error, 'Empty message');
  assert.strictEqual(c.add(fresh, 'k', 'Cy', { emote: '<script>' }).error, 'Unknown emote');
  assert.strictEqual(c.add(fresh, 'k', 'Cy', {}).error, 'Empty message');
  assert.strictEqual(c.add(fresh, 'k', 'Cy', { emote: '🔥' }).msg.emote, '🔥');
  const sneaky = c.add(fresh, 'k', 'Cy', { text: 'a‮b\u0000c​d\nline' }).msg.text;
  assert.strictEqual(sneaky, 'a b c d line', 'bidi override, NUL, zero-width and newlines are neutralised');
  assert.strictEqual(c.add(fresh, 'k', 'Cy', { text: '<img src=x onerror=alert(1)>' }).msg.text, '<img src=x onerror=alert(1)>', 'stored verbatim: clients render with textContent');
  assert.strictEqual(c.log(fresh).length, 4, "rejected messages are never stored");
  for (let i = 0; i < 80; i++) c.add(fresh, 'k', 'Cy', { text: 'm' + i });
  assert.strictEqual(c.log(fresh).length, 50, 'history is capped');
  assert.strictEqual(createChat.EMOTES.length, 12);
});

test('rate limit: a burst is allowed, then 429, and one player cannot throttle another', async () => {
  const solo = { players: [{ name: 'Di', token: 'tok-di' }, { name: 'Ed', token: 'tok-ed' }] };
  rooms.set('RATE', solo);
  const r = [];
  for (let i = 0; i < 5; i++) r.push((await post({ code: 'RATE', token: 'tok-di', text: 'spam' + i })).status);
  assert.deepStrictEqual(r, [200, 200, 200, 429, 429]);
  assert.strictEqual((await post({ code: 'RATE', token: 'tok-ed', text: 'still fine' })).status, 200);
});

test('bad requests do not crash the server', async () => {
  const r1 = await fetch(B + '/api/chat', { method: 'POST', body: '{nope' });
  assert.strictEqual(r1.status, 400);
  const r2 = await fetch(B + '/api/chat', { method: 'POST', body: 'x'.repeat(5000) }).catch(() => ({ status: 'closed' }));
  assert.ok(r2.status === 413 || r2.status === 'closed');
  assert.strictEqual((await post({ code: 'ABCD', token: 'tok-ann', text: 'alive' })).status, 200);
  assert.strictEqual(createChat.clean('  a  b  '), 'a b');
});
