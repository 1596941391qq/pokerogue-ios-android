// Hides the on-screen buttons while the player is really using a controller (phone apps).
// Loaded by index.html (scripts/patch-web.mjs adds the tag).
//   - a button of a controller goes down, or a stick is moved      -> buttons hide;
//   - the screen is touched, or the last controller disconnects    -> buttons come back.
// A controller merely being "connected" hides nothing: many Android phones report a fingerprint key,
// a stylus or a sensor as a gamepad, some with a button or an axis stuck on. Only a change counts
// (a button that was up going down, a stick leaving where it rested), and when the player has to
// bring the buttons back by touch twice shortly after they were hidden, hiding is switched off for
// the rest of the session.
// The player can also switch the buttons off by hand (联机 panel on the title screen -> 屏幕按键), for a
// controller or keyboard this script does not notice. That choice is kept (localStorage 'prs-keys-off');
// while it is on, a small 「按键」 tag stays at the left edge and brings the buttons back when touched.
(function () {
  'use strict';
  var hidden = false, timer = null, off = false;
  var manual = false, chip = null; // switched off by hand
  try { manual = localStorage.getItem('prs-keys-off') === '1'; } catch (e) {}
  var last = {};          // pad index -> { b: [pressed...], a: [axis values...] } from the previous poll
  var hiddenAt = 0, shownAt = 0, fights = 0;
  var FAKE = /uinput|fingerprint|fpc|goodix|gf_|sensor|accel|gyro|touch|stylus|pen|keypad|gpio|pwrkey|power|hall|headset|jack|virtual/i;
  var css = document.createElement('style');
  css.textContent = 'body.prs-pad > #touchControls{display:none !important}' +
    '#prsKeysChip{position:fixed;left:max(4px,env(safe-area-inset-left));top:50%;transform:translateY(-50%);z-index:2147483000;padding:10px 6px;' +
    'border-radius:9px;background:rgba(43,38,51,.55);color:rgba(241,238,245,.8);border:1px solid rgba(255,255,255,.25);' +
    'font:11px/1.2 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;writing-mode:vertical-rl;letter-spacing:2px}' +
    '@media (pointer: coarse){body.prs-pad #app{align-items:center !important}' +
    'body.prs-pad #app > div:first-child{transform-origin:center !important}}';
  (document.head || document.documentElement).appendChild(css);

  var any = 0; // connected devices of any kind at the last look, the ignored ones included
  function pads() {
    var list = [];
    any = 0;
    try {
      var all = navigator.getGamepads ? navigator.getGamepads() : [];
      for (var i = 0; i < all.length; i++) {
        var p = all[i];
        if (!p || !p.connected) continue;
        any++;
        if (!FAKE.test(p.id || '') && p.buttons && p.buttons.length >= 4) list.push(p);
      }
    } catch (e) {}
    return list;
  }
  // true when this controller did something since the previous poll
  function used(pad) {
    var prev = last[pad.index], now = { b: [], a: [] }, i, act = false;
    for (i = 0; i < pad.buttons.length; i++) now.b.push(!!(pad.buttons[i].pressed || pad.buttons[i].value > 0.5));
    for (i = 0; i < pad.axes.length; i++) now.a.push(pad.axes[i] || 0);
    last[pad.index] = now;
    if (!prev) return false; // first sight: whatever is held or tilted now is its resting state
    for (i = 0; i < now.b.length; i++) if (now.b[i] && prev.b[i] === false) act = true;
    for (i = 0; i < now.a.length; i++) if (Math.abs(now.a[i]) > 0.6 && Math.abs(now.a[i] - (prev.a[i] || 0)) > 0.3) act = true;
    return act;
  }
  // the class follows both reasons to hide: a controller in use, or the player's own switch
  function apply() {
    if (!document.body) return;
    var want = hidden || manual;
    if (document.body.classList.contains('prs-pad') !== want) {
      document.body.classList.toggle('prs-pad', want);
      window.dispatchEvent(new Event('resize')); // the game re-fits its canvas
    }
    if (manual && !chip) {
      chip = document.createElement('div');
      chip.id = 'prsKeysChip'; chip.textContent = '按键';
      ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
        chip.addEventListener(t, function (ev) { ev.stopPropagation(); if (t === 'click') setManual(false); });
      });
      document.body.appendChild(chip);
    } else if (!manual && chip) { chip.remove(); chip = null; }
  }
  function set(hide) {
    if (hide === hidden || !document.body) return;
    hidden = hide;
    if (hide) hiddenAt = Date.now(); else shownAt = Date.now();
    apply();
  }
  function setManual(on) {
    manual = !!on;
    try { localStorage.setItem('prs-keys-off', manual ? '1' : '0'); } catch (e) {}
    apply();
  }
  function watch() {
    var list = pads(), act = false;
    if (!list.length) { last = {}; set(false); if (!any) { clearInterval(timer); timer = null; } return; }
    for (var i = 0; i < list.length; i++) if (used(list[i])) act = true;
    // just brought back by touch: leave them alone for a moment
    if (act && !hidden && !off && Date.now() - shownAt > 3000) set(true);
  }
  function start() { if (!timer && !off) timer = setInterval(watch, 150); }
  window.addEventListener('gamepadconnected', start);
  window.addEventListener('gamepaddisconnected', function () { setTimeout(function () { if (!pads().length) { last = {}; set(false); } }, 0); });
  window.addEventListener('touchstart', function () {
    if (!hidden) return;
    if (Date.now() - hiddenAt < 10000 && ++fights >= 2) { off = true; if (timer) { clearInterval(timer); timer = null; } }
    set(false);
  }, true);
  window.PRS_PAD = { hidden: function () { return hidden; }, off: function () { return off; }, set: set, manual: function () { return manual; }, setManual: setManual };
  if (manual) { if (document.body) apply(); else document.addEventListener('DOMContentLoaded', apply); }
})();
