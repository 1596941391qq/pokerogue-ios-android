// Co-op host, part 4 of 4: what the two players are doing, drawn into the game itself, so the host window
// and the guest's video both show it. Needs window.CoopGame (host-game.js) and window.PRS_SCENE.
// - On the reward screen, a tag at the top: whose pick it is (5 选 2).
// - A bubble over each player's Pokémon: "思考中…" -> "水枪 → 刺尾虫" while choosing -> "✓ 水枪 → 刺尾虫".
// - A marker over each enemy a player aims at; both players on one enemy -> "集火".
// - When both hit the same enemy in a turn, a "集火!" flash; the count grows over consecutive turns.
// - A slim status bar (room code, 2P online or away, whose move it is) on every screen.
// - Shouts (集火这只 / 等我一下 / 换你来 / 好的): a short-lived speech bubble over the speaker's Pokémon.
// Coordinates: the game draws at 1920×1080 with its content scaled ×6, so this layer is ×6 too and works
// in the game's 320×180 pixels.
(function () {
  const COLOR = { p1: 0x4aa3ff, p2: 0xf5c84c, gold: 0xffd84a, ink: 0x1d1824 };
  const CSS = { p1: '#4aa3ff', p2: '#f5c84c', gold: '#ffd84a', white: '#f8f8f8', dim: '#c9c1d6' };
  const SHOW_IN = ['COMMAND', 'FIGHT', 'TARGET_SELECT', 'BALL', 'MESSAGE'];
  const CSS2 = { ok: '#5fd38a', off: '#ff7a66', mute: '#a59cb3' };
  let scene = null, layer = null, fx = null, bar = null, lastSig = '', lastStates = {}, barSig = '';

  function ready() {
    const s = window.PRS_SCENE;
    if (!s || !s.add || !window.Phaser || !window.CoopGame) return false;
    if (s !== scene || !layer || !layer.scene) {
      scene = s;
      layer = s.add.container(0, 0).setScale(6).setDepth(1e6).setName('coop-overlay');
      fx = s.add.container(0, 0).setScale(6).setDepth(1e6 + 1).setName('coop-fx');
      bar = s.add.container(0, 0).setScale(6).setDepth(1e6 + 2).setName('coop-bar');
      barSig = '';
    }
    return true;
  }
  function text(str, color, size) {
    return new Phaser.GameObjects.Text(scene, 0, 0, str, { fontFamily: 'emerald', fontSize: size, color, padding: { bottom: 6 } })
      .setScale(1 / 6).setShadow(3, 4, '#0b0910', 0, false, true);
  }
  // world-space top-centre of a Pokémon's sprite, in the layer's 320×180 coordinates
  function topOf(mon) {
    const sp = mon.getSprite ? mon.getSprite() : mon;
    const r = sp.getBounds();
    return { x: Math.round((r.x + r.width / 2) / 6), y: Math.round(r.y / 6) };
  }

  // dx shifts the box sideways (the tail stays on the Pokémon), used when the two bubbles would overlap
  function bubble(at, who, body, done, dx = 0) {
    const c = new Phaser.GameObjects.Container(scene, at.x, at.y - 1);
    const tag = text(who === 'p1' ? '1P' : '2P', CSS[who], 72);
    const t = text((done ? '✓ ' : '') + body, done ? CSS.white : CSS.dim, 72);
    const pad = 3, gap = 3, h = Math.ceil(Math.max(tag.displayHeight, t.displayHeight)) + 1;
    const w = Math.ceil(tag.displayWidth + gap + t.displayWidth) + pad * 2;
    const x0 = Math.min(Math.max(Math.round(-w / 2 + dx), 2 - at.x), 318 - at.x - w), y0 = -h - 4;
    const g = new Phaser.GameObjects.Graphics(scene);
    g.fillStyle(COLOR.ink, 0.92).fillRoundedRect(x0, y0, w, h, 3);
    g.lineStyle(1, COLOR[who], done ? 1 : 0.7).strokeRoundedRect(x0, y0, w, h, 3);
    g.fillStyle(COLOR[who], 1).fillTriangle(-3, -4, 3, -4, 0, 0);
    tag.setPosition(x0 + pad, y0);
    t.setPosition(tag.x + tag.displayWidth + gap, y0);
    c.add([g, tag, t]);
    c.span = [at.x + x0, at.x + x0 + w];
    return c;
  }
  function marker(at, whos, firm) {
    const both = whos.length > 1, col = both ? 'gold' : whos[0];
    const c = new Phaser.GameObjects.Container(scene, at.x, at.y - 2).setAlpha(firm ? 1 : 0.6);
    const g = new Phaser.GameObjects.Graphics(scene);
    g.fillStyle(COLOR[col], 1).fillTriangle(-4, -6, 4, -6, 0, 0);
    g.lineStyle(1, COLOR.ink, 1).strokeTriangle(-4, -6, 4, -6, 0, 0);
    const label = text(both ? '集火' : whos[0] === 'p1' ? '1P' : '2P', CSS[col], both ? 80 : 64).setOrigin(0.5, 1);
    label.setPosition(0, -7);
    c.add([g, label]);
    scene.tweens.add({ targets: c, y: c.y - 2, yoyo: true, repeat: -1, duration: 380, ease: 'Sine.InOut' });
    return c;
  }
  function pop(obj) {
    obj.setScale(1.3);
    scene.tweens.add({ targets: obj, scale: 1, duration: 220, ease: 'Back.Out' });
  }

  // a tag in the top-left corner (right of the game's own small icons there): "2P 先挑" on the reward
  // screen (5 选 2), "轮到 2P · 剩 7 点" on the starter screen
  function cornerTag(who, body, x = 22, y = 3) {
    const c = new Phaser.GameObjects.Container(scene, x, y);
    const tag = text(who === 'p1' ? '1P' : '2P', CSS[who], 72);
    const t = text(body, CSS.white, 72);
    const pad = 4, gap = 3, h = Math.ceil(Math.max(tag.displayHeight, t.displayHeight)) + 1;
    const w = Math.ceil(tag.displayWidth + gap + t.displayWidth) + pad * 2, x0 = 0;
    const g = new Phaser.GameObjects.Graphics(scene);
    g.fillStyle(COLOR.ink, 0.92).fillRoundedRect(x0, 0, w, h, 3);
    g.lineStyle(1, COLOR[who], 1).strokeRoundedRect(x0, 0, w, h, 3);
    tag.setPosition(x0 + pad, 0);
    t.setPosition(tag.x + tag.displayWidth + gap, 0);
    c.add([g, tag, t]);
    return c;
  }

  // ---- status bar: 房间 CODE · ● 2P 在线 · 1P 出招. One line of small text on a dark strip. ----
  // Where it sits per game screen, in 320×180 pixels: [x, y, anchor] with anchor 'r' (x is the right edge),
  // 'l' (left edge) or 'c' (centre). Chosen so it stays off the game's own UI on each screen.
  const BAR_POS = window.CoopBarPos = {
    default: [160, 0, 'c'],
    STARTER_SELECT: [2, 172, 'l'], // under the 'whose pick' tag; the filter bar runs along the top
  };
  function drawBar() {
    const g = CoopGame.state(), mode = CoopGame.uiMode() || '';
    const on = CoopGame.online(), ever = CoopGame.everJoined();
    const room = String(window.PRS_COOP_ROOM || 'TEST').toUpperCase();
    const turn = g.owner ? (g.stage ? (g.owner === 'p1' ? '1P' : '2P') + ' 出招' : '轮到 ' + (g.owner === 'p1' ? '1P' : '2P')) : '';
    // the starter screen's own menus (OPTION_SELECT, CONFIRM...) sit over the same screen: keep the bar at the bottom
    const picking = CoopGame.phaseName() === 'SelectStarterPhase';
    const pos = BAR_POS[mode] || (picking ? BAR_POS.STARTER_SELECT : BAR_POS.default);
    // each player's money, and how tough the enemies are set (host-team.js)
    let purse = null, hp = null;
    try { purse = CoopTeam.purse().money; hp = CoopTeam.hpMult(); } catch {}
    const cash = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e5 ? Math.round(n / 1e3) + 'k' : String(Math.floor(n)));
    const inRun = !!(scene && scene.currentBattle && scene.getPlayerParty && scene.getPlayerParty().length) && !picking;
    const sig = [room, on, ever, turn, g.owner, pos.join(), inRun && purse ? purse.p1 + '/' + purse.p2 : '', hp].join('|');
    if (sig === barSig) return;
    barSig = sig;
    bar.removeAll(true);
    if (pos[3] === 'hide') return;
    const parts = [
      [text('房间 ', CSS2.mute, 54)], [text(room, CSS.white, 54)],
      [text(' ● ', on ? CSS2.ok : CSS2.off, 54)],
      [text(on ? '2P 在线' : (ever ? '2P 掉线' : '2P 未加入') + ' · 1P 代打', on ? CSS.white : CSS2.off, 54)],
    ];
    if (turn && (on || g.owner === 'p1')) parts.push([text(' · ', CSS2.mute, 54)], [text(turn, CSS[g.owner], 54)]);
    if (inRun && purse) parts.push([text(' · ', CSS2.mute, 54)], [text('1P ₽' + cash(purse.p1), CSS.p1, 54)], [text('  2P ₽' + cash(purse.p2), CSS.p2, 54)]);
    if (hp) parts.push([text(' · 敌人血×' + hp, CSS2.mute, 54)]);
    const pad = 3, h = Math.ceil(parts[0][0].displayHeight) + 2;
    const w = Math.ceil(parts.reduce((a, p) => a + p[0].displayWidth, 0)) + pad * 2;
    const x0 = Math.round(pos[2] === 'r' ? pos[0] - w : pos[2] === 'l' ? pos[0] : pos[0] - w / 2), y0 = pos[1];
    const bg = new Phaser.GameObjects.Graphics(scene);
    bg.fillStyle(COLOR.ink, 0.82).fillRoundedRect(x0, y0, w, h, { tl: 0, tr: 0, bl: 2, br: 2 });
    bar.add(bg);
    let x = x0 + pad;
    parts.forEach(([t]) => { t.setPosition(x, y0 + 1); x += t.displayWidth; bar.add(t); });
  }

  // ---- shouts: a filled bubble in the speaker's colour, gone after about two seconds ----
  const SAY_OVER = ['COMMAND', 'FIGHT', 'TARGET_SELECT', 'BALL', 'MESSAGE'];
  const sayNow = {};
  function sayAt(who) {
    try {
      const s = scene, b = s.currentBattle;
      if (b && SAY_OVER.includes(CoopGame.uiMode())) {
        const f = s.getPlayerField(), T = window.CoopTeam;
        const own = (p, i) => (T && T.ownerOf(p)) || (i === 1 ? 'p2' : 'p1');
        const mon = f.find((p, i) => p && p.isActive(true) && own(p, i) === who && p.getSprite().visible);
        if (mon) { const at = topOf(mon); if (at.y > 30 && at.y < 170 && at.x > 0 && at.x < 320) return { x: at.x, y: at.y - 15, tail: true }; }
      }
    } catch {}
    return { x: 160, y: who === 'p1' ? 24 : 38, tail: false }; // not in battle: top centre
  }
  function sayBubble(ev) {
    if (!ready()) return;
    const who = ev.who === 'p1' ? 'p1' : 'p2', at = sayAt(who);
    if (sayNow[who] && sayNow[who].scene) sayNow[who].destroy();
    const c = new Phaser.GameObjects.Container(scene, at.x, at.y);
    const tag = text(who === 'p1' ? '1P' : '2P', '#1d1824', 60);
    const t = text(ev.text, '#1d1824', 84);
    tag.setShadow(0, 0, '#000', 0, false, false); t.setShadow(0, 0, '#000', 0, false, false);
    const pad = 4, gap = 3, h = Math.ceil(t.displayHeight) + 1, w = Math.ceil(tag.displayWidth + gap + t.displayWidth) + pad * 2;
    const x0 = Math.min(Math.max(Math.round(-w / 2), 2 - at.x), 318 - at.x - w), y0 = -h - 4;
    const g = new Phaser.GameObjects.Graphics(scene);
    g.fillStyle(COLOR.ink, 1).fillRoundedRect(x0 - 1, y0 - 1, w + 2, h + 2, 5);
    g.fillStyle(COLOR[who], 1).fillRoundedRect(x0, y0, w, h, 4);
    if (at.tail) g.fillStyle(COLOR[who], 1).fillTriangle(-3, -4, 3, -4, 0, 0);
    tag.setPosition(x0 + pad, y0 + 2);
    t.setPosition(tag.x + tag.displayWidth + gap, y0);
    c.add([g, tag, t]);
    fx.add(c);
    sayNow[who] = c;
    pop(c);
    scene.tweens.add({ targets: c, alpha: 0, delay: 2200, duration: 300, onComplete: () => c.destroy() });
  }

  function draw() {
    if (!ready()) return;
    try { drawBar(); } catch (e) { console.log('COOP bar error ' + e); }
    const g = CoopGame.state(), s = scene, b = s.currentBattle;
    if (g.reward && CoopGame.uiMode() === 'MODIFIER_SELECT') {
      const sig = 'reward ' + g.reward.round + g.reward.picker + (g.reward.single ? 's' : '');
      if (sig !== lastSig) {
        lastSig = sig; lastStates = {}; layer.removeAll(true);
        layer.add(cornerTag(g.reward.picker, g.reward.single ? '挑奖励' : g.reward.round === 1 ? '先挑' : '挑剩下的'));
      }
      return;
    }
    if (g.starters && g.starters.picker && CoopGame.uiMode() === 'STARTER_SELECT') {
      const t = g.starters, sig = 'starters ' + t.picker + t.left.p1 + ',' + t.left.p2;
      if (sig !== lastSig) {
        lastSig = sig; lastStates = {}; layer.removeAll(true);
        // bottom-left, over the keyboard hint (the filter bar along the top is in use)
        layer.add(cornerTag(t.picker, '挑 · 1P 剩 ' + t.left.p1 + ' 点 · 2P 剩 ' + t.left.p2 + ' 点', 2, 160));
      }
      return;
    }
    const show = g.stage && b && b.double && SHOW_IN.includes(CoopGame.uiMode());
    if (!show) {
      if (lastSig) { layer.removeAll(true); lastSig = ''; lastStates = {}; }
      return;
    }
    const field = s.getPlayerField(), enemies = s.getEnemyField().filter(e => e && e.isActive(true));
    const items = [];
    const aim = {};
    (g.mons || []).forEach(({ slot, who, intent: i }) => {
      const mon = field[slot];
      if (!i || !mon || !mon.isActive(true)) return;
      const body = i.state === 'thinking' ? '思考中…' : i.kind ? i.kind
        : (i.move || '…') + (i.spread ? ' → 全体' : i.target != null && i.target >= 2 ? ' → ' + nameOf(enemies, i.target) : '');
      items.push({ slot, who, at: topOf(mon), body, done: i.state === 'done' });
      if (i.target != null && i.target >= 2) (aim[i.target] = aim[i.target] || []).push({ who, firm: i.state === 'done' });
    });
    const marks = enemies.filter(e => aim[e.getBattlerIndex()]).map(e => {
      const a = aim[e.getBattlerIndex()];
      return { at: topOf(e), whos: [...new Set(a.map(x => x.who))], firm: a.every(x => x.firm) };
    });
    const sig = JSON.stringify([items, marks]);
    if (sig === lastSig) return;
    lastSig = sig;
    layer.removeAll(true);
    let bubs = items.map(it => bubble(it.at, it.who, it.body, it.done));
    if (bubs.length === 2) { // keep 1P's (left) and 2P's (right) bubbles apart
      const [l, r] = bubs[0].span[0] <= bubs[1].span[0] ? [0, 1] : [1, 0];
      const overlap = bubs[l].span[1] + 3 - bubs[r].span[0];
      if (overlap > 0) {
        bubs.forEach(b => b.destroy());
        const half = Math.ceil(overlap / 2);
        bubs = items.map((it, k) => bubble(it.at, it.who, it.body, it.done, k === l ? -half : half));
      }
    }
    bubs.forEach((bub, k) => {
      layer.add(bub);
      if (items[k].done && !lastStates[items[k].slot]) pop(bub); // just confirmed
    });
    marks.forEach(m => layer.add(marker(m.at, m.whos, m.firm)));
    lastStates = Object.fromEntries(items.map(it => [it.slot, it.done]));
  }
  function nameOf(enemies, bi) {
    const e = enemies.find(x => x.getBattlerIndex() === bi);
    return e ? (e.getNameToRender ? e.getNameToRender() : e.name) : '';
  }

  // the turn starts: flash "集火!" when both hit the same enemy
  function flash(ev) {
    if (!ready() || !ev.combo) return;
    const y = 62, banner = new Phaser.GameObjects.Container(scene, 160, y);
    const g = new Phaser.GameObjects.Graphics(scene);
    g.fillStyle(COLOR.ink, 0.72).fillRect(-160, -13, 320, 26);
    g.fillStyle(COLOR.gold, 1).fillRect(-160, -13, 320, 1).fillRect(-160, 12, 320, 1);
    g.fillStyle(COLOR.p1, 1).fillRect(-160, -11, 3, 22);
    g.fillStyle(COLOR.p2, 1).fillRect(157, -11, 3, 22);
    const t = text(ev.streak > 1 ? '集火 ×' + ev.streak : '集火！', CSS.gold, 150).setOrigin(0.5).setStroke('#5a3a00', 12);
    banner.add([g, t]);
    banner.scaleX = 0;
    fx.add(banner);
    scene.tweens.add({
      targets: banner, scaleX: 1, duration: 200, ease: 'Cubic.Out',
      onComplete: () => scene.tweens.add({ targets: banner, alpha: 0, delay: 1500, duration: 380, onComplete: () => banner.destroy() }),
    });
    t.setScale(0.6 / 6);
    scene.tweens.add({ targets: t, scale: 1 / 6, duration: 320, ease: 'Back.Out' });
  }

  const wait = setInterval(() => {
    if (!window.CoopGame) return;
    clearInterval(wait);
    CoopGame.on((type, data) => {
      if (type === 'turnstart') flash(data);
      if (type === 'say') { try { sayBubble(data); } catch (e) { console.log('COOP say error ' + e); } }
    });
    setInterval(() => { try { draw(); } catch (e) { console.log('COOP overlay error ' + e); } }, 100);
  }, 200);
})();
