// Runs first in index.html (inlined by scripts/patch-web.mjs). Plain ES5 on purpose: it must run on the old
// system browsers that cannot run the game, to say so instead of leaving a blank screen.
(function () {
  var errors = [];
  window.addEventListener('error', function (e) {
    var t = e.target || {};
    errors.push(e.message ? e.message + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno : '加载失败 ' + (t.src || t.href || ''));
  }, true);
  function supported() {
    try { new Function('class A{static{}}'); new RegExp('(?<=a)b'); return true; } catch (e) { return false; }
  }
  function engine() {
    var ua = navigator.userAgent, m = /Chrom(?:e|ium)\/(\d+)/.exec(ua), i = /OS (\d+)[_.](\d+)/.exec(ua);
    if (m) return '系统浏览器内核 Chrome ' + m[1] + '（需要 94 或更高）';
    if (i) return 'iOS ' + i[1] + '.' + i[2] + '（需要 16.4 或更高）';
    return ua;
  }
  function show(title, lines, retry) {
    var old = document.getElementById('prsNotice'); if (old) old.parentNode.removeChild(old);
    var d = document.createElement('div');
    d.id = 'prsNotice';
    d.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:#484050;' +
      'color:#f1eef5;font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px;box-sizing:border-box';
    var html = '<div style="max-width:520px"><div style="font-size:18px;font-weight:700;margin-bottom:8px">' + title + '</div>';
    for (var i = 0; i < lines.length; i++) html += '<div style="margin-top:4px">' + lines[i] + '</div>';
    if (retry) html += '<button id="prsRetry" style="margin-top:14px;padding:9px 18px;border:0;border-radius:7px;background:#6d5bd0;color:#fff;font-size:15px">重新加载</button>';
    d.innerHTML = html + '</div>';
    (document.body || document.documentElement).appendChild(d);
    var b = document.getElementById('prsRetry'); if (b) b.onclick = function () { location.reload(); };
  }
  function check() {
    if (!supported()) {
      var android = /Android/.test(navigator.userAgent);
      show('这台设备的系统版本太旧，游戏运行不了', [
        '当前：' + engine(),
        android ? '解决办法：在应用商店把「Android System WebView」和「Chrome」更新到最新版，再重新打开游戏。' : '解决办法：把系统升级到 iOS 16.4 或更高。',
        android ? '华为、荣耀等没有谷歌服务的手机：请升级系统版本，系统自带的浏览器内核会一起更新。' : '',
        '游戏存档不受影响。',
      ], false);
      return;
    }
    // The game creates its canvas as soon as its code runs. No canvas after a while = the code did not load.
    setTimeout(function () {
      if (document.querySelector('canvas')) return;
      show('游戏没有加载出来', ['可能是设备内存不足或文件没读到。点下面的按钮重试；还不行请完全关掉游戏再打开。', '当前：' + engine()]
        .concat(errors.slice(0, 3).map(function (x) { return '<span style="font-size:12px;color:#b3abc0">' + String(x).replace(/</g, '&lt;') + '</span>'; })), true);
    }, 30000);
  }
  if (document.body) check(); else document.addEventListener('DOMContentLoaded', check);
})();
