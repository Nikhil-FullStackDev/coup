const test = require('node:test');
const assert = require('node:assert');
const Coup = require('../public/game.js');
const { botMove, botReact } = require('../bot.js');

const mk = (n, opts) => Coup.create(Array.from({ length: n }, (_, i) => ({ name: 'P' + i })), opts);
const hand = (...cs) => cs.map(c => ({ c, dead: false }));
// Put a fixed game in place: player `turn` to act, given hands (cards taken from a fresh deck are irrelevant here).
function setup(n, turn, hands, opts) {
  const s = mk(n, opts);
  s.turn = turn; s.players.forEach(p => { p.coins = 2; });
  hands.forEach((h, i) => { if (h) s.players[i].cards = hand(...h); });
  // keep the 15-card / 3-each invariant: rebuild the deck from what is not in hands
  const left = [];
  Coup.CHARS.forEach(c => { for (let k = 0; k < 3; k++) left.push(c); });
  s.players.forEach(p => p.cards.forEach(x => left.splice(left.indexOf(x.c), 1)));
  s.deck = left;
  return s;
}
function allCards(s) {
  const all = [...s.deck];
  s.players.forEach(p => p.cards.forEach(c => all.push(c.c)));
  if (s.exch) all.push(...s.exch.options);
  return all;
}
function assertConserved(s) {
  const all = allCards(s);
  assert.strictEqual(all.length, 15, 'card count');
  for (const c of Coup.CHARS) assert.strictEqual(all.filter(x => x === c).length, 3, 'copies of ' + c);
}

test('setup: 2 cards, 2 coins, 15-card deck', () => {
  const s = mk(4);
  assert.strictEqual(s.deck.length, 15 - 8);
  s.players.forEach(p => { assert.strictEqual(p.coins, 2); assert.strictEqual(p.cards.length, 2); });
});

test('2-player game: the starting player gets only 1 coin', () => {
  for (let i = 0; i < 10; i++) {
    const s = mk(2);
    assert.strictEqual(s.players[s.turn].coins, 1);
    assert.strictEqual(s.players[1 - s.turn].coins, 2);
  }
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
  s.players[t].coins = 3; s.players[t].cards = hand('duke', 'duke');
  Coup.act(s, t, { type: 'action', action: 'assassinate', target: o });
  assert.ok(Coup.act(s, t, { type: 'challenge' }).error);
  Coup.act(s, o, { type: 'challenge' });
  assert.strictEqual(s.phase, 'lose');
  assert.strictEqual(s.lose.player, t);
  Coup.act(s, t, { type: 'lose', index: 0 });
  assert.strictEqual(s.players[t].coins, 3);
  assert.strictEqual(s.phase, 'action');
});

test('bots play whole games to completion (one reaction per window, windows expire on the clock)', () => {
  for (let n = 2; n <= 6; n++) {
    const s = mk(n, { now: 0 });
    let steps = 0, now = 0, reacted = -1;
    while (s.phase !== 'over' && steps++ < 5000) {
      if (s.phase === 'window') {
        if (reacted !== s.stageNo) { // like the server: every bot decides once per window
          reacted = s.stageNo;
          for (const p of s.players) {
            const m = s.phase === 'window' && reacted === s.stageNo && p.alive && botReact(s, p.id);
            if (m) assert.ok(!Coup.act(s, p.id, m, now).error);
          }
          continue;
        }
        now += 10000; // exactly windowMs later: deadlines were set with the injected clock
        assert.ok(Coup.tick(s, now), 'window should expire at its deadline');
        continue;
      }
      const id = Coup.waitingOn(s)[0];
      const r = Coup.act(s, id, botMove(s, id), now);
      assert.ok(!r.error, r.error + ' in ' + s.phase);
      assertConserved(s);
    }
    assert.strictEqual(s.phase, 'over', `game with ${n} did not finish`);
    assert.strictEqual(s.players.filter(p => p.alive).length, 1);
    assert.ok(s.players[s.winner].alive);
  }
});

test('steal: challenge stage, then only target may block; No from all ends block stage', () => {
  const s = mk(3), t = s.turn, o = (t + 1) % 3, x = (t + 2) % 3;
  Coup.act(s, t, { type: 'action', action: 'steal', target: o }, 0);
  assert.strictEqual(s.pending.stage, 'claim');
  assert.ok(Coup.act(s, o, { type: 'block' }, 0).error);
  Coup.act(s, o, { type: 'pass' }, 0); Coup.act(s, x, { type: 'pass' }, 0);
  assert.strictEqual(s.pending.stage, 'block');
  assert.ok(!Coup.reactions(s, x).block);
  assert.ok(Coup.act(s, o, { type: 'block', as: 'captain' }, 0).ok);
  assert.strictEqual(s.pending.stage, 'bchallenge');
  Coup.act(s, t, { type: 'pass' }, 0); Coup.act(s, x, { type: 'pass' }, 0);
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

// ---------- validation ----------
test('prototype keys are not actions', () => {
  const s = mk(3), t = s.turn;
  for (const action of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const r = Coup.act(s, t, { type: 'action', action });
    assert.strictEqual(r.error, 'Bad action', action);
  }
  assert.strictEqual(s.turn, t);
  assert.strictEqual(s.phase, 'action');
  assert.ok(Coup.act(s, t, null).error);
  assert.ok(Coup.act(s, t, 'income').error);
});

test('exchange keep indexes must be distinct integers in range', () => {
  const s = setup(3, 0, [['ambassador', 'duke'], ['captain', 'captain'], ['contessa', 'assassin']]);
  Coup.act(s, 0, { type: 'action', action: 'exchange' }, 0);
  Coup.tick(s, 1e6);
  assert.strictEqual(s.phase, 'exchange');
  for (const keep of [[0.5, 1], [0, 0], ['0', '1'], [-1, 0], [0, 4], [0], [0, 1, 2], 'xx', null, [NaN, 1], [0, Infinity]]) {
    assert.ok(Coup.act(s, 0, { type: 'keep', keep }).error, JSON.stringify(keep));
    assertConserved(s);
  }
  const opts = s.exch.options.slice();
  assert.ok(Coup.act(s, 0, { type: 'keep', keep: [3, 1] }).ok);
  assert.deepStrictEqual(s.players[0].cards.map(c => c.c), [opts[3], opts[1]]);
  assert.strictEqual(s.deck.length, 15 - 6);
  assertConserved(s);
});

test('lose index must be an integer pointing at a live card', () => {
  const s = setup(3, 1, [['duke', 'captain'], null, null]);
  s.players[1].coins = 7;
  Coup.act(s, 1, { type: 'action', action: 'coup', target: 0 });
  assert.strictEqual(s.phase, 'lose');
  for (const index of [0.5, '0', -1, 2, null, undefined, NaN]) assert.ok(Coup.act(s, 0, { type: 'lose', index }).error, String(index));
  assert.ok(Coup.act(s, 0, { type: 'lose', index: 1 }).ok);
  assert.ok(s.players[0].cards[1].dead);
});

// ---------- clock ----------
test('deadlines use the injected clock in every path (expire, pass, resume)', () => {
  const s = setup(3, 0, [['captain', 'duke'], ['assassin', 'contessa'], ['duke', 'ambassador']]);
  Coup.act(s, 0, { type: 'action', action: 'steal', target: 1 }, 0);
  assert.strictEqual(s.pending.deadline, 10000);
  Coup.tick(s, 10000); // claim window expires -> block window opened at t=10000
  assert.strictEqual(s.pending.stage, 'block');
  assert.strictEqual(s.pending.deadline, 20000);

  const s2 = setup(3, 0, [['captain', 'duke'], ['assassin', 'contessa'], ['duke', 'ambassador']]);
  Coup.act(s2, 0, { type: 'action', action: 'steal', target: 1 }, 0);
  Coup.act(s2, 1, { type: 'pass' }, 5000);
  Coup.act(s2, 2, { type: 'pass' }, 5000); // everyone said No at t=5000
  assert.strictEqual(s2.pending.deadline, 15000);

  // challenge fails -> challenger loses a card -> resume opens the block window at that moment
  const s3 = setup(3, 0, [['captain', 'duke'], ['assassin', 'contessa'], ['duke', 'ambassador']]);
  Coup.act(s3, 0, { type: 'action', action: 'steal', target: 1 }, 0);
  Coup.act(s3, 2, { type: 'challenge' }, 3000);
  assert.strictEqual(s3.phase, 'lose');
  Coup.act(s3, 2, { type: 'lose', index: 0 }, 7000);
  assert.strictEqual(s3.pending.stage, 'block');
  assert.strictEqual(s3.pending.deadline, 17000);
  assertConserved(s3);
});

test('turn timer auto-plays a stalled decision with a safe move', () => {
  // action: Income
  const s = setup(3, 0, [['duke', 'captain'], ['assassin', 'contessa'], ['duke', 'ambassador']], { turnMs: 60000, now: 0 });
  s.decideBy = 60000;
  assert.ok(!Coup.tick(s, 59999));
  assert.ok(Coup.tick(s, 60000));
  assert.strictEqual(s.players[0].coins, 3);
  assert.strictEqual(s.turn, 1);
  assert.match(s.log.join('\n'), /P0 ran out of time/);
  assert.strictEqual(s.decideBy, 120000, 'next player gets a fresh deadline');

  // 10+ coins: forced Coup on the next living player
  s.players[1].coins = 10;
  Coup.tick(s, 120000);
  assert.strictEqual(s.pending.action, 'coup');
  assert.strictEqual(s.phase, 'lose');
  assert.strictEqual(s.lose.player, 2);
  // lose: first live card goes
  Coup.tick(s, 180000);
  assert.ok(s.players[2].cards[0].dead);
  assert.strictEqual(s.phase, 'action');

  // exchange: keep the cards you had
  const e = setup(3, 0, [['ambassador', 'duke'], ['assassin', 'contessa'], ['captain', 'captain']], { turnMs: 60000, now: 0 });
  Coup.act(e, 0, { type: 'action', action: 'exchange' }, 0);
  Coup.tick(e, 10000);
  assert.strictEqual(e.phase, 'exchange');
  assert.strictEqual(e.decideBy, 70000);
  Coup.tick(e, 70000);
  assert.deepStrictEqual(e.players[0].cards.map(c => c.c), ['ambassador', 'duke']);
  assertConserved(e);

  // no timer configured -> never auto-plays
  const n = mk(3, { now: 0 });
  assert.ok(!Coup.tick(n, 1e12));
});

test('safeMove (absent humans) never claims a character and is always legal', () => {
  const s = setup(3, 1, [['duke', 'captain'], ['contessa', 'ambassador'], ['assassin', 'duke']]);
  s.players[1].coins = 3;
  assert.deepStrictEqual(Coup.safeMove(s, 1), { type: 'action', action: 'income' });
  assert.strictEqual(Coup.safeMove(s, 0), null, 'not their decision');
  s.players[1].coins = 10;
  assert.deepStrictEqual(Coup.safeMove(s, 1), { type: 'action', action: 'coup', target: 2 });
  for (let i = 0; i < 100; i++) {
    const g = mk(2 + (i % 5));
    for (let k = 0; k < 400 && g.phase !== 'over'; k++) {
      const id = Coup.waitingOn(g)[0], m = Coup.safeMove(g, id);
      assert.ok(m && !(m.type === 'action' && Coup.ACTIONS[m.action].claim), 'no character claim: ' + JSON.stringify(m));
      assert.ok(!Coup.act(g, id, m).error, 'legal: ' + JSON.stringify(m));
    }
    assert.strictEqual(g.phase, 'over');
    assertConserved(g);
  }
});

// ---------- rules flows ----------
test('steal block names one character, and a challenge checks that one', () => {
  // target holds Captain but blocks claiming Ambassador: that is a bluff
  const s = setup(3, 0, [['captain', 'duke'], ['captain', 'contessa'], ['duke', 'assassin']]);
  Coup.act(s, 0, { type: 'action', action: 'steal', target: 1 }, 0);
  Coup.tick(s, 10000);
  assert.ok(Coup.act(s, 1, { type: 'block', as: 'duke' }, 10000).error);
  assert.ok(Coup.act(s, 1, { type: 'block', as: 'ambassador' }, 10000).ok);
  assert.deepStrictEqual(s.pending.block.chars, ['ambassador']);
  Coup.act(s, 0, { type: 'challenge' }, 11000);
  assert.match(s.log.join('\n'), /P1 was bluffing/);
  assert.strictEqual(s.phase, 'lose'); // P1 picks a card, then the steal goes through
  Coup.act(s, 1, { type: 'lose', index: 1 });
  assert.strictEqual(s.players[0].coins, 4);
  assert.strictEqual(s.players[1].coins, 0);
  assertConserved(s);
});

test('Contessa bluff after a failed challenge costs both influences', () => {
  const s = setup(3, 0, [['assassin', 'duke'], ['duke', 'captain'], ['contessa', 'ambassador']]);
  s.players[0].coins = 3;
  Coup.act(s, 0, { type: 'action', action: 'assassinate', target: 1 }, 0);
  Coup.act(s, 1, { type: 'challenge' }, 1000); // P0 really has the Assassin
  assert.strictEqual(s.lose.player, 1);
  Coup.act(s, 1, { type: 'lose', index: 0 }, 2000);
  assert.strictEqual(s.pending.stage, 'block'); // P1 may still block with (a claimed) Contessa
  Coup.act(s, 1, { type: 'block' }, 3000);
  Coup.act(s, 0, { type: 'challenge' }, 4000);
  assert.ok(!s.players[1].alive);
  assert.strictEqual(s.players[0].coins, 0);
  assertConserved(s);
});

test('a Duke block of Foreign Aid can be challenged', () => {
  const s = setup(3, 0, [['captain', 'assassin'], ['duke', 'contessa'], ['ambassador', 'captain']]);
  Coup.act(s, 0, { type: 'action', action: 'aid' }, 0);
  assert.ok(Coup.reactions(s, 2).block, 'anyone may block Foreign Aid');
  Coup.act(s, 1, { type: 'block' }, 0);
  assert.deepStrictEqual(s.pending.block.chars, ['duke']);
  Coup.act(s, 0, { type: 'challenge' }, 0); // P1 has the Duke: the challenger loses
  assert.strictEqual(s.lose.player, 0);
  Coup.act(s, 0, { type: 'lose', index: 0 });
  assert.strictEqual(s.players[0].coins, 2, 'aid was blocked');
  assert.strictEqual(s.turn, 1);
  assertConserved(s);
});

test('view exposes the public log, a timer and no hidden cards', () => {
  const s = setup(3, 0, [['captain', 'duke'], ['assassin', 'contessa'], ['duke', 'ambassador']], { turnMs: 60000, now: 0 });
  Coup.act(s, 0, { type: 'action', action: 'tax' }, 0);
  Coup.act(s, 1, { type: 'challenge' }, 100);
  const v = Coup.view(s, 2, 100);
  assert.ok(v.log.some(l => /P1 challenges P0's Duke/.test(l)));
  assert.ok(v.log.some(l => /P0 shows Duke — challenge fails/.test(l)));
  assert.ok(v.logNo >= v.log.length);
  assert.deepStrictEqual(v.timer && v.timer.kind, 'turn'); // P1 must pick a card to lose
  assert.ok(v.players[0].cards.every(c => c.c === null), 'P0 reshuffled; still hidden');
  const w = Coup.view(setup(3, 0, [['duke', 'duke'], null, null]), 1, 0);
  assert.strictEqual(w.timer, null);
});

test('random play keeps every invariant (cards, coins, winner, hidden info)', () => {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const junk = () => pick([{}, { type: 'challenge' }, { type: 'block', as: 'duke' }, { type: 'pass' },
    { type: 'action', action: pick([...Object.keys(Coup.ACTIONS), 'constructor']), target: Math.floor(Math.random() * 7) - 1 },
    { type: 'lose', index: pick([0, 1, 0.5, '1']) }, { type: 'keep', keep: pick([[0, 1], [0.5, 1], [1, 1], [2]]) }]);
  for (let g = 0; g < 300; g++) {
    const n = 2 + (g % 5), s = mk(n, { now: 0, turnMs: 60000 });
    let now = 0, k = 0;
    while (s.phase !== 'over' && k++ < 4000) {
      const who = Math.floor(Math.random() * n), r = Math.random();
      if (r < 0.3) Coup.act(s, who, junk(), now);
      else if (s.phase === 'window') Coup.act(s, who, botReact(s, who) || { type: 'pass' }, now);
      else { const w = Coup.waitingOn(s)[0]; assert.ok(!Coup.act(s, w, botMove(s, w), now).error); }
      if (Math.random() < 0.2) { now += 11000; Coup.tick(s, now); }
      assertConserved(s);
      s.players.forEach(p => { assert.ok(p.coins >= 0); if (s.phase !== 'exchange') assert.strictEqual(p.alive, p.cards.some(c => !c.dead)); });
      const v = Coup.view(s, who, now);
      v.players.forEach(q => { if (q.id !== who) q.cards.forEach((c, i) => assert.ok(!c.c || s.players[q.id].cards[i].dead, 'leak')); });
      if (v.exch && s.exch.player !== who) assert.strictEqual(v.exch.options, undefined);
    }
    assert.strictEqual(s.phase, 'over');
    assert.strictEqual(s.players.filter(p => p.alive).length, 1);
  }
});

// ---------- bots ----------
test('bots always challenge a claim whose every copy is face up', () => {
  for (let i = 0; i < 30; i++) {
    const s = setup(4, 0, [['captain', 'assassin'], ['duke', 'contessa'], ['duke', 'ambassador'], ['duke', 'captain']]);
    s.players.slice(1).forEach(p => { p.cards[0].dead = true; }); // all three Dukes revealed
    Coup.act(s, 0, { type: 'action', action: 'tax' }, 0);
    assert.deepStrictEqual(botReact(s, 2), { type: 'challenge' });
  }
});

test('bots never bluff a character whose every copy is face up', () => {
  const s = setup(4, 0, [['captain', 'assassin'], ['duke', 'contessa'], ['duke', 'ambassador'], ['duke', 'captain']]);
  s.players.slice(1).forEach(p => { p.cards[0].dead = true; });
  s.players[0].coins = 2;
  for (let i = 0; i < 300; i++) assert.notStrictEqual(botMove(s, 0).action, 'tax');
});

test('bots give up their weakest card and block steals naming a character', () => {
  const s = setup(3, 1, [['ambassador', 'duke'], null, null]);
  s.players[1].coins = 7;
  Coup.act(s, 1, { type: 'action', action: 'coup', target: 0 });
  for (let i = 0; i < 50; i++) assert.deepStrictEqual(botMove(s, 0), { type: 'lose', index: 0 });

  const t = setup(3, 0, [['captain', 'duke'], ['ambassador', 'contessa'], ['duke', 'assassin']]);
  Coup.act(t, 0, { type: 'action', action: 'steal', target: 1 }, 0);
  Coup.tick(t, 10000);
  let blocked = 0;
  for (let i = 0; i < 50; i++) { const m = botReact(t, 1); if (m) { blocked++; assert.deepStrictEqual(m, { type: 'block', as: 'ambassador' }); } }
  assert.ok(blocked > 30);
});

test('a bot down to its last card always defends against an assassination', () => {
  for (let i = 0; i < 50; i++) {
    const s = setup(3, 0, [['assassin', 'duke'], ['duke', 'captain'], ['contessa', 'ambassador']]);
    s.players[0].coins = 3; s.players[1].cards[0].dead = true;
    Coup.act(s, 0, { type: 'action', action: 'assassinate', target: 1 }, 0);
    const m = botReact(s, 1);
    if (m) { assert.deepStrictEqual(m, { type: 'challenge' }); continue; }
    Coup.tick(s, 10000);
    assert.deepStrictEqual(botReact(s, 1), { type: 'block', as: 'contessa' });
  }
});
