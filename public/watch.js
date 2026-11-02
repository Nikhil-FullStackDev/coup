/* Spectator helpers shared by the multiplayer games. On the home screen, "Watch" (next to "Join") enters a room as a
   spectator: they see the public table, can chat, and cannot play.

   Watch.chip(snap)      -> html string        "👁 3" when somebody is watching (for the game's header), else ''
   Watch.ribbon(snap)    -> html string        "👁 You're watching" for a spectator's status area, else ''
   Everything is built with textContent or numbers only, so names and messages can never inject markup. */
(function () {
  'use strict';
  var CSS = [
    '.watch-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:99px;background:#ffffff1a;font-size:12.5px;font-weight:700;white-space:nowrap}',
    '.watch-ribbon{display:flex;align-items:center;justify-content:center;gap:6px;padding:5px 12px;border-radius:99px;background:#ffffff14;border:1px dashed #ffffff44;font-size:13px;font-weight:700}'
  ].join('');
  var styled = false;
  function style() {
    if (styled) return; styled = true;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function chip(snap) {
    var n = snap && snap.watching | 0;
    if (!n) return '';
    style();
    return '<span class="watch-chip" title="' + n + (n === 1 ? ' spectator' : ' spectators') + '">👁 ' + n + '</span>';
  }
  function ribbon(snap) {
    if (!snap || !snap.watch) return '';
    style();
    return '<div class="watch-ribbon" role="status">👁 You’re watching' + (snap.watching > 1 ? ' · ' + snap.watching + ' watching' : '') + '</div>';
  }
  window.Watch = { chip: chip, ribbon: ribbon };
})();
