// Co-op host, part 3 of 4: the two-player rules, read from the running game. Needs window.CoopLink
// (host.js), window.CoopTeam (host-team.js: who owns which Pokémon) and window.PRS_SCENE.
// Normally field slot 0 holds a 1P Pokémon and slot 1 a 2P one; when a player has nothing left to send
// out, the other may hold both.
// - Whose turn: while a Pokémon chooses its command, only its owner's keys reach the game. Questions
//   about one Pokémon (switch it? learn a move?) and the reward picks (5 选 2) go the same way.
// - Pick ahead: 2P picks a move on the phone any time in the turn and presses 完成; when the game gets to
//   2P's Pokémon, the host enters that pick through the game's own menus.
// - Intents: what each player is choosing right now (for host-overlay.js's bubbles and for the phone).
// - Party: both players' Pokémon and the bag, for the phone's team sheet.
// - 2P away (never joined, or dropped): nothing waits for 2P; 1P's keyboard plays every Pokémon and
//   answers every prompt until the guest is back.
// - Shouts: four preset lines, 2P from the phone ({say: n}), 1P with F1–F4.
window.CoopGame = (function () {
  const log = (...a) => console.log('COOP', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x)));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const L = window.CoopLink;
  const uiMode = () => { const t = document.getElementById('touchControls'); return (t && t.dataset.uiMode) || null; };
  const nameOf = p => (p.getNameToRender ? p.getNameToRender() : p.name);
  const CHOOSING = ['CommandPhase', 'SelectTargetPhase'];
  const STAGE = ['CommandPhase', 'SelectTargetPhase', 'EnemyCommandPhase'];
  const SHARED_PHASES = ['MysteryEncounterPhase', 'SelectBiomePhase'], SHARED_MODES = ['OPTION_SELECT', 'MYSTERY_ENCOUNTER'];
  const KIND = { 1: '扔精灵球', 2: '换宝可梦', 3: '逃走' };
  const T = window.CoopTeam;
  // other questions go to one player too: who answers, and the Pokémon it is about
  const PROMPT = {
    CheckSwitchPhase: { who: (ph, s) => T.ownerOf(s.getPlayerParty()[ph.fieldIndex]), mon: (ph, s) => s.getPlayerParty()[ph.fieldIndex], what: n => '要不要换下' + n },
    SwitchPhase: { who: ph => T.askerFor(ph.fieldIndex, ph.isModal), mon: (ph, s) => s.getPlayerParty()[ph.fieldIndex], what: () => '选谁上场' },
    LearnMovePhase: { who: ph => T.ownerOf(ph.getPokemon()), mon: ph => ph.getPokemon(), what: n => n + '要学新招式' },
    // a catch (and its "your team is full, release one?") is the thrower's
    AttemptCapturePhase: { who: () => T.catcher(), mon: ph => ph.getPokemon(), what: n => '收服' + n },
  }; // Command enum: FIGHT 0, BALL 1, POKEMON 2, RUN 3
  // field slot -> owner (falls back to slot 0 = 1P, slot 1 = 2P for a Pokémon not assigned yet)
  const whoAt = (s, slot) => T.ownerOf(s.getPlayerField()[slot]) || (slot === 1 ? 'p2' : 'p1');
  // the field slot of 2P's Pokémon (the one the phone's pick panel is for), or -1
  function slotOf2P(s) {
    const f = s.getPlayerField();
    const slots = f.map((p, i) => (p && p.isActive(true) && whoAt(s, i) === 'p2' ? i : -1)).filter(i => i >= 0);
    return slots.includes(1) ? 1 : slots.length ? slots[0] : -1;
  }
  const STATUS = ['', '中毒', '剧毒', '麻痹', '睡眠', '冰冻', '灼伤', '濒死'];

  const st = {
    stage: false, owner: null, shared: null, turnKey: '', pick: null, pickSlot: -1, choice: null, intent2: null, applying: false,
    p1: null, p2: null, mons: [], reward: null, starters: null, streak: 0, sent: {},
  };
  const listeners = [];
  const emit = (type, data) => listeners.forEach(f => { try { f(type, data); } catch (e) { log('listener error', String(e)); } });
  // send only when it changed, and remember it for a guest that (re)connects
  function sendState(kind, msg) {
    const j = JSON.stringify(msg);
    if (st.sent[kind] === j) return;
    st.sent[kind] = j;
    L.send(msg);
  }
  // is 2P here? While not, no key is gated and no pick is waited for (1P plays for 2P)
  const online = () => !L.online || L.online();
  function resync() {
    // rebuild this turn's pick panel from the game (2P may have dropped mid-turn), then resend the rest
    st.turnKey = ''; st.choice = null; st.intent2 = null; delete st.sent.pick;
    Object.values(st.sent).forEach(j => L.send(JSON.parse(j)));
  }
  L.onOpen(() => { resync(); emit('link', { online: true }); });
  L.onClose && L.onClose(() => {
    st.choice = null; st.intent2 = null; // a pick 2P left behind is dropped, 1P chooses instead
    log('2P away: 1P plays for 2P');
    emit('link', { online: false });
  });

  // ---- shouts: one of four preset lines, shown as a speech bubble (host-overlay.js) and on the phone ----
  const SAY = ['集火这只', '等我一下', '换你来', '好的'];
  const saidAt = { p1: 0, p2: 0 };
  function shout(who, n) {
    n = Number(n);
    if (!(n >= 0 && n < SAY.length) || Date.now() - saidAt[who] < 1500) return false; // one per 1.5 s each
    saidAt[who] = Date.now();
    const ev = { who, n, text: SAY[n] };
    emit('say', ev);
    L.send({ said: ev });
    return true;
  }

  // ---- what a player is doing: {state: 'thinking'|'choosing'|'done', move, target (BattlerIndex), kind} ----
  // player commands keep their targets on the command itself; enemy commands on .move
  const targetsOf = c => (c.targets && c.targets.length ? c.targets : (c.move && c.move.targets) || []);
  function describe(cmd, mon) {
    if (cmd.command === 0 && cmd.move) {
      const pm = mon.getMoveset().find(m => m && m.moveId === cmd.move.move);
      const t = targetsOf(cmd);
      return { state: 'done', move: pm ? pm.getName() : '招式', target: t.length === 1 ? t[0] : null, spread: t.length > 1 };
    }
    return { state: 'done', kind: KIND[cmd.command] || '行动' };
  }
  function fromMenus(s, mon, cmd) {
    const mode = uiMode(), h = s.ui.getHandler();
    if (mode === 'FIGHT') { const pm = mon.getMoveset()[h.getCursor()]; return { state: 'choosing', move: pm ? pm.getName() : null }; }
    if (mode === 'TARGET_SELECT') return { state: 'choosing', move: cmd ? describe(cmd, mon).move : null, target: h.getCursor() };
    return null;
  }
  function intent(s, ph, b, slot) {
    const mon = s.getPlayerField()[slot];
    if (!mon || !mon.isActive(true)) return null;
    const cmd = b.turnCommands && b.turnCommands[slot];
    const choosingNow = CHOOSING.includes(ph.phaseName) && ph.fieldIndex === slot;
    if (cmd && !choosingNow && !cmd.skip) return describe(cmd, mon);
    if (choosingNow) { const m = fromMenus(s, mon, cmd); if (m) return m; }
    if (slot === st.pickSlot && st.pick) { // 2P's choice on the phone
      const c = st.choice && st.choice.key === st.turnKey ? st.choice : st.intent2 && st.intent2.key === st.turnKey ? st.intent2 : null;
      if (c && c.move != null) return { state: c === st.choice ? 'done' : 'choosing', move: (st.pick.moves[c.move] || {}).name, target: c.target };
    }
    return { state: 'thinking' };
  }

  // ---- 2P's pick: offered at the start of each turn, entered by the host when 2P's Pokémon is up ----
  function readPick(s, key, slot) {
    const mon = s.getPlayerField()[slot];
    if (slot < 0 || !mon || !mon.isActive(true)) return null;
    const moves = mon.getMoveset().filter(Boolean).map(m => {
      const max = m.getMovePp(), left = max - m.ppUsed;
      return { name: m.getName(), pp: left, max, ok: left > 0 };
    });
    const targets = s.getEnemyField().filter(e => e && e.isActive(true)).map(e => ({ name: nameOf(e), bi: e.getBattlerIndex() }));
    return { key, mon: nameOf(mon), moves, targets };
  }
  async function tap(btn) { L.press(btn, true); await sleep(70); L.press(btn, false); await sleep(60); }
  async function waitMode(test, ms) {
    for (let t = 0; t < ms; t += 50) { if (test(uiMode())) return true; await sleep(50); }
    return false;
  }
  async function applyChoice(s, c) {
    st.applying = true;
    try {
      // 1P's last key may still be held when the game reaches 2P's Pokémon, and a second keydown of a held
      // key does nothing, so give it a moment and retry
      await sleep(250);
      // the menu may already be open (2P, or 1P playing for a dropped 2P, went in by hand): start from there
      if (uiMode() === 'TARGET_SELECT') { await tap('b'); await waitMode(m => m === 'FIGHT', 800); }
      let opened = uiMode() === 'FIGHT';
      for (let i = 0; i < 4 && !opened; i++) {
        if (uiMode() !== 'COMMAND') break;
        s.ui.getHandler().setCursor(0); // 战斗
        await tap('a');
        opened = await waitMode(m => m === 'FIGHT', 600);
      }
      if (!opened) throw new Error('fight menu did not open');
      s.ui.getHandler().setCursor(c.move);
      await tap('a');
      await waitMode(m => m !== 'FIGHT', 1500);
      if (uiMode() === 'TARGET_SELECT') {
        if (c.target != null) s.ui.getHandler().setCursor(c.target);
        await tap('a');
      }
      log('applied 2P pick', c);
      st.pick = null;
      sendState('pick', { pick: null });
      L.send({ applied: c.key });
    } catch (e) {
      log('2P pick not applied', String(e));
      L.send({ applied: c.key, failed: true });
    }
    st.choice = null;
    st.applying = false;
  }

  L.on(m => {
    if ('choice' in m) { st.choice = m.choice; log('2P pick', m.choice); }
    if ('intent' in m) st.intent2 = m.intent;
    if ('say' in m) shout('p2', m.say);
    if (m.sync && !st.applying) resync(); // the phone cleared its panels after a hiccup only it saw
  });
  // presses: the guest is ignored while 1P's Pokémon chooses (and while the host enters 2P's pick) ...
  L.setGate(() => !(st.owner === 'p1' || st.applying));
  // ... and 1P's own keyboard is ignored while 2P's Pokémon chooses (the guest's synthetic keys are untrusted)
  // Only while 2P is connected: with 2P away 1P's keyboard does everything.
  window.addEventListener('keydown', e => {
    if (!e.isTrusted) return;
    const f = ['F1', 'F2', 'F3', 'F4'].indexOf(e.key);
    if (f >= 0) { e.stopImmediatePropagation(); e.preventDefault(); if (!e.repeat) shout('p1', f); return; } // 1P's shouts
    if (st.owner === 'p2' && online()) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
  // Same rule for the game's on-screen touch buttons (1P hosting from a phone): they feed the game directly,
  // not through key events, so their presses are stopped here. Releases always pass so no button sticks.
  for (const type of ['touchstart', 'pointerdown']) window.addEventListener(type, e => {
    if (!e.isTrusted || !(st.owner === 'p2' && online())) return;
    const tc = document.getElementById('touchControls');
    if (tc && e.target instanceof Node && tc.contains(e.target)) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, { capture: true, passive: false });

  const enemyName = (s, bi) => { const e = s.getEnemyField().find(x => x && x.getBattlerIndex() === bi); return e ? nameOf(e) : ''; };
  const say = (s, i) => !i ? '' : i.state === 'thinking' ? '思考中…' : i.kind ? i.kind
    : (i.move || '…') + (i.spread ? ' → 全体' : i.target != null && i.target >= 2 ? ' → ' + enemyName(s, i.target) : '');

  function tick() {
    const s = window.PRS_SCENE;
    let ph = null;
    try { ph = s && s.phaseManager.getCurrentPhase(); } catch {}
    const b = s && s.currentBattle;
    const stage = !!(ph && b && STAGE.includes(ph.phaseName));
    if (st.stage && !stage) { // the turn just started: did the two players aim one move at the same enemy?
      // read this turn's two commands from the game (the last sample may predate 2P's pick going in)
      const aimOf = c => c && c.command === 0 && targetsOf(c).length === 1 ? targetsOf(c)[0] : null;
      const t0 = b && b.turnCommands ? aimOf(b.turnCommands[0]) : null, t1 = b && b.turnCommands ? aimOf(b.turnCommands[1]) : null;
      const two = !!(s && whoAt(s, 0) !== whoAt(s, 1));
      const combo = !!(b && b.double && two && t0 != null && t0 >= 2 && t0 === t1);
      st.streak = combo ? st.streak + 1 : 0;
      emit('turnstart', { combo, streak: st.streak, target: combo ? t0 : null });
    }
    st.stage = stage;
    if (!stage) {
      st.p1 = st.p2 = null; st.mons = [];
      sendState('mate', { mate: null });
      st.reward = T.reward();
      st.starters = T.starters();
      const q = ph && PROMPT[ph.phaseName];
      let who = null, n = '';
      try { if (q) { who = q.who(ph, s); const mon = q.mon(ph, s); n = mon ? nameOf(mon) : ''; } } catch {}
      // host-team.js may name one player for team-wide choices (older versions do not have sharedPicker)
      let shared = null;
      try {
        if (typeof T.sharedPicker === 'function' && ph && (SHARED_PHASES.includes(ph.phaseName) || SHARED_MODES.includes(uiMode()))) {
          const w = T.sharedPicker(ph);
          if (w === 'p1' || w === 'p2') shared = w;
        }
      } catch {}
      st.shared = shared;
      if (st.starters && st.starters.picker) { // picking starters: take turns, each with their own points
        const t = st.starters, w = t.picker;
        st.owner = w;
        sendState('turn', w === 'p2'
          ? { turn: 'p2', text: '轮到你挑初始宝可梦', sub: '你还剩 ' + t.left.p2 + ' 点（共 ' + t.lim + '）' }
          : { turn: 'p1', text: '1P 在挑初始宝可梦', sub: '你还剩 ' + t.left.p2 + ' 点，1P 挑完轮到你' });
      } else if (st.reward) {
        const r = st.reward, first = r.round === 1;
        st.owner = r.picker;
        if (r.single) { // a special reward screen: one pick only, no 5 选 2
          sendState('turn', r.picker === 'p2' ? { turn: 'p2', text: '轮到你挑奖励', sub: '' } : { turn: 'p1', text: '1P 在挑奖励', sub: '' });
        } else sendState('turn', r.picker === 'p2'
          ? { turn: 'p2', text: '轮到你挑奖励（5 选 2）', sub: first ? '你先挑，剩下的给 1P' : '1P 挑过了，从剩下的里挑' }
          : { turn: 'p1', text: '1P 在挑奖励（5 选 2）', sub: first ? '1P 挑完轮到你' : '你挑过了' });
      } else if (who) {
        st.owner = who;
        // "switch X?" but X's owner has nothing of their own to send out: answer 否 for them
        if (ph.phaseName === 'CheckSwitchPhase' && !T.canSendOut(who) && uiMode() === 'CONFIRM' && st.autoNo !== ph) {
          st.autoNo = ph;
          (async () => {
            st.applying = true;
            try {
              await sleep(300);
              for (let i = 0; i < 5 && uiMode() === 'CONFIRM' && s.ui.getHandler().getCursor() !== 1; i++) { s.ui.getHandler().setCursor(1); await sleep(80); }
              if (uiMode() === 'CONFIRM' && s.ui.getHandler().getCursor() === 1) { await tap('a'); log('auto 否: ' + T.label(who) + ' has nothing to switch in'); }
            } finally { st.applying = false; }
          })();
        }
        sendState('turn', who === 'p2' ? { turn: 'p2', mon: n, text: '轮到你：' + q.what(n), sub: '' } : { turn: 'p1', text: '1P 在决定：' + q.what(n), sub: '' });
      } else if (shared) { // a choice for the whole team (mystery encounter, next biome): one player decides
        st.owner = shared;
        sendState('turn', shared === 'p2' ? { turn: 'p2', text: '轮到你决定', sub: '' } : { turn: 'p1', text: '1P 在决定', sub: '' });
      } else {
        st.owner = null;
        sendState('turn', { turn: null, text: '两人都能操作', sub: '' });
      }
      return;
    }
    st.reward = null;
    const key = b.waveIndex + ':' + b.turn;
    if (key !== st.turnKey) {
      st.turnKey = key; st.choice = null; st.intent2 = null;
      st.pickSlot = slotOf2P(s);
      try { st.pick = readPick(s, key, st.pickSlot); } catch (e) { st.pick = null; log('pick read failed', String(e)); }
      sendState('pick', { pick: st.pick });
    }
    const field = s.getPlayerField();
    st.owner = CHOOSING.includes(ph.phaseName) ? whoAt(s, ph.fieldIndex) : null;
    try {
      st.mons = field.map((p, slot) => ({ slot, who: whoAt(s, slot), intent: intent(s, ph, b, slot) })).filter(m => m.intent);
      const first = who => (st.mons.find(m => m.who === who) || {});
      st.p1 = first('p1').intent || null; st.p2 = first('p2').intent || null;
    } catch (e) { log('intent read failed', String(e)); }
    const nameAt = slot => (field[slot] ? nameOf(field[slot]) : '');
    const mine1 = st.mons.find(m => m.who === 'p1');
    sendState('mate', { mate: mine1 ? { mon: nameAt(mine1.slot), state: mine1.intent.state, text: say(s, mine1.intent) } : null });
    const now = nameAt(ph.fieldIndex || 0);
    if (st.owner === 'p1') {
      sendState('turn', { turn: 'p1', text: '1P 在给' + now + '选招', sub: st.pick ? (st.choice ? '你已选好，等 1P' : '你可以先选好按完成') : '' });
    } else if (st.owner === 'p2') {
      sendState('turn', { turn: 'p2', mon: now, text: '轮到你了：' + now + '出招', sub: st.choice && ph.fieldIndex === st.pickSlot ? '正在替你出招' : '' });
      if (online() && st.choice && st.choice.key === key && ph.fieldIndex === st.pickSlot && !st.applying && ['COMMAND', 'FIGHT', 'TARGET_SELECT'].includes(uiMode())) applyChoice(s, st.choice);
    } else {
      sendState('turn', { turn: null, text: '对手在想…', sub: '' });
    }
  }
  setInterval(tick, 120);

  // ---- party and bag for the phone's team sheet ----
  const itemName = m => m.type.name + (m.stackCount > 1 ? '×' + m.stackCount : '');
  function readParty(s) {
    const field = s.getPlayerField();
    const mons = s.getPlayerParty().map(p => {
      const o = T.ownerOf(p);
      return {
        name: nameOf(p), lv: p.level, hp: p.hp, max: p.getMaxHp(),
        st: p.isFainted() ? '濒死' : STATUS[(p.status && p.status.effect) || 0] || '',
        who: o ? T.label(o) : '', field: field.includes(p),
        items: p.getHeldItems().map(itemName),
      };
    });
    mons.sort((a, b) => (a.who > b.who) - (a.who < b.who)); // 1P's first, then 2P's
    // each player's own money and balls (host-team.js); money stays the total for an older phone page
    const purse = typeof T.purse === 'function' ? T.purse() : null;
    return { mons, bag: s.modifiers.filter(m => !('pokemonId' in m)).map(itemName), money: purse ? purse.money.p1 + purse.money.p2 : s.money,
      purse, cap: T.CAP || null, hp: typeof T.hpMult === 'function' ? T.hpMult() : null };
  }
  setInterval(() => {
    const s = window.PRS_SCENE;
    if (!s || !s.getPlayerParty) return;
    try { sendState('party', { party: readParty(s) }); } catch {}
  }, 1000);

  const phaseName = () => { try { return window.PRS_SCENE.phaseManager.getCurrentPhase().phaseName; } catch { return null; } };
  return { state: () => st, on: fn => listeners.push(fn), uiMode, phaseName, online, everJoined: () => !!(L.everJoined && L.everJoined()), shout, SAY };
})();
