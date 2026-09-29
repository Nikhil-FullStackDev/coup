const $app = document.getElementById('app');
const A = Coup.ACTIONS;
const cap = w => w[0].toUpperCase() + w.slice(1);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const img = c => (c ? `img/${c}.png` : 'img/coup-card-back.png');

let session = JSON.parse(localStorage.getItem('coup-session') || 'null'); // {code, token}
let snap = null, es = null, lastErr = '', uiTarget = null, exchSel = [];

async function post(path, body) {
  const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Error');
  return j;
}
const withRoom = b => ({ code: session.code, token: session.token, ...b });
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2500); }
const send = (path, b) => post(path, withRoom(b)).catch(e => toast(e.message));
const move = m => { uiTarget = null; return send('move', { move: m }); };

function connect() {
  if (es) es.close();
  es = new EventSource(`/api/events?code=${session.code}&token=${session.token}`);
  es.onmessage = e => { snap = JSON.parse(e.data); render(); };
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) { leave(); lastErr = 'Room closed.'; render(); } };
}
function leave() { if (es) es.close(); es = null; snap = null; session = null; localStorage.removeItem('coup-session'); }
function setSession(r) { session = { code: r.code, token: r.token }; localStorage.setItem('coup-session', JSON.stringify(session)); connect(); }

// ---------- screens ----------
function home() {
  $app.innerHTML = `<div class="center"><h1>COUP</h1>
    <input id="name" placeholder="Your name" maxlength="14" value="${esc(localStorage.getItem('coup-name') || '')}">
    <button class="primary" id="create">Create room</button>
    <div class="row"><input id="code" placeholder="Room code" maxlength="4" style="text-transform:uppercase"><button id="join">Join</button></div>
    <div class="err">${esc(lastErr)}</div>
    </div>`;
  const nm = () => { const v = document.getElementById('name').value.trim(); localStorage.setItem('coup-name', v); return v; };
  const go = p => async () => { try { setSession(await p()); lastErr = ''; } catch (e) { lastErr = e.message; home(); } };
  document.getElementById('create').onclick = go(() => post('create', { name: nm() }));
  document.getElementById('join').onclick = go(() => post('join', { name: nm(), code: document.getElementById('code').value }));
}

const voiceBtn = s => (s.voice ? `<a href="${esc(s.voice)}" target="_blank" rel="noopener noreferrer"><button style="width:100%">🎙 Join voice chat</button></a>` : '');

function lobby() {
  const s = snap;
  $app.innerHTML = `<div class="center"><div class="dim" style="text-align:center">Room code — share with friends</div>
    <div class="code">${s.code}</div>
    <ul class="plist">${s.lobby.map((p, i) => `<li><span>${esc(p.name)}${i === s.you ? ' (you)' : ''}${i === 0 ? ' ★' : ''}</span><span class="dim">${p.connected ? '' : 'offline '}
      ${s.host && i > 0 ? `<button data-kick="${i}">Remove</button>` : ''}</span></li>`).join('')}</ul>
    ${voiceBtn(s)}
    ${s.host ? `<div class="row"><input id="voice" placeholder="Voice chat link (Discord / Meet / WhatsApp…)" value="${esc(s.voice)}"><button id="setvoice">Set</button></div>
      <div class="row"><span class="dim" style="flex:1">Challenge window: <b id="wl">${s.windowSec}</b>s</span><input id="win" type="range" min="4" max="30" value="${s.windowSec}" style="flex:2"></div>
      <div class="row"><button id="bot" ${s.lobby.length >= 6 ? 'disabled' : ''}>+ Add bot</button>
      <button class="primary" id="start" ${s.lobby.length < 2 ? 'disabled' : ''}>Start game</button></div>` : '<div class="dim" style="text-align:center">Waiting for host to start…</div>'}
    <div class="row"><button id="leave">Leave</button></div></div>`;
  document.getElementById('leave').onclick = () => { leave(); render(); };
  if (s.host) {
    document.getElementById('setvoice').onclick = () => send('settings', { voice: document.getElementById('voice').value });
    const w = document.getElementById('win');
    w.oninput = () => { document.getElementById('wl').textContent = w.value; };
    w.onchange = () => send('settings', { windowSec: +w.value });
    document.getElementById('bot').onclick = () => send('addbot', {});
    document.getElementById('start').onclick = () => send('start', {});
    document.querySelectorAll('[data-kick]').forEach(b => b.onclick = () => send('kick', { index: +b.dataset.kick }));
  }
}

function cardsHtml(p, mine, pick) {
  return `<div class="cards">${p.cards.map((c, i) => `<div class="card ${c.dead ? 'dead' : ''} ${pick && !c.dead ? 'pick' : ''}" data-i="${i}" title="${c.c ? cap(c.c) : ''}" style="background-image:url(${img(c.c)})"></div>`).join('')}</div>`;
}

function describe(g) {
  const pd = g.pending, nm = i => esc(g.players[i].name);
  if (g.phase === 'over') return `🏆 ${nm(g.winner)} wins!`;
  if (g.phase === 'action') return `${nm(g.turn)}'s turn`;
  if (g.phase === 'lose') return `${nm(g.lose.player)} loses an influence`;
  if (g.phase === 'exchange') return `${nm(g.exch.player == null ? g.you : g.exch.player)} is exchanging`;
  let t = `${nm(pd.actor)}: <b>${Coup.LABEL[pd.action]}</b>${pd.target != null ? ' → ' + nm(pd.target) : ''}`;
  if (pd.claim) t += ` <span class="dim">(${cap(pd.claim)})</span>`;
  if (pd.block) t += `<br>🛡 ${nm(pd.block.by)} blocks <span class="dim">(${pd.block.chars.map(cap).join(' / ')})</span>`;
  return t;
}

function game() {
  const g = snap.game, me = g.players[g.you], myTurn = g.waiting.includes(g.you);
  const opps = g.players.filter(p => p.id !== g.you);
  const needTarget = uiTarget && A[uiTarget].target;
  let prompt = '', reactBar = '';
  const pd = g.pending;
  if (g.phase === 'window') {
    const btns = [];
    if (g.can.passed) btns.push(`<span class="dim">Waiting for others…</span>`);
    else if (g.can.challenge) btns.push(`<button class="danger big" data-mv="challenge">Challenge</button><button class="big" data-mv="pass">No</button>`);
    else if (g.can.block) btns.push(`<button class="danger big" data-mv="block">Block</button><button class="big" data-mv="pass">No</button>`);
    reactBar = `<div class="timer"><div id="bar" data-ms="${g.msLeft}" data-total="${g.windowMs}"></div></div>`;
    prompt = btns.join('');
  } else if (myTurn && me.alive) {
    if (g.phase === 'action') {
      const forced = me.coins >= 10;
      const btn = (a, label, ok = true) => `<button data-act="${a}" ${ok && (!forced || a === 'coup') ? '' : 'disabled'}>${label}</button>`;
      prompt = `<div class="actions">${btn('income', 'Income')}${btn('aid', 'Foreign Aid')}${btn('coup', 'Coup (7)', me.coins >= 7)}
        ${btn('tax', 'Tax')}${btn('assassinate', 'Assassinate (3)', me.coins >= 3)}${btn('steal', 'Steal')}${btn('exchange', 'Exchange')}</div>
        ${needTarget ? `<div class="dim" style="width:100%;text-align:center">Click a player above <button data-cancel>Cancel</button></div>` : ''}`;
    } else if (g.phase === 'lose') {
      prompt = `<b>Click a card to lose it.</b>`;
    } else if (g.phase === 'exchange') {
      prompt = `<b>Keep ${g.exch.keep}:</b>
        <div class="cards" style="justify-content:center">${g.exch.options.map((c, i) => `<div class="card pick ${exchSel.includes(i) ? 'sel' : ''}" data-ex="${i}" style="width:100px;background-image:url(${img(c)})"></div>`).join('')}</div>
        <button class="primary" data-keep ${exchSel.length === g.exch.keep ? '' : 'disabled'}>Confirm</button>`;
    }
  } else if (g.phase === 'over') {
    prompt = snap.host ? `<button class="primary" id="again">Play again</button>` : '<span class="dim">Waiting for host…</span>';
  } else if (!me.alive) prompt = '<span class="dim">You are out — spectating.</span>';

  const pickLose = myTurn && g.phase === 'lose';
  $app.innerHTML = `<div class="game"><div class="main">
    <div class="opps">${opps.map(p => `<div class="seat ${g.turn === p.id ? 'turn' : ''} ${p.alive ? '' : 'out'} ${needTarget && p.alive ? 'target' : ''}" data-p="${p.id}">
      <div class="nm">${esc(p.name)}</div><div class="coins">🪙 ${p.coins}</div>${cardsHtml(p)}</div>`).join('')}</div>
    <div class="table"><div class="banner">${describe(g)}</div>${reactBar}<div class="prompt">${g.phase === 'exchange' || g.phase === 'action' ? '' : prompt}</div></div>
    <div class="mine me ${g.turn === g.you ? 'turn' : ''}"><div style="text-align:center"><div class="nm">${esc(me.name)} (you)</div><div class="coins">🪙 ${me.coins}</div>${cardsHtml(me, true, pickLose)}</div>
      ${g.phase === 'exchange' || g.phase === 'action' ? `<div style="flex:1;min-width:260px" class="prompt">${prompt}</div>` : ''}</div>
    </div>
    <div class="side"><div class="row"><b style="flex:1">Room ${snap.code}</b><button id="leave">Leave</button></div>
      ${snap.host ? '<button id="restart">↻ Restart game</button>' : ''}
      ${voiceBtn(snap)}<div class="dim">Deck: ${g.deck} cards</div>
      ${snap.host ? snap.lobby.map((p, i) => (!p.bot && !p.connected && i ? `<button data-rep="${i}">Bot replaces ${esc(p.name)}</button>` : '')).join('') : ''}
    </div></div>${rules()}`;

  const q = s => document.querySelectorAll(s);
  q('[data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (A[a].target) { uiTarget = a; game(); } else move({ type: 'action', action: a });
  });
  q('[data-cancel]').forEach(b => b.onclick = () => { uiTarget = null; game(); });
  q('.seat.target').forEach(s => s.onclick = () => move({ type: 'action', action: uiTarget, target: +s.dataset.p }));
  q('[data-mv]').forEach(b => b.onclick = () => move({ type: b.dataset.mv }));
  q('.mine .card.pick').forEach(c => c.onclick = () => move({ type: 'lose', index: +c.dataset.i }));
  q('[data-ex]').forEach(c => c.onclick = () => {
    const i = +c.dataset.ex;
    exchSel = exchSel.includes(i) ? exchSel.filter(x => x !== i) : [...exchSel, i].slice(-g.exch.keep);
    game();
  });
  q('[data-keep]').forEach(b => b.onclick = () => { const k = exchSel; exchSel = []; move({ type: 'keep', keep: k }); });
  q('[data-rep]').forEach(b => b.onclick = () => send('replace', { index: +b.dataset.rep }));
  const again = document.getElementById('again'); if (again) again.onclick = () => send('restart', {});
  const rs = document.getElementById('restart'); if (rs) rs.onclick = () => { if (confirm('Restart the game with the same players?')) send('restart', {}); };
  document.getElementById('leave').onclick = () => { leave(); render(); };
  const bar = document.getElementById('bar');
  if (bar) {
    const end = Date.now() + +bar.dataset.ms, total = +bar.dataset.total;
    clearInterval(barTimer);
    const upd = () => { bar.style.width = Math.max(0, (end - Date.now()) / total * 100) + '%'; };
    upd(); barTimer = setInterval(upd, 100);
  } else clearInterval(barTimer);
}

function rules() {
  return `<section class="rules"><h2>Rules</h2>
    <p class="dim">Be the last player with influence (cards). Talk it out over voice chat: after a declaration, everyone answers Challenge / No. Blocks work the same way.</p>
    <img src="img/actions-reference.png" alt="Actions"><img src="img/reactions-reference.png" alt="Reactions"><img src="img/reminders-reference.png" alt="Reminders"></section>`;
}

let lastPhaseKey = '', barTimer = null;
function render() {
  if (!session || !snap) return home();
  const key = snap.game ? snap.game.phase + snap.game.turn + snap.game.stageNo : '';
  if (key !== lastPhaseKey) { uiTarget = null; exchSel = []; lastPhaseKey = key; }
  snap.game ? game() : lobby();
}

if (session) connect(); else home();
