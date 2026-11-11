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
// - 二打一: a single boss facing both players (a double battle with one enemy in all) gets double HP, once.
window.CoopTeam = (function () {
  const log = (...a) => console.log('COOP', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x)));
  const KEY = 'coop-owners-v1';
  const UI_PARTY = 8, UI_STARTER = 10, OWNERS_KEPT = 2000;
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
    if (fresh) { log('new party: ' + (startersPicked && starterOwners.length === list.length ? 'starter owners ' + starterOwners.join(',') : 'alternating (picked ' + startersPicked + ', owners ' + starterOwners.length + ', party ' + list.length + ')')); startersPicked = false; } // used up by this run
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
      if (c && c.command === 1 && ownerOf(p)) lastBall = { who: ownerOf(p), wave: b.waveIndex };
    }
  }

  // who answers for a field slot: the owner of the Pokémon there. Only when it has fainted (a forced switch)
  // and its owner has nothing left to send out does the slot go to the other player.
  function askerFor(slot, forced) {
    const p = party()[slot], who = ownerOf(p);
    if (!who) return null;
    return !forced || canSendOut(who) || !canSendOut(other(who)) ? who : other(who);
  }

  const notYours = o => '这只是 ' + label(o) + ' 的宝可梦，选你自己的';
  // who threw the ball that caught something this wave (the party-full release question is theirs)
  function catcher() {
    const b = scene().currentBattle;
    return lastBall && b && lastBall.wave === b.waveIndex ? lastBall.who : null;
  }
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
      if (o !== who) return () => refuse(this, notYours(o));
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
    let who = b.picks.p1 <= b.picks.p2 ? 'p1' : 'p2';
    if (b.left[who] < b.min && b.left[other(who)] >= b.min) who = other(who);
    return b.left[who] >= b.min ? who : null;
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
      return ph;
    };
    log('rewards: 5 选 2 on');
  }

  // ---- 二打一: one boss against both players has double HP ----
  // Only when the enemy side is a single boss in a double battle (in this build every wave is a double
  // battle, so the every-10-waves bosses come as two with the game's own split health bars: not touched;
  // a lone boss happens in mystery-encounter and one-Pokémon boss trainer battles). Applied once per boss:
  // what was done is remembered by boss id + wave, so continuing a save does not double again.
  const BOSS_KEY = 'coop-boss-x2-v1';
  let bossDone = {};
  try { bossDone = JSON.parse(localStorage.getItem(BOSS_KEY) || '{}') || {}; } catch {}
  function keepDouble(e) { // the game recalculates stats (form change...): keep the doubling through it
    if (e.__coopX2) return;
    e.__coopX2 = true;
    const calc = e.calculateStats;
    e.calculateStats = function () {
      const hp0 = this.hp, max0 = this.stats ? this.stats[0] : 0;
      const r = calc.apply(this, arguments);
      const max = this.stats[0] * 2;
      this.stats[0] = max;
      if (hp0 > 0) this.hp = Math.min(max, hp0 + Math.max(0, max - max0));
      return r;
    };
  }
  function bossRule() {
    const s = scene(), b = s.currentBattle;
    if (!b || !b.double || !b.enemyParty || b.enemyParty.length !== 1) return;
    const e = b.enemyParty[0];
    if (!e || e.__coopX2 || !e.stats || !e.isBoss || !e.isBoss()) return;
    const rec = bossDone[e.id];
    if (rec && rec.wave === b.waveIndex) { // a continued save: already doubled once
      if (e.stats[0] < rec.max) { // saved before the doubling (or recalculated on load): put it back, same share of HP
        e.hp = Math.min(rec.max, Math.round(e.hp * rec.max / e.stats[0]));
        e.stats[0] = rec.max;
      }
      keepDouble(e);
      try { e.updateInfo(true); } catch {}
      log('boss x2 kept (continued save): ' + e.name + ' wave ' + b.waveIndex + ' HP ' + e.hp + '/' + e.stats[0]);
      return;
    }
    // both players in the fight: the two leading Pokémon are one each
    const lead = party().slice(0, 2).filter(p => !p.isFainted()).map(ownerOf);
    if (!(lead.includes('p1') && lead.includes('p2'))) return;
    if (e.hp < e.stats[0]) return; // already hurt (a player came back mid-fight, an old save): leave it
    const base = e.stats[0], max = base * 2;
    e.stats[0] = max;
    e.hp = Math.min(max, e.hp * 2);
    keepDouble(e);
    bossDone = { [e.id]: { wave: b.waveIndex, max } }; // one boss at a time: older records are not needed
    try { localStorage.setItem(BOSS_KEY, JSON.stringify(bossDone)); } catch {}
    try { e.updateInfo(true); } catch {}
    log('boss x2 ' + e.name + ' wave ' + b.waveIndex + ': HP ' + base + ' -> ' + max);
  }

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
    if (name === 'MysteryEncounterPhase') who = wave % 2 ? 'p1' : 'p2';
    else if (name === 'SelectBiomePhase') who = Math.floor(wave / 10) % 2 ? 'p1' : 'p2';
    else if (name === 'EvolutionPhase' || name === 'FormChangePhase') who = ownerOf(ph.pokemon);
    if (who && !count(who) && count(other(who))) who = other(who); // someone with no Pokémon does not answer
    return who;
  }

  setInterval(() => {
    const s = scene();
    if (!s || !s.phaseManager) return;
    try { hookPhases(s); hookParty(s); hookStarters(s); watchBalls(); assign(); bossRule(); } catch (e) { log('team error', String(e)); }
  }, 150);

  // the reward round on screen now: {round, picker} or null; a special one-pick reward has single: true
  function reward() {
    const s = scene();
    try { const ph = s.phaseManager.getCurrentPhase(); return ph && ph.phaseName === 'SelectModifierPhase' && ph.__coop ? ph.__coop : null; } catch { return null; }
  }
  return { ownerOf, askerFor, canSendOut, reward, sharedPicker, catcher, starters, label, other, owners: () => owners, starterOwners: () => starterOwners.slice() };
})();
