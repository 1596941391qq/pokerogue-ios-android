// Keeps a save from a newer game version from locking the game. Plain ES5; runs before the game on every
// platform (phone apps: inlined into index.html by scripts/patch-web.mjs; desktop: injected by main.mjs).
// window.PRS_GAME_VERSION must be set first (the version of the bundled game, "1.12.2.6").
//
// What the game does by itself: 导入数据 writes any file that parses, then reloads; at start-up a save whose
// gameVersion is higher than the game's is refused with 「你的游戏版本已过期」 and nothing else can be done:
// every start ends on that message until the app's data is cleared (player reports 11-14).
// What this adds:
//   - importing such a file: nothing is written, the old save stays, a notice says why;
//   - a save that is already stored with a higher version (imported before this fix): its version field is
//     set to this game's so that it loads; the version it had is kept in localStorage 'prsTooNew_<key>';
//   - a file that cannot be read at all (the game throws and shows nothing): a notice.
(function () {
  'use strict';
  if (window.PRS_SAVE_GUARD) return;
  var CUR = String(window.PRS_GAME_VERSION || '');
  var rawSet = Storage.prototype.setItem;

  function cmp(a, b) { // dotted numbers, like the game's own check: 1 when a is newer
    var x = String(a).split('.'), y = String(b).split('.'), i, p, q;
    for (i = 0; i < Math.max(x.length, y.length); i++) {
      p = parseInt(x[i], 10) || 0; q = parseInt(y[i], 10) || 0;
      if (p !== q) return p > q ? 1 : -1;
    }
    return 0;
  }
  // offline builds store data as btoa(encodeURIComponent(json))
  function decode(v) { try { return decodeURIComponent(atob(v)); } catch (e) { return null; } }
  function encode(t) { return btoa(encodeURIComponent(t)); }
  var VER = /"gameVersion":"([^"]*)"/;
  function versionOf(text) { var m = text && VER.exec(text); return m ? m[1] : null; }
  function tooNew(v) { return !!(CUR && v && cmp(v, CUR) > 0); }
  function isSystemKey(k) { return /^data_/.test(String(k)); }

  function notice(title, lines) {
    function show() {
      var old = document.getElementById('prsSaveNotice'); if (old) old.parentNode.removeChild(old);
      var d = document.createElement('div');
      d.id = 'prsSaveNotice';
      d.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.6);color:#f1eef5;font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px;box-sizing:border-box';
      var html = '<div style="max-width:520px;padding:16px 18px;border-radius:12px;background:#2b2633"><div style="font-size:17px;font-weight:700;margin-bottom:6px">' + title + '</div>';
      for (var i = 0; i < lines.length; i++) html += '<div style="margin-top:4px">' + lines[i] + '</div>';
      d.innerHTML = html + '<button id="prsSaveOk" style="margin-top:14px;padding:9px 22px;border:0;border-radius:7px;background:#6d5bd0;color:#fff;font-size:15px">知道了</button></div>';
      // the game listens on window/document: keep these touches and keys away from it
      ['keydown', 'keyup', 'touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
        d.addEventListener(t, function (ev) { ev.stopPropagation(); });
      });
      document.body.appendChild(d);
      document.getElementById('prsSaveOk').onclick = function () { d.parentNode && d.parentNode.removeChild(d); };
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
  function esc(s) { return String(s).replace(/[<>&]/g, ''); }

  // 1. an import of a newer save is not written
  Storage.prototype.setItem = function (k, v) {
    try {
      if (this === window.localStorage && isSystemKey(k)) {
        var ver = versionOf(decode(String(v)));
        if (tooNew(ver)) {
          try { sessionStorage.setItem('prs-import-refused', ver); } catch (e) {}
          return undefined;
        }
      }
    } catch (e) {}
    return rawSet.apply(this, arguments);
  };

  // 2. a newer save that is already stored: make it load
  var rescued = null;
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!isSystemKey(k)) continue;
      var text = decode(localStorage.getItem(k)), ver = versionOf(text);
      if (!tooNew(ver)) continue;
      rawSet.call(localStorage, 'prsTooNew_' + k, ver);
      rawSet.call(localStorage, k, encode(text.replace(VER, '"gameVersion":"' + CUR + '"')));
      rescued = ver;
    }
  } catch (e) {}

  var refused = null;
  try { refused = sessionStorage.getItem('prs-import-refused'); sessionStorage.removeItem('prs-import-refused'); } catch (e) {}
  if (refused) {
    notice('这个存档没有导入', [
      '它来自更高的游戏版本 ' + esc(refused) + '，这一版是 ' + esc(CUR) + '，读不了。',
      '原来的存档没有动。等这边更新到同样的版本再导入；别的修改版导出的存档这里读不了。',
    ]);
  } else if (rescued) {
    notice('存档来自更高的游戏版本', [
      '存档是 ' + esc(rescued) + ' 版的，这一版是 ' + esc(CUR) + '。之前会一直停在「游戏版本已过期」，现在按这一版来读。',
      '如果图鉴、道具有不对的地方，是那个版本多出来的内容这一版没有。',
    ]);
  }

  // 3. a file the game cannot read: it throws inside its file reader and shows nothing
  window.addEventListener('error', function (e) {
    if (e && /Malformed UTF-8/.test(String(e.message || ''))) {
      notice('这个文件读不出来', ['它不是这个游戏导出的存档（.prsv），或者文件不完整。原来的存档没有动。']);
    }
  });

  window.PRS_SAVE_GUARD = { version: CUR, cmp: cmp, rescued: rescued, refused: refused };
})();
