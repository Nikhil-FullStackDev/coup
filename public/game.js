// Coup rules engine (pure, server-authoritative). Works in Node and the browser.
// "Table mode": players talk over voice chat. After a declaration there is an open, timed
// window in which anyone may challenge (or an eligible player may block). No one is prompted.
(function (root) {
  const CHARS = ['duke', 'assassin', 'captain', 'ambassador', 'contessa'];
  const ACTIONS = {
    income: {},
    aid: { blockBy: ['duke'] },
    coup: { cost: 7, target: true },
    tax: { claim: 'duke' },
    assassinate: { cost: 3, target: true, claim: 'assassin', blockBy: ['contessa'] },
    steal: { target: true, claim: 'captain', blockBy: ['captain', 'ambassador'] },
    exchange: { claim: 'ambassador' },
  };
  const LABEL = { income: 'Income', aid: 'Foreign Aid', coup: 'Coup', tax: 'Tax', assassinate: 'Assassinate', steal: 'Steal', exchange: 'Exchange' };

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function create(players, opts = {}) {
    const deck = [];
    CHARS.forEach(c => { for (let i = 0; i < 3; i++) deck.push(c); });
    shuffle(deck);
    const s = {
      players: players.map((p, i) => ({
        id: i, name: p.name, bot: !!p.bot, coins: 2, alive: true,
        cards: [{ c: deck.pop(), dead: false }, { c: deck.pop(), dead: false }],
      })),
      deck, turn: 0, phase: 'action', pending: null, lose: null, exch: null,
      windowMs: opts.windowMs || 10000, stageNo: 0,
      log: [], winner: null,
    };
    s.turn = Math.floor(Math.random() * s.players.length);
    log(s, `${s.players[s.turn].name} goes first.`);
    return s;
  }

  const log = (s, m) => { s.log.push(m); if (s.log.length > 80) s.log.shift(); };
  const P = (s, i) => s.players[i];
  const liveCards = p => p.cards.filter(c => !c.dead);
  const aliveIds = s => s.players.filter(p => p.alive).map(p => p.id);
  const cap = w => w[0].toUpperCase() + w.slice(1);

  function checkWinner(s) {
    const a = aliveIds(s);
    if (a.length === 1) {
      s.winner = a[0]; s.phase = 'over'; s.pending = s.lose = s.exch = null;
      log(s, `${P(s, a[0]).name} wins!`);
      return true;
    }
    return false;
  }

  function endTurn(s) {
    s.pending = s.lose = s.exch = null;
    if (checkWinner(s)) return;
    do { s.turn = (s.turn + 1) % s.players.length; } while (!P(s, s.turn).alive);
    s.phase = 'action';
  }

  function kill(s, p, idx) {
    const c = p.cards[idx];
    c.dead = true;
    log(s, `${p.name} loses ${cap(c.c)}.`);
    if (!liveCards(p).length) { p.alive = false; log(s, `${p.name} is out!`); }
  }

  function loseInfluence(s, pid, resume) {
    const p = P(s, pid);
    const live = p.cards.map((c, i) => (c.dead ? -1 : i)).filter(i => i >= 0);
    if (live.length === 0) return runResume(s, resume);
    if (live.length === 1) { kill(s, p, live[0]); return runResume(s, resume); }
    s.phase = 'lose'; s.lose = { player: pid, resume };
  }

  function runResume(s, r, now) {
    if (checkWinner(s)) return;
    const pd = s.pending;
    if (r === 'toBlock') return toBlock(s, now);
    if (r === 'resolve') return resolve(s);
    if (r === 'cancelRefund') { if (pd) P(s, pd.actor).coins += ACTIONS[pd.action].cost || 0; return endTurn(s); }
    return endTurn(s); // 'cancel' | 'end'
  }

  function blockersOf(s, pd) {
    const def = ACTIONS[pd.action];
    if (!def.blockBy) return [];
    if (pd.action === 'aid') return aliveIds(s).filter(i => i !== pd.actor);
    return P(s, pd.target).alive ? [pd.target] : [];
  }

  function openWindow(s, stage, now) {
    s.phase = 'window'; s.stageNo++;
    s.pending.stage = stage; s.pending.passed = [];
    s.pending.deadline = (now ?? Date.now()) + s.windowMs;
  }

  function toBlock(s, now) {
    if (!blockersOf(s, s.pending).length) return resolve(s);
    openWindow(s, 'block', now);
  }

  function resolve(s) {
    const pd = s.pending, a = P(s, pd.actor);
    if (!a.alive) return endTurn(s);
    const t = pd.target != null ? P(s, pd.target) : null;
    switch (pd.action) {
      case 'income': a.coins += 1; log(s, `${a.name} takes Income (+1).`); break;
      case 'aid': a.coins += 2; log(s, `${a.name} takes Foreign Aid (+2).`); break;
      case 'tax': a.coins += 3; log(s, `${a.name} collects Tax (+3).`); break;
      case 'steal': {
        if (!t.alive) break;
        const n = Math.min(2, t.coins); t.coins -= n; a.coins += n;
        log(s, `${a.name} steals ${n} from ${t.name}.`); break;
      }
      case 'exchange': {
        const live = a.cards.filter(c => !c.dead).map(c => c.c);
        a.cards = a.cards.filter(c => c.dead);
        const options = live.concat(s.deck.splice(0, 2));
        s.phase = 'exchange'; s.exch = { player: a.id, options, keep: live.length };
        log(s, `${a.name} exchanges cards.`); return;
      }
      case 'coup': case 'assassinate':
        if (t.alive) { log(s, `${a.name}'s ${pd.action === 'coup' ? 'Coup' : 'assassination'} hits ${t.name}.`); return loseInfluence(s, t.id, 'end'); }
        break;
    }
    endTurn(s);
  }

  function challenge(s, challenger, target, chars, kind) {
    const c = P(s, challenger), t = P(s, target);
    const said = chars.map(cap).join('/');
    log(s, `${c.name} challenges ${t.name}'s ${said}!`);
    const idx = t.cards.findIndex(x => !x.dead && chars.includes(x.c));
    if (idx >= 0) {
      log(s, `${t.name} shows ${cap(t.cards[idx].c)} — challenge fails. ${c.name} loses an influence.`);
      s.deck.push(t.cards[idx].c); shuffle(s.deck); t.cards[idx].c = s.deck.shift();
      loseInfluence(s, challenger, kind === 'action' ? 'toBlock' : 'cancel');
    } else {
      log(s, `${t.name} was bluffing!`);
      loseInfluence(s, target, kind === 'action' ? 'cancelRefund' : 'resolve');
    }
  }

  // Players who must act (turn, lose a card, exchange). Windows are open to all — nobody "waits".
  function waitingOn(s) {
    switch (s.phase) {
      case 'action': return [s.turn];
      case 'lose': return [s.lose.player];
      case 'exchange': return [s.exch.player];
      default: return [];
    }
  }

  // Which reactions a player could make right now.
  function reactions(s, pid) {
    const p = P(s, pid);
    const none = { challenge: false, block: false };
    if (s.phase !== 'window' || !p || !p.alive) return none;
    const pd = s.pending;
    switch (pd.stage) {
      case 'claim': return { challenge: pid !== pd.actor && !!pd.claim, block: false };
      case 'block': return { challenge: false, block: blockersOf(s, pd).includes(pid) };
      case 'bchallenge': return { challenge: pid !== pd.block.by, block: false };
    }
    return none;
  }

  function respondents(s) {
    return s.players.filter(p => { const r = reactions(s, p.id); return r.challenge || r.block; }).map(p => p.id);
  }

  function expire(s) {
    const pd = s.pending;
    if (pd.stage === 'bchallenge') { log(s, `The block stands.`); return endTurn(s); }
    if (pd.stage === 'claim') return toBlock(s);
    resolve(s);
  }

  // Server calls this regularly; returns true if state changed.
  function tick(s, now) {
    if (s.phase === 'window' && now >= s.pending.deadline) { expire(s); return true; }
    return false;
  }

  function act(s, pid, m, now) {
    const err = e => ({ error: e });
    const pl = P(s, pid);
    if (!pl || !pl.alive) return err('You are out');
    if (s.phase === 'over') return err('Game over');
    const pd = s.pending;

    if (s.phase === 'window') {
      const r = reactions(s, pid);
      if (m.type === 'challenge') {
        if (!r.challenge) return err('Cannot challenge now');
        if (pd.stage === 'bchallenge') challenge(s, pid, pd.block.by, pd.block.chars, 'block');
        else challenge(s, pid, pd.actor, [pd.claim], 'action');
        return { ok: true };
      }
      if (m.type === 'block') {
        if (!r.block) return err('Cannot block now');
        const chars = ACTIONS[pd.action].blockBy;
        pd.block = { by: pid, chars };
        log(s, `${pl.name} blocks (${chars.map(cap).join('/')}).`);
        openWindow(s, 'bchallenge', now);
        return { ok: true };
      }
      if (m.type === 'pass') { // "No" — once every eligible player says no, move on immediately
        if (!r.challenge && !r.block) return err('Nothing to respond to');
        if (!pd.passed.includes(pid)) pd.passed.push(pid);
        if (respondents(s).every(i => pd.passed.includes(i))) expire(s);
        return { ok: true };
      }
      return err('Challenge or No');
    }

    if (!waitingOn(s).includes(pid)) return err('Not your turn to act');
    switch (s.phase) {
      case 'action': {
        const def = ACTIONS[m.action];
        if (m.type !== 'action' || !def) return err('Bad action');
        if (pl.coins >= 10 && m.action !== 'coup') return err('You must Coup with 10+ coins');
        if (def.cost && pl.coins < def.cost) return err('Not enough coins');
        let target = null;
        if (def.target) {
          target = Number(m.target);
          if (!Number.isInteger(target) || target === pid || !s.players[target] || !P(s, target).alive) return err('Pick a target');
        }
        pl.coins -= def.cost || 0;
        s.pending = { actor: pid, action: m.action, target, claim: def.claim || null, block: null, stage: null, deadline: 0 };
        const tn = target != null ? ` on ${P(s, target).name}` : '';
        log(s, `${pl.name}: ${LABEL[m.action]}${tn}${def.claim ? ` (claims ${cap(def.claim)})` : ''}.`);
        if (def.claim) openWindow(s, 'claim', now);
        else if (m.action === 'aid') openWindow(s, 'block', now);
        else resolve(s);
        return { ok: true };
      }
      case 'lose': {
        const i = Number(m.index);
        if (m.type !== 'lose' || !pl.cards[i] || pl.cards[i].dead) return err('Pick a card to lose');
        const r = s.lose.resume; s.lose = null; kill(s, pl, i); runResume(s, r, now);
        return { ok: true };
      }
      case 'exchange': {
        const ex = s.exch;
        const keep = Array.isArray(m.keep) ? [...new Set(m.keep.map(Number))] : [];
        if (m.type !== 'keep' || keep.length !== ex.keep || keep.some(i => !(i >= 0 && i < ex.options.length))) return err(`Keep exactly ${ex.keep}`);
        keep.map(i => ex.options[i]).forEach(c => pl.cards.push({ c, dead: false }));
        s.deck.push(...ex.options.filter((_, i) => !keep.includes(i))); shuffle(s.deck);
        endTurn(s);
        return { ok: true };
      }
    }
    return err('Invalid');
  }

  // What a given player is allowed to see.
  function view(s, pid, now) {
    const pd = s.pending;
    return {
      phase: s.phase, turn: s.turn, winner: s.winner, deck: s.deck.length,
      players: s.players.map(p => ({
        id: p.id, name: p.name, bot: p.bot, coins: p.coins, alive: p.alive,
        cards: p.cards.map(c => (c.dead || p.id === pid ? { c: c.c, dead: c.dead } : { c: null, dead: false })),
      })),
      pending: pd && { actor: pd.actor, action: pd.action, target: pd.target, claim: pd.claim, block: pd.block, stage: pd.stage },
      msLeft: s.phase === 'window' ? Math.max(0, pd.deadline - (now || Date.now())) : 0,
      windowMs: s.windowMs, stageNo: s.stageNo,
      can: { ...reactions(s, pid), passed: !!(pd && pd.passed && pd.passed.includes(pid)) },
      lose: s.lose && { player: s.lose.player },
      exch: s.exch && s.exch.player === pid ? { options: s.exch.options, keep: s.exch.keep } : (s.exch ? { player: s.exch.player } : null),
      waiting: waitingOn(s),
      you: pid,
    };
  }

  const api = { CHARS, ACTIONS, LABEL, create, act, tick, view, waitingOn, reactions };
  if (typeof module !== 'undefined') module.exports = api; else root.Coup = api;
})(typeof self !== 'undefined' ? self : this);
