// Coup client: vanilla JS, no build step. Server snapshots arrive over SSE and are rendered into a
// few regions; a region's DOM is only replaced when its HTML changed, so taps, typing and scroll
// positions survive the frequent updates. All clicks go through one delegated handler.
'use strict';
const $ = id => document.getElementById(id);
const $app = $('app');
const A = Coup.ACTIONS, LABEL = Coup.LABEL;
const cap = w => (w ? w[0].toUpperCase() + w.slice(1) : '');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = c => `img/${c || 'coup-card-back'}.webp`;
const short = n => String(n).replace(/ \(bot\)$/, '');
const TAP = matchMedia('(hover: none)').matches ? 'Tap' : 'Click';

// Storage can throw (private mode, blocked storage in in-app browsers): never let it break the page.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
function loadSession() {
  try {
    const s = JSON.parse(store.get('coup-session') || 'null');
    return s && typeof s.code === 'string' && typeof s.token === 'string' ? s : null;
  } catch { return null; }
}
const invite = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
let session = loadSession();
if (invite && session && session.code !== invite) session = null; // invite link to another room: show the join form

let snap = null, es = null, lastErr = '';
let uiTarget = null, exchSel = [], busy = false, logOpen = false, lastPhaseKey = '', lastNeed = '';
let seenLog = -1, clockEnd = 0, clockKind = '', retryT = 0, retryN = 0, netT = 0, toastT = 0;
let voiceDirty = false, winDrag = false, implicitSubmit = false;

// ---------- network ----------
async function post(path, body) {
  let r;
  try {
    r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('Network error — check your connection'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Error ${r.status}`); e.status = r.status; throw e; }
  return j;
}
const withRoom = b => ({ code: session.code, token: session.token, ...b });
const send = (path, b) => (session ? post(path, withRoom(b)).catch(e => toast(e.message)) : Promise.resolve());
function move(m) {
  if (busy) return; // ignore double taps while a move is in flight
  busy = true; uiTarget = null;
  send('move', { move: m }).finally(() => { busy = false; if (snap) render(); });
}

function toast(m, kind = 'err') {
  const t = $('toast');
  t.textContent = m; t.className = kind;
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), kind === 'err' ? 2600 : 3400);
}
function setNet(ok) {
  clearTimeout(netT);
  if (ok) $('net').classList.add('hidden');
  else netT = setTimeout(() => $('net').classList.remove('hidden'), 1500);
}

function connect() {
  clearTimeout(retryT);
  if (es) es.close();
  es = null;
  if (!session) return;
  const src = new EventSource(`/api/events?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
  es = src;
  src.onopen = () => { if (src === es) { retryN = 0; setNet(true); } };
  src.onmessage = e => {
    if (src !== es) return;
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    snap = d; setNet(true); render();
  };
  src.onerror = () => {
    if (src !== es) return;
    setNet(false);
    if (src.readyState === EventSource.CLOSED) probe(); // CONNECTING: the browser retries by itself
  };
}
// The stream was refused (room gone, or just a proxy hiccup). Only forget the session when the
// server confirms the seat is gone; otherwise retry with backoff.
async function probe() {
  if (!session) return;
  try {
    await post('ping', withRoom({}));
  } catch (e) {
    if (e.status === 404) return dropSession('That room has closed.');
    if (e.status === 403) return dropSession('You are no longer in that room.');
  }
  retryN++;
  retryT = setTimeout(connect, Math.min(10000, 1000 * 2 ** Math.min(retryN, 4)));
}
function dropSession(msg) {
  clearTimeout(retryT);
  if (es) es.close();
  es = null; snap = null; session = null; seenLog = -1;
  store.del('coup-session');
  lastErr = msg || '';
  setNet(true);
  render();
}
function leaveRoom() {
  if (session) post('leave', withRoom({})).catch(() => {});
  dropSession('');
}
function setSession(r) {
  session = { code: r.code, token: r.token };
  store.set('coup-session', JSON.stringify(session));
  if (location.search) try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  snap = null;
  connect();
  render();
}
// Phones suspend background tabs: reconnect as soon as the page is usable again.
const wake = () => { if (session && (!es || es.readyState === EventSource.CLOSED)) connect(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
addEventListener('online', wake);
addEventListener('pageshow', e => { if (e.persisted) connect(); });

// ---------- rendering helpers ----------
function screen(name, html, init) {
  if ($app.dataset.screen === name) return;
  $app.dataset.screen = name;
  // Overlays belong to the screen they were opened on: a Rules sheet left open when the host ends
  // the game (or the room closes) must not leave the next screen locked against scrolling.
  document.body.classList.remove('noscroll');
  $('zoom').classList.add('hidden');
  $app.innerHTML = html;
  scrollTo(0, 0);
  if (init) init();
}
function patch(el, html) {
  if (el && el._h !== html) { el._h = html; el.innerHTML = html; }
}
function card(c, cls = '', attrs = '') {
  const face = c.c ? ` data-zoom="${c.c}" title="${cap(c.c)}"` : '';
  return `<div class="card${c.dead ? ' dead' : ''}${cls}"${face} ${attrs} style="background-image:url(${img(c.c)})"></div>`;
}

const sliderPos = {};
function slider(id, title, imgs) {
  return `<section class="slider" data-s="${id}"><div class="sl-head"><b>${title}</b><span class="dots">${imgs.map(() => '<i></i>').join('')}</span></div>
    <div class="sl-body"><button type="button" class="chev" data-dir="-1" aria-label="Previous">‹</button>
    <div class="track">${imgs.map(([src, alt, w, h], i) => `<div class="slide"><img ${i ? 'data-' : ''}src="${src}" alt="${alt}" width="${w}" height="${h}" loading="lazy" decoding="async"></div>`).join('')}</div>
    <button type="button" class="chev" data-dir="1" aria-label="Next">›</button></div></section>`;
}
function info(inGame) {
  return `<aside class="info" id="info">${inGame ? '<button type="button" class="sheet-close" data-cmd="rules-close">✕ Close rules</button>' : slider('roles', 'Roles', Coup.CHARS.map(c => [img(c), cap(c), 308, 512]))}
    ${slider('rules', 'Rules', [['img/actions-reference.webp', 'Actions', 400, 502], ['img/reactions-reference.webp', 'Reactions', 400, 502], ['img/reminders-reference.webp', 'Reminders', 400, 502]])}</aside>`;
}
// Sliders are built once per screen; they remember the slide each player was reading.
// Only the first slide's image loads up front; the rest load once the player starts browsing.
function initSliders() {
  document.querySelectorAll('.slider').forEach(sl => {
    const id = sl.dataset.s, track = sl.querySelector('.track'), dots = sl.querySelectorAll('.dots i');
    const n = dots.length, w = () => track.clientWidth || 1;
    const mark = i => dots.forEach((d, k) => d.classList.toggle('on', k === i));
    const hydrate = () => sl.querySelectorAll('img[data-src]').forEach(im => { im.src = im.dataset.src; im.removeAttribute('data-src'); });
    sl.sync = () => { if (sliderPos[id]) hydrate(); track.scrollLeft = (sliderPos[id] || 0) * w(); mark(sliderPos[id] || 0); };
    sl.sync();
    track.addEventListener('scroll', () => {
      if (!track.clientWidth) return;
      hydrate();
      const i = Math.round(track.scrollLeft / w());
      if (i !== sliderPos[id]) { sliderPos[id] = i; mark(i); }
    }, { passive: true });
    track.addEventListener('pointerdown', hydrate, { passive: true });
    sl.querySelectorAll('.chev').forEach(b => { b.onclick = () => { hydrate(); track.scrollTo({ left: ((Math.round(track.scrollLeft / w()) + +b.dataset.dir + n) % n) * w(), behavior: 'smooth' }); }; });
  });
}
let resizeT = 0;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => document.querySelectorAll('.slider').forEach(s => s.sync && s.sync()), 150); });

const voiceLink = (s, cls = '') => (s.voice ? `<a class="btn ${cls}" href="${esc(s.voice)}" target="_blank" rel="noopener noreferrer">🎙 Join voice chat</a>` : '');

// ---------- home ----------
function home() {
  screen('home', `<div class="lobbywrap"><form class="center" id="homeform" novalidate>
      <h1>COUP</h1>
      <p class="sub dim">The bluffing card game — online with friends or bots</p>
      <label class="fld"><span>Your name</span>
        <input id="name" maxlength="14" placeholder="e.g. Sam" autocomplete="nickname" autocapitalize="words" enterkeyhint="go"></label>
      <button type="submit" class="${invite ? '' : 'primary'}" data-go="create">Create a room</button>
      <div class="or dim"><span>or join a friend</span></div>
      <div class="row"><input id="code" maxlength="4" placeholder="Room code" aria-label="Room code" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
        <button type="submit" class="${invite ? 'primary' : ''}" data-go="join">Join</button></div>
      <div class="err" id="herr" role="alert"></div>
    </form>${info(false)}</div>`, () => {
    $('name').value = store.get('coup-name') || '';
    $('code').value = invite;
    if (invite && !$('name').value) $('name').focus();
    initSliders();
  });
  $('herr').textContent = lastErr;
}
async function submitHome(e) {
  e.preventDefault();
  const f = e.target, name = $('name').value.trim(), code = $('code').value.trim();
  store.set('coup-name', name);
  // Enter / "Go" on the keyboard joins when a code is typed, otherwise creates.
  const how = implicitSubmit || !e.submitter ? (code ? 'join' : 'create') : e.submitter.dataset.go;
  implicitSubmit = false;
  if (how === 'join' && code.length !== 4) { lastErr = 'Enter the 4-letter room code.'; $('herr').textContent = lastErr; $('code').focus(); return; }
  const btns = f.querySelectorAll('button');
  btns.forEach(b => { b.disabled = true; });
  try {
    const r = await post(how, how === 'join' ? { name, code } : { name });
    lastErr = '';
    if (document.activeElement) document.activeElement.blur();
    setSession(r);
  } catch (err) {
    lastErr = err.message;
    if ($('herr')) $('herr').textContent = lastErr;
  } finally { btns.forEach(b => { b.disabled = false; }); }
}

function loading() {
  screen('loading', `<div class="loading"><div class="spin" aria-hidden="true"></div><div class="dim">Connecting to room ${esc(session.code)}…</div>
    <button type="button" data-cmd="leave">Back</button></div>`);
}

// ---------- lobby ----------
const HOST_HTML = `<form class="row" id="voiceform" novalidate><input id="voice" type="url" inputmode="url" placeholder="Voice chat link (Discord / Meet / WhatsApp…)" aria-label="Voice chat link" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"><button type="submit">Set</button></form>
  <label class="row slider-row"><span class="dim">Challenge window: <b id="wl"></b>s</span><input id="win" type="range" min="4" max="30" step="1" aria-label="Challenge window in seconds"></label>`;

function lobby() {
  const s = snap;
  screen('lobby', `<div class="lobbywrap"><div class="center">
      <div class="dim tc">Room code — share it with friends</div>
      <div class="code" id="l-code"></div>
      <button type="button" data-cmd="share">🔗 Share invite link</button>
      <ul class="plist" id="l-list"></ul>
      <div id="l-voice"></div>
      <div id="l-host" class="stack"></div>
      <div id="l-ctrl" class="stack"></div>
      <button type="button" class="ghost" data-cmd="leave">Leave room</button>
    </div>${info(false)}</div>`, initSliders);
  patch($('l-code'), esc(s.code));
  patch($('l-list'), s.lobby.map((p, i) => `<li class="${p.connected ? '' : 'off'}">
      <span class="pn">${p.bot ? '🤖 ' : ''}${esc(short(p.name))}${i === s.you ? ' <em class="dim">(you)</em>' : ''}${p.host ? ' <span class="star" title="Host">★</span>' : ''}</span>
      <span class="pst">${p.connected ? '' : '<span class="dim">offline</span>'}${s.host && i !== s.you ? `<button type="button" data-kick="${i}" aria-label="Remove ${esc(p.name)}">Remove</button>` : ''}</span></li>`).join('') +
    (s.lobby.length < 6 ? `<li class="open dim">${6 - s.lobby.length} open seat${s.lobby.length === 5 ? '' : 's'}</li>` : ''));
  patch($('l-voice'), voiceLink(s, 'wide'));
  patch($('l-host'), s.host ? HOST_HTML : '');
  if (s.host) {
    const v = $('voice');
    if (document.activeElement !== v && !voiceDirty && v.value !== s.voice) v.value = s.voice;
    if (!winDrag) { $('win').value = s.windowSec; $('wl').textContent = s.windowSec; }
  }
  patch($('l-ctrl'), s.host
    ? `<div class="row2"><button type="button" data-cmd="addbot" ${s.lobby.length >= 6 ? 'disabled' : ''}>+ Add bot</button><button type="button" class="primary" data-cmd="start" ${s.lobby.length < 2 ? 'disabled' : ''}>Start game</button></div>
       ${s.lobby.length < 2 ? '<div class="dim tc small">Invite a friend or add a bot to start.</div>' : ''}`
    : '<div class="dim tc">Waiting for the host to start…</div>');
  document.title = `Coup · Room ${s.code}`;
}
async function share() {
  const url = `${location.origin}/?room=${snap.code}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Coup', text: `Join my Coup game — room ${snap.code}`, url }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied', 'ok'); } catch { prompt('Copy this invite link:', url); }
}

// ---------- game ----------
function describe(g) {
  const pd = g.pending, nm = i => (i === g.you ? 'You' : esc(short(g.players[i].name)));
  if (g.phase === 'over') return g.winner === g.you ? '🏆 <b>You win!</b>' : `🏆 ${nm(g.winner)} wins!`;
  if (g.phase === 'action') return g.turn === g.you ? '<b>Your turn</b>' : `${nm(g.turn)}'s turn`;
  if (g.phase === 'lose') return g.lose.player === g.you ? '<b>You lose an influence</b>' : `${nm(g.lose.player)} loses an influence`;
  if (g.phase === 'exchange') return g.exch.player === g.you ? '<b>Exchange</b> — choose your cards' : `${nm(g.exch.player)} is exchanging`;
  let t = `${nm(pd.actor)}: <b>${LABEL[pd.action]}</b>${pd.target != null ? ' → ' + nm(pd.target) : ''}`;
  if (pd.claim) t += ` <span class="dim">(${cap(pd.claim)})</span>`;
  if (pd.block) t += `<br>🛡 ${nm(pd.block.by)} block${pd.block.by === g.you ? '' : 's'} <span class="dim">(${pd.block.chars.map(cap).join(' / ')})</span>`;
  return t;
}

function controls(g, me) {
  const pd = g.pending, nm = i => esc(short(g.players[i].name));
  if (g.phase === 'over') {
    return snap.host
      ? '<div class="row2"><button type="button" class="primary big" data-cmd="again">Play again</button><button type="button" class="big" data-cmd="lobby">Back to lobby</button></div>'
      : '<div class="hint">Waiting for the host…</div><div class="row2"><button type="button" data-cmd="leave">Leave</button></div>';
  }
  if (!me.alive) return '<div class="hint">You are out — spectating.</div>';
  if (g.phase === 'window') {
    if (g.can.passed) return '<div class="hint">You said no — waiting for the others…</div>';
    if (g.can.challenge) {
      const who = pd.stage === 'bchallenge' ? pd.block.by : pd.actor, ch = pd.stage === 'bchallenge' ? pd.block.chars[0] : pd.claim;
      return `<div class="row2"><button type="button" class="danger big" data-mv="challenge">Challenge<small>${nm(who)} has no ${cap(ch)}</small></button>
        <button type="button" class="big" data-mv="pass">No<small>don't challenge</small></button></div>`;
    }
    if (g.can.block) {
      return `<div class="row2">${A[pd.action].blockBy.map(c => `<button type="button" class="danger big" data-mv="block" data-as="${c}">Block<small>as ${cap(c)}</small></button>`).join('')}
        <button type="button" class="big" data-mv="pass">No<small>don't block</small></button></div>`;
    }
    return `<div class="hint">${pd.stage === 'block' ? 'Waiting to see if anyone blocks…' : 'Waiting for challenges…'}</div>`;
  }
  if (!g.waiting.includes(g.you)) return '';
  if (g.phase === 'action') {
    if (uiTarget) {
      const foes = g.players.filter(p => p.id !== g.you && p.alive);
      return `<div class="hint">${LABEL[uiTarget]} — choose a player</div>
        <div class="targets">${foes.map(p => { const n = p.cards.filter(c => !c.dead).length; return `<button type="button" data-tgt="${p.id}">${p.bot ? '🤖 ' : ''}${esc(short(p.name))}<small>🪙 ${p.coins} · ${n} card${n === 1 ? '' : 's'}</small></button>`; }).join('')}</div>
        <button type="button" class="ghost" data-cmd="cancel">Cancel</button>`;
    }
    const forced = me.coins >= 10, held = c => me.cards.some(x => !x.dead && x.c === c);
    const btn = (a, label, sub, ok = true) => {
      const cl = A[a].claim, mark = cl ? (held(cl) ? ' have' : ' bluff') : '';
      return `<button type="button" class="act act-${a}${mark}" data-act="${a}" ${ok && (!forced || a === 'coup') ? '' : 'disabled'}>${label}<small>${sub}</small></button>`;
    };
    return `${forced ? '<div class="hint">10+ coins — you must Coup.</div>' : ''}<div class="actions">
      ${btn('income', 'Income', '+1')}${btn('aid', 'Foreign Aid', '+2 · Duke blocks')}${btn('tax', 'Tax', '+3 · Duke')}
      ${btn('steal', 'Steal', '+2 · Captain')}${btn('exchange', 'Exchange', 'Ambassador')}${btn('assassinate', 'Assassinate', '−3 · Assassin', me.coins >= 3)}
      ${btn('coup', 'Coup', '−7 · cannot be blocked', me.coins >= 7)}</div>`;
  }
  if (g.phase === 'lose') {
    return `<div class="hint">Choose a card to reveal and lose</div><div class="row2">${me.cards.map((c, i) => (c.dead ? ''
      : `<button type="button" class="big lose" data-lose="${i}"><span class="mini" style="background-image:url(${img(c.c)})"></span>Lose ${cap(c.c)}</button>`)).join('')}</div>`;
  }
  if (g.phase === 'exchange') {
    const ex = g.exch;
    return `<div class="hint">Keep ${ex.keep} — ${TAP.toLowerCase()} to choose</div>
      <div class="exch" style="--n:${ex.options.length}">${ex.options.map((c, i) => `<div class="card pick${exchSel.includes(i) ? ' sel' : ''}" role="button" tabindex="0" data-ex="${i}" aria-pressed="${exchSel.includes(i)}" aria-label="${cap(c)}" style="background-image:url(${img(c)})"></div>`).join('')}</div>
      <button type="button" class="primary big" data-keep ${exchSel.length === ex.keep ? '' : 'disabled'}>Keep selected</button>`;
  }
  return '';
}

function menuHtml() {
  const items = [];
  if (snap.host) {
    items.push('<button type="button" data-cmd="restart">↻ Restart game</button>', '<button type="button" data-cmd="lobby">⌂ Back to lobby</button>');
    snap.lobby.forEach((p, i) => { if (!p.bot && !p.connected && i !== snap.you) items.push(`<button type="button" data-rep="${i}">🤖 Bot replaces ${esc(p.name)}</button>`); });
  }
  items.push('<button type="button" class="warn" data-cmd="leave">Leave game</button>');
  return items.join('');
}

function game() {
  const g = snap.game, me = g.players[g.you], pd = g.pending;
  screen('game', `<div class="game"><div class="main">
      <header class="bar">
        <span class="room" id="g-room"></span>
        <a id="g-voice" class="btn icon hidden" target="_blank" rel="noopener noreferrer" aria-label="Join voice chat">🎙<span class="lbl">Voice</span></a>
        <button type="button" class="rules-btn" data-cmd="rules">Rules</button>
        <details class="menu" id="g-menu"><summary class="btn icon" aria-label="Game menu">⋯</summary><div class="pop" id="g-pop"></div></details>
      </header>
      <section class="opps" id="g-opps" aria-label="Opponents"></section>
      <section class="feed" id="g-log" data-cmd="log" aria-label="Game log — ${TAP.toLowerCase()} to expand"></section>
      <section class="mine" id="g-me" aria-label="Your hand"></section>
      <section class="dock" id="g-dock">
        <div class="timer" id="g-timer"></div>
        <div class="banner" id="g-banner" aria-live="polite"></div>
        <div class="ctl" id="g-ctl"></div>
      </section>
    </div>${info(true)}</div>`, initSliders);

  // top bar
  patch($('g-room'), `<b title="Room code"><span class="lbl">Room </span>${esc(snap.code)}</b><span class="dim">Deck ${g.deck}</span>`);
  const v = $('g-voice');
  if (snap.voice && v.getAttribute('href') !== snap.voice) v.setAttribute('href', snap.voice);
  v.classList.toggle('hidden', !snap.voice);
  patch($('g-pop'), menuHtml());

  // opponents
  const targeting = uiTarget && A[uiTarget].target && g.phase === 'action' && g.turn === g.you;
  patch($('g-opps'), g.players.filter(p => p.id !== g.you).map(p => {
    const lob = snap.lobby[p.id] || {}, pick = targeting && p.alive;
    const cls = ['seat', g.turn === p.id && g.phase !== 'over' ? 'turn' : '', p.alive ? '' : 'out', pick ? 'target' : '', g.winner === p.id ? 'win' : ''].filter(Boolean).join(' ');
    const badge = (pd && pd.target === p.id ? '🎯 ' : '') + (pd && pd.block && pd.block.by === p.id ? '🛡 ' : '');
    const lost = p.cards.filter(c => c.dead).map(c => cap(c.c));
    return `<div class="${cls}" data-p="${p.id}"${pick ? ' role="button" tabindex="0"' : ''}>
      <div class="nm">${badge}${p.bot ? '<span title="Bot">🤖</span> ' : ''}${esc(short(p.name))}</div>
      <div class="st"><div class="cards">${p.cards.map(c => card(c)).join('')}</div><span class="coins">🪙 ${p.coins}</span></div>
      ${lost.length || (!p.bot && !lob.connected) ? `<div class="lost">${!p.bot && !lob.connected ? '<span class="away">away</span> ' : ''}${lost.length ? '✕ ' + lost.join(' · ') : ''}</div>` : ''}
    </div>`;
  }).join(''));

  // log: public events, newest last
  if (seenLog < 0 || g.logNo < seenLog) seenLog = g.logNo; // first snapshot / new game: don't replay old news
  const fresh = g.log.slice(Math.max(0, g.log.length - (g.logNo - seenLog)));
  const news = fresh.filter(l => /challenge fails|was bluffing|is out!|ran out of time/.test(l)).pop();
  if (news) toast(news, 'info');
  seenLog = g.logNo;
  const lines = g.log.slice(logOpen ? -12 : -3);
  $('g-log').setAttribute('aria-expanded', logOpen);
  patch($('g-log'), `<ol>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ol><span class="more">${logOpen ? '▴' : '▾'}</span>`);

  // my hand
  const pickLose = g.phase === 'lose' && g.waiting.includes(g.you);
  const meEl = $('g-me');
  meEl.classList.toggle('turn', g.turn === g.you && g.phase !== 'over' && me.alive);
  meEl.classList.toggle('out', !me.alive);
  patch(meEl, `<div class="who"><div class="nm">${esc(short(me.name))} <em class="dim">(you)</em></div><div class="coins big">🪙 ${me.coins}</div>${me.alive ? '' : '<div class="dim small">Out</div>'}</div>
    <div class="hand">${me.cards.length ? me.cards.map((c, i) => card(c, pickLose && !c.dead ? ' pick' : '', pickLose && !c.dead ? `data-lose="${i}" role="button" tabindex="0"` : '')).join('') : '<div class="dim small">Choosing cards…</div>'}</div>`);

  // dock: timer, banner, controls
  const t = g.timer, tk = t ? t.kind + t.no : '', tEl = $('g-timer');
  if (tEl._k !== tk) {
    tEl._k = tk;
    tEl.className = 'timer ' + (t ? t.kind : 'none');
    tEl.innerHTML = t ? `<div class="tbar"><i style="animation-duration:${t.total}ms;animation-delay:-${t.total - t.left}ms"></i></div><span id="secs"></span>` : '';
  }
  clockEnd = t ? performance.now() + t.left : 0; clockKind = t ? t.kind : '';
  tickSecs();
  patch($('g-banner'), describe(g));
  patch($('g-ctl'), controls(g, me));

  // a buzz and a title cue when the game needs this player
  const need = me.alive && (g.waiting.includes(g.you) || (g.phase === 'window' && !g.can.passed && (g.can.block || (pd && pd.target === g.you)))) ? lastPhaseKey : '';
  const activated = !navigator.userActivation || navigator.userActivation.hasBeenActive; // Chrome blocks vibrate before a tap
  if (need && need !== lastNeed && activated && document.visibilityState === 'visible' && navigator.vibrate) navigator.vibrate(30);
  lastNeed = need;
  document.title = need ? '▶ Your move · Coup' : `Coup · Room ${snap.code}`;
}

function tickSecs() {
  const el = $('secs');
  if (!el) return;
  const s = clockEnd ? Math.max(0, Math.ceil((clockEnd - performance.now()) / 1000)) : 0;
  el.textContent = !clockEnd ? '' : clockKind === 'window' ? s + 's' : s <= 15 ? `auto-play in ${s}s` : '';
}
setInterval(tickSecs, 250);

function render() {
  if (!session) return home();
  if (!snap) return loading();
  const g = snap.game;
  const key = g ? `${g.phase}:${g.turn}:${g.stageNo}:${g.timer ? g.timer.no : ''}` : '';
  if (key !== lastPhaseKey) { uiTarget = null; exchSel = []; lastPhaseKey = key; }
  if (g) game(); else lobby();
}

// ---------- overlays ----------
function zoom(c) {
  const z = $('zoom');
  z.querySelector('img').src = img(c);
  z.querySelector('img').alt = cap(c);
  z.classList.remove('hidden');
}
function rules(open) {
  const el = $('info');
  if (!el) return;
  el.classList.toggle('open', open);
  document.body.classList.toggle('noscroll', open);
  if (open) el.querySelectorAll('.slider').forEach(s => s.sync && s.sync());
}
function closeMenu() { const m = $('g-menu'); if (m) m.open = false; }

// ---------- input ----------
document.addEventListener('click', e => {
  const t = e.target;
  if (!t.closest('#g-menu')) closeMenu();
  if (t.closest('#zoom')) { $('zoom').classList.add('hidden'); return; }
  const seat = t.closest('.seat.target');
  if (seat) return move({ type: 'action', action: uiTarget, target: +seat.dataset.p });
  const el = t.closest('[data-act],[data-tgt],[data-mv],[data-lose],[data-ex],[data-keep],[data-cmd],[data-kick],[data-rep],[data-zoom]');
  if (!el) return;
  const d = el.dataset;
  if (el.closest('.pop')) closeMenu();
  if (d.act) {
    if (A[d.act].target) { uiTarget = d.act; render(); } else move({ type: 'action', action: d.act });
  } else if (d.tgt) move({ type: 'action', action: uiTarget, target: +d.tgt });
  else if (d.mv) move(d.as ? { type: d.mv, as: d.as } : { type: d.mv });
  else if (d.lose) move({ type: 'lose', index: +d.lose });
  else if (d.ex) {
    const i = +d.ex, k = snap.game.exch.keep;
    exchSel = exchSel.includes(i) ? exchSel.filter(x => x !== i) : [...exchSel, i].slice(-k);
    render();
  } else if ('keep' in d) { const k = exchSel; exchSel = []; move({ type: 'keep', keep: k }); }
  else if (d.kick) send('kick', { index: +d.kick });
  else if (d.rep) send('replace', { index: +d.rep });
  else if (d.zoom) zoom(d.zoom);
  else command(d.cmd);
});
function command(c) {
  switch (c) {
    case 'cancel': uiTarget = null; render(); break;
    case 'log': logOpen = !logOpen; render(); break;
    case 'rules': rules(true); break;
    case 'rules-close': rules(false); break;
    case 'share': share(); break;
    case 'addbot': send('addbot', {}); break;
    case 'start': send('start', {}); break;
    case 'again': send('restart', {}); break;
    case 'restart': if (confirm('Restart the game with the same players?')) send('restart', {}); break;
    case 'lobby': if (snap.game.phase === 'over' || confirm('End this game and go back to the lobby?')) send('lobby', {}); break;
    case 'leave':
      if (!snap || !snap.game || snap.game.phase === 'over' || !snap.game.players[snap.game.you].alive || confirm('Leave the game? A bot will take your seat.')) leaveRoom();
      break;
  }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('zoom').classList.add('hidden'); rules(false); closeMenu(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('role') === 'button') { e.preventDefault(); e.target.click(); }
  if (e.key === 'Enter' && e.target.closest && e.target.closest('#homeform') && e.target.tagName === 'INPUT') implicitSubmit = true;
});
document.addEventListener('submit', e => {
  if (e.target.id === 'homeform') return submitHome(e);
  if (e.target.id === 'voiceform') {
    e.preventDefault();
    const v = $('voice');
    let link = v.value.trim();
    if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link; // people paste "discord.gg/…"
    v.value = link;
    if (session) post('settings', withRoom({ voice: link })).then(() => { voiceDirty = false; v.blur(); }, err => toast(err.message));
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  if (e.target.id === 'voice') voiceDirty = true;
  if (e.target.id === 'win') { winDrag = true; $('wl').textContent = e.target.value; }
});
document.addEventListener('change', e => {
  if (e.target.id === 'win') { winDrag = false; send('settings', { windowSec: +e.target.value }); }
});

if (session) connect();
render();
