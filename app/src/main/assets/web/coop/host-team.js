// Co-op host, part 2 of 4: two teams in one game. Needs window.PRS_SCENE (the co-op game build exposes
// its scene there). The game has one party; here every Pokémon in it gets an owner, 1P or 2P:
// - Starters: each player has their own points (10, or 15 in endless; the co-op build doubles the game's
//   limit when window.PRS_COOP_TEAMS is set, and each player's half is checked here). The two take turns
//   (whoever has fewer goes next, 1P first), so the first two, the ones on the field, are one each.
//   Each starter belongs to whoever picked it. A caught Pokémon is the thrower's. Anything else that joins
//   goes to whoever has fewer. Owners are kept in localStorage by Pokémon id, so they survive a restart.
//   (A save from before co-op teams: alternating by party order.)
// - Switching (fainted, between waves, or "换宝可梦" in battle) only offers the asker's own Pokémon, so
//   1P's always replaces 1P's. When a player has nothing left to send out, the slot goes to the other.
// - Rewards are 5 to choose from and both get one (5 选 2): one picks, then the other picks from the
//   rest. Who goes first alternates by wave. An item that goes on a Pokémon only goes on your own.
//   A special reward (a set list: fixed battles, mystery encounters) is one pick, by the same alternation.
// - Held-item transfer, discard, fusion, reordering and releasing (on the reward screen's party menu) only
//   touch the picker's own Pokémon; after a catch with a full party only the catcher's own can be released.
// - Two players: every enemy Pokémon has double max HP (wild, trainers, bosses), on top of the double battles.
window.CoopTeam = (function () {
  const log = (...a) => console.log('COOP', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x)));
  const KEY = 'coop-owners-v1';
  const UI_PARTY = 8, UI_STARTER = 10, OWNERS_KEPT = 2000;
  const CAP = 3; // each player's share of the game's six party slots
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
  // The game asks "party full, release one?" only at six. The co-op build also asks this hook (see the
  // "full" patch in patch-coop.mjs / patch-web.mjs): the catcher already has their three.
  window.PRS_COOP_FULL = () => { try { const w = catcher(); return !!w && count(w) >= CAP; } catch { return false; } };
  // ---- the party menu only offers your own Pokémon ----
  function hookParty(s) {
    const h = s.ui && s.ui.handlers && s.ui.handlers[UI_PARTY];
    if (!h || h.__coop) return;
    h.__coop = true;
    const show = h.show;
    h.show = function (args) {
      try {
        const mode = args[0];
        let who = null;
        let any = false; // nothing of their own passes the game's filter: let them pick anyone
        if (SWITCHING.includes(mode)) who = askerFor(args[1], mode === 1); // 1 = FAINT_SWITCH
        else if (ITEM_ON_MON.includes(mode) || mode === 9) who = rewardPicker(); // 9 = SPLICE: both halves your own
        else if (mode === 3) { // REVIVAL_BLESSING: the user's owner revives one of their own (no cancel in this mode)
          who = ownerOf(party()[args[1]]);
          any = !!who && !party().some(p => owners[p.id] === who && p.isFainted());
        }
        this.__coopAsker = SWITCHING.includes(mode) ? who : null; // for 放生 from the in-battle switch menu
        if (who && !any) {
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
      const mode = this.partyUiMode, who = mode === 10 ? catcher() : rewardPicker() || this.__coopAsker, o = ownerOf(pokemon);
      if (!who || !o) return null;
      // after a catch: your own; the teammate's only when they hold more than their three and you fewer
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

  // ---- starters: own points, taking turns ----
  // parallel to the starter screen's partyStarterIds, in the order that becomes the party. Only changed
  // when a starter is added or removed: the screen empties its list when the run starts, and the owners
  // must survive that until assign() reads them.
  let starterOwners = [], startersPicked = false;
  const alternate = n => Array.from({ length: n }, (x, i) => (i % 2 ? 'p2' : 'p1'));
  let starterHandler = null;
  function starterBudget(h) {
    const ids = h.partyStarterIds || [], gd = scene().gameData;
    let own = starterOwners;
    if (own.length === ids.length + 1) own = own.slice(0, ids.length); // in the middle of adding one
    else if (own.length !== ids.length) own = alternate(ids.length); // a list we didn't see built
    const spent = { p1: 0, p2: 0 }, picks = { p1: 0, p2: 0 };
    ids.forEach((id, i) => { const w = own[i]; spent[w] += gd.getSpeciesStarterValue(id); picks[w]++; });
    const lim = ((scene().gameMode || {}).modeId === 1 || (scene().gameMode || {}).modeId === 2) ? 15 : 10;
    // the cheapest starter still on offer: a player with less than that left is done picking
    let min = Infinity;
    try {
      (h.starterContainers || []).forEach(c => {
        const id = c.species.speciesId, dex = gd.dexData[id];
        if (dex && dex.caughtAttr && !ids.includes(id)) min = Math.min(min, gd.getSpeciesStarterValue(id)); // only ones you have
      });
    } catch {}
    if (!isFinite(min)) min = 1;
    return { spent, picks, lim, min, left: { p1: lim - spent.p1, p2: lim - spent.p2 }, full: ids.length >= 6 };
  }
  // whose pick is next: whoever has fewer (1P first); someone out of points is skipped
  function starterPicker() {
    const h = starterHandler;
    if (!h || !h.active) return null;
    const b = starterBudget(h);
    if (b.full) return null;
    const can = w => b.picks[w] < CAP && b.left[w] >= b.min; // three each at most
    let who = b.picks.p1 <= b.picks.p2 ? 'p1' : 'p2';
    if (!can(who)) who = other(who);
    return can(who) ? who : null;
  }
  function hookStarters(s) {
    const h = s.ui && s.ui.handlers && s.ui.handlers[UI_STARTER];
    if (!h || h.__coop) return;
    h.__coop = true;
    starterHandler = h;
    const add = h.addToParty;
    h.addToParty = function (...a) {
      const who = starterPicker() || 'p1';
      if (starterOwners.length !== this.partyStarterIds.length) starterOwners = alternate(this.partyStarterIds.length);
      starterOwners.push(who);
      startersPicked = true;
      try { return add.apply(this, a); } catch (e) { starterOwners.pop(); throw e; }
      finally { log('starter ' + this.partyStarterIds.length + ' -> ' + label(who)); }
    };
    const pop = h.popPartyStarter;
    // leaving the screen (the run starts) empties the list one by one: keep the owners through that
    let clearing = false;
    const clear = h.clear;
    h.clear = function () { clearing = true; try { return clear.apply(this, arguments); } finally { clearing = false; } };
    h.popPartyStarter = function (index) {
      if (!clearing && starterOwners.length === this.partyStarterIds.length) starterOwners.splice(index, 1);
      return pop.call(this, index);
    };
    const upd = h.tryUpdateValue;
    h.tryUpdateValue = function (add = 0, addingToParty) {
      const b = starterBudget(this), who = starterPicker();
      if (addingToParty && who && add > b.left[who]) { log('starter refused: ' + label(who) + ' has ' + b.left[who] + ' points left'); return false; }
      const r = upd.call(this, add, addingToParty);
      try {
        // grey out what the player picking now cannot afford with their own points
        if (who) this.starterContainers.forEach(c => {
          const cost = scene().gameData.getSpeciesStarterValue(c.species.speciesId);
          if (cost > b.left[who] && !this.partyStarterIds.includes(c.species.speciesId)) c.icon.setAlpha(0.375);
        });
      } catch {}
      return r;
    };
    // starting the run while one player has picked nothing (and could): not yet
    const start = h.tryStart;
    if (typeof start === 'function') h.tryStart = function (...a) {
      try {
        const b = starterBudget(this), none = ['p1', 'p2'].find(w => !b.picks[w] && b.left[w] >= b.min);
        const sig = this.partyStarterIds.join(',');
        if (this.partyStarterIds.length && !b.full && none && this.__coopRefused !== sig) {
          this.__coopRefused = sig; // asked once for these picks: pressing start again goes ahead
          log('start refused: ' + label(none) + ' has not picked yet');
          try { this.showText('两人都要至少挑一只，' + label(none) + ' 还没挑（再按一次就这样开始）', undefined, () => { try { this.clearText(); } catch {} }, 1800); } catch {}
          return false;
        }
      } catch (e) { log('start check error', String(e)); }
      return start.apply(this, a);
    };
    log('starters: own points on');
  }
  function starters() {
    const h = starterHandler;
    if (!h || !h.active) return null;
    const b = starterBudget(h);
    return { picker: starterPicker(), left: b.left, lim: b.lim, picks: b.picks };
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
    try { hookPhases(s); hookParty(s); hookStarters(s); hookPurse(s); watchBalls(); ownersFromSave(s); assign(); enemyRule(); purseTick(s); } catch (e) { log('team error', String(e)); }
  }, 150);

  // the reward round on screen now: {round, picker} or null; a special one-pick reward has single: true
  function reward() {
    const s = scene();
    try { const ph = s.phaseManager.getCurrentPhase(); return ph && ph.phaseName === 'SelectModifierPhase' && ph.__coop ? ph.__coop : null; } catch { return null; }
  }
  return { ownerOf, askerFor, canSendOut, reward, sharedPicker, catcher, starters, label, other, count, CAP, hpMult, setHpMult, purse: purseNow, actor, owners: () => owners, starterOwners: () => starterOwners.slice() };
})();
