// Presence: a player who just joined, or whose stream blipped, is not shown as offline.
const test = require('node:test');
const assert = require('node:assert');
const server = require('../server.js');

let B;
test.before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); B = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.closeAllConnections?.(); server.close(); });

const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
async function stream(code, token) {
  const ctl = new AbortController();
  const res = await fetch(`${B}/api/events?code=${code}&token=${token}`, { signal: ctl.signal });
  const out = { snaps: [], stop: () => ctl.abort() };
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
          const da = /^data: (.*)$/m.exec(block);
          if (da) out.snaps.push(JSON.parse(da[1]));
        }
      }
    } catch { /* aborted */ }
  })();
  return out;
}
const until = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 15)); } return false; };

test('a fresh joiner is online in the lobby before their stream opens, and a dropped stream is a grace, not an instant offline', async () => {
  const host = await post('/api/create', { name: 'Host' });
  const h = await stream(host.code, host.token);
  assert.ok(await until(() => h.snaps.length >= 1));
  const guest = await post('/api/join', { name: 'Guest', code: host.code });
  assert.ok(guest.token);
  // The host sees the new seat with the guest's stream not opened yet: must read as connected.
  assert.ok(await until(() => h.snaps.some(s => s.lobby.length === 2)));
  const joined = h.snaps.filter(s => s.lobby.length === 2);
  assert.ok(joined.every(s => s.lobby[1].connected === true), 'joiner shown offline before their stream opened');
  // Their stream opens and then drops (a network blip): still shown connected during the grace.
  const g = await stream(host.code, guest.token);
  assert.ok(await until(() => g.snaps.length >= 1));
  const before = h.snaps.length;
  g.stop();
  assert.ok(await until(() => h.snaps.length > before));
  assert.strictEqual(h.snaps[h.snaps.length - 1].lobby[1].connected, true, 'blip flashed offline');
  h.stop();
});
