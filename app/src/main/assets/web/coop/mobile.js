// Co-op entry for the phone apps (Android + iOS). Loaded by index.html (scripts/patch-web.mjs adds the tag).
// Adds a small "联机" button on the title screen. From its panel the player can
//   - open a room and be 1P: the host scripts in this folder (same ones the desktop app injects) stream the
//     game to the friend, who joins from any browser (phone or computer) by QR code, link or room code;
//   - open a LAN room: the same, but the join page and the signaling come from this phone itself (the app's
//     own local server; coop/api/lan tells where it is), so it works with no internet: the friend is on the
//     same Wi-Fi or on this phone's hotspot;
//   - join a friend's room as 2P: opens the join page in the system browser.
// Nothing here touches the game until a room is opened.
(function () {
  'use strict';
  var ORIGIN = 'https://192.220.36.155:8790'; // signaling server + join page
  var SCRIPTS = ['coop.js', 'host.js', 'host-team.js', 'host-game.js', 'host-overlay.js', 'host-mods.js', 'mods-bundle.js']; // order matters
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: the code is read aloud and typed
  var IOS = location.protocol === 'pokerogue:'; // the iOS app serves the game under its own scheme
  var room = null, status = ['', ''], panel = null, pill = null;
  var lan = null; // LAN room: { links: one join link per address of this phone, pick: the one shown }

  var css = document.createElement('style');
  css.textContent =
    '#prsCoopPill{position:fixed;top:max(6px,env(safe-area-inset-top));left:max(8px,env(safe-area-inset-left));z-index:2147483000;' +
    'padding:5px 14px;border-radius:14px;background:rgba(43,38,51,.82);color:#f1eef5;font:13px/1.3 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
    'border:1px solid rgba(255,255,255,.25);white-space:nowrap}' +
    '#prsCoopPill.small{padding:2px 8px;font-size:11px;opacity:.6}' +
    '#prsCoopPill.ok{background:rgba(46,125,79,.9)}#prsCoopPill.bad{background:rgba(162,59,59,.9)}' +
    '#prsCoopMask{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}' +
    '#prsCoopCard{box-sizing:border-box;width:min(92vw,430px);max-height:94vh;overflow:auto;padding:14px 16px;border-radius:12px;background:#2b2633;color:#f1eef5;' +
    'font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}' +
    '#prsCoopCard h3{margin:0 0 8px;font-size:16px}#prsCoopCard p{margin:8px 0 0;font-size:12px;color:#b3abc0}' +
    '#prsCoopCard button{padding:8px 14px;border:0;border-radius:7px;background:#6d5bd0;color:#fff;font-size:14px}' +
    '#prsCoopCard button.sub{background:#4a4356}#prsCoopCard button.bad{background:#a23b3b}' +
    '#prsCoopCard .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px}' +
    '#prsCoopCard input{flex:1;min-width:0;padding:8px;border:1px solid #5a5266;border-radius:7px;background:#1f1b26;color:#f1eef5;font:15px ui-monospace,Menlo,monospace;' +
    '-webkit-user-select:text;user-select:text}' +
    '#prsCoopCode{font:700 30px/1.1 ui-monospace,Menlo,monospace;letter-spacing:3px;-webkit-user-select:text;user-select:text}' +
    '#prsCoopQr{width:124px;height:124px;background:#fff;border-radius:6px;flex:none;image-rendering:pixelated}' +
    '#prsCoopStatus{display:inline-block;margin-top:6px;padding:2px 10px;border-radius:12px;font-size:13px;background:#5a5266}' +
    '#prsCoopStatus.ok{background:#2e7d4f}#prsCoopStatus.bad{background:#a23b3b}';
  document.head.appendChild(css);

  function el(tag, attrs, kids) {
    var e = document.createElement(tag), k;
    for (k in attrs || {}) { if (k === 'text') e.textContent = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  // The game listens for keys and touches on window/document: keep what happens inside our UI away from it.
  function shield(e) {
    ['keydown', 'keyup', 'keypress', 'touchstart', 'touchend', 'touchmove', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
      e.addEventListener(t, function (ev) { ev.stopPropagation(); });
    });
    return e;
  }
  function link() { return lan ? lan.links[lan.pick] : ORIGIN + '/coop/guest2.html?room=' + room + '&auto=1'; }
  function uiMode() { var tc = document.getElementById('touchControls'); return (tc && tc.dataset.uiMode) || ''; }

  function setStatus(text, kind) {
    status = [text, kind || ''];
    var s = document.getElementById('prsCoopStatus');
    if (s) { s.textContent = text; s.className = kind || ''; }
    refreshPill();
  }
  function refreshPill() {
    if (!pill) return;
    if (room) {
      // connected and in a run: shrink to a small tag in the corner so it does not cover the battle
      var small = status[1] === 'ok' && uiMode() !== 'TITLE';
      pill.textContent = small ? '联机中' : status[1] === 'ok' ? '房间 ' + room : status[0] + ' · ' + room;
      pill.className = status[1] + (small ? ' small' : ''); pill.style.display = '';
    }
    else { pill.textContent = '联机'; pill.className = ''; pill.style.display = uiMode() === 'TITLE' ? '' : 'none'; }
  }

  // The host scripts report through console lines that start with "COOP" (see host.js).
  var rawLog = console.log;
  console.log = function () {
    try {
      var msg = Array.prototype.join.call(arguments, ' ');
      if (room && msg.indexOf('COOP') === 0) {
        if (/^COOP room open/.test(msg)) setStatus(/here: true/.test(msg) ? '队友已进房间，正在连接…' : '等队友加入');
        else if (/^COOP guest joined/.test(msg)) setStatus('队友已进房间，正在连接…');
        else if (/^COOP state connected/.test(msg)) { setStatus('队友已连接', 'ok'); closePanel(); }
        else if (/^COOP (guest left|state (disconnected|failed|closed))/.test(msg)) setStatus('队友掉线，等队友重新加入', 'bad');
        else if (/^COOP FAIL/.test(msg)) setStatus('开房间失败，请检查网络后关闭房间重开', 'bad');
      }
    } catch (e) {}
    return rawLog.apply(console, arguments);
  };

  function loadScripts(i) {
    if (i >= SCRIPTS.length) return;
    var s = document.createElement('script');
    s.src = './coop/' + SCRIPTS[i];
    s.onload = function () { loadScripts(i + 1); };
    s.onerror = function () { setStatus('开房间失败：缺少文件 ' + SCRIPTS[i], 'bad'); };
    document.head.appendChild(s);
  }
  // the list of mods and their switches (coop/host-mods.js); also works before a room is open
  function openMods() {
    closePanel();
    var files = window.CoopMods ? [] : ['host-mods.js', 'mods-bundle.js'];
    (function next(i) {
      if (i >= files.length) { try { window.CoopMods && window.CoopMods.openPanel(); } catch (e) {} return; }
      var s = document.createElement('script');
      s.src = './coop/' + files[i];
      s.onload = function () { next(i + 1); };
      document.head.appendChild(s);
    })(0);
  }
  var modsRow = function () { return el('div', { class: 'row' }, [el('button', { class: 'sub', text: 'Mod（民间创意工坊）', onclick: openMods })]); };
  var opening = false;
  function openRoom(useLan) {
    if (room || opening) return;
    if (!window.PRS_SCENE) { alert('游戏还没加载完，等标题画面出来再开房间。'); return; }
    if (!window.RTCPeerConnection || !HTMLCanvasElement.prototype.captureStream) { alert('这台设备的系统版本不支持当房主，可以让朋友开房间、你来加入。'); return; }
    var code = '';
    for (var i = 0; i < 6; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
    function start() {
      room = code;
      window.PRS_COOP_ROOM = room;
      setStatus('正在开房间…');
      loadScripts(0);
      showPanel();
    }
    if (useLan !== true) { start(); return; }
    // LAN room: ask the app where its local server is and which addresses a friend can reach it on
    opening = true;
    fetch('./coop/api/lan').then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(function (info) {
      opening = false;
      if (!info.addresses || !info.addresses.length) { alert('没找到局域网地址。\n先连上 Wi-Fi，或者打开这台手机的热点让朋友连上来，再开局域网房间。'); return; }
      window.COOP_ORIGIN = info.origin || location.origin; // coop.js: signaling goes to the app's own server
      window.COOP_ICE = [];
      lan = { pick: 0, links: info.addresses.map(function (a) { return 'http://' + a + ':' + info.port + '/coop/guest2.html?room=' + code + '&auto=1'; }) };
      start();
    }).catch(function (e) {
      opening = false;
      rawLog.call(console, 'coop lan failed ' + e);
      alert('局域网房间没开起来，可以关掉游戏重新打开再试，或者先用普通房间。');
    });
  }
  function closeRoom() {
    if (!confirm('关闭房间 ' + room + '？\n游戏会回到标题画面，队友会断开。这场战斗里还没存档的进度会丢失（每打完一波会自动存档）。')) return;
    location.reload(); // a fresh page has none of the co-op scripts
  }
  function copyLink(btn) {
    var done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制链接'; }, 1500); };
    var fallback = function () {
      var t = document.getElementById('prsCoopLink'); t.focus(); t.select(); t.setSelectionRange(0, 999);
      try { document.execCommand('copy'); done(); } catch (e) {}
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link()).then(done, fallback); else fallback();
  }
  function join(code) {
    code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) { alert('请输入朋友给你的房间号。'); return; }
    var a = el('a', { href: ORIGIN + '/coop/guest2.html?room=' + code + '&auto=1', target: '_blank', rel: 'noopener' });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function drawQr(c) {
    try {
      var m = window.QRCodeCore.create(link(), { errorCorrectionLevel: 'M' }).modules, quiet = 3, n = m.size + quiet * 2, scale = Math.max(1, Math.floor(372 / n));
      c.width = c.height = n * scale;
      var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
      for (var y = 0; y < m.size; y++) for (var x = 0; x < m.size; x++) if (m.data[y * m.size + x]) g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    } catch (e) { rawLog.call(console, 'coop qr failed ' + e); }
  }
  // Enemy HP with two players: the host picks (coop/host-team.js reads the same localStorage key).
  var HP_CHOICES = [[1, '1 倍 简单'], [1.5, '1.5 倍 标准'], [2, '2 倍 困难']];
  function hpNow() { var v = NaN; try { v = Number(localStorage.getItem('coop-enemy-hp')); } catch (e) {} return v === 1 || v === 2 ? v : 1.5; }
  function hpRow() {
    var row = el('div', { class: 'row' }, []);
    function draw() {
      row.innerHTML = '';
      var now = hpNow();
      HP_CHOICES.forEach(function (c) {
        row.appendChild(el('button', { class: c[0] === now ? '' : 'sub', text: c[1], onclick: function () {
          try { localStorage.setItem('coop-enemy-hp', String(c[0])); } catch (e) {}
          if (window.CoopTeam && window.CoopTeam.setHpMult) window.CoopTeam.setHpMult(c[0]);
          draw();
        } }));
      });
    }
    draw();
    return row;
  }
  function closePanel() { if (panel) { panel.remove(); panel = null; } }
  function showPanel() {
    closePanel();
    var card;
    if (!room) {
      var input = el('input', { placeholder: '朋友的房间号', maxlength: '8', autocapitalize: 'characters', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' });
      card = el('div', { id: 'prsCoopCard' }, [
        el('h3', { text: '双人合作（测试版）' }),
        el('div', { class: 'row' }, [el('button', { text: '开房间（我当 1P）', onclick: function () { openRoom(false); } }),
          el('button', { text: '开局域网房间', onclick: function () { openRoom(true); } }), el('button', { class: 'sub', text: '关闭', onclick: closePanel })]),
        el('p', { text: '开房间后把二维码或链接发给朋友，朋友用手机或电脑的浏览器打开就能当 2P，不用装游戏。' }),
        el('p', { text: '局域网房间：朋友和你连同一个 Wi-Fi，或者连你这台手机开的热点，就能一起玩，不用外网，也不经过服务器。' + (IOS ? '第一次开会问「本地网络」权限，要点允许。' : '') }),
        el('div', { class: 'row' }, [input, el('button', { class: 'sub', text: '加入房间', onclick: function () { join(input.value); } })]),
        el('p', { text: '敌人血量（两个人打，敌人比单人更耐打；改了从下一场战斗起生效）' }),
        hpRow(),
        modsRow(),
        el('p', { text: '加入朋友开的房间会跳到浏览器里玩（朋友开的是局域网房间时，直接扫他的二维码）。合作规则（双打、各自 10 点、每人最多 6 只、钱和精灵球各一份、5 选 2）只对开房间之后新开的一局生效。普通房间两边都要联网。' }),
      ]);
    } else {
      var qr = el('canvas', { id: 'prsCoopQr' }), copy = el('button', { class: 'sub', text: '复制链接' });
      copy.addEventListener('click', function () { copyLink(copy); });
      var linkBox = el('input', { id: 'prsCoopLink', readonly: 'readonly', value: link() });
      var btns = [copy];
      if (navigator.share) btns.push(el('button', { class: 'sub', text: '分享', onclick: function () { navigator.share({ title: 'PokéRogue 双人合作', text: '房间号 ' + room, url: link() }).catch(function () {}); } }));
      btns.push(el('button', { text: '回到游戏', onclick: closePanel }));
      var kids = [
        el('div', { class: 'row', style: 'margin-top:0' }, [qr, el('div', {}, [
          el('div', { style: 'font-size:12px;color:#b3abc0', text: lan ? '局域网房间' : '房间号' }), el('div', { id: 'prsCoopCode', text: room }),
          el('div', { id: 'prsCoopStatus', class: status[1], text: status[0] }),
        ])]),
        el('div', { class: 'row' }, [linkBox]),
        el('div', { class: 'row' }, btns),
      ];
      if (lan) {
        kids.push(el('p', { text: '朋友先和你连同一个 Wi-Fi（或者连你这台手机的热点），再扫码或打开链接，手机、电脑浏览器都行。不用外网。' +
          (IOS ? '系统问「本地网络」权限时点允许。' : '') + '请在标题画面开房间，再开始新游戏或读取合作存档。' }));
        if (lan.links.length > 1) {
          // several networks (Wi-Fi and hotspot, say): the friend can only reach the one they are on
          kids.push(el('p', { text: '这台手机有 ' + lan.links.length + ' 个网络地址，朋友打不开就换一个再扫：' }));
          kids.push(el('div', { class: 'row' }, lan.links.map(function (l, i) {
            return el('button', { class: i === lan.pick ? '' : 'sub', text: l.replace(/^http:\/\//, '').replace(/:\d+\/.*$/, ''), onclick: function () { lan.pick = i; showPanel(); } });
          })));
        }
      } else {
        kids.push(el('p', { text: '朋友扫码或打开链接就能加入（手机、电脑浏览器都行）。请在标题画面开房间，再开始新游戏或读取合作存档。' }));
      }
      kids = kids.concat([
        el('p', { text: '敌人血量（改了从下一场战斗起生效）' }),
        hpRow(),
        modsRow(),
        el('div', { class: 'row' }, [el('button', { class: 'bad', text: '关闭房间', onclick: closeRoom })]),
      ]);
      card = el('div', { id: 'prsCoopCard' }, kids);
      drawQr(qr);
    }
    panel = shield(el('div', { id: 'prsCoopMask' }, [card]));
    panel.addEventListener('click', function (e) { if (e.target === panel) closePanel(); });
    document.body.appendChild(panel);
  }

  function boot() {
    pill = shield(el('div', { id: 'prsCoopPill', text: '联机' }));
    pill.addEventListener('click', showPanel);
    pill.style.display = 'none';
    document.body.appendChild(pill);
    setInterval(refreshPill, 500);
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
  window.PRS_COOP_MOBILE = { open: openRoom, panel: showPanel, lan: function () { return lan; }, room: function () { return room; }, status: function () { return status; }, link: function () { return room ? link() : null; } };
})();
