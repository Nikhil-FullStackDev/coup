// Simple heuristic AI. Only looks at its own hand plus public info (revealed cards, coins).
const Coup = require('./public/game.js');

const rnd = n => Math.random() < n;
const pick = a => a[Math.floor(Math.random() * a.length)];
const RANK = { duke: 5, contessa: 4, assassin: 3, captain: 3, ambassador: 2 };

// Copies of each character this bot can account for: its own live cards plus every face-up card.
// 3 means nobody else can hold that character, so a claim of it is a certain bluff.
function seenCounts(s, id) {
  const seen = {};
  Coup.CHARS.forEach(c => { seen[c] = 0; });
  s.players.forEach(p => p.cards.forEach(c => { if ((c.dead || p.id === id) && c.c in seen) seen[c.c]++; }));
  return seen;
}

// Probability of challenging a claim of `ch` given how many copies are accounted for.
const doubt = (seen, ch) => (seen[ch] >= 3 ? 1 : 0.08 + seen[ch] * 0.22);

function botMove(s, id) {
  const me = s.players[id];
  const hand = me.cards.filter(c => !c.dead).map(c => c.c);
  const has = c => hand.includes(c);
  const seen = seenCounts(s, id);
  // Claim a character: always if held, sometimes as a bluff, never when every copy is accounted for.
  const claim = (c, bluff) => has(c) || (seen[c] < 3 && rnd(bluff));
  const foes = s.players.filter(p => p.alive && p.id !== id);

  switch (s.phase) {
    case 'action': {
      const live = p => p.cards.filter(c => !c.dead).length;
      const richest = [...foes].sort((a, b) => b.coins - a.coins || live(b) - live(a))[0];
      if (me.coins >= 10 || (me.coins >= 7 && rnd(0.85))) return { type: 'action', action: 'coup', target: richest.id };
      const opts = [];
      if (claim('duke', 0.2)) opts.push({ action: 'tax' }, { action: 'tax' });
      const rich = foes.filter(p => p.coins >= 2);
      if (rich.length && claim('captain', 0.15)) {
        const t = rich.includes(richest) ? richest : pick(rich);
        opts.push({ action: 'steal', target: t.id }, { action: 'steal', target: t.id });
      }
      if (me.coins >= 3 && claim('assassin', 0.15)) opts.push({ action: 'assassinate', target: pick(foes).id }, { action: 'assassinate', target: richest.id });
      if (has('ambassador')) opts.push({ action: 'exchange' });
      opts.push({ action: 'income' }, { action: 'aid' });
      return { type: 'action', ...pick(opts) };
    }
    case 'lose': { // give up the least useful card
      const live = me.cards.map((c, i) => ({ i, dead: c.dead, r: (RANK[c.c] || 0) + Math.random() * 0.5 })).filter(x => !x.dead);
      live.sort((a, b) => a.r - b.r);
      return { type: 'lose', index: live[0].i };
    }
    case 'exchange': { // keep the best cards, preferring two different characters
      const { options, keep } = s.exch;
      const left = options.map((c, i) => ({ c, i, r: (RANK[c] || 0) + Math.random() }));
      const kept = [];
      while (kept.length < keep) {
        left.sort((a, b) => (b.r - (kept.some(k => k.c === b.c) ? 2 : 0)) - (a.r - (kept.some(k => k.c === a.c) ? 2 : 0)));
        kept.push(left.shift());
      }
      return { type: 'keep', keep: kept.map(x => x.i) };
    }
  }
  return null;
}

// One-shot reaction during an open window (bots decide once per window).
function botReact(s, id) {
  const me = s.players[id], pd = s.pending, can = Coup.reactions(s, id);
  const hand = me.cards.filter(c => !c.dead).map(c => c.c);
  const seen = seenCounts(s, id);
  const foes = s.players.filter(p => p.alive && p.id !== id).length;
  if (pd.stage === 'bchallenge') {
    if (!can.challenge) return null;
    const ch = pd.block.chars[0];
    const p = seen[ch] >= 3 ? 1 : doubt(seen, ch) + (pd.actor === id ? 0.12 : 0);
    return rnd(p) ? { type: 'challenge' } : null;
  }
  if (pd.stage === 'claim') {
    if (!can.challenge) return null;
    let p = doubt(seen, pd.claim);
    if (p < 1 && pd.action === 'assassinate' && pd.target === id) {
      // Holding Contessa: block instead of risking a challenge. Otherwise fight harder for the last card.
      p = hand.includes('contessa') ? Math.min(p, 0.05) : Math.max(p, hand.length === 1 ? 0.5 : 0.35);
    }
    if (p < 1 && foes === 1) p += 0.15;
    return rnd(p) ? { type: 'challenge' } : null;
  }
  if (can.block) {
    const opts = Coup.ACTIONS[pd.action].blockBy;
    const held = opts.filter(c => hand.includes(c));
    // Bluff with the character that is least accounted for; never one whose copies are all visible.
    const bluff = opts.filter(c => seen[c] < 3).sort((a, b) => seen[a] - seen[b])[0];
    const as = held[0] || bluff;
    if (!as) return null;
    let p;
    if (pd.action === 'aid') p = held.length ? 0.7 : 0.05;
    else if (held.length) p = pd.action === 'assassinate' ? 1 : 0.9;
    else if (pd.action === 'assassinate') p = hand.length === 1 ? 1 : 0.4; // a last card is worth any bluff
    else p = 0.15;
    if (rnd(p)) return { type: 'block', as };
  }
  return null;
}

module.exports = { botMove, botReact, seenCounts };
