// Hides the on-screen buttons while the player is using a controller (phone apps).
// Loaded by index.html (scripts/patch-web.mjs adds the tag).
//   - a controller connects, or one of its buttons / sticks is used  -> buttons hide;
//   - the screen is touched, or the last controller disconnects      -> buttons come back.
// Touching the screen always brings the buttons back, so a device that wrongly reports itself as a
// controller can never leave the player without buttons.
(function () {
  'use strict';
  var hidden = false, timer = null;
  var css = document.createElement('style');
  css.textContent = 'body.prs-pad > #touchControls{display:none !important}' +
    '@media (pointer: coarse){body.prs-pad #app{align-items:center !important}' +
    'body.prs-pad #app > div:first-child{transform-origin:center !important}}';
  (document.head || document.documentElement).appendChild(css);

  function pads() {
    var list = [];
    try {
      var all = navigator.getGamepads ? navigator.getGamepads() : [];
      for (var i = 0; i < all.length; i++) if (all[i] && all[i].connected) list.push(all[i]);
    } catch (e) {}
    return list;
  }
  function inUse(pad) {
    var i;
    for (i = 0; i < pad.buttons.length; i++) if (pad.buttons[i].pressed || pad.buttons[i].value > 0.5) return true;
    for (i = 0; i < pad.axes.length; i++) if (Math.abs(pad.axes[i]) > 0.6) return true;
    return false;
  }
  function set(hide) {
    if (hide === hidden || !document.body) return;
    hidden = hide;
    document.body.classList.toggle('prs-pad', hide);
    window.dispatchEvent(new Event('resize')); // the game re-fits its canvas
    if (timer) { clearInterval(timer); timer = null; }
    // Buttons are showing but a controller is still there: watch for it being used again.
    if (!hide && pads().length) timer = setInterval(watch, 200);
  }
  function watch() {
    var list = pads();
    if (!list.length) { clearInterval(timer); timer = null; return; }
    for (var i = 0; i < list.length; i++) if (inUse(list[i])) return set(true);
  }
  window.addEventListener('gamepadconnected', function () { set(true); });
  window.addEventListener('gamepaddisconnected', function () { setTimeout(function () { if (!pads().length) set(false); }, 0); });
  window.addEventListener('touchstart', function () { if (hidden) set(false); }, true);
  window.PRS_PAD = { hidden: function () { return hidden; }, set: set };
})();
