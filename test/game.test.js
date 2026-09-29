const test = require('node:test');
const assert = require('node:assert');
const Coup = require('../public/game.js');
const { botMove, botReact } = require('../bot.js');

const mk = n => Coup.create(Array.from({ length: n }, (_, i) => ({ name: 'P' + i })));

test('setup: 2 cards, 2 coins, 15-card deck', () => {
  const s = mk(4);
  assert.strictEqual(s.deck.length, 15 - 8);
  s.players.forEach(p => { assert.strictEqual(p.coins, 2); assert.strictEqual(p.cards.length, 2); });
});

test('view hides opponents cards', () => {
  const v = Coup.view(mk(3), 0);
  assert.ok(v.players[0].cards.every(c => c.c));
  assert.ok(v.players[1].cards.every(c => c.c === null));
});

test('tax with no challenge gives 3 coins', () => {
  const s = mk(3), t = s.turn;
  Coup.act(s, t, { type: 'action', action: 'tax' }, 0);
  assert.strictEqual(s.phase, 'window');
  assert.ok(!Coup.tick(s, 5000));
  assert.ok(Coup.tick(s, 10001));
  assert.strictEqual(s.players[t].coins, 5);
  assert.notStrictEqual(s.turn, t);
});

test('must coup at 10 coins; coup costs 7', () => {
  const s = mk(3), t = s.turn, o = (t + 1) % 3;
  s.players[t].coins = 10;
  assert.ok(Coup.act(s, t, { type: 'action', action: 'income' }).error);
  Coup.act(s, t, { type: 'action', action: 'coup', target: o });
  assert.strictEqual(s.players[t].coins, 3);
  assert.strictEqual(s.phase, 'lose');
});

test('failed bluff challenge costs the bluffer, assassin coins refunded', () => {
  const s = mk(3), t = s.turn, o = (t + 1) % 3;
  s.players[t].coins = 3; s.players[t].cards = [{ c: 'duke' }, { c: 'duke' }].map(c => ({ ...c, dead: false }));
  Coup.act(s, t, { type: 'action', action: 'assassinate', target: o });
  assert.ok(Coup.act(s, t, { type: 'challenge' }).error);
  Coup.act(s, o, { type: 'challenge' });
  assert.strictEqual(s.phase, 'lose');
  assert.strictEqual(s.lose.player, t);
  Coup.act(s, t, { type: 'lose', index: 0 });
  assert.strictEqual(s.players[t].coins, 3);
  assert.strictEqual(s.phase, 'action');
});

test('bots can play whole games to completion', () => {
  for (let n = 2; n <= 6; n++) {
    const s = mk(n);
    let steps = 0;
    let now = 0;
    while (s.phase !== 'over' && steps++ < 5000) {
      if (s.phase === 'window') {
        for (const p of s.players) { const m = s.phase === 'window' && p.alive && botReact(s, p.id); if (m) assert.ok(!Coup.act(s, p.id, m, now).error); }
        now += 20000; Coup.tick(s, now);
        continue;
      }
      const id = Coup.waitingOn(s)[0];
      const r = Coup.act(s, id, botMove(s, id), now);
      assert.ok(!r.error, r.error + ' in ' + s.phase);
    }
    assert.strictEqual(s.phase, 'over', `game with ${n} did not finish`);
  }
});

test('block during window: only target can block steal; actor accepts to end block', () => {
  const s = mk(3), t = s.turn, o = (t + 1) % 3, x = (t + 2) % 3;
  Coup.act(s, t, { type: 'action', action: 'steal', target: o }, 0);
  assert.deepStrictEqual(Coup.reactions(s, x).block, []);
  assert.ok(Coup.reactions(s, x).challenge);
  assert.ok(Coup.act(s, o, { type: 'block', char: 'captain' }, 0).ok);
  assert.strictEqual(s.pending.stage, 'bchallenge');
  Coup.act(s, t, { type: 'accept' }, 0);
  assert.strictEqual(s.players[o].coins, 2);
  assert.strictEqual(s.phase, 'action');
});

test('everyone saying No resolves the window immediately', () => {
  const s = mk(3), t = s.turn;
  Coup.act(s, t, { type: 'action', action: 'tax' }, 0);
  const rest = [1, 2].map(k => (t + k) % 3);
  Coup.act(s, rest[0], { type: 'pass' }, 0);
  assert.strictEqual(s.phase, 'window');
  Coup.act(s, rest[1], { type: 'pass' }, 0);
  assert.strictEqual(s.players[t].coins, 5);
});
