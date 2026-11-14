// Co-op host, optional part: mods (民间创意工坊). Injected after host-team.js / host-game.js, followed by
// mods-bundle.js (every mod of the package: mods/<id>/mod.json + mod.js, packed by tools/build-mods.mjs).
// - A mod registers items and handlers through a small interface (docs: workshop-repo/docs/MOD-API.md); it never touches the
//   game's own classes. This file is the only place that knows where the game is hooked.
// - Mods only run in a co-op room (window.CoopTeam is there) and only while switched on. The switch is per
//   device (localStorage coop-mods-v1). With every mod off, no game method is wrapped except the save reader
//   and writer below, which then pass everything through unchanged.
// - Mod items are NOT game items. Who holds what is kept here, by Pokémon id, and written into the session
//   save as one extra block "coopMods" that the game itself ignores (same idea as host-team.js's "coop"
//   block), plus a copy on this device by run seed. So a save made with mods loads in a build without them
//   (the block is just dropped), and a block of a mod that is off or missing is carried along untouched.
// - Rewards: on the normal 5 选 2 reward screen a slot of the same rarity may be replaced by a mod item (as if
//   the item were one more entry in that rarity's pool). Picking it asks which of your Pokémon holds it.
// - Shown: item icons next to each player's Pokémon in battle, names on the party screen, a message when an
//   item triggers. CoopMods.openPanel() is the list of mods with their switches.
(function () {
  if (window.CoopMods) return; // injected twice (from the menu before a room, then with the room)
  const API_VERSION = 1;
  const log = (...a) => console.log('COOP mods', ...a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))));
  const scene = () => window.PRS_SCENE;
  const uiMode = () => { const t = document.getElementById('touchControls'); return (t && t.dataset.uiMode) || null; };
  const PREF_KEY = 'coop-mods-v1', HELD_KEY = 'coop-mods-held-v1', SAVE_KEY = 'coopMods', HELD_KEPT = 30;
  const TIER = { COMMON: 0, GREAT: 1, ULTRA: 2, ROGUE: 3, MASTER: 4 };
  const TIER_ZH = ['白色', '蓝色', '金色', '红色', '紫色'], TIER_CSS = ['#d8d8d8', '#6aa9ff', '#f5c84c', '#ff6a5c', '#c58cff'];
  // The game picks a reward in two steps: a rarity, then one entry of that rarity's pool by weight. A mod item
  // is treated as one more entry: chance per slot of its rarity = weight / (total + the mod weights there).
  // total: about what the game's own pool adds up to in a normal run (pokerogue 1.12 pools); cap: the largest
  // weight a mod item may have, so it never shows up more often than the game's own held items of that rarity.
  const POOL = [{ total: 250, cap: 4 }, { total: 200, cap: 4 }, { total: 170, cap: 9 }, { total: 90, cap: 5 }, { total: 80, cap: 14 }];
  const EVENTS = ['damageCalc', 'beforeDamage', 'moveSelect', 'status', 'statChange', 'faint', 'turnStart', 'turnEnd', 'give', 'remove'];
  const STATUS = [null, 'poison', 'toxic', 'paralysis', 'sleep', 'freeze', 'burn'], STATUS_ZH = { poison: '中毒', toxic: '剧毒', paralysis: '麻痹', sleep: '睡眠', freeze: '冰冻', burn: '灼伤' };

  // ---- the mods of this package, and which are switched on ----
  const mods = {}, order = [], items = {}; // items: 'modId:itemId' -> definition
  const prefs = { on: {} };
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); if (p && p.on && typeof p.on === 'object') prefs.on = p.on; } catch {}
  const isOn = id => !!mods[id] && mods[id].ok && (id in prefs.on ? !!prefs.on[id] : mods[id].manifest.default === 'on');
  const anyOn = () => order.some(isOn);
  const active = () => !!(window.CoopTeam && scene() && scene().phaseManager); // a co-op room is open
  const partyOf = s => (s && s.getPlayerParty && s.getPlayerParty()) || []; // not there yet while the game boots
  function setOn(id, on) {
    if (!mods[id]) return false;
    prefs.on[id] = !!on;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
    log('mod ' + id + ' switched ' + (on ? 'on' : 'off'));
    ov.sig = '';
    return isOn(id);
  }
  const problems = {};
  function problem(mod, what, e) {
    const n = problems[mod.id] = (problems[mod.id] || 0) + 1;
    if (n <= 20) log('mod ' + mod.id + ' error in ' + what + ': ' + String((e && e.stack) || e).slice(0, 300));
  }
  function manifest(m) {
    if (!m || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(m.id)) { log('manifest refused: bad id', m && m.id); return false; }
    if (mods[m.id]) return false;
    mods[m.id] = { id: m.id, manifest: m, items: [], on: {}, phase: [], ok: false, error: null };
    order.push(m.id);
    return true;
  }
  function define(id, setup) {
    const mod = mods[id];
    if (!mod) { log('mod ' + id + ': mod.json missing from the bundle, not loaded'); return; }
    if (mod.ok || mod.error) return;
    try {
      setup(makeApi(mod));
      mod.ok = true;
      log('mod ' + id + ' v' + mod.manifest.version + ' loaded (' + mod.items.length + ' items), ' + (isOn(id) ? 'on' : 'off'));
    } catch (e) {
      mod.error = String((e && e.stack) || e);
      mod.items.forEach(k => { delete items[k]; });
      mod.items = []; mod.on = {}; mod.phase = [];
      log('mod ' + id + ' failed to load: ' + mod.error.slice(0, 300));
    }
  }

  // ---- who holds which mod item: Pokémon id -> { 'modId:itemId': state } ----
  let held = {}, heldSeed = null;
  const fromSave = {}; // run seed -> the coopMods block of a save the game has read (null: that save has none)
  const fieldStates = new WeakMap(); // a Pokémon's summonData (a new object every time it enters the field) -> {}
  const heldOf = p => (p && held[p.id]) || null;
  const holds = (p, key) => { const h = heldOf(p); return !!(h && h[key]); };
  // what a Pokémon holds that is shown and counted: items of mods that are on
  const shownItems = p => Object.keys(heldOf(p) || {}).filter(k => items[k] && isOn(items[k].mod)).map(k => ({ key: k, def: items[k], state: held[p.id][k] }));
  function give(p, key, state) {
    if (!p || !items[key]) return false;
    (held[p.id] = held[p.id] || {})[key] = state && typeof state === 'object' ? state : {};
    ov.sig = '';
    log('item ' + key + ' -> ' + nameOf(p));
    emit('give', { pokemon: p, item: key });
    return true;
  }
  function remove(p, key) {
    if (!holds(p, key)) return false;
    delete held[p.id][key];
    if (!Object.keys(held[p.id]).length) delete held[p.id];
    ov.sig = '';
    log('item ' + key + ' gone from ' + nameOf(p));
    emit('remove', { pokemon: p, item: key });
    return true;
  }
  const kept = () => { try { return JSON.parse(localStorage.getItem(HELD_KEY) || '{}') || {}; } catch { return {}; } };
  function keep(seed, block) { // this device's copy, for a save rewritten by a build without mods
    const all = kept();
    if (block) all[seed] = { block, t: Date.now() }; else if (all[seed]) delete all[seed]; else return;
    const ids = Object.keys(all).sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
    ids.slice(0, Math.max(0, ids.length - HELD_KEPT)).forEach(id => { delete all[id]; });
    try { localStorage.setItem(HELD_KEY, JSON.stringify(all)); } catch {}
  }
  const validBlock = b => !!(b && b.v === 1 && b.held && typeof b.held === 'object' && !Array.isArray(b.held));
  function loadFor(seed) {
    heldSeed = seed;
    const sv = fromSave[seed], dev = (kept()[seed] || {}).block;
    const b = validBlock(sv) ? sv : validBlock(dev) ? dev : null;
    held = {};
    if (b) for (const id of Object.keys(b.held)) { const h = b.held[id]; if (h && typeof h === 'object' && !Array.isArray(h)) held[id] = JSON.parse(JSON.stringify(h)); }
    ov.sig = '';
    const n = Object.keys(held).length;
    const sig = seed + JSON.stringify(held);
    if (n && sig !== loadFor.sig) log('held items restored for ' + n + ' Pokémon, from ' + (b === sv ? 'the save' : 'this device'));
    loadFor.sig = sig;
  }
  function exportHeld(s) {
    const ids = new Set(partyOf(s).map(p => String(p.id))), out = {};
    for (const id of Object.keys(held)) if (ids.has(id) && held[id] && Object.keys(held[id]).length) out[id] = held[id];
    return Object.keys(out).length ? { v: 1, held: out } : null;
  }
  function hookSave(s) {
    const gd = s.gameData;
    if (!gd || gd.__coopMods || typeof gd.getSessionSaveData !== 'function') return;
    gd.__coopMods = true;
    const save = gd.getSessionSaveData;
    gd.getSessionSaveData = function () {
      const r = save.apply(this, arguments);
      try {
        if (r && typeof r === 'object' && r.seed) {
          if (r.seed !== heldSeed) loadFor(r.seed);
          const block = exportHeld(s);
          if (block) r[SAVE_KEY] = block; // a key the game's save reader does not know and leaves alone
          keep(r.seed, block);
        }
      } catch (e) { log('save error', String(e)); }
      return r;
    };
    const parse = gd.parseSessionData;
    if (typeof parse === 'function') gd.parseSessionData = function () {
      const r = parse.apply(this, arguments);
      try { if (r && r.seed) fromSave[r.seed] = validBlock(r[SAVE_KEY]) ? r[SAVE_KEY] : null; } catch {}
      return r;
    };
    const load = gd.loadSession;
    if (typeof load === 'function') gd.loadSession = function () {
      const r = load.apply(this, arguments);
      Promise.resolve(r).then(() => { heldSeed = null; }, () => {}); // this run again from its save
      return r;
    };
    log('save: held items go into the "' + SAVE_KEY + '" block');
  }

  // ---- events ----
  const listeners = type => { const out = []; for (const id of order) { const m = mods[id]; if (isOn(id) && m.on[type]) for (const fn of m.on[type]) out.push([m, fn]); } return out; };
  const has = type => active() && order.some(id => isOn(id) && mods[id].on[type] && mods[id].on[type].length);
  function emit(type, ev) {
    let last;
    for (const [m, fn] of listeners(type)) { try { const r = fn(ev); if (r !== undefined) last = r; } catch (e) { problem(m, type, e); } }
    return last;
  }
  function phaseEvent(when, ph) {
    const name = ph && ph.phaseName;
    if (!name) return;
    for (const id of order) {
      const m = mods[id];
      if (!isOn(id)) continue;
      for (const h of m.phase) if (h.name === name && h.when === when) { try { h.fn(ph); } catch (e) { problem(m, name + ' ' + when, e); } }
    }
    if (when !== 'start') return;
    if (name === 'TurnStartPhase') emit('turnStart', {});
    else if (name === 'TurnEndPhase') emit('turnEnd', {});
    else if (name === 'FaintPhase') { let p = null; try { p = ph.getPokemon(); } catch {} if (p && p.hp <= 0) emit('faint', { pokemon: p }); }
  }

  // ---- hooks into the game (installed the first time a mod is on in a co-op room) ----
  const hooked = {}; // which hooks are in: phases, pokemon, statChange, rewards
  function hookPhases(s) {
    const pm = s.phaseManager;
    if (pm.__coopMods) return;
    pm.__coopMods = true; hooked.phases = true;
    // every phase starts through startCurrentPhase and ends through shiftPhase (Phase.end)
    const start = pm.startCurrentPhase;
    pm.startCurrentPhase = function () {
      try { const ph = this.currentPhase; if (ph) { patchPhase(ph); if (active() && anyOn()) phaseEvent('start', ph); } } catch (e) { log('phase start hook error', String(e)); }
      return start.apply(this, arguments);
    };
    const shift = pm.shiftPhase;
    pm.shiftPhase = function () {
      try { const ph = this.currentPhase; if (ph && active() && anyOn()) phaseEvent('end', ph); } catch (e) { log('phase end hook error', String(e)); }
      return shift.apply(this, arguments);
    };
    log('hooks: phases');
  }
  function patchPhase(ph) {
    const proto = Object.getPrototypeOf(ph);
    if (!proto || Object.prototype.hasOwnProperty.call(proto, '__coopMods')) return;
    if (ph.phaseName === 'StatStageChangePhase' && typeof proto.applyStatChangesAndEnd === 'function') {
      proto.__coopMods = true; hooked.statChange = true;
      const apply = proto.applyStatChangesAndEnd;
      // (pokemon, changes): changes are what really applies, [{stat, stages}], already clamped to -6..+6
      proto.applyStatChangesAndEnd = function (pokemon, changes) {
        const r = apply.apply(this, arguments);
        try {
          if (has('statChange')) {
            const real = (changes || []).filter(c => c && c.stages).map(c => ({ stat: c.stat, stages: c.stages }));
            if (real.length) emit('statChange', { pokemon, changes: real, copied: !!(this.options && this.options.coopModCopy) });
          }
        } catch (e) { log('stat change hook error', String(e)); }
        return r;
      };
    } else if (ph.phaseName === 'SelectModifierPhase' && typeof proto.getModifierTypeOptions === 'function' && typeof proto.applyChosenModifier === 'function') {
      proto.__coopMods = true; hooked.rewards = true;
      const options = proto.getModifierTypeOptions;
      proto.getModifierTypeOptions = function () {
        const opts = options.apply(this, arguments);
        try { if (Array.isArray(opts)) offer(this, opts); } catch (e) { log('reward offer error', String(e)); }
        return opts;
      };
      const chosen = proto.applyChosenModifier;
      proto.applyChosenModifier = function (type, cost, cb) {
        if (!type || !type.__coopMod) return chosen.apply(this, arguments);
        try { return pickHolder(this, type, cost, cb); } catch (e) { log('reward pick error', String(e)); return false; }
      };
    }
  }
  function hookPokemon(s) {
    if (hooked.pokemon) return;
    const any = partyOf(s)[0] || (s.currentBattle && s.currentBattle.enemyParty && s.currentBattle.enemyParty[0]);
    if (!any) return;
    let proto = Object.getPrototypeOf(any); // PlayerPokemon / EnemyPokemon -> Pokemon
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'damageAndUpdate')) proto = Object.getPrototypeOf(proto);
    if (!proto || proto.__coopMods) { hooked.pokemon = !!proto; if (!proto) log('hooks: Pokemon class not found in this build'); return; }
    proto.__coopMods = true; hooked.pokemon = true;
    const wrap = (name, make) => { if (typeof proto[name] === 'function') proto[name] = make(proto[name]); else log('hooks: no Pokemon.' + name + ' in this build'); };
    // damage a move would do. Returns {cancelled, result, damage}; the game calls it for real hits and, with
    // simulated (the default), for the enemy AI's estimates.
    wrap('getAttackDamage', orig => function (o) {
      const r = orig.apply(this, arguments);
      try {
        if (r && r.damage > 0 && !r.cancelled && o && o.source && has('damageCalc')) {
          const ev = { attacker: o.source, target: this, move: o.move, simulated: o.simulated !== false, critical: !!o.isCritical, damage: r.damage };
          for (const [m, fn] of listeners('damageCalc')) { try { const d = fn(ev); if (typeof d === 'number' && isFinite(d)) ev.damage = d; } catch (e) { problem(m, 'damageCalc', e); } }
          let d = Math.max(1, Math.floor(ev.damage));
          // a limit the game itself put on this hit stays: False Swipe, Sturdy at full HP (both leave 1 HP)
          if (d > r.damage && r.damage === this.hp - 1) {
            let limited = false;
            try { limited = !!(o.move && o.move.hasAttr && o.move.hasAttr('ModifiedDamageAttr')) || (!o.ignoreAbility && this.isFullHp() && this.hasAbilityWithAttr('PreDefendFullHpEndureAbAttr')); } catch {}
            if (limited) d = r.damage;
          }
          r.damage = d;
        }
      } catch (e) { log('damage calc hook error', String(e)); }
      return r;
    });
    // every loss of HP with an animation (move hits pass opts.source, the attacker)
    wrap('damageAndUpdate', orig => function (dmg, opts) {
      let after = null;
      try {
        if (dmg > 0 && !this.isFainted() && has('beforeDamage')) {
          const o = opts || {};
          const ev = { target: this, damage: dmg, source: o.source || null, byMove: !!o.source, lethal: dmg >= this.hp, fullHp: this.hp === this.getMaxHp(), then: fn => { (after = after || []).push(fn); } };
          for (const [m, fn] of listeners('beforeDamage')) { try { const d = fn(ev); if (typeof d === 'number' && isFinite(d)) { ev.damage = Math.max(0, Math.floor(d)); ev.lethal = ev.damage >= this.hp; } } catch (e) { problem(m, 'beforeDamage', e); } }
          dmg = ev.damage;
        }
      } catch (e) { log('damage hook error', String(e)); }
      const r = orig.call(this, dmg, opts);
      if (after) for (const fn of after) { try { fn(r); } catch (e) { log('after damage error', String(e)); } }
      return r;
    });
    // may this Pokémon choose this move? Returns [ok, text shown when not]
    wrap('isMoveSelectable', orig => function (moveId) {
      try {
        if (has('moveSelect')) for (const [m, fn] of listeners('moveSelect')) {
          let no; try { no = fn({ pokemon: this, moveId }); } catch (e) { problem(m, 'moveSelect', e); }
          if (typeof no === 'string' && no) return [false, no];
        }
      } catch (e) { log('move select hook error', String(e)); }
      return orig.apply(this, arguments);
    });
    wrap('doSetStatus', orig => function (effect) {
      const r = orig.apply(this, arguments);
      try { if (STATUS[effect] && has('status')) emit('status', { pokemon: this, status: STATUS[effect] }); } catch (e) { log('status hook error', String(e)); }
      return r;
    });
    log('hooks: Pokemon damage, move choice, status');
  }

  // ---- rewards ----
  const SCREEN_CHANCE = 0.1, SCREEN_WEIGHT = [8, 6, 5, 3, 2]; // by rarity: COMMON, GREAT, ULTRA, ROGUE, MASTER
  const debug = { force: [] }; // test only: item keys the next reward screen must offer
  function rng(str) { // small seeded generator: the same run, wave and reroll always give the same offers
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h = (h + 0x6D2B79F5) | 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function makeOption(like, key, upgradeCount) {
    const it = items[key];
    const type = { // what the reward screen reads of an item type: name, iconImage, tier, getDescription()
      id: 'COOPMOD_' + key.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), localeKey: '', name: it.name, group: 'coopmod:' + key, soundName: 'se/restore',
      iconImage: it.icon, tier: TIER[it.tier], __coopMod: key,
      getDescription: () => it.description,
      setTier(t) { this.tier = t; }, getOrInferTier() { return this.tier; }, withIdFromFunc() { return this; }, withTierFromPool() { return this; },
      newModifier() { return { type: this }; }, // not a game modifier: scene.addModifier does nothing with it
    };
    const opt = Object.create(Object.getPrototypeOf(like)); // a ModifierTypeOption
    opt.type = type; opt.upgradeCount = upgradeCount || 0; opt.cost = 0;
    return opt;
  }
  // the normal reward after a battle, first round (host-team.js tags it; the second round is what is left of it)
  function offer(ph, opts) {
    const c = ph.__coop;
    const forced = debug.force.splice(0).filter(k => items[k]);
    if (!active() || !c || c.round !== 1 || c.single || ph.customModifierSettings || ph.isCopy) return;
    if (!anyOn() && !forced.length) return;
    const s = scene(), b = s.currentBattle;
    const roll = rng([s.seed, b ? b.waveIndex : 0, ph.rerollCount || 0, 'coop-mods'].join(':'));
    const taken = new Set(), put = [];
    opts.forEach((opt, i) => {
      const r = roll();
      if (!opt || !opt.type) return;
      let key = null;
      if (forced.length) key = forced.shift();
      else {
        const tier = opt.type.tier, pool = POOL[tier];
        const cands = Object.keys(items).filter(k => isOn(items[k].mod) && TIER[items[k].tier] === tier && !taken.has(k));
        if (!pool || !cands.length) return;
        const w = k => Math.max(0, Math.min(Number(items[k].weight) || 0, pool.cap));
        const total = pool.total + cands.reduce((a, k) => a + w(k), 0);
        let acc = 0;
        for (const k of cands) { acc += w(k) / total; if (r < acc) { key = k; break; } }
      }
      if (!key || taken.has(key)) return;
      taken.add(key);
      opts[i] = makeOption(opt, key, opt.upgradeCount);
      put.push(key);
    });
    // On top of the rarity pools (where a ROGUE or MASTER item would turn up once in hundreds of screens): with
    // mods on, about one reward screen in ten swaps one of its options for a mod item, picked by rarity weight.
    if (!put.length && anyOn() && roll() < SCREEN_CHANCE) {
      const cands = Object.keys(items).filter(k => isOn(items[k].mod) && SCREEN_WEIGHT[TIER[items[k].tier]]);
      const slots = opts.map((o, i) => (o && o.type ? i : -1)).filter(i => i >= 0);
      if (cands.length && slots.length) {
        const w = k => SCREEN_WEIGHT[TIER[items[k].tier]], total = cands.reduce((x, k) => x + w(k), 0);
        let r = roll() * total, key = cands[cands.length - 1];
        for (const k of cands) { r -= w(k); if (r < 0) { key = k; break; } }
        const i = slots[Math.floor(roll() * slots.length)];
        opts[i] = makeOption(opts[i], key, 0);
        put.push(key);
      }
    }
    if (put.length) log('rewards: offered ' + put.join(', '));
  }
  const handlerIndex = (s, name, fallback) => { const i = (s.ui.handlers || []).findIndex(h => h && h.constructor && h.constructor.name === name); return i >= 0 ? i : fallback; };
  // a mod item was picked on the reward screen: ask which Pokémon holds it, the way the game does for its own
  // held items (party menu in MODIFIER mode; host-team.js limits it to the picker's own Pokémon)
  function pickHolder(ph, type, cost, cb) {
    const s = scene(), key = type.__coopMod, it = items[key];
    if (!it) { s.ui.playError(); return false; }
    const party = s.getPlayerParty(), partyMode = handlerIndex(s, 'PartyUiHandler', 8);
    const rewardMode = typeof s.ui.mode === 'number' ? s.ui.mode : handlerIndex(s, 'ModifierSelectUiHandler', 6); // the screen we are on
    s.ui.setModeWithoutClear(partyMode, 4 /* PartyUiMode.MODIFIER */, -1, slot => {
      if (slot < 6 && party[slot]) {
        s.ui.setMode(rewardMode, ph.isPlayer()).then(() => {
          give(party[slot], key, {});
          try { s.ui.playSelect(); } catch {}
          ph.applyModifier({ type }, cost, true); // ends the reward round like any other pick
        });
      } else ph.resetModifierSelect(cb);
    }, p => (holds(p, key) ? nameOf(p) + '已经带着' + it.name + '了' : null));
    return cost === -1;
  }

  // ---- what a mod may ask of the battle (the stable part: mods use these, not the game's objects) ----
  const nameOf = p => (p ? (p.getNameToRender ? p.getNameToRender() : p.name) : '');
  const whoAt = (s, slot) => (window.CoopTeam && CoopTeam.ownerOf(s.getPlayerField()[slot])) || (slot === 1 ? 'p2' : 'p1');
  const targetsOf = c => (c.targets && c.targets.length ? c.targets : (c.move && c.move.targets) || []);
  let combo = null; // host-game.js's own verdict for the turn that is running: {key: 'wave:turn', target}
  function watchCombo() {
    if (combo || !window.CoopGame) return;
    combo = { key: '', target: null };
    CoopGame.on((type, d) => {
      if (type !== 'turnstart') return;
      const b = scene().currentBattle;
      combo = { key: b ? b.waveIndex + ':' + b.turn : '', target: d && d.combo ? d.target : null };
    });
  }
  const B = {
    name: nameOf,
    isPlayer: p => !!(p && p.isPlayer && p.isPlayer()),
    index: p => p.getBattlerIndex(),                    // 0, 1: the players' side; 2, 3: the enemies
    owner: p => (window.CoopTeam ? CoopTeam.ownerOf(p) : null), // 'p1' | 'p2'
    hp: p => p.hp, maxHp: p => p.getMaxHp(),
    onField: p => !!(p && p.isActive && p.isActive(true) && !p.isFainted()),
    playerField: () => scene().getPlayerField().filter(p => B.onField(p)),
    // the other Pokémon on the same side, if it is on the field and standing
    ally: p => { let a = null; try { a = p.getAlly(); } catch {} return B.onField(a) ? a : null; },
    status: p => STATUS[(p && p.status && p.status.effect) || 0] || null, // 'poison' | 'toxic' | 'paralysis' | 'sleep' | 'freeze' | 'burn' | null
    statusName: st => STATUS_ZH[st] || '',
    wave: () => (scene().currentBattle || {}).waveIndex || 0,
    turn: () => (scene().currentBattle || {}).turn || 0,
    message: text => scene().phaseManager.queueMessage(String(text)),
    // lose HP now, with the game's hit animation; not a move hit (no attacker)
    damage: (p, amount) => p.damageAndUpdate(Math.max(1, Math.floor(amount)), {}),
    // cured when the queued messages get there; false when there is nothing to cure
    cureStatus(p, text) {
      const st = B.status(p);
      if (!st) return false;
      scene().phaseManager.queueMessage(text || nameOf(p) + '的' + STATUS_ZH[st] + '治好了！');
      p.resetStatus(false, false, false, true);
      return true;
    },
    // the same stat stages for another Pokémon; marked so that no mod reacts to it again (event.copied)
    changeStats(p, changes) {
      const list = (changes || []).filter(c => c && c.stages).map(c => ({ stat: c.stat, stages: c.stages }));
      if (!list.length || !B.onField(p)) return false;
      scene().phaseManager.unshiftNew('StatStageChangePhase', { battlerIndex: p.getBattlerIndex(), sourcePokemon: p, changes: list, ignoreAbilities: true, coopModCopy: true });
      return true;
    },
    moveName(p, moveId) { const m = p.getMoveset().find(x => x && x.moveId === moveId); return m ? m.getName() : '那个招式'; },
    // moves used since entering the field, and the first one chosen by the player from position n on
    moveCount: p => p.getMoveHistory().length,
    firstMoveSince(p, n) {
      const h = p.getMoveHistory();
      for (let i = Math.max(0, n || 0); i < h.length; i++) { const m = h[i]; if (m && m.move && m.move !== 165 /* 挣扎 */ && !(m.useMode > 2)) return m.move; }
      return null;
    },
    // 集火: the enemy both players' Pokémon aim one single-target move at this turn (battler index), or null.
    // host-game.js decides it at turn start; before its verdict arrives the same rule is read from the game.
    focusTarget() {
      const s = scene(), b = s && s.currentBattle;
      if (!b || !b.double || !b.turnCommands) return null;
      if (combo && combo.key === b.waveIndex + ':' + b.turn) return combo.target;
      const aim = c => (c && c.command === 0 && targetsOf(c).length === 1 ? targetsOf(c)[0] : null);
      const t0 = aim(b.turnCommands[0]), t1 = aim(b.turnCommands[1]);
      return whoAt(s, 0) !== whoAt(s, 1) && t0 != null && t0 >= 2 && t0 === t1 ? t0 : null;
    },
  };
  function makeApi(mod) {
    return {
      version: API_VERSION,
      manifest: mod.manifest,
      battle: B,
      log: (...a) => log('[' + mod.id + ']', ...a),
      // a new item: { id, name, description, tier: 'ULTRA' | 'ROGUE' | 'MASTER' (also 'COMMON', 'GREAT'), weight, icon }
      item(def) {
        if (!def || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(def.id || '')) throw new Error('item id must be lowercase letters, digits and -');
        if (!(def.tier in TIER)) throw new Error('item ' + def.id + ': tier must be one of ' + Object.keys(TIER).join(', '));
        if (!def.name || !def.description) throw new Error('item ' + def.id + ': name and description are required');
        const key = mod.id + ':' + def.id;
        if (items[key]) throw new Error('item ' + key + ' defined twice');
        const it = items[key] = { key, mod: mod.id, id: def.id, name: String(def.name), description: String(def.description), tier: def.tier, weight: Number(def.weight) || 0, icon: String(def.icon || 'unknown') };
        mod.items.push(key);
        return {
          key, name: it.name,
          heldBy: p => holds(p, key) && isOn(mod.id),
          state: p => (holds(p, key) ? held[p.id][key] : null), // a plain object kept in the save: put only JSON values in it
          give: (p, state) => give(p, key, state),
          remove: p => remove(p, key),
        };
      },
      on(type, fn) {
        if (!EVENTS.includes(type)) throw new Error('unknown event ' + type + ' (known: ' + EVENTS.join(', ') + ')');
        (mod.on[type] = mod.on[type] || []).push(fn);
      },
      // a game phase by its class name ('TurnInitPhase', 'ObtainStatusEffectPhase' ...), before it starts or as it ends
      onPhase(name, fn, when) { mod.phase.push({ name: String(name), when: when === 'end' ? 'end' : 'start', fn }); },
      // memory that lasts while the Pokémon stays on the field (gone when it is switched out); never saved
      fieldState(p, tag) {
        const sd = p && p.summonData;
        if (!sd || typeof sd !== 'object') return {};
        let m = fieldStates.get(sd);
        if (!m) fieldStates.set(sd, m = {});
        const k = mod.id + ':' + (tag || '');
        return m[k] = m[k] || {};
      },
    };
  }

  // ---- drawn into the game (host window and the guest's video): who holds what ----
  const ov = { scene: null, layer: null, sig: '' };
  const BATTLE_MODES = ['COMMAND', 'FIGHT', 'TARGET_SELECT', 'BALL', 'MESSAGE'];
  const ownerCss = p => { const w = B.owner(p); return w === 'p1' ? '#4aa3ff' : w === 'p2' ? '#f5c84c' : '#f8f8f8'; };
  function text(s, str, color, size) {
    return new Phaser.GameObjects.Text(s, 0, 0, str, { fontFamily: 'emerald', fontSize: size, color, padding: { bottom: 6 } }).setScale(1 / 6).setShadow(3, 4, '#0b0910', 0, false, true);
  }
  function icon(s, frame, used) {
    let sp;
    try { sp = new Phaser.GameObjects.Sprite(s, 0, 0, 'items', s.textures.get('items').has(frame) ? frame : 'unknown'); } catch { return null; }
    sp.setOrigin(0, 0).setScale(12 / 32);
    if (used) sp.setAlpha(0.45).setTint(0x8a8a8a);
    return sp;
  }
  // a small dark plate with the item icons (and names when there is room), top-left corner at x, y
  function plate(s, x, y, list, names, color) {
    const c = new Phaser.GameObjects.Container(s, x, y), g = new Phaser.GameObjects.Graphics(s);
    c.add(g);
    let cx = 1;
    list.forEach(it => {
      const used = !!(it.state && it.state.used);
      const ic = icon(s, it.def.icon, used);
      if (ic) { ic.setPosition(cx, 0); c.add(ic); cx += 12; }
      if (names) { const t = text(s, it.def.name + (used ? '(已用)' : ''), used ? '#a59cb3' : '#f8f8f8', 54); t.setPosition(cx, 1); c.add(t); cx += Math.ceil(t.displayWidth) + 3; }
    });
    g.fillStyle(0x1d1824, 0.85).fillRoundedRect(0, -1, cx + 1, 14, 2);
    g.lineStyle(1, Phaser.Display.Color.HexStringToColor(color).color, 0.9).strokeRoundedRect(0, -1, cx + 1, 14, 2);
    c.w = cx + 1;
    return c;
  }
  function draw() {
    const s = scene();
    if (!s || !s.add || !window.Phaser) return;
    // (the game empties its display list at the title without destroying our layer: check it is still on it)
    if (s !== ov.scene || !ov.layer || !ov.layer.scene || s.children.getIndex(ov.layer) < 0) {
      try { if (ov.layer && ov.layer.scene) ov.layer.destroy(); } catch {}
      ov.scene = s; ov.sig = '';
      ov.layer = s.add.container(0, 0).setScale(6).setDepth(1e6 - 1).setName('coop-mods');
    }
    const mode = uiMode(), marks = [];
    if (active() && anyOn() && partyOf(s).length) {
      if (s.currentBattle && BATTLE_MODES.includes(mode)) {
        // in battle: under each of the players' Pokémon on the field
        s.getPlayerField().forEach(p => {
          if (!p || !p.isActive(true)) return;
          const list = shownItems(p);
          if (!list.length) return;
          const r = p.getSprite().getBounds();
          marks.push({ id: p.id, x: Math.round(r.x / 6), y: Math.round((r.y + r.height) / 6), anchor: 'feet', list, names: false, color: ownerCss(p) });
        });
      } else if (mode === 'PARTY') {
        // party screen: on each Pokémon's row
        const h = s.ui.getHandler(), slots = (h && h.partySlots) || [];
        partyOf(s).forEach((p, i) => {
          const list = shownItems(p), slot = slots[i];
          if (!list.length || !slot || !slot.getBounds) return;
          const r = slot.getBounds();
          // the two big cards on the left (on the field): along the top edge; the rows on the right: on the level line, inside the row
          const big = r.height > 250;
          marks.push({ id: p.id, x: Math.round((big ? r.x + r.width : r.x + 90 * 6) / 6), y: Math.round((big ? r.y : r.y + 18 * 6) / 6), anchor: big ? 'card' : 'row', list, names: true, color: ownerCss(p) });
        });
      }
    }
    const sig = mode + '|' + JSON.stringify(marks.map(m => [m.id, m.x, m.y, m.anchor, m.list.map(it => [it.key, !!(it.state && it.state.used)])]));
    if (sig === ov.sig) return;
    ov.sig = sig;
    ov.layer.removeAll(true);
    marks.forEach(m => {
      const c = plate(s, 0, 0, m.list, m.names, m.color);
      if (m.anchor === 'feet') c.setPosition(Math.max(2, m.x - c.w + 6), Math.min(m.y - 15, 115)); // left of the sprite's feet, above the message box
      else if (m.anchor === 'card') c.setPosition(Math.max(2, m.x - c.w - 2), m.y + 1);
      else { // a row has about 66 px free between the level and the HP numbers: names only when they fit
        let row = c;
        if (c.w > 66) { c.destroy(); row = plate(s, 0, 0, m.list, false, m.color); }
        row.setPosition(m.x, m.y);
        ov.layer.add(row);
        return;
      }
      ov.layer.add(c);
    });
  }

  // ---- the list of mods, with switches (opened from the co-op menu) ----
  let panel = null;
  const el = (tag, attrs, kids) => {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'text') e.textContent = v; else if (k === 'onclick') e.addEventListener('click', v); else e.setAttribute(k, v); });
    (kids || []).forEach(k => k && e.appendChild(k));
    return e;
  };
  const keysOff = e => { if (!panel) return; if (e.key === 'Escape' && e.type === 'keydown') closePanel(); e.stopImmediatePropagation(); };
  function closePanel() {
    if (!panel) return;
    panel.remove(); panel = null;
    ['keydown', 'keyup'].forEach(t => window.removeEventListener(t, keysOff, true));
  }
  function openPanel() {
    if (!document.getElementById('prsModsCss')) {
      const css = el('style', { id: 'prsModsCss' });
      css.textContent = '#prsModsMask{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}' +
        '#prsModsCard{box-sizing:border-box;width:min(94vw,520px);max-height:92vh;overflow:auto;padding:14px 16px;border-radius:12px;background:#2b2633;color:#f1eef5;font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none;-webkit-user-select:none}' +
        '#prsModsCard h2{margin:0 0 2px;font-size:17px}#prsModsCard p{margin:4px 0;color:#b3abc0;font-size:12.5px}' +
        '#prsModsCard .mod{margin:10px 0;padding:10px 12px;border-radius:9px;background:#1f1b26}' +
        '#prsModsCard .head{display:flex;align-items:center;gap:10px}#prsModsCard .head b{font-size:15px;flex:1}' +
        '#prsModsCard .meta{color:#b3abc0;font-size:12px}#prsModsCard .desc{margin:4px 0 6px}' +
        '#prsModsCard ul{margin:4px 0 0;padding:0;list-style:none}#prsModsCard li{margin:3px 0;font-size:12.5px;color:#d9d3e3}' +
        '#prsModsCard li i{font-style:normal;font-weight:600}' +
        '#prsModsCard button{padding:7px 14px;border:0;border-radius:7px;background:#6d5bd0;color:#fff;font-size:14px;cursor:pointer}' +
        '#prsModsCard button.off{background:#4a4356}#prsModsCard .row{display:flex;justify-content:flex-end;margin-top:8px}' +
        '#prsModsCard .err{color:#ff8a7a;font-size:12px}';
      document.head.appendChild(css);
    }
    closePanel();
    const card = el('div', { id: 'prsModsCard' });
    const render = () => {
      card.textContent = '';
      card.appendChild(el('h2', { text: 'Mod（民间创意工坊）' }));
      card.appendChild(el('p', { text: '玩家提的点子做成的可装卸内容。只在合作房间里生效，开关记在这台设备上；关掉不影响存档，再打开时已经拿到的道具还在。' }));
      if (!order.length) card.appendChild(el('p', { text: '这个版本没有自带任何 mod。' }));
      order.forEach(id => {
        const m = mods[id], mf = m.manifest, on = isOn(id);
        const btn = el('button', { class: on ? '' : 'off', text: m.error ? '加载失败' : on ? '已开启' : '已关闭', onclick: () => { if (!m.error) { setOn(id, !isOn(id)); render(); } } });
        const list = el('ul', {}, m.items.map(k => {
          const it = items[k], t = TIER[it.tier];
          const name = el('i', { text: it.name + '（' + TIER_ZH[t] + '）' });
          name.style.color = TIER_CSS[t];
          return el('li', {}, [name, document.createTextNode(' ' + it.description.replace(/\n/g, ''))]);
        }));
        card.appendChild(el('div', { class: 'mod' }, [
          el('div', { class: 'head' }, [el('b', { text: mf.name || id }), btn]),
          el('div', { class: 'meta', text: 'v' + (mf.version || '?') + ' · 作者：' + (mf.author || '?') + (mf.credits ? ' · ' + mf.credits : '') }),
          el('div', { class: 'desc', text: mf.description || '' }),
          m.error ? el('div', { class: 'err', text: '这个 mod 没能加载：' + m.error.slice(0, 160) }) : list,
        ]));
      });
      card.appendChild(el('p', { text: active() ? '改了马上生效；奖励里的新道具从下一次战后奖励起出现。' : '现在没有开着的合作房间：开关先记下，开房间后生效。' }));
      card.appendChild(el('div', { class: 'row' }, [el('button', { text: '回到游戏', onclick: closePanel })]));
    };
    render();
    panel = el('div', { id: 'prsModsMask', onclick: e => { if (e.target === panel) closePanel(); } }, [card]);
    document.body.appendChild(panel);
    ['keydown', 'keyup'].forEach(t => window.addEventListener(t, keysOff, true)); // keys stay out of the game while the list is open
    return true;
  }

  setInterval(() => {
    const s = scene();
    if (!s || !s.phaseManager || !window.CoopTeam) return; // no co-op room: nothing is touched
    try {
      hookSave(s);
      if (s.seed && s.seed !== heldSeed && partyOf(s).length) loadFor(s.seed);
      if (anyOn()) { watchCombo(); hookPhases(s); hookPokemon(s); }
    } catch (e) { log('error', String(e)); }
    try { draw(); } catch (e) { log('overlay error', String(e)); }
  }, 200);

  window.CoopMods = {
    apiVersion: API_VERSION,
    manifest, define, openPanel, closePanel,
    list: () => order.map(id => ({ id, name: mods[id].manifest.name, version: mods[id].manifest.version, on: isOn(id), error: mods[id].error, items: mods[id].items.slice() })),
    isOn, setOn,
    // names of the mod items a Pokémon holds (for the phone's team sheet, host-game.js readParty)
    heldNames: p => shownItems(p).map(it => it.def.name + (it.state && it.state.used ? '(已用)' : '')),
    // does a mod that is on refuse this move for this Pokémon? (host-game.js greys it out in 2P's pick list)
    moveBlocked(p, moveId) {
      if (!has('moveSelect')) return false;
      for (const [m, fn] of listeners('moveSelect')) { try { const no = fn({ pokemon: p, moveId }); if (typeof no === 'string' && no) return true; } catch (e) { problem(m, 'moveSelect', e); } }
      return false;
    },
    // for tests from the console; not used by the game or by mods
    debug: {
      hooked: () => ({ ...hooked, save: !!(scene() && scene().gameData && scene().gameData.__coopMods) }),
      held: () => JSON.parse(JSON.stringify(held)),
      give: (partyIndex, key, state) => give(scene().getPlayerParty()[partyIndex], key, state),
      remove: (partyIndex, key) => remove(scene().getPlayerParty()[partyIndex], key),
      forceReward: keys => { debug.force = [].concat(keys); return debug.force.slice(); },
      chance: () => Object.fromEntries(Object.keys(items).map(k => { const t = TIER[items[k].tier], pool = POOL[t], same = Object.keys(items).filter(x => TIER[items[x].tier] === t); const w = x => Math.min(Number(items[x].weight) || 0, pool.cap); return [k, w(k) / (pool.total + same.reduce((a, x) => a + w(x), 0))]; })),
      battle: B,
    },
  };
  log('loader ready (interface v' + API_VERSION + ')');
})();
