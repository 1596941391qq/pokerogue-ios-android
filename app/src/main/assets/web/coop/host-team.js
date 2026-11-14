// Co-op host, part 2 of 4: two teams in one game. Needs window.PRS_SCENE (the co-op game build exposes
// its scene there). The game has one party; here every Pokémon in it gets an owner, 1P or 2P, and each
// player may have up to six (CAP), so the one party holds up to twelve:
// - Starters: two rounds on the game's own starter screen. 1P picks up to six with their own points (10, or
//   15 in endless: the game's own limit, per round), confirms, then 2P does the same; the two lists become
//   one party with one of each player in the first two places (the ones on the field).
//   Each starter belongs to whoever picked it. A caught Pokémon is the thrower's. Anything else that joins
//   goes to whoever has fewer. Owners are kept in localStorage by Pokémon id, so they survive a restart.
//   (A save from before co-op teams: alternating by party order.)
// - More than six in the party: the game's party menu has six places (two on the field + four in reserve
//   in a double battle) and uses the cursor as the place in the party. So the party itself is put in order
//   for whoever is looking (their own reserve first, then the teammate's) and the menu shows the first six;
//   moving past the last / first reserve row scrolls the reserve by one ("▲▼ 还有 N 只"). The cursor is
//   always the real place in the party, so the rest of the game needs no change. With six or fewer nothing
//   of this happens.
// - Switching (fainted, between waves, or "换宝可梦" in battle) only offers the asker's own Pokémon, so
//   1P's always replaces 1P's. When a player has nothing left to send out, the slot goes to the other.
// - Rewards are 5 to choose from and both get one (5 选 2): one picks, then the other picks from the
//   rest. Who goes first alternates by wave. An item that goes on a Pokémon only goes on your own, except
//   medicine (HP, revive, status, PP: gone once used), which may be used on the teammate's Pokémon too.
//   A special reward (a set list: fixed battles, mystery encounters) is one pick, by the same alternation.
// - Held-item transfer, discard, fusion, reordering and releasing (on the reward screen's party menu) only
//   touch the picker's own Pokémon; after a catch only the catcher's six count: when they are full the
//   game asks which of their own to release (the teammate's room does not matter).
// - Two players: every enemy Pokémon has double max HP (wild, trainers, bosses), on top of the double battles.
window.CoopTeam = (function () {
  const log = (...a) => console.log('COOP', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x)));
  const KEY = 'coop-owners-v1';
  const UI_PARTY = 8, UI_STARTER = 10, OWNERS_KEPT = 2000;
  const CAP = 6; // Pokémon per player (the game's own party limit, for each of the two)
  const SLOTS = 6; // places in the game's party menu; its cursor uses 6 and 7 for the buttons
  window.PRS_COOP_TEAMS = true;
  const SWITCHING = [0, 1, 2]; // PartyUiMode SWITCH, FAINT_SWITCH, POST_BATTLE_SWITCH
  const ITEM_ON_MON = [4, 5, 6, 7, 14, 15]; // MODIFIER, MOVE_, TM_, REMEMBER_MOVE_, EVOLUTION_ITEM_, FORM_CHANGE_ITEM_
  const label = w => (w === 'p1' ? '1P' : '2P');
  const other = w => (w === 'p1' ? 'p2' : 'p1');
  const scene = () => window.PRS_SCENE;
  let owners = {};
  try { owners = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
  let lastBall = null; // {who, wave}: who threw a ball this wave, for a Pokémon that joins

  const party = () => { const s = scene(); return (s && s.getPlayerParty && s.getPlayerParty()) || []; };
  const ownerOf = p => (p && owners[p.id]) || null;
  const count = who => party().filter(p => owners[p.id] === who).length;
  // can this player still send something out? (own, not fainted, not already on the field)
  const canSendOut = who => party().some(p => owners[p.id] === who && !p.isFainted() && !p.isOnField());

  function assign() {
    const s = scene(), list = party();
    if (!list.length) return;
    const fresh = list.every(p => !owners[p.id]); // a new run (or a save from before co-op teams)
    let changed = false;
    list.forEach((p, i) => {
      if (owners[p.id]) return;
      const b = s.currentBattle, wave = b ? b.waveIndex : -1;
      let who;
      if (fresh) who = startersPicked && starterOwners.length === list.length ? starterOwners[i] : i % 2 ? 'p2' : 'p1';
      else if (lastBall && lastBall.wave === wave) who = lastBall.who;
      else { const a = count('p1'), c = count('p2'); who = a < c ? 'p1' : c < a ? 'p2' : i % 2 ? 'p2' : 'p1'; }
      owners[p.id] = who;
      changed = true;
      log('owner', (p.getNameToRender ? p.getNameToRender() : p.name) + ' -> ' + label(who));
    });
    if (fresh) { log('new party: ' + (startersPicked && starterOwners.length === list.length ? 'starter owners ' + starterOwners.join(',') : 'alternating (picked ' + startersPicked + ', owners ' + starterOwners.length + ', party ' + list.length + ')')); if (startersPicked) { try { purseNewRun(); } catch (e) { log('purse error', String(e)); } } startersPicked = false; } // used up by this run
    if (changed) {
      // keep owners of Pokémon not in this party too (another save slot); bounded (ids are number-like keys, so what goes beyond the bound is by id, not by age: keep it large)
      const now = {}, old = {};
      list.forEach(p => { if (owners[p.id]) now[p.id] = owners[p.id]; });
      Object.keys(owners).filter(id => !now[id]).slice(-OWNERS_KEPT).forEach(id => { old[id] = owners[id]; });
      owners = { ...old, ...now };
      try { localStorage.setItem(KEY, JSON.stringify(owners)); } catch {}
    }
  }
  function watchBalls() {
    const s = scene(), b = s && s.currentBattle;
    if (!b || !b.turnCommands) return;
    // turnCommands is keyed by field slot = party index (getPlayerField() skips an empty slot, so its
    // positions are not slots when the left one is gone)
    for (let slot = 0; slot < (b.double ? 2 : 1); slot++) {
      const c = b.turnCommands[slot], p = party()[slot];
      // when one Pokemon throws, the game writes a BALL command with skip:true for the other slot too:
      // only the command without skip is the throw
      if (c && c.command === 1 && !c.skip && ownerOf(p)) lastBall = { who: ownerOf(p), wave: b.waveIndex };
    }
  }

  // who answers for a field slot: the owner of the Pokémon there. Only when it has fainted (a forced switch)
  // and its owner has nothing left to send out does the slot go to the other player.
  function askerFor(slot, forced) {
    const p = party()[slot], who = ownerOf(p);
    if (!who) return null;
    if (forced) { // a slot to refill: the teammate takes it when they have nobody on the field and can send one
      const x = other(who);
      if (!party().some(q => owners[q.id] === x && q.isOnField() && !q.isFainted()) && canSendOut(x)) return x;
    }
    return !forced || canSendOut(who) || !canSendOut(other(who)) ? who : other(who);
  }

  // both field slots hold this player's Pokemon (the teammate had nothing left to send out)
  function holdsBoth(who) {
    const b = scene().currentBattle, l = party();
    return !!(b && b.double && l[0] && l[1] && l[0].isOnField() && l[1].isOnField() && ownerOf(l[0]) === who && ownerOf(l[1]) === who);
  }
  // ... and the teammate can fight again (revived): which slot goes back to them, and with which Pokemon
  function slotToReturn() {
    const l = party(), w = ownerOf(l[0]);
    if (!w || !holdsBoth(w) || l[0].isFainted() || l[1].isFainted()) return null;
    const x = other(w), slot = l.findIndex((p, i) => i > 1 && owners[p.id] === x && !p.isFainted());
    return slot < 0 ? null : { who: x, field: x === 'p1' ? 0 : 1, slot };
  }
  function patchTurnInit(proto) {
    if (proto.__coopRet) return;
    proto.__coopRet = true;
    const start = proto.start;
    proto.start = function () {
      try { settle(); } catch (e) { log('settle error', String(e)); }
      try {
        const r = slotToReturn(), s = scene();
        if (r) {
          const l = party(), out = l[r.field], back = l[r.slot];
          log('slot ' + r.field + ' back to ' + label(r.who) + ': ' + back.name + ' in for ' + out.name);
          s.phaseManager.unshiftNew('SwitchSummonPhase', s.currentBattle.turn <= 1 ? 0 : 1, r.field, r.slot, true);
        }
      } catch (e) { log('slot return error', String(e)); }
      return start.apply(this, arguments);
    };
  }
  // A trainer with nobody left to send. Co-op makes every trainer battle a double battle, also against one
  // trainer alone (the game itself only does doubles against trainer pairs, whose Pokémon are split between
  // the two). For such a trainer the game queues one "send the next one" phase per fainted Pokémon as long as
  // anything is left in reserve: two knocked out in one turn with one in reserve gives two phases. The first
  // sends the last Pokémon; the second finds nobody, the game then reads the missing Pokémon inside a timer
  // (switchAndSummon: "Cannot read properties of undefined (reading 'resetSummonData')") and the phase never
  // ends: the battle hangs on "XX派出了YY！". Such a phase is ended here before it starts; that field slot
  // stays empty, as it does when a Pokémon faints with no reserve at all.
  function patchSwitchSummon(proto) {
    if (proto.__coopNone) return;
    proto.__coopNone = true;
    let base = proto; // the root Phase class: its end() only moves on to the next phase
    for (let p = Object.getPrototypeOf(base); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) base = p;
    const start = proto.start;
    proto.start = function () {
      let none = false;
      try {
        if (!this.player) { // the same lookup the game is about to do (SwitchSummonPhase.preSummon)
          const b = scene().currentBattle, l = b.enemyParty, tr = b.trainer;
          if (this.slotIndex === -1) none = !tr || !tr.getPartyMemberMatchupScores(this.fieldIndex ? 2 : 1).length;
          else none = !l[this.slotIndex];
        }
      } catch (e) { log('send-out check error', String(e)); }
      if (none) {
        log('enemy slot ' + this.fieldIndex + ': nobody left to send out, phase skipped');
        return base.end.call(this);
      }
      return start.apply(this, arguments);
    };
  }
  const notYours = o => '这只是 ' + label(o) + ' 的宝可梦，选你自己的';
  // who threw the ball that caught something this wave (the party-full release question is theirs)
  function catcher() {
    const b = scene().currentBattle;
    return lastBall && b && lastBall.wave === b.waveIndex ? lastBall.who : null;
  }
  // ---- a Pokémon joins: whose it is, and is there room ----
  // Who gets the Pokémon being added now: a catch is the thrower's; anything else (a gift, a mystery
  // encounter) goes to whoever has fewer, the encounter's decider when they have the same.
  function receiver() {
    let name = '';
    try { name = scene().phaseManager.getCurrentPhase().phaseName; } catch {}
    const c = catcher();
    if (c && name === 'AttemptCapturePhase') return c;
    const a = count('p1'), b = count('p2');
    if (a !== b) return a < b ? 'p1' : 'p2';
    if (c) return c;
    const bt = scene().currentBattle;
    return mePicker((bt && bt.waveIndex) || 0);
  }
  let joining = null; // {who, wave}: the answer given to the game's "is the party full?" just before it adds one
  const waveNow = () => { const b = scene().currentBattle; return b ? b.waveIndex : -1; };
  const joinsTo = () => (joining && joining.wave === waveNow() ? joining.who : null);
  // The game asks "party full, release one?" at six in the party. The co-op build asks this hook instead
  // (the "full" and "mefull" patches in patch-coop.mjs / patch-web.mjs): full means the one who gets the
  // Pokémon already has their six, however many the teammate has.
  window.PRS_COOP_FULL = () => {
    try {
      const w = receiver();
      joining = { who: w, wave: waveNow() };
      return count(w) >= CAP || party().length >= 2 * CAP;
    } catch (e) { log('full check error', String(e)); return party().length >= SLOTS; }
  };
  const saveOwners = () => { try { localStorage.setItem(KEY, JSON.stringify(owners)); } catch {} };
  const protoWith = (obj, method) => {
    for (let p = obj && Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) if (Object.prototype.hasOwnProperty.call(p, method)) return p;
    return null;
  };
  // The game's own "add the caught Pokémon" (EnemyPokemon.addToParty, used by a catch and by mystery
  // encounters) does nothing at six or more in the party, and the Nincada evolution only leaves a Shedinja
  // behind below six. Both look at the party's length at that moment only, so for that one call the party
  // is shortened to five and put back right after (nothing else runs in between).
  function hookJoin(s) {
    const enemy = (s.getEnemyParty && s.getEnemyParty()[0]) || null;
    const ep = enemy && protoWith(enemy, 'addToParty');
    if (ep && !ep.__coopJoin) {
      ep.__coopJoin = true;
      const add = ep.addToParty;
      ep.addToParty = function (ball, slot = -1) {
        const l = party(), n = l.length;
        let who = null;
        try { who = joinsTo() || receiver(); } catch {}
        joining = null;
        let rest = null, r;
        if (n >= SLOTS && n < 2 * CAP) rest = l.splice(SLOTS - 1);
        try { r = add.call(this, ball, slot); } finally { if (rest) l.push(...rest); }
        if (!r) { log('join: not added (party of ' + n + ')'); return r; }
        if (rest && !(slot >= 0 && slot < SLOTS)) { const i = l.indexOf(r); if (i >= 0) { l.splice(i, 1); l.push(r); } } // no place asked for: last
        if (who) { owners[r.id] = who; saveOwners(); log('owner', (r.getNameToRender ? r.getNameToRender() : r.name) + ' -> ' + label(who) + ' (joined, party of ' + l.length + ')'); }
        return r;
      };
      log('join: up to ' + CAP + ' each');
    }
    const mine = party()[0];
    const pp = mine && protoWith(mine, 'handleSpecialEvolutions');
    if (pp && !pp.__coopJoin) {
      pp.__coopJoin = true;
      const special = pp.handleSpecialEvolutions;
      pp.handleSpecialEvolutions = function (...a) {
        const l = party(), who = ownerOf(this), before = new Set(l);
        let rest = null, r;
        if (who && l.length >= SLOTS && l.length < 2 * CAP && count(who) < CAP) rest = l.splice(SLOTS - 1);
        try { r = special.apply(this, a); } finally { if (rest) l.push(...rest); }
        try {
          l.filter(p => !before.has(p)).forEach(p => { // the Shedinja left behind: its owner's, last in the party
            if (rest) { l.splice(l.indexOf(p), 1); l.push(p); }
            if (who) { owners[p.id] = who; saveOwners(); log('owner', p.name + ' -> ' + label(who) + ' (left behind by an evolution)'); }
          });
        } catch (e) { log('evolution join error', String(e)); }
        return r;
      };
    }
  }
  // ---- the party menu with more than six in the party ----
  // view.h: the menu while it is open; view.who: who is looking; view.off: how many reserve Pokémon are
  // scrolled away above the rows on screen. The reserve as a list is: those `off`, then the rows on screen,
  // then the rest; in the party array the rows on screen always come right after the field places.
  const view = { h: null, who: null, off: 0, pos: null, hint: null };
  const big = () => party().length > SLOTS;
  const bench0 = () => { const b = scene().currentBattle; return Math.max(1, Math.min(SLOTS - 1, (b && b.getBattlerCount && b.getBattlerCount()) || 1)); };
  // Put the party in a new order, in place (the game and its menus hold on to the array itself), and take
  // along everything that remembers a Pokémon by its place: a switch already chosen this turn, phases
  // waiting in the queue (exp, level up, move learning, a switch about to happen) and the open menu.
  function reorder(next) {
    const l = party(), s = scene();
    const to = new Map();
    next.forEach((p, i) => to.set(p, i));
    if (next.length !== l.length || to.size !== l.length || l.some(p => !to.has(p))) { log('reorder refused: not the same Pokémon'); return false; }
    const map = l.map(p => to.get(p)); // old place -> new place
    if (map.every((x, i) => x === i)) return false;
    for (let i = 0; i < next.length; i++) l[i] = next[i];
    const mv = i => (Number.isInteger(i) && i >= 0 && i < map.length ? map[i] : i);
    let moved = 0;
    try {
      const b = s.currentBattle, tc = b && b.turnCommands;
      if (tc) for (const slot of [0, 1]) { const c = tc[slot]; if (c && c.command === 2 && Number.isInteger(c.cursor) && mv(c.cursor) !== c.cursor) { c.cursor = mv(c.cursor); moved++; } }
    } catch (e) { log('reorder: commands', String(e)); }
    try {
      const pm = s.phaseManager, seen = new Set();
      const take = ph => {
        if (!ph || typeof ph !== 'object' || !ph.phaseName || seen.has(ph)) return;
        seen.add(ph);
        if (ph.player !== true) return; // the enemy's side, or not about one party member
        if (Number.isInteger(ph.partyMemberIndex) && mv(ph.partyMemberIndex) !== ph.partyMemberIndex) { ph.partyMemberIndex = mv(ph.partyMemberIndex); moved++; }
        if (ph.phaseName === 'SwitchSummonPhase' && Number.isInteger(ph.slotIndex) && mv(ph.slotIndex) !== ph.slotIndex) { ph.slotIndex = mv(ph.slotIndex); moved++; }
      };
      take(pm.currentPhase); take(pm.standbyPhase);
      (((pm.phaseQueue || {}).levels) || []).forEach(lv => (lv || []).forEach(take));
      const dm = (pm.dynamicQueueManager || {}).dynamicPhaseMap;
      if (dm && dm.forEach) dm.forEach(q => ((q && q.queue) || []).forEach(take));
    } catch (e) { log('reorder: phases', String(e)); }
    const h = view.h;
    if (h) {
      try {
        if (h.transferMode) h.transferCursor = mv(h.transferCursor);
        if (h.partySwitchCursor >= 0) h.partySwitchCursor = mv(h.partySwitchCursor);
        if (h.partySlots && h.partySlots.length === l.length) { const old = h.partySlots.slice(); old.forEach((sl, i) => { h.partySlots[map[i]] = sl; }); }
      } catch (e) { log('reorder: menu', String(e)); }
    }
    if (moved) log('reorder: ' + moved + ' waiting place(s) moved along');
    return true;
  }
  function listNow() {
    const l = party(), b = bench0(), win = SLOTS - b, bench = l.slice(b);
    const rows = bench.slice(0, win), rest = bench.slice(win), off = Math.min(view.off, rest.length);
    return { b, win, off, list: rest.slice(0, off).concat(rows, rest.slice(off)) };
  }
  // The reserve in the order the players see it (Pokémon ids). The party array itself is left turned the way
  // the menu was scrolled when it closed (the game still reads places from it right after), so the order is
  // kept here and put back the next time the menu opens and at the start of every turn.
  let canon = [];
  function canonList() {
    const bench = party().slice(bench0());
    const at = p => { const i = canon.indexOf(p.id); return i < 0 ? canon.length : i; };
    return bench.map((p, i) => [p, at(p), i]).sort((x, y) => x[1] - y[1] || x[2] - y[2]).map(x => x[0]);
  }
  function settle() {
    if (!big() || view.h || !canon.length) return;
    const l = party(), b = bench0(), list = canonList();
    if (list.every((p, i) => l[b + i] === p)) return;
    view.off = 0;
    reorder(l.slice(0, b).concat(list));
  }
  function showFrom(list, off) {
    const l = party(), b = bench0(), win = SLOTS - b;
    off = Math.max(0, Math.min(off, Math.max(0, list.length - win)));
    view.off = off;
    canon = list.map(p => p.id);
    return reorder(l.slice(0, b).concat(list.slice(off, off + win), list.slice(0, off), list.slice(off + win)));
  }
  // the menu is about to open for `who`: their own reserve first, then the teammate's, from the top
  function arrange(who) {
    view.off = 0; view.order = null;
    if (!big()) return;
    const list = canonList();
    const mine = who ? list.filter(p => owners[p.id] === who) : list, others = who ? list.filter(p => owners[p.id] !== who) : [];
    showFrom(mine.concat(others), 0);
  }
  function dropHint() { if (view.hint) { try { view.hint.destroy(); } catch {} view.hint = null; } }
  const smallText = (str, color, size) => new Phaser.GameObjects.Text(scene(), 0, 0, str, { fontFamily: 'emerald', fontSize: size, color, padding: { bottom: 6 } })
    .setScale(1 / 6).setShadow(3, 4, '#0b0910', 0, false, true);
  function drawHint(h) {
    dropHint();
    if (!big() || !window.Phaser || !h.partyContainer) return;
    const v = listNow(), above = v.off, below = Math.max(0, v.list.length - v.win - v.off);
    const str = above && below ? '▲ 上面 ' + above + ' 只　▼ 下面 ' + below + ' 只' : above ? '▲ 上面还有 ' + above + ' 只' : below ? '▼ 下面还有 ' + below + ' 只' : '';
    if (!str) return;
    view.hint = smallText(str, '#ffd84a', 66).setOrigin(1, 0).setPosition(317, -179);
    h.partyContainer.add(view.hint);
  }
  // after the game has drawn a slot for every Pokémon in the party: tag each with its owner, and with more
  // than six keep only the first six on screen (the others sit below the screen edge otherwise)
  function afterPopulate(h) {
    view.pos = null;
    if (window.Phaser) h.partySlots.forEach(sl => {
      const o = ownerOf(sl.getPokemon());
      if (!o || !sl.slotBg) return;
      const t = smallText(label(o), o === 'p1' ? '#4aa3ff' : '#f5c84c', 54).setOrigin(1, 0);
      t.setPosition(sl.slotBg.x + sl.slotBg.displayWidth - 3, sl.slotBg.y + 1);
      sl.add(t);
    });
    view.n = party().length;
    if (!big()) { view.order = null; dropHint(); return; }
    view.pos = h.partySlots.map(sl => [sl.x, sl.y]);
    view.off = Math.min(view.off, Math.max(0, party().length - SLOTS));
    view.order = listNow().list;
    canon = view.order.map(p => p.id);
    h.partySlots.forEach((sl, i) => sl.setVisible(i < SLOTS));
    drawHint(h);
  }
  // one was released while the menu is open: the list closes up where it was (the game cut it out of the
  // party array, which would leave the rows above and below the window in the wrong order)
  function closeUp(h) {
    if (view.h !== h || !view.order || !view.n || view.n === party().length) return;
    const l = party(), b = bench0(), bench = l.slice(b);
    const list = view.order.filter(p => bench.includes(p));
    bench.forEach(p => { if (!list.includes(p)) list.push(p); });
    showFrom(list, view.off);
  }
  // slots follow their Pokémon to its new place (same objects, so what the menu wrote on them stays)
  function place(h) {
    const pos = view.pos;
    if (!pos) return;
    h.partySlots.forEach((sl, i) => {
      if (pos[i]) sl.setPosition(pos[i][0], pos[i][1]);
      sl.slotIndex = i;
      sl.setVisible(i < SLOTS);
      if (i === h.cursor) sl.select(); else sl.deselect();
    });
    view.order = listNow().list;
    canon = view.order.map(p => p.id);
    drawHint(h);
  }
  function scroll(h, d) {
    const v = listNow(), off = v.off + d;
    if (off < 0 || off > v.list.length - v.win) return false;
    showFrom(v.list, off);
    place(h);
    try { h.showPartyText(); } catch {}
    return true;
  }
  // An item transfer or a fusion starts on one Pokémon and ends on another, and the game only accepts both
  // among the first six: when the first one has been scrolled away, bring it back before the second is confirmed.
  function bringIn(h) {
    if (!h.transferMode || !(h.transferCursor >= SLOTS)) return;
    const l = party(), b = bench0();
    let j = SLOTS - 1;
    if (j === h.cursor) j--;
    if (j < b) return;
    const next = l.slice();
    [next[j], next[h.transferCursor]] = [next[h.transferCursor], next[j]];
    if (reorder(next)) place(h);
  }
  // medicine: used up on the spot (HP, revive, status, PP). May be used on the teammate's Pokémon.
  const MEDICINE = ['PokemonHpRestoreModifierType', 'PokemonStatusHealModifierType', 'PokemonPpRestoreModifierType', 'PokemonAllMovePpRestoreModifierType'];
  function isMedicine(type) {
    for (let p = type && Object.getPrototypeOf(type); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (p.constructor && MEDICINE.includes(p.constructor.name)) return true;
    }
    return false;
  }

  // ---- the party menu only offers your own Pokémon ----
  function hookParty(s) {
    const h = s.ui && s.ui.handlers && s.ui.handlers[UI_PARTY];
    if (!h || h.__coop) return;
    h.__coop = true;
    const populate = h.populatePartySlots;
    h.populatePartySlots = function () {
      try { closeUp(this); } catch (e) { log('party list error', String(e)); }
      const r = populate.apply(this, arguments);
      try { afterPopulate(this); } catch (e) { log('party slots error', String(e)); }
      return r;
    };
    const input = h.processInput;
    h.processInput = function (button) {
      try {
        if (this.active && big() && !this.pendingPrompt && !this.blockInput && !this.awaitingActionInput) {
          if (button === 5) bringIn(this);
          if (!this.optionsMode) {
            const last = Math.min(SLOTS, party().length) - 1;
            let done = false;
            if (button === 1 && this.cursor === last) done = scroll(this, 1); // 下 on the last row: the next one comes up
            else if (button === 0 && this.cursor === bench0()) done = scroll(this, -1);
            else if (button === 0 && this.cursor === 6) { this.setCursor(last); done = true; } // from 取消 up: the last row on screen
            if (done) { try { this.getUi().playSelect(); } catch {} return true; }
          }
        }
      } catch (e) { log('party scroll error', String(e)); }
      return input.call(this, button);
    };
    const clear = h.clear;
    h.clear = function () {
      dropHint();
      view.h = null; view.pos = null; view.order = null; view.n = 0;
      return clear.apply(this, arguments);
    };
    const show = h.show;
    h.show = function (args) {
      try {
        const mode = args[0];
        let who = null;
        let any = false; // nothing of their own passes the game's filter: let them pick anyone
        let medicine = false;
        if (SWITCHING.includes(mode)) who = askerFor(args[1], mode === 1); // 1 = FAINT_SWITCH
        else if (ITEM_ON_MON.includes(mode) || mode === 9) { // 9 = SPLICE: both halves your own
          who = rewardPicker();
          try { // the menu was opened by the game for exactly that item (its own filter came along), not by anything else
            const ph = scene().phaseManager.getCurrentPhase(), item = ph && ph.__coopItem;
            medicine = mode !== 9 && !!who && isMedicine(item) && (typeof item.selectFilter === 'function' ? args[3] === item.selectFilter : args[3] == null);
          } catch {}
          if (medicine) log('party menu: medicine, ' + label(who) + ' may use it on either team');
        }
        else if (mode === 3) { // REVIVAL_BLESSING: the user's owner revives one of their own (no cancel in this mode)
          who = ownerOf(party()[args[1]]);
          any = !!who && !party().some(p => owners[p.id] === who && p.isFainted());
        }
        this.__coopAsker = SWITCHING.includes(mode) ? who : null; // for 放生 from the in-battle switch menu
        if (!this.active && args.length) { // the menu really opens now: set its list up for whoever is looking
          view.h = this;
          view.who = who || (mode === 10 ? joinsTo() || catcher() : null) || actor();
          arrange(view.who);
        }
        if (who && !any && !medicine) {
          const base = typeof args[3] === 'function' ? args[3] : null;
          const switching = SWITCHING.includes(mode);
          args = args.slice();
          while (args.length < 3) args.push(undefined);
          args[3] = (p, ...rest) => {
            const r = base ? base(p, ...rest) : null;
            if (r) return r;
            const o = ownerOf(p);
            if (o && o !== who && switching && holdsBoth(who)) return null; // hand the slot back to the teammate
            if (o && o !== who && (!switching || mode !== 1 || canSendOut(who))) return notYours(o);
            return null;
          };
        }
      } catch (e) { log('party filter error', String(e)); }
      return show.call(this, args);
    };
    // The rest goes by what the menu is doing when the button is pressed, not by how it was opened: the
    // 查看队伍 menu (CHECK 11) turns into item transfer (8) or discard (13) in place.
    const refuse = (h, text, later) => {
      const say = () => { try { h.clearOptions(); h.showText(text, undefined, () => h.showPartyText(), undefined, true); } catch (e) { log('refuse error', String(e)); } };
      if (later) setTimeout(say, 0); else say();
      try { h.getUi().playError(); } catch {}
      return true;
    };
    const wrap = (name, f) => {
      const orig = h[name];
      if (typeof orig !== 'function') { log('party menu: no ' + name + ' in this build'); return; }
      h[name] = function (...a) {
        let stop = null;
        try { stop = f.call(this, ...a); } catch (e) { log(name + ' check error', String(e)); }
        return stop ? stop() : orig.apply(this, a);
      };
    };
    // held items: take from and give to your own only (also "全部"); same for throwing items away
    const ownItems = function (pokemon) {
      const who = rewardPicker(), o = ownerOf(pokemon);
      return who && o && o !== who ? () => refuse(this, notYours(o)) : null;
    };
    wrap('processModifierTransferModeInput', ownItems);
    wrap('processDiscardMenuInput', ownItems);
    // releasing: after a catch with a full party (RELEASE 10) only the catcher's own; from 查看队伍 only
    // the picker's own, and never your last one; from the in-battle switch menu only the asker's own
    wrap('processReleaseOption', function (pokemon) {
      const mode = this.partyUiMode, who = mode === 10 ? joinsTo() || catcher() : rewardPicker() || this.__coopAsker, o = ownerOf(pokemon);
      if (!who || !o) return null;
      // after a catch: your own; the teammate's only when they hold more than their share and you fewer
      if (o !== who && !(mode === 10 && count(who) < CAP && count(o) > CAP)) return () => refuse(this, notYours(o));
      if (mode !== 10 && count(who) <= 1) return () => refuse(this, '这是你最后一只宝可梦，不能放生');
      return null;
    });
    // reordering in 查看队伍: only among your own, so the two field slots stay one each
    wrap('startPartySwitch', function (cursor) {
      const who = rewardPicker(), o = ownerOf(party()[cursor]);
      return who && o && o !== who ? () => refuse(this, notYours(o)) : null;
    });
    wrap('swapPartyMembers', function (a, b) {
      const oa = ownerOf(party()[a]), ob = ownerOf(party()[b]);
      // the caller redraws the menu text right after, so say it one tick later
      return oa && ob && oa !== ob ? () => refuse(this, '只能和你自己的宝可梦换位置', true) : null;
    });
    log('party menu: own Pokémon only');
  }

  // ---- starters: two rounds, each with their own points ----
  // The game's starter screen holds six and checks its own points limit (10, or 15 in endless). It is used
  // twice: 1P picks and confirms, the screen is emptied, 2P picks and confirms; then the run starts with
  // both lists as one party: 1P's first, 2P's first (the two on the field), then the rest of each.
  // starterOwners is parallel to that party and is read by assign() when the run's party appears.
  let starterOwners = [], startersPicked = false;
  let starterHandler = null;
  const round = { n: 1, first: null, spent: 0 }; // first: 1P's picks, kept while 2P picks
  const startLimit = () => { const m = (scene().gameMode || {}).modeId; return m === 1 || m === 2 ? 15 : 10; };
  const starterCost = ids => ids.reduce((a, id) => a + scene().gameData.getSpeciesStarterValue(id), 0);
  // whose round it is
  function starterPicker() {
    const h = starterHandler;
    return h && h.active ? (round.n === 1 ? 'p1' : 'p2') : null;
  }
  function hookStarters(s) {
    const h = s.ui && s.ui.handlers && s.ui.handlers[UI_STARTER];
    if (!h || h.__coop) return;
    h.__coop = true;
    starterHandler = h;
    const show = h.show;
    h.show = function (args) {
      try {
        if (args && args.length && typeof args[0] === 'function') { // the screen opens for a new run
          const run = args[0], self = this;
          round.n = 1; round.first = null; round.spent = 0;
          const picked = function (list) {
            if (round.n === 1) { // 1P is done: keep their picks, empty the screen, 2P's round
              round.first = list.slice();
              round.spent = starterCost(self.partyStarterIds);
              round.n = 2;
              self.starterSelectCallback = picked; // the game dropped it before calling
              while (self.partyStarterIds.length > 0) self.popPartyStarter(self.partyStarterIds.length - 1);
              try { self.tryUpdateValue(); } catch {}
              try { self.clearText(); } catch {}
              log('starters: 1P picked ' + round.first.length + ' (' + round.spent + ' points), 2P picks now');
              return;
            }
            const a = round.first || [], b = list.slice();
            const all = [a[0], b[0], ...a.slice(1), ...b.slice(1)].filter(Boolean);
            starterOwners = [a.length ? 'p1' : null, b.length ? 'p2' : null, ...a.slice(1).map(() => 'p1'), ...b.slice(1).map(() => 'p2')].filter(Boolean);
            startersPicked = true;
            log('starters: 1P ' + a.length + ' + 2P ' + b.length + ' = ' + all.length);
            round.n = 1; round.first = null; round.spent = 0;
            return run(all);
          };
          args = args.slice();
          args[0] = picked;
        }
      } catch (e) { log('starter rounds error', String(e)); }
      return show.call(this, args);
    };
    // the confirm question says whose round ends
    const start = h.tryStart;
    if (typeof start === 'function') h.tryStart = function (...a) {
      const ui = this.getUi(), own = Object.prototype.hasOwnProperty.call(ui, 'showText'), st = ui.showText;
      ui.showText = function (text, ...r) {
        return st.call(this, round.n === 1 ? '1P 就带这 ' + h.partyStarterIds.length + ' 只吗？\n确定后轮到 2P 挑。' : '2P 就带这 ' + h.partyStarterIds.length + ' 只吗？\n确定后两队一起出发。', ...r);
      };
      try { return start.apply(this, a); } finally { if (own) ui.showText = st; else delete ui.showText; }
    };
    log('starters: two rounds, own points');
  }
  function starters() {
    const h = starterHandler;
    if (!h || !h.active) return null;
    const lim = startLimit(), now = starterCost(h.partyStarterIds || []), n = (h.partyStarterIds || []).length;
    const first = round.n === 1;
    return {
      picker: starterPicker(), round: round.n, lim, cap: CAP,
      left: { p1: first ? lim - now : lim - round.spent, p2: first ? lim : lim - now },
      picks: { p1: first ? n : (round.first || []).length, p2: first ? 0 : n },
    };
  }

  // ---- rewards: 5 选 2 ----
  let making = null; // set while we create the second round, so create() knows what it is
  function rewardPicker() {
    const s = scene();
    try { const ph = s.phaseManager.getCurrentPhase(); return (ph && ph.__coop && ph.__coop.picker) || null; } catch { return null; }
  }
  function patchRewardPhase(proto) {
    if (proto.__coop) return;
    proto.__coop = true;
    const count = proto.getModifierCount;
    proto.getModifierCount = function () {
      const n = count.call(this), c = this.__coop;
      if (!c || this.customModifierSettings) return n; // a set list (the second round, or a special reward)
      return c.round === 1 ? n + 2 : n + 1; // normally 3 -> 5; the second round's reroll gives one fewer
    };
    const menu = proto.openModifierMenu; // the party menu opens for an item: which one (medicine may go to the teammate's)
    if (typeof menu === 'function') proto.openModifierMenu = function (type, ...r) { this.__coopItem = type; return menu.call(this, type, ...r); };
    const select = proto.selectRewardModifierOption;
    proto.selectRewardModifierOption = function (cursor, cb) { this.__coopCursor = cursor; return select.call(this, cursor, cb); };
    const apply = proto.applyModifier;
    proto.applyModifier = function (modifier, cost = -1, playSound = false) {
      if (this.__coop && cost === -1) this.__coop.took = this.__coopCursor;
      return apply.call(this, modifier, cost, playSound);
    };
    const reroll = proto.rerollModifiers;
    proto.rerollModifiers = function () {
      const r = reroll.call(this);
      if (r && this.__coop) this.__coop.rerolled = true;
      return r;
    };
    // the phase finishes through its parent's end(), so hook that one (it only acts on tagged phases)
    const parent = Object.getPrototypeOf(proto), end = parent.end;
    parent.end = function () {
      const c = this.__coop;
      if (c && !c.ended) {
        c.ended = true;
        try { if (c.round === 1 && !c.rerolled && !c.single) queueSecondRound(this, c); } catch (e) { log('second round error', String(e)); }
      }
      return end.apply(this, arguments);
    };
  }
  function queueSecondRound(ph, c) {
    const pm = scene().phaseManager;
    const rest = (ph.typeOptions || []).filter((o, i) => i !== c.took);
    // a TM picked, its learning cancelled and something picked again: replace the round queued the first time
    pm.tryRemovePhase('SelectModifierPhase', p => p.__coop && p.__coop.round === 2);
    if (!rest.length) return;
    making = { round: 2, picker: other(c.picker) };
    let next;
    try { next = pm.create('SelectModifierPhase', 0, undefined, { guaranteedModifierTypeOptions: rest, fillRemaining: false, allowLuckUpgrades: false }, true); }
    finally { making = null; }
    pm.unshiftPhase(next);
    log('rewards: ' + label(c.picker) + (c.took == null ? ' skipped' : ' took one') + ', ' + label(next.__coop.picker) + ' picks from ' + rest.length);
  }
  function tagReward(ph, args) {
    const [rerollCount, , custom, isCopy] = args;
    if (making) { ph.__coop = { ...making }; return; }
    let cur = null;
    try { cur = scene().phaseManager.getCurrentPhase(); } catch {}
    const curCo = cur && cur.phaseName === 'SelectModifierPhase' && cur.__coop;
    if (curCo && (isCopy || rerollCount > 0)) { // the same round again: a reroll, or the copy kept for a TM
      ph.__coop = { round: curCo.round, picker: curCo.picker };
      if (curCo.single) ph.__coop.single = true;
      return;
    }
    if (!isCopy && !rerollCount) {
      const wave = (scene().currentBattle || {}).waveIndex || 0, picker = wave % 2 ? 'p2' : 'p1';
      if (!custom) ph.__coop = { round: 1, picker }; // the normal reward after a battle
      // a set list (fixed battles, mystery encounters, the shop-only screen): one pick, no second round
      else { ph.__coop = { round: 1, picker, single: true }; log('rewards: special, one pick by ' + label(picker)); }
    }
  }
  function hookPhases(s) {
    const pm = s.phaseManager;
    if (!pm || pm.__coop) return;
    pm.__coop = true;
    const create = pm.create;
    pm.create = function (name, ...args) {
      const ph = create.call(this, name, ...args);
      if (name === 'SelectModifierPhase') {
        try { patchRewardPhase(Object.getPrototypeOf(ph)); tagReward(ph, args); } catch (e) { log('reward hook error', String(e)); }
      }
      // every replacement after a faint is made here (pushNew goes through create), so the first one patches the class
      if (name === 'SwitchSummonPhase') { try { patchSwitchSummon(Object.getPrototypeOf(ph)); } catch (e) { log('send-out hook error', String(e)); } }
      return ph;
    };
    // the game starts a turn with `new TurnInitPhase` (not through create), so patch its class right away
    try { patchTurnInit(Object.getPrototypeOf(create.call(pm, 'TurnInitPhase'))); } catch (e) { log('turn hook error', String(e)); }
    log('rewards: 5 选 2 on');
  }

  // ---- two players: tougher enemies ----
  // hacking 11-12: with two players the enemies get more HP than in single player, on top of the double
  // battles. 11-13 (players found twice too hard): the host picks 1, 1.5 or 2 times (localStorage
  // coop-enemy-hp, default 1.5), and a battle the game forces to be single (some mystery encounters) is left
  // at the game's own HP, because only one of the two can fight there.
  // Every enemy Pokémon of a double battle (wild, trainer's whole party, bosses) gets that many times the
  // max HP the game would give it; nothing else (level, other stats, rewards) changes.
  // Nothing is remembered between sessions: the normal max HP is recomputed with the game's own
  // calculateStats, so an enemy rebuilt from a save is set to exactly the multiple again, never twice over.
  const HP_KEY = 'coop-enemy-hp', HP_CHOICES = [1, 1.5, 2];
  function hpMult() {
    let v = NaN;
    try { v = Number(localStorage.getItem(HP_KEY)); } catch {}
    return HP_CHOICES.includes(v) ? v : 1.5;
  }
  function setHpMult(v) {
    v = Number(v);
    if (!HP_CHOICES.includes(v)) return hpMult();
    try { localStorage.setItem(HP_KEY, String(v)); } catch {}
    log('enemy HP setting: x' + v + ' (from the next enemies on)');
    return v;
  }
  function scaleHp(e, mult) {
    if (e.__coopX2 || !e.stats || typeof e.calculateStats !== 'function') return;
    const calc = e.calculateStats, hp0 = e.hp, max0 = e.stats[0];
    calc.call(e); // the game's own numbers (also undoes a multiplied value that came back from a save)
    const base = e.stats[0];
    if (!(base > 1)) { e.__coopX2 = true; return; } // 1 HP by design (Shedinja): left alone
    const share = max0 > 0 ? Math.min(1, hp0 / max0) : 1; // how full it was before
    const top = Math.round(base * mult);
    e.stats[0] = top;
    e.hp = hp0 > 0 ? Math.max(1, Math.round(share * top)) : 0;
    e.__coopX2 = true;
    if (mult !== 1) e.calculateStats = function () { // the game recalculates stats (form change, level...): keep the multiple
      const hp1 = this.hp, max1 = this.stats ? this.stats[0] : 0;
      const r = calc.apply(this, arguments);
      const max = Math.round(this.stats[0] * mult);
      this.stats[0] = max;
      if (hp1 > 0) this.hp = Math.min(max, hp1 + Math.max(0, max - max1));
      return r;
    };
    try { if (e.battleInfo) e.updateInfo(true); } catch {}
    return base;
  }
  function enemyRule() {
    const s = scene(), b = s.currentBattle;
    if (!b || !b.enemyParty) return;
    const mult = b.double ? hpMult() : 1, done = [];
    for (const e of b.enemyParty) {
      if (!e || e.__coopX2) continue;
      const base = scaleHp(e, mult);
      if (base) done.push(e.name + ' ' + base + '->' + e.stats[0] + (e.isBoss && e.isBoss() ? ' (boss)' : ''));
    }
    if (done.length) { log('enemy HP x' + mult + ' wave ' + b.waveIndex + (b.double ? '' : ' (single battle)') + ': ' + done.join(', ')); }
  }

  // ---- each player's own money and Poké Balls ----
  // The game has one wallet and one ball pouch. Here each player has their own, and the game's two fields
  // (scene.money, scene.pokeballCounts) become views: while something is one player's business the game
  // reads and writes that player's share; otherwise it sees the two added together.
  // - Whose business: the reward screen is the picker's (buying, rerolling, a money or ball reward picked);
  //   a Pokémon choosing its command is its owner's (the ball menu shows their balls); a throw is the
  //   thrower's; a mystery encounter is its decider's.
  // - Anything else that comes in (prize money after a battle) is split in half; anything else that goes
  //   out is taken half each.
  // - The save file keeps the totals, as the game expects, plus one extra block "coop" that the game itself
  //   ignores: who owns each Pokémon of the party and each player's money and balls at that moment. Loading
  //   that save (next session, another device, an exported file) puts both back. A copy of the split is also
  //   kept here by run seed. Either is used only if it still adds up to the totals in the save (otherwise:
  //   half each).
  const PURSE_KEY = 'coop-purse-v1', PURSES_KEPT = 30;
  const purse = { seed: null, money: { p1: 0, p2: 0 }, balls: { p1: {}, p2: {} }, keys: ['0', '1', '2', '3', '4'], flip: 0, dirty: false, until: 0, last: null };
  let asTotal = 0; // > 0 while the game builds its save data: totals, whoever's turn it is
  const fromSave = {}; // run seed -> the "coop" block of a save the game has read
  let ownSeed = null; // the run whose owners were last taken from its save
  const mePicker = wave => { let w = wave % 2 ? 'p1' : 'p2'; if (!count(w) && count(other(w))) w = other(w); return w; };
  function actor() {
    if (asTotal) return null;
    let ph = null;
    try { ph = scene().phaseManager.getCurrentPhase(); } catch {}
    if (!ph || !ph.phaseName) return null;
    const n = ph.phaseName;
    if (n === 'SelectModifierPhase') return (ph.__coop && ph.__coop.picker) || null;
    if (n === 'CommandPhase' || n === 'SelectTargetPhase') return ownerOf(party()[ph.fieldIndex]);
    if (n === 'AttemptCapturePhase') return catcher();
    if (n === 'EvolutionPhase') return ownerOf(ph.pokemon); // the Poké Ball a Shedinja needs is its owner's
    if (n.indexOf('MysteryEncounter') >= 0) { const b = scene().currentBattle; return b ? mePicker(b.waveIndex || 0) : null; }
    return null;
  }
  // change one player's share, or both: what comes in is halved, what goes out is taken half each
  function give(box, who, d) {
    if (!d) return;
    if (who) { box[who] = Math.max(0, (box[who] || 0) + d); return; }
    box.p1 = box.p1 || 0; box.p2 = box.p2 || 0;
    if (d > 0) {
      const half = Math.floor(d / 2), odd = d - 2 * half;
      box.p1 += half; box.p2 += half;
      if (odd) { box[purse.flip ? 'p2' : 'p1'] += odd; purse.flip ^= 1; }
    } else {
      let out = -d;
      const a = Math.min(box.p1, Math.ceil(out / 2)); box.p1 -= a; out -= a;
      const c = Math.min(box.p2, out); box.p2 -= c; out -= c;
      box.p1 = Math.max(0, box.p1 - out);
    }
  }
  const ballBox = k => ({ p1: purse.balls.p1[k] || 0, p2: purse.balls.p2[k] || 0 });
  const ballsSeen = (k, who) => (who ? purse.balls[who][k] || 0 : (purse.balls.p1[k] || 0) + (purse.balls.p2[k] || 0));
  const isBall = k => typeof k === 'string' && /^\d+$/.test(k);
  const ballView = new Proxy({}, {
    get: (t, k) => (isBall(k) ? ballsSeen(k, actor()) : undefined),
    set: (t, k, v) => {
      if (!isBall(k)) return true;
      const who = actor(), box = ballBox(k);
      give(box, who, (Number(v) || 0) - ballsSeen(k, who));
      purse.balls.p1[k] = box.p1; purse.balls.p2[k] = box.p2;
      if (!purse.keys.includes(k)) purse.keys.push(k);
      purse.dirty = true;
      return true;
    },
    has: (t, k) => isBall(k) && purse.keys.includes(k),
    ownKeys: () => purse.keys.slice(),
    getOwnPropertyDescriptor: (t, k) => (isBall(k) && purse.keys.includes(k) ? { value: ballsSeen(k, actor()), writable: true, enumerable: true, configurable: true } : undefined),
  });
  const totals = () => {
    const balls = {};
    purse.keys.forEach(k => { balls[k] = ballsSeen(k, null); });
    return { money: purse.money.p1 + purse.money.p2, balls };
  };
  function hookPurse(s) {
    if (s.__coopPurse || !('money' in s) || !s.pokeballCounts || !s.gameData) return;
    s.__coopPurse = true;
    const money0 = Math.floor(Number(s.money) || 0), balls0 = s.pokeballCounts;
    Object.defineProperty(s, 'money', {
      configurable: true, enumerable: true,
      get: () => { const who = actor(); return who ? purse.money[who] : purse.money.p1 + purse.money.p2; },
      set: v => {
        const who = actor(), now = who ? purse.money[who] : purse.money.p1 + purse.money.p2;
        give(purse.money, who, (Number(v) || 0) - now);
        purse.dirty = true;
      },
    });
    Object.defineProperty(s, 'pokeballCounts', {
      configurable: true, enumerable: true,
      get: () => ballView,
      set: obj => { // the game puts a new pouch in place (new run): split it
        purse.keys = Object.keys(obj || {});
        purse.balls = { p1: {}, p2: {} };
        purse.keys.forEach(k => { const box = { p1: 0, p2: 0 }; give(box, null, Number(obj[k]) || 0); purse.balls.p1[k] = box.p1; purse.balls.p2[k] = box.p2; });
        purse.dirty = true;
      },
    });
    s.money = money0;
    s.pokeballCounts = balls0;
    // the save file gets the totals, as plain numbers
    const save = s.gameData.getSessionSaveData;
    if (typeof save === 'function') s.gameData.getSessionSaveData = function () {
      asTotal++;
      try {
        const r = save.apply(this, arguments);
        if (r && typeof r === 'object') {
          const t = totals(), own = {};
          party().forEach(p => { if (owners[p.id]) own[p.id] = owners[p.id]; });
          r.money = Math.floor(t.money); r.pokeballCounts = t.balls;
          // keys here must not be ones the game's save reader converts (party, modifiers, arena, trainer...)
          r.coop = { v: 1, own, cash: { p1: purse.money.p1, p2: purse.money.p2 }, pb: { p1: { ...purse.balls.p1 }, p2: { ...purse.balls.p2 } } };
          if (r.seed) { // the same split by seed, for a save written before this block existed in it
            const all = purseStore();
            all[r.seed] = { money: r.coop.cash, balls: r.coop.pb, t: Date.now() };
            const ids = Object.keys(all).sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
            ids.slice(0, Math.max(0, ids.length - PURSES_KEPT)).forEach(id => { delete all[id]; });
            try { localStorage.setItem(PURSE_KEY, JSON.stringify(all)); } catch {}
          }
        }
        return r;
      } finally { asTotal--; }
    };
    // reading a save: remember its co-op block; loading one: take owners and the split from it again
    const parse = s.gameData.parseSessionData;
    if (typeof parse === 'function') s.gameData.parseSessionData = function () {
      const r = parse.apply(this, arguments);
      try { if (r && r.seed && r.coop && r.coop.v === 1) fromSave[r.seed] = r.coop; } catch {}
      return r;
    };
    const load = s.gameData.loadSession;
    if (typeof load === 'function') s.gameData.loadSession = function () {
      const r = load.apply(this, arguments);
      Promise.resolve(r).then(() => { ownSeed = null; purse.seed = null; }, () => {});
      return r;
    };
    log('purse: own money and balls on (' + money0 + ' to split)');
  }
  // owners of a loaded run come from its save (this device may never have seen that run)
  function ownersFromSave(s) {
    if (!s.seed || s.seed === ownSeed || !party().length) return;
    ownSeed = s.seed;
    const c = fromSave[s.seed];
    if (!c || !c.own) return;
    let n = 0;
    party().forEach(p => { const w = c.own[p.id]; if ((w === 'p1' || w === 'p2') && owners[p.id] !== w) { owners[p.id] = w; n++; } });
    if (n) { try { localStorage.setItem(KEY, JSON.stringify(owners)); } catch {} log('owners: ' + n + ' taken from the save'); }
  }
  const purseStore = () => { try { return JSON.parse(localStorage.getItem(PURSE_KEY) || '{}') || {}; } catch { return {}; } };
  function purseTick(s) {
    if (!s.__coopPurse) return;
    const now = Date.now();
    if (s.seed !== purse.seed) { purse.seed = s.seed; purse.until = now + 4000; } // another run, or this one loaded again: its split is in the save
    if (purse.until) {
      const t = totals(), sv = fromSave[purse.seed], kept = purseStore()[purse.seed];
      const fits = o => o && o.money && o.balls && o.money.p1 + o.money.p2 === t.money
        && purse.keys.every(k => ((o.balls.p1 || {})[k] || 0) + ((o.balls.p2 || {})[k] || 0) === t.balls[k]);
      const old = [sv && { money: sv.cash, balls: sv.pb, from: 'the save' }, kept && { ...kept, from: 'this device' }].find(fits);
      if (old && t.money + purse.keys.reduce((a, k) => a + t.balls[k], 0) > 0) {
        purse.money = { p1: old.money.p1, p2: old.money.p2 };
        purse.balls = { p1: { ...old.balls.p1 }, p2: { ...old.balls.p2 } };
        purse.until = 0;
        log('purse: split restored from ' + old.from + ', money ' + purse.money.p1 + ' / ' + purse.money.p2);
      } else if (now > purse.until) purse.until = 0;
    }
    // the number on screen is whoever's business it is now: redraw it when that changes
    const who = actor();
    if (who !== purse.last) { purse.last = who; try { s.updateMoneyText(); } catch {} }
  }
  // a new run: the game hands out five Poké Balls; here each player starts with five
  function purseNewRun() {
    const t = totals();
    if (t.balls['0'] === 5 && purse.keys.every(k => k === '0' || !t.balls[k])) { purse.balls.p1['0'] = 5; purse.balls.p2['0'] = 5; purse.dirty = true; }
    log('purse: new run, money ' + purse.money.p1 + ' / ' + purse.money.p2 + ', balls 5 each');
  }
  const purseNow = () => ({ money: { p1: purse.money.p1, p2: purse.money.p2 }, balls: { p1: { ...purse.balls.p1 }, p2: { ...purse.balls.p2 } } });

  // ---- one shared question: who answers ----
  // null when the current phase is not a shared question. Mystery encounter: the one who does NOT get the
  // reward pick of this wave, so on such a wave one answers and the other takes the reward. Biome choice
  // comes every 10 waves (always an even wave), so it alternates by tens. An evolution is its owner's.
  function sharedPicker() {
    const s = scene();
    let ph = null;
    try { ph = s.phaseManager.getCurrentPhase(); } catch {}
    const b = s && s.currentBattle;
    if (!ph || !b) return null;
    const wave = b.waveIndex || 0, name = ph.phaseName;
    let who = null;
    if (name === 'MysteryEncounterPhase') return mePicker(wave);
    else if (name === 'SelectBiomePhase') who = Math.floor(wave / 10) % 2 ? 'p1' : 'p2';
    else if (name === 'EvolutionPhase' || name === 'FormChangePhase') who = ownerOf(ph.pokemon);
    if (who && !count(who) && count(other(who))) who = other(who); // someone with no Pokémon does not answer
    return who;
  }

  setInterval(() => {
    const s = scene();
    if (!s || !s.phaseManager) return;
    try { hookPhases(s); hookParty(s); hookStarters(s); hookPurse(s); hookJoin(s); watchBalls(); ownersFromSave(s); assign(); enemyRule(); purseTick(s); } catch (e) { log('team error', String(e)); }
  }, 150);

  // the reward round on screen now: {round, picker} or null; a special one-pick reward has single: true
  function reward() {
    const s = scene();
    try { const ph = s.phaseManager.getCurrentPhase(); return ph && ph.phaseName === 'SelectModifierPhase' && ph.__coop ? ph.__coop : null; } catch { return null; }
  }
  return { ownerOf, askerFor, canSendOut, reward, sharedPicker, catcher, receiver, starters, label, other, count, CAP, hpMult, setHpMult, purse: purseNow, actor, owners: () => owners, starterOwners: () => starterOwners.slice(), view: () => ({ who: view.who, off: view.off, open: !!view.h }) };
})();
