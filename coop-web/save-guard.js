// Keeps a save from a newer game version from locking the game. Plain ES5; runs before the game on every
// platform (phone apps: inlined into index.html by scripts/patch-web.mjs; desktop: injected by main.mjs).
// window.PRS_GAME_VERSION must be set first (the version of the bundled game, "1.12.2.6").
//
// What the game does by itself: 导入数据 writes any file that parses, then reloads; at start-up a save whose
// gameVersion is higher than the game's is refused with 「你的游戏版本已过期」 and nothing else can be done:
// every start ends on that message until the app's data is cleared (player reports 11-14).
// What this adds:
//   - importing such a file (a newer official version, or another modified version with a higher number): it
//     is not written as it is. It is cut down to what this version knows (see trim below) and, after the reload,
//     the player is asked whether to import that; the save from before is kept as a backup and can be put back
//     on each of the next UNDO_STARTS starts. If it cannot be cut down, nothing is written and a notice says why;
//   - a save that is already stored with a higher version (imported before this fix): its version field is
//     set to this game's so that it loads; the version it had is kept in localStorage 'prsTooNew_<key>';
//   - a file that cannot be read at all (the game throws and shows nothing): a notice.
(function () {
  'use strict';
  if (window.PRS_SAVE_GUARD) return;
  var CUR = String(window.PRS_GAME_VERSION || '');
  var rawSet = Storage.prototype.setItem;
  var OFFER = 'prs-import-offer', TRIMMED = 'prs-import-trimmed', UNDO = 'prsImportUndo', BACKUP = 'prsImportBackup_', UNDO_STARTS = 3;

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

  // buttons: [[label, fn], ...]; without any, one 知道了
  function notice(title, lines, buttons) {
    function show() {
      var old = document.getElementById('prsSaveNotice'); if (old) old.parentNode.removeChild(old);
      var d = document.createElement('div'), i;
      d.id = 'prsSaveNotice';
      d.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.6);color:#f1eef5;font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px;box-sizing:border-box';
      var html = '<div style="max-width:520px;max-height:100%;overflow:auto;padding:16px 18px;border-radius:12px;background:#2b2633"><div style="font-size:17px;font-weight:700;margin-bottom:6px">' + title + '</div>';
      for (i = 0; i < lines.length; i++) html += '<div style="margin-top:4px">' + lines[i] + '</div>';
      var bs = buttons && buttons.length ? buttons : [['知道了', null]];
      html += '<div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:10px">';
      for (i = 0; i < bs.length; i++) html += '<button data-i="' + i + '" style="padding:9px 18px;border:0;border-radius:7px;background:' + (i ? '#4a4356' : '#6d5bd0') + ';color:#fff;font-size:15px">' + bs[i][0] + '</button>';
      d.innerHTML = html + '</div></div>';
      // the game listens on window/document: keep these touches and keys away from it
      ['keydown', 'keyup', 'touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
        d.addEventListener(t, function (ev) { ev.stopPropagation(); });
      });
      document.body.appendChild(d);
      var els = d.getElementsByTagName('button');
      for (i = 0; i < els.length; i++) els[i].onclick = function () {
        var f = bs[Number(this.getAttribute('data-i'))][1];
        if (d.parentNode) d.parentNode.removeChild(d);
        if (f) { try { f(); } catch (e) {} }
      };
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
  function esc(s) { return String(s).replace(/[<>&]/g, ''); }

  // ---- a save from another version, cut down to what this version knows ----
  // Needs the running game (window.PRS_SCENE): its list of species and starters is the whitelist. Kept: Pokédex
  // entries and starter progress of species this version has (forms and variants it does not have are dropped),
  // eggs of this version's starters, stats, achievements, vouchers, unlocks. Dropped: everything about species
  // this version does not have, each starter's saved moveset (move numbers may differ between versions; the
  // starter screen gives the default moves again), eggs without a species. Returns {text, report} or null.
  function trim(text) {
    var s = window.PRS_SCENE, gd = s && s.gameData, B = window.BigInt;
    if (!gd || !B || typeof gd.initDexData !== 'function' || typeof gd.initStarterData !== 'function') return null;
    var d = JSON.parse(text);
    if (!d || typeof d !== 'object' || !d.dexData || typeof d.dexData !== 'object') return null;
    // this version's defaults, built on a scratch object so that the running game's data is not touched
    var scratch = Object.create(Object.getPrototypeOf(gd));
    scratch.initDexData(); scratch.initStarterData();
    var dex0 = scratch.dexData, st0 = scratch.starterData;
    if (!dex0 || !st0 || Object.keys(dex0).length < 100 || Object.keys(st0).length < 50) return null;
    var species = {};
    try { s.randomSpecies(1, 1, false, function (sp) { species[sp.speciesId] = sp; return false; }); } catch (e) {}
    var ZERO = B(0), LOW = B(1 | 2 | 4 | 8 | 16 | 128), LIMIT = B(0x80000000);
    function big(v) { try { if (typeof v === 'number' && isFinite(v) && v >= 0) return B(Math.floor(v)); if (typeof v === 'string' && /^\d{1,60}$/.test(v)) return B(v); } catch (e) {} return ZERO; }
    function out(b) { return b <= LIMIT ? Number(b) : b.toString(); } // the way the game writes them
    function maskOf(id) { try { if (species[id]) return species[id].getFullUnlocksData(); } catch (e) {} return LOW; }
    function int(v, lo, hi) { v = Math.floor(Number(v)); if (!isFinite(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }
    function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    var BIG = 2147483647, rep = { dexKept: 0, dexDropped: 0, starters: 0, startersReset: 0, eggs: 0, eggsDropped: 0 }, k;

    var dex = {};
    for (k in d.dexData) {
      if (!Object.prototype.hasOwnProperty.call(d.dexData, k)) continue;
      var src = d.dexData[k], def = dex0[k];
      if (!def || !isObj(src)) { rep.dexDropped++; continue; }
      var mask = maskOf(k), ivs = [], i;
      for (i = 0; i < 6; i++) ivs.push(int(Array.isArray(src.ivs) ? src.ivs[i] : 0, 0, 31));
      var caught = big(src.caughtAttr) & mask, seen = (big(src.seenAttr) & mask) | caught;
      dex[k] = {
        seenAttr: out(seen), caughtAttr: out(caught), natureAttr: int(src.natureAttr, 0, 0x3FFFFFE) & 0x3FFFFFE,
        seenCount: int(src.seenCount, 0, BIG), caughtCount: int(src.caughtCount, 0, BIG), hatchedCount: int(src.hatchedCount, 0, BIG),
        ivs: ivs, ribbons: typeof src.ribbons === 'string' && /^[0-9a-fA-F]{1,16}$/.test(src.ribbons) ? src.ribbons : '0'
      };
      if (caught === ZERO) { dex[k].natureAttr = 0; dex[k].caughtCount = 0; dex[k].hatchedCount = 0; }
      rep.dexKept++;
    }
    // species the file does not have: this version's default entry (the three starter families are caught by default)
    function dexOf(id) { return dex[id] || { caughtAttr: out(dex0[id] ? dex0[id].caughtAttr : ZERO), caughtCount: 0, hatchedCount: 0 }; }

    var starters = {}, sd = isObj(d.starterData) ? d.starterData : {};
    for (k in st0) {
      if (!Object.prototype.hasOwnProperty.call(st0, k)) continue;
      var a = st0[k], b = sd[k];
      var e = { moveset: null, eggMoves: 0, candyCount: 0, friendship: 0, abilityAttr: a.abilityAttr || 0, passiveAttr: 0, valueReduction: 0, classicWinCount: 0, pity: [0, 0] };
      if (isObj(b)) {
        e.eggMoves = int(b.eggMoves, 0, 15) & 15; e.candyCount = int(b.candyCount, 0, 9999); e.friendship = int(b.friendship, 0, BIG);
        e.abilityAttr = (int(b.abilityAttr, 0, 7) & 7) | e.abilityAttr; e.passiveAttr = int(b.passiveAttr, 0, 3) & 3;
        e.valueReduction = int(b.valueReduction, 0, 2); e.classicWinCount = int(b.classicWinCount, 0, BIG);
        if (Array.isArray(b.pity)) e.pity = [int(b.pity[0], 0, BIG), int(b.pity[1], 0, BIG)];
        rep.starters++;
        // the game refuses to save when a starter has progress but was never caught: such progress is dropped
        var dx = dexOf(k), never = !int(dx.caughtCount, 0, BIG) && !int(dx.hatchedCount, 0, BIG) && big(dx.caughtAttr) === ZERO;
        if (never && (e.eggMoves || e.passiveAttr || e.valueReduction || e.abilityAttr)) { e.eggMoves = 0; e.passiveAttr = 0; e.valueReduction = 0; e.abilityAttr = a.abilityAttr || 0; rep.startersReset++; }
      }
      starters[k] = e;
    }

    var eggs = [], list = Array.isArray(d.eggs) ? d.eggs : [];
    for (k = 0; k < list.length; k++) {
      var g = list[k];
      if (!isObj(g) || !st0[g.species] || !species[g.species] || !isFinite(Number(g.id))) { rep.eggsDropped++; continue; }
      eggs.push({
        id: Math.floor(Number(g.id)), tier: int(g.tier, 0, 3), sourceType: (function (t) { t = Math.floor(Number(t)); return t >= 0 && t <= 4 ? t : 0; })(g.sourceType == null ? g.gachaType : g.sourceType), hatchWaves: int(g.hatchWaves, 1, 200),
        timestamp: int(g.timestamp, 0, 8640000000000000), variantTier: int(g.variantTier, 0, 2), isShiny: !!g.isShiny, species: Number(g.species),
        eggMoveIndex: int(g.eggMoveIndex, 0, 3), overrideHiddenAbility: !!g.overrideHiddenAbility
      });
      rep.eggs++;
    }
    // flat tables: only plain numbers and yes/no
    function flat(o) { var r = {}, n; if (isObj(o)) for (n in o) if (Object.prototype.hasOwnProperty.call(o, n) && ((typeof o[n] === 'number' && isFinite(o[n])) || typeof o[n] === 'boolean')) r[n] = o[n]; return r; }
    function four(a) { var r = [], n; for (n = 0; n < 4; n++) r.push(int(Array.isArray(a) ? a[n] : 0, 0, BIG)); return r; }
    var vc = {}, vsrc = isObj(d.voucherCounts) ? d.voucherCounts : {};
    for (k = 0; k < 4; k++) vc[k] = int(vsrc[k], 0, BIG);
    var res = {
      trainerId: int(d.trainerId, 0, 65535), secretId: int(d.secretId, 0, 65535),
      gender: d.gender === 1 || d.gender === 2 ? d.gender : 0, // 0 = not set: the game then keeps the player's own setting
      dexData: dex, starterData: starters, gameStats: flat(d.gameStats), unlocks: flat(d.unlocks),
      achvUnlocks: flat(d.achvUnlocks), voucherUnlocks: flat(d.voucherUnlocks), voucherCounts: vc, eggs: eggs,
      gameVersion: CUR, timestamp: int(d.timestamp, 1, 8640000000000000) > 1 ? int(d.timestamp, 1, 8640000000000000) : Date.now(),
      eggPity: four(d.eggPity), unlockPity: four(d.unlockPity), appliedMigrators: {}
    };
    return { text: JSON.stringify(res), report: rep };
  }

  // 1. an import of a newer save is not written as it is
  Storage.prototype.setItem = function (k, v) {
    try {
      if (this === window.localStorage && isSystemKey(k)) {
        var text = decode(String(v)), ver = versionOf(text);
        if (tooNew(ver)) {
          var t = null;
          try { t = trim(text); } catch (e) { t = null; }
          try {
            if (t) { sessionStorage.setItem(TRIMMED, t.text); sessionStorage.setItem(OFFER, JSON.stringify({ key: String(k), ver: ver, report: t.report })); }
            else sessionStorage.setItem('prs-import-refused', ver);
          } catch (e) { try { sessionStorage.removeItem(TRIMMED); sessionStorage.removeItem(OFFER); sessionStorage.setItem('prs-import-refused', ver); } catch (e2) {} }
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

  var refused = null, offer = null, trimmed = null, undo = null;
  try { refused = sessionStorage.getItem('prs-import-refused'); sessionStorage.removeItem('prs-import-refused'); } catch (e) {}
  try {
    offer = JSON.parse(sessionStorage.getItem(OFFER) || 'null'); trimmed = sessionStorage.getItem(TRIMMED);
    sessionStorage.removeItem(OFFER); sessionStorage.removeItem(TRIMMED);
  } catch (e) { offer = null; }
  try { undo = JSON.parse(localStorage.getItem(UNDO) || 'null'); } catch (e) { undo = null; }
  function dropUndo() { try { if (undo && undo.key) localStorage.removeItem(BACKUP + undo.key); localStorage.removeItem(UNDO); } catch (e) {} }

  if (offer && offer.key && trimmed && versionOf(trimmed) === CUR) {
    var r = offer.report || {};
    notice('这个存档来自别的版本', [
      '文件是 ' + esc(offer.ver) + ' 版的，这一版是 ' + esc(CUR) + '，原样读不了。可以只导入这一版认识的部分：',
      '图鉴 ' + (r.dexKept || 0) + ' 种保留' + (r.dexDropped ? '，' + r.dexDropped + ' 种这一版没有、不导入' : '') + '；初始宝可梦的糖果、特性、被动、蛋招式保留，带的招式回到默认'
        + (r.eggs || r.eggsDropped ? '；蛋 ' + (r.eggs || 0) + ' 个保留' + (r.eggsDropped ? '、' + r.eggsDropped + ' 个不导入' : '') : '') + '；统计、成就、兑换券保留。',
      '那个版本改过的数值、多出来的宝可梦和形态带不过来。现在的存档会留一份备份，之后 ' + UNDO_STARTS + ' 次打开游戏都可以换回去。',
    ], [
      ['导入这一部分', function () {
        try {
          var cur = localStorage.getItem(offer.key);
          if (cur != null) rawSet.call(localStorage, BACKUP + offer.key, cur); else localStorage.removeItem(BACKUP + offer.key);
          rawSet.call(localStorage, UNDO, JSON.stringify({ key: offer.key, ver: offer.ver, left: UNDO_STARTS, had: cur != null }));
          rawSet.call(localStorage, offer.key, encode(trimmed));
        } catch (e) { notice('没有导入', ['设备的存储空间不够，原来的存档没有动。']); return; }
        location.reload();
      }],
      ['不导入', null],
    ]);
  } else if (undo && undo.key && undo.left > 0) {
    try { undo.left--; if (undo.left > 0) rawSet.call(localStorage, UNDO, JSON.stringify(undo)); } catch (e) {}
    var last = undo.left <= 0;
    notice('已导入 ' + esc(undo.ver) + ' 版存档里这一版认识的部分', [
      '进游戏看看图鉴和初始宝可梦对不对。导入前的存档还留着备份，不对的话可以换回去。',
      last ? '这是最后一次问：点「留着」以后备份就删掉了。' : '接下来还会再问 ' + undo.left + ' 次。',
    ], [
      ['留着，进游戏', function () { if (last) dropUndo(); }],
      ['换回导入前的存档', function () {
        try {
          var old = localStorage.getItem(BACKUP + undo.key);
          if (old != null) rawSet.call(localStorage, undo.key, old); else if (undo.had === false) localStorage.removeItem(undo.key); else return;
          dropUndo();
        } catch (e) { return; }
        location.reload();
      }],
    ]);
  } else if (refused) {
    notice('这个存档没有导入', [
      '它来自别的版本 ' + esc(refused) + '，这一版是 ' + esc(CUR) + '，读不了，也没能整理成这一版能读的样子。',
      '原来的存档没有动。',
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

  window.PRS_SAVE_GUARD = { version: CUR, cmp: cmp, rescued: rescued, refused: refused, offer: offer, undo: undo, trim: trim };
})();
