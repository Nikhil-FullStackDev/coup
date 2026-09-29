// Simple heuristic AI. Only looks at its own hand plus public info.
const Coup = require('./public/game.js');

const rnd = n => Math.random() < n;
const pick = a => a[Math.floor(Math.random() * a.length)];

function botMove(s, id) {
  const me = s.players[id];
  const hand = me.cards.filter(c => !c.dead).map(c => c.c);
  const has = c => hand.includes(c);
  const foes = s.players.filter(p => p.alive && p.id !== id);
  const pd = s.pending;

  switch (s.phase) {
    case 'action': {
      const richest = [...foes].sort((a, b) => b.coins - a.coins || b.cards.filter(c => !c.dead).length - a.cards.filter(c => !c.dead).length)[0];
      if (me.coins >= 10 || (me.coins >= 7 && rnd(0.85))) return { type: 'action', action: 'coup', target: richest.id };
      const opts = [];
      if (has('duke') || rnd(0.2)) opts.push({ action: 'tax' }, { action: 'tax' });
      if ((has('captain') || rnd(0.15)) && richest.coins >= 2) opts.push({ action: 'steal', target: richest.id }, { action: 'steal', target: richest.id });
      if (me.coins >= 3 && (has('assassin') || rnd(0.15))) opts.push({ action: 'assassinate', target: pick(foes).id }, { action: 'assassinate', target: richest.id });
      if (has('ambassador')) opts.push({ action: 'exchange' });
      opts.push({ action: 'income' }, { action: 'aid' });
      return { type: 'action', ...pick(opts) };
    }
    case 'lose': {
      const live = me.cards.map((c, i) => ({ c, i })).filter(x => !x.c.dead);
      return { type: 'lose', index: pick(live).i };
    }
    case 'exchange': {
      const { options, keep } = s.exch;
      const rank = { duke: 5, contessa: 4, assassin: 3, captain: 3, ambassador: 2 };
      const order = options.map((c, i) => ({ i, r: rank[c] + Math.random() })).sort((a, b) => b.r - a.r);
      return { type: 'keep', keep: order.slice(0, keep).map(x => x.i) };
    }
  }
  return null;
}

// One-shot reaction during an open window (bots decide once per window).
function botReact(s, id) {
  const me = s.players[id], pd = s.pending, can = Coup.reactions(s, id);
  const hand = me.cards.filter(c => !c.dead).map(c => c.c);
  const has = c => hand.includes(c);
  const foes = s.players.filter(p => p.alive && p.id !== id).length;
  if (pd.stage === 'bchallenge') {
    const n = hand.filter(c => c === pd.block.char).length;
    return can.challenge && rnd(0.08 + n * 0.25 + (pd.actor === id ? 0.12 : 0)) ? { type: 'challenge' } : null;
  }
  if (can.challenge) {
    const n = hand.filter(c => c === pd.claim).length;
    let p = 0.08 + n * 0.25;
    if (pd.action === 'assassinate' && pd.target === id) p = Math.max(p, 0.4);
    if (foes === 1) p += 0.15;
    if (rnd(p)) return { type: 'challenge' };
  }
  if (can.block.length) {
    const holds = can.block.find(has);
    let p;
    if (pd.action === 'aid') p = holds ? 0.7 : 0.05;
    else if (holds) p = 0.85;
    else p = pd.action === 'assassinate' ? (hand.length === 1 ? 0.6 : 0.4) : 0.15;
    if (rnd(p)) return { type: 'block', char: holds || pick(can.block) };
  }
  return null;
}

module.exports = { botMove, botReact };
