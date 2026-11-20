// Co-op host, optional part: mods (民间创意工坊). Injected after host-team.js / host-game.js, followed by
// mods-bundle.js (every mod of the package: mods/<id>/mod.json + mod.js + icons/*.png, packed by tools/build-mods.mjs).
// The shipped host-mods.js is this file followed by the engine extensions (engine/ext-*.js), put together by
// tools/assemble.mjs. 接口版本 3; mods written for 接口版本 1 and 2 load and behave as before.
// - A mod registers items and handlers through a small interface (docs/MOD-API.md); it never touches the
//   game's own classes. This file and the extensions (engine/EXT.md) are the only places that know where
//   the game is hooked.
// - A mod runs only while switched on, and only in the modes its mod.json names ("modes", 接口版本 3): 'coop' =
//   in a co-op room (window.CoopTeam is there), 'solo' = without one. A mod that names none runs in co-op rooms
//   only, as every mod did before. The switch is per device (localStorage coop-mods-v1). Without a room and
//   without a solo mod switched on nothing of the game is touched; in a room with every mod off, no game
//   method is wrapped except the save reader and writer below, which then pass everything through unchanged.
// - A mod may keep a few values per run (api.runState): they travel in the same save block ("run").
// - Mod items are NOT game items. A 携带道具 (kind 'held') is on one Pokémon, a 被动增益 (kind 'passive') is
//   in the team bag; both may stack up to the item's max. All of it is kept here and written into the
//   session save as one extra block "coopMods" that the game itself ignores (same idea as host-team.js's
//   "coop" block), plus a copy on this device by run seed. So a save made with mods loads in a build without
//   them (the block is just dropped), and a block of a mod that is off or missing is carried along untouched.
//   Block v2 = { v: 2, held: { pokemonId: { itemKey: { n, s } } }, bag: { itemKey: { n, s } } } (n: how many,
//   s: the item's state). Block v1 = { v: 1, held: { pokemonId: { itemKey: state } } } is still read.
// - Rewards: on the normal 5 选 2 reward screen a slot of the same rarity may be replaced by a mod item (as if
//   the item were one more entry in that rarity's pool); an extension may switch that off (X.cfg.normalOffer)
//   and offer mod items its own way. Picking a held item asks which of your Pokémon holds it; a passive
//   item goes straight into the bag.
// - Icons: a mod may bring its own 32x32 PNGs; they are added to the game's item texture as extra frames, so
//   the reward screen, the plates below and anything else that draws an item by frame name shows them.
// - Shown: item icons next to each player's Pokémon in battle (×n for a stack), names on the party screen, a
//   message when an item triggers. CoopMods.openPanel() is the list of mods with their switches and the bag.
(function () {
  if (window.CoopMods) return; // injected twice (from the menu before a room, then with the room)
  const API_VERSION = 3;
  const log = (...a) => console.log('COOP mods', ...a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))));
  const scene = () => window.PRS_SCENE;
  const uiMode = () => { const t = document.getElementById('touchControls'); return (t && t.dataset.uiMode) || null; };
  const PREF_KEY = 'coop-mods-v1', HELD_KEY = 'coop-mods-held-v1', SAVE_KEY = 'coopMods', HELD_KEPT = 30;
  const TIER = { COMMON: 0, GREAT: 1, ULTRA: 2, ROGUE: 3, MASTER: 4 };
  // what a rarity is called for mod items (issue #2); the colours are the game's own (white, blue, gold, red, purple)
  const TIER_ZH = ['普通道具', '超级道具', '高级道具', '肉鸽道具', '大师道具'], TIER_CSS = ['#d8d8d8', '#6aa9ff', '#f5c84c', '#ff6a5c', '#c58cff'];
  const KIND_ZH = { held: '携带道具', passive: '被动增益' };
  // The game picks a reward in two steps: a rarity, then one entry of that rarity's pool by weight. A mod item
  // is treated as one more entry: chance per slot of its rarity = weight / (total + the mod weights there).
  // total: about what the game's own pool adds up to in a normal run (pokerogue 1.12 pools); cap: the largest
  // weight a mod item may have, so it never shows up more often than the game's own held items of that rarity.
  const POOL = [{ total: 250, cap: 4 }, { total: 200, cap: 4 }, { total: 170, cap: 9 }, { total: 90, cap: 5 }, { total: 80, cap: 14 }];
  const EVENTS = ['damageCalc', 'beforeDamage', 'moveSelect', 'status', 'statChange', 'faint', 'turnStart', 'turnEnd', 'give', 'remove',
    'heal', 'moveUsed', 'battleStart', 'battleEnd']; // the last four are new in 接口版本 2; extensions add more (X.addEvent)
  const STATUS = [null, 'poison', 'toxic', 'paralysis', 'sleep', 'freeze', 'burn'], STATUS_ZH = { poison: '中毒', toxic: '剧毒', paralysis: '麻痹', sleep: '睡眠', freeze: '冰冻', burn: '灼伤' };
  // stats that have stages in battle: name <-> the game's Stat enum (HP is 0 and has no stage)
  const STAT = { atk: 1, def: 2, spatk: 3, spdef: 4, spd: 5, acc: 6, eva: 7 };
  const STAT_NAMES = [null, 'atk', 'def', 'spatk', 'spdef', 'spd', 'acc', 'eva'], STAT_ZH = [null, '攻击', '防御', '特攻', '特防', '速度', '命中率', '闪避率'];
  const statNum = x => (typeof x === 'number' ? (STAT_NAMES[x] ? x : 0) : STAT[x] || 0);
  const statApi = Object.freeze({ ...STAT, names: Object.freeze(STAT_NAMES.slice(1)), battle: Object.freeze(['atk', 'def', 'spatk', 'spdef', 'spd']),
    name: x => STAT_NAMES[statNum(x)] || null, zh: x => STAT_ZH[statNum(x)] || '', num: statNum });

  // ---- the mods of this package, and which are switched on ----
  const mods = {}, order = [], items = {}; // items: 'modId:itemId' -> definition
  const prefs = { on: {} };
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); if (p && p.on && typeof p.on === 'object') prefs.on = p.on; } catch {}
  const coop = () => !!window.CoopTeam; // a co-op room is open
  // the switch as the player left it / the mod really runs now (switched on, and made for the mode the game is in)
  const wanted = id => !!mods[id] && mods[id].ok && (id in prefs.on ? !!prefs.on[id] : mods[id].manifest.default === 'on');
  const isOn = id => wanted(id) && mods[id].modes.includes(coop() ? 'coop' : 'solo');
  const anyOn = () => order.some(isOn);
  const active = () => !!(scene() && scene().phaseManager && (coop() || anyOn())); // a co-op room, or a solo game with a solo mod on
  const partyOf = s => (s && s.getPlayerParty && s.getPlayerParty()) || []; // not there yet while the game boots
  const switchFns = [];
  function setOn(id, on) {
    if (!mods[id]) return false;
    prefs.on[id] = !!on;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
    log('mod ' + id + ' switched ' + (on ? 'on' : 'off'));
    ov.sig = '';
    for (const fn of switchFns) { try { fn(id, isOn(id)); } catch (e) { log('switch handler error', String(e)); } }
    return wanted(id);
  }
  const problems = {};
  function problem(mod, what, e) {
    const n = problems[mod.id] = (problems[mod.id] || 0) + 1;
    if (n <= 20) log('mod ' + mod.id + ' error in ' + what + ': ' + String((e && e.stack) || e).slice(0, 300));
  }
  function manifest(m) {
    if (!m || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(m.id)) { log('manifest refused: bad id', m && m.id); return false; }
    if (mods[m.id]) return false;
    // where it runs: "modes" of mod.json (接口版本 3), a list of 'solo' and 'coop'; anything else = co-op rooms only
    const modes = Number(m.api) >= 3 && Array.isArray(m.modes) ? m.modes.filter((x, i, a) => (x === 'solo' || x === 'coop') && a.indexOf(x) === i) : [];
    mods[m.id] = { id: m.id, manifest: m, items: [], on: {}, phase: [], ok: false, error: null, v1: !(Number(m.api) >= 2), once: {}, modes: modes.length ? modes : ['coop'] };
    order.push(m.id);
    return true;
  }
  function define(id, setup) {
    const mod = mods[id];
    if (!mod) { log('mod ' + id + ': mod.json missing from the bundle, not loaded'); return; }
    if (mod.ok || mod.error) return;
    try {
      if (Number(mod.manifest.api) > API_VERSION) throw new Error('needs interface v' + mod.manifest.api + ', this game has v' + API_VERSION);
      setup(makeApi(mod));
      mod.ok = true;
      log('mod ' + id + ' v' + mod.manifest.version + ' loaded (' + mod.items.length + ' items, interface v' + (mod.v1 ? 1 : Number(mod.manifest.api) >= 3 ? 3 : 2) + ', ' + mod.modes.join('+') + '), ' + (wanted(id) ? 'on' : 'off'));
    } catch (e) {
      mod.error = String((e && e.stack) || e);
      mod.items.forEach(k => { delete items[k]; });
      mod.items = []; mod.on = {}; mod.phase = [];
      log('mod ' + id + ' failed to load: ' + mod.error.slice(0, 300));
    }
  }

  // ---- a mod's own icons: PNGs of at most 32x32 packed into the bundle as data URIs ----
  // They become extra frames of the game's 'items' texture ('coopmod/<mod id>/<file name>'), so everything
  // that draws an item by frame name (the reward screen, its name box, the plates here) can show them.
  const ICON = 32, iconData = {}; // 'modId/name' -> { uri, img, ok }
  const iconReg = { tex: null, done: new Set(), n: 0 };
  function icons(modId, map) {
    if (!mods[modId] || !map || typeof map !== 'object') return 0;
    let n = 0;
    for (const name of Object.keys(map)) {
      const uri = map[name];
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || typeof uri !== 'string' || !uri.startsWith('data:image/png;base64,')) { log('mod ' + modId + ': icon ' + name + ' refused'); continue; }
      const d = iconData[modId + '/' + name] = { uri, img: new Image(), ok: false };
      d.img.onload = () => { d.ok = d.img.width > 0 && d.img.height > 0; iconReg.n++; };
      d.img.onerror = () => { log('mod ' + modId + ': icon ' + name + ' is not a picture the browser can read'); };
      d.img.src = uri;
      n++;
    }
    return n;
  }
  function registerIcons(s) {
    const tm = s.textures;
    if (!tm || !tm.exists('items')) return;
    const tex = tm.get('items');
    if (tex !== iconReg.tex) { iconReg.tex = tex; iconReg.done = new Set(); iconReg.seen = -1; } // (the game made its texture anew)
    if (iconReg.seen === iconReg.n) return; // nothing decoded since the last look
    iconReg.seen = iconReg.n;
    const todo = Object.keys(iconData).filter(k => iconData[k].ok && !iconReg.done.has(k));
    if (!todo.length) return;
    // one sheet for this batch: 32x32 cells, each icon centred in its cell (the game's item frames are 32x32)
    const cols = Math.min(todo.length, 16), sheet = document.createElement('canvas');
    sheet.width = cols * ICON; sheet.height = Math.ceil(todo.length / cols) * ICON;
    const g = sheet.getContext('2d');
    g.imageSmoothingEnabled = false;
    todo.forEach((k, i) => {
      const img = iconData[k].img, f = Math.min(1, ICON / img.width, ICON / img.height);
      const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
      g.drawImage(img, (i % cols) * ICON + Math.floor((ICON - w) / 2), Math.floor(i / cols) * ICON + Math.floor((ICON - h) / 2), w, h);
    });
    const Source = tex.source[0].constructor; // Phaser.Textures.TextureSource
    tex.source.push(new Source(tex, sheet, sheet.width, sheet.height));
    const si = tex.source.length - 1;
    todo.forEach((k, i) => { tex.add('coopmod/' + k, si, (i % cols) * ICON, Math.floor(i / cols) * ICON, ICON, ICON); iconReg.done.add(k); });
    ov.sig = '';
    log('icons: ' + todo.length + ' of the mods\' own added to the item texture');
  }
  // the frame of the 'items' texture to draw for an item, right now
  const frameOf = it => (it.custom ? (iconReg.done.has(it.custom) ? 'coopmod/' + it.custom : it.fallback) : it.icon);

  // ---- who has which mod item ----
  // held: Pokémon id -> { 'modId:itemId': { n, s } }; bag (passive items, the whole team's): 'modId:itemId' -> { n, s }
  let held = {}, bag = {}, heldSeed = null;
  // run: mod id -> a plain object of this run (api.runState), saved with it. While the starter screen of a new
  // game is up there is no run yet: what a mod writes then goes into `setup` and becomes the run's when it begins.
  let run = {}, setup = null;
  const runOf = id => { const r = setup || run; return r[id] = isObj(r[id]) ? r[id] : {}; };
  const setupFns = []; // extensions: fn() when a new game's starter screen opens (setup is fresh and empty)
  const runMark = { wave: 0, time: 0 }; // where the run was when last looked at (to notice it starting over)
  const fromSave = {}; // run seed -> { block, ids } of a save the game has read (block null: that save has none)
  const fieldStates = new WeakMap(); // a Pokémon's summonData (a new object every time it enters the field) -> {}
  const entryOf = (p, key) => (p && held[p.id] && held[p.id][key]) || null;
  const countOf = (p, key) => { const e = entryOf(p, key); return e ? e.n : 0; };
  const holds = (p, key) => countOf(p, key) > 0;
  const bagCount = key => (bag[key] ? bag[key].n : 0);
  const itemOn = key => !!items[key] && isOn(items[key].mod);
  // how many of a held item this Pokémon may hold: the item's max, unless an extension (X.onMax) says otherwise
  // for this Pokémon (异次元树果袋 raises the limit of the items that count as berries). Passive items: it.max.
  const maxFns = [];
  function maxOf(p, key) {
    const it = items[key];
    if (!it) return 0;
    let max = it.max;
    if (it.kind === 'passive' || !p || !maxFns.length || !isOn(it.mod)) return max;
    for (const fn of maxFns) { const r = guard('item max', () => fn(p, key, max)); if (typeof r === 'number' && isFinite(r)) max = Math.max(1, Math.min(Math.floor(r), 999)); }
    return max;
  }
  // what a Pokémon holds that is shown and counted: items of mods that are on
  const shownItems = p => Object.keys((p && held[p.id]) || {}).filter(itemOn).map(k => ({ key: k, def: items[k], state: held[p.id][k].s, count: held[p.id][k].n }));
  const shownBag = () => Object.keys(bag).filter(itemOn).map(k => ({ key: k, def: items[k], state: bag[k].s, count: bag[k].n }));
  // a few words an item says about its own state (def.note(state, count)), for the lists: '' when it has none
  const noteOf = it => { if (!it.def.note) return ''; const t = guard('item note ' + it.key, () => it.def.note(it.state, it.count), ''); return typeof t === 'string' && t ? t.slice(0, 24) : ''; };
  const plain = state => (state && typeof state === 'object' && !Array.isArray(state) ? state : {});
  // one more of an item. Held: for this Pokémon, up to the item's max (false when it has max already).
  // Passive: p is ignored, the item goes into the team bag. from: 'reward' when picked on the reward screen.
  function give(p, key, state, from) {
    const it = items[key];
    if (!it) return false;
    let e;
    if (it.kind === 'passive') {
      e = bag[key];
      if (e && e.n >= it.max) return false;
      if (e) e.n++; else e = bag[key] = { n: 1, s: plain(state) };
      p = null;
    } else {
      if (!p) return false;
      e = entryOf(p, key);
      if (e && it.v1) e.s = plain(state); // 接口版本 1: giving again starts the item over
      else if (e && e.n >= maxOf(p, key)) return false;
      else if (e) e.n++;
      else e = (held[p.id] = held[p.id] || {})[key] = { n: 1, s: plain(state) };
    }
    ov.sig = '';
    log('item ' + key + ' -> ' + (p ? nameOf(p) : 'the team bag') + (e.n > 1 ? ' (×' + e.n + ')' : ''));
    emit('give', { pokemon: p, item: key, count: e.n, from: from || 'mod' });
    return true;
  }
  // n of them away (all of them when n is not given); the last one takes the item and its state with it
  function take(p, key, n) {
    const it = items[key], passive = !!it && it.kind === 'passive';
    const e = passive ? bag[key] : entryOf(p, key);
    if (!e) return false;
    const all = n == null || n === Infinity;
    n = all ? e.n : Math.max(1, Math.floor(Number(n) || 1));
    e.n -= Math.min(n, e.n);
    if (e.n <= 0) {
      if (passive) delete bag[key];
      else { delete held[p.id][key]; if (!Object.keys(held[p.id]).length) delete held[p.id]; }
    }
    ov.sig = '';
    log('item ' + key + (e.n > 0 ? ': ' + e.n + ' left with ' : ' gone from ') + (passive ? 'the team bag' : nameOf(p)));
    emit('remove', { pokemon: passive ? null : p, item: key, left: Math.max(0, e.n) });
    return true;
  }
  const remove = (p, key) => take(p, key, null);
  // is there room for one more of this item? Held: on any Pokémon in the party (who: only that player's own)
  function canTake(key, who) {
    const it = items[key];
    if (!it) return false;
    if (it.kind === 'passive') return bagCount(key) < it.max;
    return partyOf(scene()).some(p => (!who || !window.CoopTeam || CoopTeam.ownerOf(p) === who) && countOf(p, key) < maxOf(p, key));
  }
  const kept = () => { try { return JSON.parse(localStorage.getItem(HELD_KEY) || '{}') || {}; } catch { return {}; } };
  function keep(seed, block, ids) { // this device's copy, for a save rewritten by a build without mods
    const all = kept();
    if (block) all[seed] = { block, ids, t: Date.now() }; else if (all[seed]) delete all[seed]; else return;
    const seeds = Object.keys(all).sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
    seeds.slice(0, Math.max(0, seeds.length - HELD_KEPT)).forEach(id => { delete all[id]; });
    try { localStorage.setItem(HELD_KEY, JSON.stringify(all)); } catch {}
  }
  const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const validBlock = b => !!(b && (b.v === 1 || b.v === 2) && isObj(b.held) && (b.v === 1 || b.bag == null || isObj(b.bag)));
  // a block of either version -> { held, bag } in today's shape (a copy; anything malformed is left out)
  function readBlock(b) {
    const out = { held: {}, bag: {}, run: {} };
    const entry = x => (b.v === 1 ? (isObj(x) ? { n: 1, s: x } : null) : isObj(x) && x.n >= 1 ? { n: Math.floor(x.n), s: plain(x.s) } : null);
    for (const id of Object.keys(b.held)) {
      if (!isObj(b.held[id])) continue;
      for (const k of Object.keys(b.held[id])) { const e = entry(b.held[id][k]); if (e) (out.held[id] = out.held[id] || {})[k] = e; }
    }
    if (b.v === 2 && isObj(b.bag)) for (const k of Object.keys(b.bag)) { const e = entry(b.bag[k]); if (e) out.bag[k] = e; }
    if (b.v === 2 && isObj(b.run)) for (const k of Object.keys(b.run)) if (isObj(b.run[k])) out.run[k] = b.run[k];
    return JSON.parse(JSON.stringify(out));
  }
  function loadFor(seed) {
    heldSeed = seed;
    const s = scene(), now = new Set(partyOf(s).map(p => String(p.id)));
    // a block belongs to this run when the party it was saved with shares a Pokémon with today's (a new run on
    // the same seed, a daily run started again, has all new Pokémon: nothing is carried into it)
    const mine = c => !!(c && validBlock(c.block) && (!Array.isArray(c.ids) ? !(c.block.bag && Object.keys(c.block.bag).length) : c.ids.some(id => now.has(String(id)))));
    const sv = fromSave[seed], dev = kept()[seed];
    const c = mine(sv) ? sv : mine(dev) ? dev : null;
    const r = c ? readBlock(c.block) : { held: {}, bag: {}, run: {} };
    held = r.held; bag = r.bag;
    // a run that begins now, from the starter screen, takes what was chosen there; a run from a save has its own
    run = !c && setup && now.size ? setup : r.run;
    if (now.size) setup = null;
    ov.sig = '';
    const n = Object.keys(held).length, m = Object.keys(bag).length;
    const sig = seed + JSON.stringify([held, bag]);
    if ((n || m) && sig !== loadFor.sig) log('items restored (block v' + c.block.v + ', from ' + (c === sv ? 'the save' : 'this device') + '): held by ' + n + ' Pokémon, ' + m + ' kind(s) in the team bag');
    loadFor.sig = sig;
  }
  function exportBlock(s) {
    const ids = new Set(partyOf(s).map(p => String(p.id))), out = {};
    for (const id of Object.keys(held)) if (ids.has(id) && held[id] && Object.keys(held[id]).length) out[id] = held[id];
    const mine = {};
    for (const id of Object.keys(run)) if (isObj(run[id]) && Object.keys(run[id]).length) mine[id] = run[id];
    const b = Object.keys(out).length || Object.keys(bag).length || Object.keys(mine).length ? { v: 2, held: out, bag } : null;
    if (b && Object.keys(mine).length) b.run = mine;
    return b;
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
          const block = exportBlock(s);
          if (block) r[SAVE_KEY] = block; // a key the game's save reader does not know and leaves alone
          keep(r.seed, block, partyOf(s).map(p => p.id));
        }
      } catch (e) { log('save error', String(e)); }
      return r;
    };
    const parse = gd.parseSessionData;
    if (typeof parse === 'function') gd.parseSessionData = function () {
      const r = parse.apply(this, arguments);
      try { if (r && r.seed) fromSave[r.seed] = { block: validBlock(r[SAVE_KEY]) ? r[SAVE_KEY] : null, ids: Array.isArray(r.party) ? r.party.map(p => p && p.id) : null }; } catch {}
      return r;
    };
    const load = gd.loadSession;
    if (typeof load === 'function') gd.loadSession = function () {
      const r = load.apply(this, arguments);
      Promise.resolve(r).then(() => { heldSeed = null; }, () => {}); // this run again from its save
      return r;
    };
    log('save: mod items go into the "' + SAVE_KEY + '" block (v2)');
  }

  // ---- events ----
  const listeners = type => { const out = []; for (const id of order) { const m = mods[id]; if (isOn(id) && m.on[type]) for (const fn of m.on[type]) out.push([m, fn]); } return out; };
  const has = type => active() && order.some(id => isOn(id) && mods[id].on[type] && mods[id].on[type].length);
  function emit(type, ev) {
    let last;
    for (const [m, fn] of listeners(type)) { try { const r = fn(ev); if (r !== undefined) last = r; } catch (e) { problem(m, type, e); } }
    return last;
  }
  const battle = { on: null, wave: -1 }; // on: between the encounter and the end of the battle (null: not seen yet)
  let moveHits = []; // { attacker, target, damage }: move hits since the attacker's move began
  // MovePhase.end queues the MoveEndPhase with the user's battler index. When the user has fainted meanwhile (its
  // own recoil) and the game has moved its teammate into that field slot, the index names the teammate. So the
  // user is remembered when its MovePhase ends: { mon, bi }.
  let movers = [];
  let healCtx = null; // the tag of the B.heal that is being carried out right now
  const phaseNow = () => { try { return scene().phaseManager.getCurrentPhase().phaseName; } catch { return null; } };
  function phaseEvent(when, ph) {
    const name = ph && ph.phaseName;
    if (!name) return;
    for (const id of order) {
      const m = mods[id];
      if (!isOn(id)) continue;
      for (const h of m.phase) if (h.name === name && h.when === when) { try { h.fn(ph); } catch (e) { problem(m, name + ' ' + when, e); } }
    }
    if (when !== 'start') {
      if (name === 'MovePhase' && ph.pokemon) { let bi = -1; try { bi = ph.pokemon.getBattlerIndex(); } catch {} if (movers.length > 12) movers = []; movers.push({ mon: ph.pokemon, bi, moveId: ph.move && ph.move.moveId != null ? ph.move.moveId : null }); }
      return;
    }
    if (name === 'TurnInitPhase') {
      movers = [];
      const b = scene().currentBattle, w = b ? b.waveIndex : -1;
      if (w !== battle.wave) { battle.wave = w; moveHits = []; emit('battleStart', { wave: w, turn: b ? b.turn : 0 }); }
    } else if (name === 'TurnStartPhase') { moveHits = []; markTurn(); emit('turnStart', {}); }
    else if (name === 'TurnEndPhase') emit('turnEnd', {});
    else if (name === 'BattleEndPhase') emit('battleEnd', { wave: B.wave(), victory: ph.isVictory !== false });
    else if (name === 'FaintPhase') { let p = null; try { p = ph.getPokemon(); } catch {} if (p && p.hp <= 0) emit('faint', { pokemon: p }); }
    else if (name === 'MoveEndPhase') {
      let p = null; try { p = ph.getPokemon(); } catch {}
      let used = null; // the move the MovePhase was for (a Pokémon that has left the field has no move history any more)
      for (let i = movers.length - 1; i >= 0; i--) if (movers[i].bi === ph.battlerIndex) { p = movers[i].mon; used = movers[i].moveId; movers.splice(i, 1); break; }
      if (!p) return;
      const hits = moveHits.filter(h => h.attacker === p);
      moveHits = moveHits.filter(h => h.attacker !== p);
      if (!has('moveUsed')) return;
      let last = null; try { last = p.getLastXMoves(1)[0] || null; } catch {}
      emit('moveUsed', { pokemon: p, moveId: last ? last.move : used, targets: last && last.targets ? last.targets.slice() : hits.map(h => { try { return h.target.getBattlerIndex(); } catch { return null; } }).filter(x => x != null),
        ok: last ? last.result === 1 : hits.length > 0, // (no history: the user has left the field; a move that hit somebody counts as done)
        damage: hits.reduce((a, h) => a + h.damage, 0), hits: hits.map(h => ({ target: h.target, damage: h.damage })), followUp: !!ph.wasFollowUp });
    }
  }
  function trackBattle(name) {
    if (name === 'EncounterPhase' || name === 'NextEncounterPhase' || name === 'NewBiomeEncounterPhase') battle.on = true;
    else if (name === 'BattleEndPhase' || name === 'SelectModifierPhase' || name === 'TitlePhase' || name === 'GameOverPhase') battle.on = false;
    if (name === 'TitlePhase' || name === 'GameOverPhase') battle.wave = -1; // back at the title: the next wave entered is a new battle, also when its number is the same
    if (name === 'TitlePhase') setup = null;
    else if (name === 'SelectStarterPhase') { setup = {}; for (const fn of setupFns) guard('run setup', fn); } // a new game is being set up
  }

  // ---- hooks into the game (installed the first time a mod is on in a co-op room) ----
  const hooked = {}; // which hooks are in: phases, pokemon, statChange, rewards, heal
  const WRAPS = '__coopModsWraps', ORIGS = '__coopModsOrigs';
  // remember obj[method] as it is now, unless it was remembered before: what X.gameMethod answers later
  function noteOrig(obj, method) {
    if (!obj || typeof obj[method] !== 'function') return;
    if (!Object.prototype.hasOwnProperty.call(obj, ORIGS)) Object.defineProperty(obj, ORIGS, { value: {}, enumerable: false });
    if (!obj[ORIGS][method]) obj[ORIGS][method] = obj[method];
  }
  // obj[method] as it was before the core or any extension wrapped it (on that same object); obj[method] itself when nobody has
  const gameMethod = (obj, method) => (obj && Object.prototype.hasOwnProperty.call(obj, ORIGS) && obj[ORIGS][method]) || (obj ? obj[method] : undefined);
  // Replace obj[method] by make(original), once per (obj, method, tag): a second call with the same tag does
  // nothing. obj is a prototype (or one object, like a UI handler). While no mod is on, or outside a co-op
  // room, the original is called directly.
  function wrapOnce(obj, method, tag, make, kind) {
    if (!obj || typeof obj[method] !== 'function') { log('hooks: no ' + method + ' to wrap (' + tag + ')'); return false; }
    if (!Object.prototype.hasOwnProperty.call(obj, WRAPS)) Object.defineProperty(obj, WRAPS, { value: {}, enumerable: false });
    const marks = obj[WRAPS], k = tag + ':' + method + ':' + (kind || 'wrap');
    if (marks[k]) return true;
    const orig = obj[method];
    noteOrig(obj, method);
    let repl = null;
    try { repl = make(orig); } catch (e) { log('hooks: wrapping ' + method + ' (' + tag + ') failed: ' + String(e)); }
    if (typeof repl !== 'function') return false;
    marks[k] = true;
    obj[method] = function () { return active() && anyOn() ? repl.apply(this, arguments) : orig.apply(this, arguments); };
    return true;
  }
  const guards = {};
  function guard(what, fn, fallback) { // run fn; an error is logged (20 times at most per name) and does not travel on
    try { return fn(); } catch (e) {
      const n = guards[what] = (guards[what] || 0) + 1;
      if (n <= 20) log('error in ' + what + ': ' + String((e && e.stack) || e).slice(0, 300));
      return fallback;
    }
  }
  // fn(self, args) runs before the original: return { args: [...] } to change the arguments, { skip: true, value }
  // to not call the original at all; anything else (or an error) lets it run as it was called.
  const before = (obj, method, tag, fn) => wrapOnce(obj, method, tag, orig => function (...args) {
    const r = guard(tag + ' before ' + method, () => fn(this, args));
    if (r && r.skip) return r.value;
    return orig.apply(this, r && Array.isArray(r.args) ? r.args : args);
  }, 'before');
  // fn(self, args, result) runs after the original: return { value } to change what the caller gets.
  const after = (obj, method, tag, fn) => wrapOnce(obj, method, tag, orig => function (...args) {
    const res = orig.apply(this, args);
    const r = guard(tag + ' after ' + method, () => fn(this, args, res));
    return r && typeof r === 'object' && 'value' in r ? r.value : res;
  }, 'after');
  const protoWith = (obj, method) => { // the prototype in obj's chain that defines method itself
    for (let p = obj && Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) if (Object.prototype.hasOwnProperty.call(p, method)) return p;
    return null;
  };
  const phaseProtos = {}, phaseClassFns = {}; // phase name -> its prototype (once seen) / what extensions want to do with it
  let pokemonProto = null; const pokemonClassFns = [];
  const tickFns = [], rewardFns = [];
  let optionProto = null; // ModifierTypeOption.prototype, taken from the first option the game makes

  function hookPhases(s) {
    const pm = s.phaseManager;
    if (pm.__coopMods) return;
    pm.__coopMods = true; hooked.phases = true;
    // every phase starts through startCurrentPhase and ends through shiftPhase (Phase.end)
    const start = pm.startCurrentPhase;
    pm.startCurrentPhase = function () {
      try { const ph = this.currentPhase; if (ph) { patchPhase(ph); trackBattle(ph.phaseName); if (active() && anyOn()) phaseEvent('start', ph); } } catch (e) { log('phase start hook error', String(e)); }
      return start.apply(this, arguments);
    };
    const shift = pm.shiftPhase;
    pm.shiftPhase = function () {
      try { const ph = this.currentPhase; if (ph && active() && anyOn()) phaseEvent('end', ph); } catch (e) { log('phase end hook error', String(e)); }
      return shift.apply(this, arguments);
    };
    log('hooks: phases');
    // The phase that is running right now started before these hooks existed (a mod switched on for the first
    // time in this session, in the middle of a reward screen or a turn): its class is patched now, so that what
    // the extensions wrap on it (reroll price, option count ...) already answers for the rest of this phase.
    try { if (pm.currentPhase) patchPhase(pm.currentPhase); } catch (e) { log('phase hook error (current phase)', String(e)); }
  }
  function patchPhase(ph) {
    const proto = Object.getPrototypeOf(ph), name = ph.phaseName;
    if (!proto || !name || phaseProtos[name] === proto) return;
    phaseProtos[name] = proto;
    for (const fn of phaseClassFns[name] || []) guard('phase class ' + name, () => fn(proto, ph));
    if (Object.prototype.hasOwnProperty.call(proto, '__coopMods')) return;
    if (name === 'StatStageChangePhase' && typeof proto.applyStatChangesAndEnd === 'function') {
      proto.__coopMods = true; hooked.statChange = true;
      noteOrig(proto, 'applyStatChangesAndEnd');
      const apply = proto.applyStatChangesAndEnd;
      // (pokemon, changes): changes are what really applies, [{stat, stages}], already clamped to -6..+6
      proto.applyStatChangesAndEnd = function (pokemon, changes) {
        const r = apply.apply(this, arguments);
        try {
          if (has('statChange')) {
            const real = (changes || []).filter(c => c && c.stages).map(c => ({ stat: c.stat, stages: c.stages, name: STAT_NAMES[c.stat] || null }));
            if (real.length) emit('statChange', { pokemon, changes: real, copied: !!(this.options && this.options.coopModCopy) });
          }
        } catch (e) { log('stat change hook error', String(e)); }
        return r;
      };
    } else if (name === 'SelectModifierPhase' && typeof proto.getModifierTypeOptions === 'function' && typeof proto.applyChosenModifier === 'function') {
      proto.__coopMods = true; hooked.rewards = true;
      noteOrig(proto, 'getModifierTypeOptions'); noteOrig(proto, 'applyChosenModifier');
      const options = proto.getModifierTypeOptions;
      proto.getModifierTypeOptions = function () {
        let opts = options.apply(this, arguments);
        try {
          if (Array.isArray(opts)) {
            if (opts[0] && !optionProto) optionProto = Object.getPrototypeOf(opts[0]);
            offer(this, opts);
            if (active() && anyOn()) for (const fn of rewardFns) { const r = guard('reward options', () => fn(this, opts)); if (Array.isArray(r)) opts = r; }
          }
        } catch (e) { log('reward offer error', String(e)); }
        return opts;
      };
      const chosen = proto.applyChosenModifier;
      proto.applyChosenModifier = function (type, cost, cb) {
        if (!type || !type.__coopMod) return chosen.apply(this, arguments);
        try { return pickItem(this, type, cost, cb); } catch (e) { log('reward pick error', String(e)); return false; }
      };
    } else if (name === 'PokemonHealPhase' && typeof proto.doHealPokemon === 'function') {
      proto.__coopMods = true; hooked.heal = true;
      noteOrig(proto, 'doHealPokemon');
      const doHeal = proto.doHealPokemon; // where the phase really restores the HP
      proto.doHealPokemon = function () {
        healCtx = this.__coopModHeal || null;
        try { return doHeal.apply(this, arguments); } finally { healCtx = null; }
      };
    }
  }
  function hookPokemon(s) {
    if (hooked.pokemon) return;
    const any = partyOf(s)[0] || (s.currentBattle && s.currentBattle.enemyParty && s.currentBattle.enemyParty[0]);
    if (!any) return;
    let proto = Object.getPrototypeOf(any); // PlayerPokemon / EnemyPokemon -> Pokemon
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'damageAndUpdate')) proto = Object.getPrototypeOf(proto);
    if (!proto || proto.__coopMods) { hooked.pokemon = !!proto; if (!proto) log('hooks: Pokemon class not found in this build'); else pokemonReady(proto); return; }
    proto.__coopMods = true; hooked.pokemon = true;
    const wrap = (name, make) => { if (typeof proto[name] === 'function') { noteOrig(proto, name); proto[name] = make(proto[name]); } else log('hooks: no Pokemon.' + name + ' in this build'); };
    // damage a move would do. Returns {cancelled, result, damage}; the game calls it for real hits and, with
    // simulated (the default), for the enemy AI's estimates.
    wrap('getAttackDamage', orig => function (o) {
      const r = orig.apply(this, arguments);
      try {
        if (r && r.damage > 0 && !r.cancelled && o && o.source && has('damageCalc')) {
          const self = this;
          const ev = { attacker: o.source, target: this, move: o.move, moveId: o.move && o.move.id != null ? o.move.id : null, simulated: o.simulated !== false, critical: !!o.isCritical, damage: r.damage,
            // 接口版本 3: the type multiplier of this move on this target (0, 0.25, 0.5, 1, 2, 4), worked out only when read
            get effectiveness() { try { return Number(self.getMoveEffectiveness(o.source, o.move, !!o.ignoreAbility, true)); } catch { return 1; } } };
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
      try { if (r > 0 && opts && opts.source && active() && anyOn()) { if (moveHits.length > 200) moveHits = []; moveHits.push({ attacker: opts.source, target: this, damage: r }); } } catch {}
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
    // every gain of HP (heal phases, abilities, medicine used from the reward screen...). Returns what was really restored.
    wrap('heal', orig => function () {
      const r = orig.apply(this, arguments);
      try { if (r > 0 && has('heal')) emit('heal', { pokemon: this, amount: r, tag: healCtx ? healCtx.tag : null, inBattle: B.inBattle(), phase: phaseNow() }); } catch (e) { log('heal hook error', String(e)); }
      return r;
    });
    log('hooks: Pokemon damage, move choice, status, heal');
    pokemonReady(proto);
  }
  function pokemonReady(proto) {
    if (pokemonProto) return;
    pokemonProto = proto;
    for (const fn of pokemonClassFns) guard('pokemon class', () => fn(proto));
  }

  // ---- rewards ----
  const cfg = { normalOffer: true, screenChance: 0.1 }; // extensions may change these (X.cfg)
  const SCREEN_WEIGHT = [8, 6, 5, 3, 2]; // by rarity: COMMON, GREAT, ULTRA, ROGUE, MASTER
  const debug = { force: [] }; // test only: item keys the next reward screen must offer
  function rng(str) { // small seeded generator: the same string always gives the same numbers
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h = (h + 0x6D2B79F5) | 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // a reward option for a mod item. like: any option the game made (for its class); may be left out once the
  // game has shown a reward screen in this session.
  function makeOption(like, key, upgradeCount) {
    const it = items[key];
    if (!it) return null;
    const type = { // what the reward screen reads of an item type: name, iconImage, tier, getDescription()
      id: 'COOPMOD_' + key.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), localeKey: '', name: it.name, group: 'coopmod:' + key, soundName: 'se/restore',
      get iconImage() { return frameOf(it); }, tier: TIER[it.tier], __coopMod: key,
      getDescription: () => it.description,
      setTier(t) { this.tier = t; }, getOrInferTier() { return this.tier; }, withIdFromFunc() { return this; }, withTierFromPool() { return this; },
      newModifier() { return { type: this }; }, // not a game modifier: scene.addModifier does nothing with it
    };
    const opt = Object.create((like && Object.getPrototypeOf(like)) || optionProto || Object.prototype); // a ModifierTypeOption
    opt.type = type; opt.upgradeCount = upgradeCount || 0; opt.cost = 0;
    return opt;
  }
  // the normal reward after a battle, first round (host-team.js tags it; the second round is what is left of it)
  function offer(ph, opts) {
    const c = ph.__coop;
    const forced = debug.force.splice(0).filter(k => items[k]);
    if (!active() || !c || c.round !== 1 || c.single || ph.customModifierSettings || ph.isCopy) return;
    if (!forced.length && (!anyOn() || !cfg.normalOffer)) return;
    const s = scene(), b = s.currentBattle;
    const roll = rng([s.seed, b ? b.waveIndex : 0, ph.rerollCount || 0, 'coop-mods'].join(':'));
    const taken = new Set(), put = [];
    const open = k => isOn(items[k].mod) && !taken.has(k) && canTake(k, c.picker); // nobody has room for it: not offered
    opts.forEach((opt, i) => {
      const r = roll();
      if (!opt || !opt.type) return;
      let key = null;
      if (forced.length) key = forced.shift();
      else if (!anyOn() || !cfg.normalOffer) return; // (a forced list shorter than the screen: the other slots stay the game's)
      else {
        const tier = opt.type.tier, pool = POOL[tier];
        const cands = Object.keys(items).filter(k => TIER[items[k].tier] === tier && open(k));
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
    if (!put.length && anyOn() && cfg.normalOffer && roll() < cfg.screenChance) {
      const cands = Object.keys(items).filter(k => SCREEN_WEIGHT[TIER[items[k].tier]] && open(k));
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
  const fullText = (p, it) => (p ? nameOf(p) + '的' : '队伍的') + it.name + '已经带满了（最多' + (p ? maxOf(p, it.key) : it.max) + '个）';
  // a mod item was picked on the reward screen. A passive item goes into the team bag. A held item asks which
  // Pokémon holds it, the way the game does for its own held items (party menu in MODIFIER mode; host-team.js
  // limits it to the picker's own Pokémon); one that already has the item's max is refused.
  function pickItem(ph, type, cost, cb) {
    const s = scene(), key = type.__coopMod, it = items[key];
    if (!it) { s.ui.playError(); return false; }
    if (it.kind === 'passive') {
      if (!give(null, key, {}, 'reward')) { // the bag has its max: the screen stays as it is
        log('rewards: ' + key + ' refused, the team bag has ' + it.max);
        try { s.ui.playError(); } catch {}
        return false;
      }
      try { s.ui.playSelect(); } catch {}
      ph.applyModifier({ type }, cost, true); // ends the reward round like any other pick
      return cost === -1;
    }
    const party = s.getPlayerParty(), partyMode = handlerIndex(s, 'PartyUiHandler', 8);
    const rewardMode = typeof s.ui.mode === 'number' ? s.ui.mode : handlerIndex(s, 'ModifierSelectUiHandler', 6); // the screen we are on
    s.ui.setModeWithoutClear(partyMode, 4 /* PartyUiMode.MODIFIER */, -1, slot => {
      if (slot < 6 && party[slot] && countOf(party[slot], key) < maxOf(party[slot], key)) {
        s.ui.setMode(rewardMode, ph.isPlayer()).then(() => {
          give(party[slot], key, {}, 'reward');
          try { s.ui.playSelect(); } catch {}
          ph.applyModifier({ type }, cost, true); // ends the reward round like any other pick
        });
      } else ph.resetModifierSelect(cb);
    }, p => (countOf(p, key) >= maxOf(p, key) ? fullText(p, it) : null));
    return cost === -1;
  }

  // ---- what a mod may ask of the battle (the stable part: mods use these, not the game's objects) ----
  const nameOf = p => (p ? (p.getNameToRender ? p.getNameToRender() : p.name) : '');
  const whoAt = (s, slot) => (window.CoopTeam && CoopTeam.ownerOf(s.getPlayerField()[slot])) || (slot === 1 ? 'p2' : 'p1');
  const targetsOf = c => (c.targets && c.targets.length ? c.targets : (c.move && c.move.targets) || []);
  // 集火 this turn. host-game.js decides it (and counts the streak shown on its banner) a moment after the turn
  // starts; its verdict is `combo`. Until it arrives the same rule is read from the game when the turn starts
  // (`mark`), counting on from host-game.js's streak of the turn before. A verdict only counts when it came
  // after the turn really started (host-game.js can speak early when something runs between the two players'
  // command menus).
  let combo = null, seq = 0; // {key: 'wave:turn', target, streak, seq}
  let mark = { key: '', target: null, streak: 0, seq: 0 };
  function watchCombo() {
    if (combo || !window.CoopGame) return;
    combo = { key: '', target: null, streak: 0, seq: 0 };
    CoopGame.on((type, d) => {
      if (type !== 'turnstart') return;
      combo = { key: turnKey(), target: d && d.combo ? d.target : null, streak: d && d.combo ? Number(d.streak) || 1 : 0, seq: ++seq };
    });
  }
  const turnKey = () => { const b = scene() && scene().currentBattle; return b ? b.waveIndex + ':' + b.turn : ''; };
  // the rule itself (the same as host-game.js): both players' Pokémon aim one single-target move at the same enemy
  function aimedAt() {
    const s = scene(), b = s && s.currentBattle;
    if (!b || !b.double || !b.turnCommands) return null;
    const aim = c => (c && c.command === 0 && targetsOf(c).length === 1 ? targetsOf(c)[0] : null);
    const t0 = aim(b.turnCommands[0]), t1 = aim(b.turnCommands[1]);
    return whoAt(s, 0) !== whoAt(s, 1) && t0 != null && t0 >= 2 && t0 === t1 ? t0 : null;
  }
  const hostStreak = () => { try { return Number(CoopGame.state().streak) || 0; } catch { return 0; } };
  function markTurn() { // the turn starts now: every command is in
    const target = aimedAt();
    mark = { key: turnKey(), target, streak: target != null ? hostStreak() + 1 : 0, seq: ++seq };
  }
  const verdict = () => { const key = turnKey(); return !key ? null : combo && combo.key === key && combo.seq > mark.seq ? combo : mark.key === key ? mark : null; };
  const B = {
    name: nameOf,
    isPlayer: p => !!(p && p.isPlayer && p.isPlayer()),
    index: p => p.getBattlerIndex(),                    // 0, 1: the players' side; 2, 3: the enemies
    owner: p => (window.CoopTeam ? CoopTeam.ownerOf(p) : null), // 'p1' | 'p2'
    hp: p => p.hp, maxHp: p => p.getMaxHp(),
    onField: p => !!(p && p.isActive && p.isActive(true) && !p.isFainted()),
    fainted: p => !!(p && p.isFainted && p.isFainted()),
    playerField: () => scene().getPlayerField().filter(p => B.onField(p)),
    enemyField: () => scene().getEnemyField().filter(p => B.onField(p)),
    // every Pokémon of the two players, in the party's order / those not on the field (fainted ones included)
    party: () => partyOf(scene()).slice(),
    bench: () => partyOf(scene()).filter(p => !(p.isOnField && p.isOnField())),
    // the other Pokémon on the same side, if it is on the field and standing
    ally: p => { let a = null; try { a = p.getAlly(); } catch {} return B.onField(a) ? a : null; },
    // two different Pokémon on the same side (whoever owns them)
    isAlly: (a, b) => !!(a && b && a !== b && B.isPlayer(a) === B.isPlayer(b)),
    status: p => STATUS[(p && p.status && p.status.effect) || 0] || null, // 'poison' | 'toxic' | 'paralysis' | 'sleep' | 'freeze' | 'burn' | null
    statusName: st => STATUS_ZH[st] || '',
    wave: () => (scene().currentBattle || {}).waveIndex || 0,
    turn: () => (scene().currentBattle || {}).turn || 0,
    // between the start of an encounter and the end of its battle (not on the reward screen, not in a shop)
    inBattle() {
      if (battle.on != null) return battle.on && !!scene().currentBattle;
      const n = phaseNow();
      return !!scene().currentBattle && n !== 'SelectModifierPhase' && n !== 'BattleEndPhase' && n !== 'TitlePhase';
    },
    message: text => scene().phaseManager.queueMessage(String(text)),
    // lose HP now, with the game's hit animation; not a move hit (no attacker). opts.indirect: like poison or
    // 生命宝珠's recoil (no hit sound of a move; 气势头带 and the like do not answer it)
    damage: (p, amount, opts) => p.damageAndUpdate(Math.max(1, Math.floor(amount)), opts && opts.indirect ? { result: 12 /* HitResult.INDIRECT */ } : {}),
    // Restore HP in battle the game's own way: its heal animation, the number over the Pokémon, 回复护符 counts.
    // Queued like a message: it happens when the queue gets there. opts: message (shown after), tag (the 'heal'
    // event this causes carries it, so a handler can tell its own heals apart), quiet (no animation).
    // false: not on the field, already at full HP, or nothing to restore.
    heal(p, amount, opts) {
      const o = opts || {};
      amount = Math.floor(Number(amount) || 0);
      if (!(amount > 0) || !B.onField(p) || p.isFullHp()) return false;
      const pm = scene().phaseManager;
      const ph = pm.create('PokemonHealPhase', p.getBattlerIndex(), amount, { message: o.message ? String(o.message) : undefined, showFullHpMessage: false, skipAnim: !!o.quiet });
      ph.__coopModHeal = { tag: o.tag == null ? null : String(o.tag) };
      pm.unshiftPhase(ph);
      return true;
    },
    // cured when the queued messages get there; false when there is nothing to cure
    cureStatus(p, text) {
      const st = B.status(p);
      if (!st) return false;
      scene().phaseManager.queueMessage(text || nameOf(p) + '的' + STATUS_ZH[st] + '治好了！');
      p.resetStatus(false, false, false, true);
      return true;
    },
    // stat stages now: { atk, def, spatk, spdef, spd, acc, eva }, each -6..+6
    statStages(p) { const out = {}; STAT_NAMES.forEach((n, i) => { if (n) out[n] = (p.getStatStage && p.getStatStage(i)) || 0; }); return out; },
    // the Pokémon's own number for a stat ('atk' ... 'spd'; stages, items and abilities not counted)
    stat: (p, stat) => { const n = statNum(stat); return n >= 1 && n <= 5 ? p.getStat(n, false) : 0; },
    // the highest of 攻击 防御 特攻 特防 速度 (HP is not looked at); the first in that order when two are equal
    highestStat(p) { let best = 'atk', top = -1; for (const n of statApi.battle) { const v = B.stat(p, n); if (v > top) { top = v; best = n; } } return best; },
    // raise (n > 0) or lower (n < 0) the Pokémon's own stat stages, as if it had done it itself (the game's
    // animation and message; 唱反调 and 单纯 apply; a statChange event follows, not marked copied).
    // stat: a name ('atk'), a list of names, or 'all' (the five battle stats).
    raise(p, stat, n) {
      n = Math.trunc(n == null ? 1 : Number(n) || 0);
      const list = (stat === 'all' ? statApi.battle : [].concat(stat)).map(statNum).filter(Boolean);
      if (!n || !list.length || !B.onField(p)) return false;
      scene().phaseManager.unshiftNew('StatStageChangePhase', { battlerIndex: p.getBattlerIndex(), sourcePokemon: p, changes: list.map(st => ({ stat: st, stages: n })) });
      return true;
    },
    // the same stat stages for another Pokémon; marked so that no mod reacts to it again (event.copied)
    changeStats(p, changes) {
      const list = (changes || []).filter(c => c && c.stages && statNum(c.stat)).map(c => ({ stat: statNum(c.stat), stages: c.stages }));
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
    // The same verdict as host-game.js's 集火 banner (before the turn starts: what the commands so far say).
    focusTarget() { const v = verdict(); return v ? v.target : aimedAt(); },
    // 集火层数: how many turns in a row, this one included, the two players have focused (host-game.js counts
    // it and shows it on the 集火 banner). 0 when this turn is not a 集火.
    focusStreak() { const v = verdict(); return v ? v.streak : aimedAt() == null ? 0 : hostStreak() + 1; },
    // a number in [0, 1) that is the same for the same run, wave, turn and tag (so a reload replays it)
    random: tag => rng([scene().seed, B.wave(), B.turn(), String(tag == null ? '' : tag)].join(':'))(),
  };
  const apiExt = []; // extensions: mod => ({ ... }) merged into each mod's api object
  const isMon = x => !!x && typeof x === 'object' && typeof x.getBattlerIndex === 'function';
  function makeApi(mod) {
    const api = {
      version: API_VERSION,
      manifest: mod.manifest,
      battle: B,
      STAT: statApi,
      log: (...a) => log('[' + mod.id + ']', ...a),
      // a new item: { id, name, description, tier: 'ULTRA' | 'ROGUE' | 'MASTER' (also 'COMMON', 'GREAT'), weight,
      //   kind: 'held' (default) | 'passive', max (default 1), icon (a packed file's name or a frame of the game's item atlas) }
      item(def) {
        if (!def || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(def.id || '')) throw new Error('item id must be lowercase letters, digits and -');
        if (!(def.tier in TIER)) throw new Error('item ' + def.id + ': tier must be one of ' + Object.keys(TIER).join(', '));
        if (!def.name || !def.description) throw new Error('item ' + def.id + ': name and description are required');
        const kind = def.kind == null ? 'held' : def.kind;
        if (kind !== 'held' && kind !== 'passive') throw new Error('item ' + def.id + ": kind must be 'held' or 'passive'");
        const max = def.max == null ? 1 : Math.floor(Number(def.max));
        if (!(max >= 1 && max <= 999)) throw new Error('item ' + def.id + ': max must be a whole number from 1 to 999');
        const key = mod.id + ':' + def.id;
        if (items[key]) throw new Error('item ' + key + ' defined twice');
        // icon: no name -> the packed picture called like the item, if the mod brought one
        const want = def.icon == null ? def.id : String(def.icon).replace(/\.png$/, '');
        const custom = iconData[mod.id + '/' + want] ? mod.id + '/' + want : null;
        const it = items[key] = { key, mod: mod.id, id: def.id, name: String(def.name), description: String(def.description), tier: def.tier, weight: Number(def.weight) || 0,
          kind, max, v1: mod.v1, icon: custom ? want : String(def.icon || 'unknown'), custom, fallback: String(def.iconFallback || 'unknown'),
          note: typeof def.note === 'function' ? def.note : null };
        mod.items.push(key);
        const on = () => isOn(mod.id), passive = kind === 'passive';
        return {
          key, id: def.id, name: it.name, kind, max,
          // held: does this Pokémon have it; passive: is there one in the team bag. Always false while the mod is off.
          heldBy: p => on() && (passive ? bagCount(key) > 0 : holds(p, key)),
          count: p => (!on() ? 0 : passive ? bagCount(key) : countOf(p, key)),
          // a plain object kept in the save, one per holder (per team for a passive item): put only JSON values in it
          state: p => { const e = passive ? bag[key] : entryOf(p, key); return e ? e.s : null; },
          give: (a, b) => (passive ? give(null, key, isMon(a) || a == null ? b : a) : give(a, key, b)),
          take: (a, b) => (passive ? take(null, key, typeof a === 'number' ? a : typeof b === 'number' ? b : 1) : take(a, key, b == null ? 1 : b)),
          remove: p => remove(passive ? null : p, key),
          // the Pokémon in the party that have it (held items; in the party's order)
          holders: () => (on() && !passive ? partyOf(scene()).filter(p => holds(p, key)) : []),
          canTake: who => canTake(key, who),
        };
      },
      on(type, fn) {
        if (!EVENTS.includes(type)) throw new Error('unknown event ' + type + ' (known: ' + EVENTS.join(', ') + ')');
        if (typeof fn !== 'function') throw new Error('api.on(' + type + '): a function is needed');
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
      // 接口版本 3: a plain object of this run, kept in its save (JSON values only). On the starter screen of a new
      // game it is the object the run will begin with.
      runState: () => runOf(mod.id),
      // 'solo' | 'coop': how the game is being played right now
      mode: () => (coop() ? 'coop' : 'solo'),
      // true the first time it is asked with this tag in a turn (wave:turn), false after that
      oncePerTurn(tag) {
        const k = String(tag == null ? '' : tag), now = (scene().seed || '') + ':' + turnKey();
        if (mod.once[k] === now) return false;
        mod.once[k] = now;
        return true;
      },
    };
    for (const f of apiExt) { const more = guard('api extension for ' + mod.id, () => f(mod, api)); if (more && typeof more === 'object') for (const k of Object.keys(more)) { if (k in api) log('api extension: ' + k + ' is taken, left out'); else api[k] = more[k]; } }
    return api;
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
  // a small dark plate with the item icons (×n for a stack; names when there is room), top-left corner at x, y
  function plate(s, x, y, list, names, color, more) {
    const c = new Phaser.GameObjects.Container(s, x, y), g = new Phaser.GameObjects.Graphics(s);
    c.add(g);
    let cx = 1;
    list.forEach(it => {
      const used = !!(it.state && it.state.used), many = it.count > 1 ? '×' + it.count : '';
      const ic = icon(s, frameOf(it.def), used);
      if (ic) { ic.setPosition(cx, 0); c.add(ic); cx += 12; }
      if (names) { const t = text(s, it.def.name + many + (used ? '(已用)' : ''), used ? '#a59cb3' : '#f8f8f8', 54); t.setPosition(cx, 1); c.add(t); cx += Math.ceil(t.displayWidth) + 3; }
      else if (many) { const t = text(s, many, '#f8f8f8', 48); t.setPosition(cx - 1, 3); c.add(t); cx += Math.ceil(t.displayWidth) + 1; }
    });
    if (more > 0) { const t = text(s, '+' + more, '#f8f8f8', 48); t.setPosition(cx, 3); c.add(t); cx += Math.ceil(t.displayWidth) + 1; } // kinds left out for lack of room
    g.fillStyle(0x1d1824, 0.85).fillRoundedRect(0, -1, cx + 1, 14, 2);
    g.lineStyle(1, Phaser.Display.Color.HexStringToColor(color).color, 0.9).strokeRoundedRect(0, -1, cx + 1, 14, 2);
    c.w = cx + 1;
    return c;
  }
  // a plate no wider than maxW: with names when they fit, else icons only, else as many icons as fit and "+N"
  function fitPlate(s, list, names, color, maxW) {
    let c = plate(s, 0, 0, list, names, color);
    if (c.w <= maxW) return c;
    if (names) { c.destroy(); c = plate(s, 0, 0, list, false, color); }
    for (let n = list.length - 1; c.w > maxW && n >= 1; n--) { c.destroy(); c = plate(s, 0, 0, list.slice(0, n), false, color, list.length - n); }
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
    const sig = mode + '|' + iconReg.done.size + '|' + JSON.stringify(marks.map(m => [m.id, m.x, m.y, m.anchor, m.list.map(it => [it.key, it.count, !!(it.state && it.state.used)])]));
    if (sig === ov.sig) return;
    ov.sig = sig;
    ov.layer.removeAll(true);
    const feet = []; // plates already placed at a Pokémon's feet: [x, y, w]
    marks.forEach(m => {
      // feet: left of the sprite's feet, above the message box (at most 150 px wide). card: along the top edge of
      // the big card of a Pokémon on the field, never wider than the card (about 104 px), so that it stays off the
      // reserve rows and the option menu. row: about 66 px free between the level and the HP numbers.
      const c = fitPlate(s, m.list, m.names, m.color, m.anchor === 'feet' ? 150 : m.anchor === 'card' ? 104 : 66);
      if (m.anchor === 'feet') {
        const w = c.w, x = Math.max(2, m.x - w + 6); let y = Math.min(m.y - 15, 115);
        // two long plates would lie on top of each other: the later one goes one line up
        while (y > 30 && feet.some(f => f[1] === y && x < f[0] + f[2] && f[0] < x + w)) y -= 15;
        feet.push([x, y, w]);
        c.setPosition(x, y);
      }
      else if (m.anchor === 'card') c.setPosition(Math.max(2, m.x - c.w - 2), m.y + 1);
      else c.setPosition(m.x, m.y);
      ov.layer.add(c);
    });
  }

  // ---- the list of mods, with switches (opened from the co-op menu) ----
  let panel = null;
  const panelFns = []; // extensions: fn(modId, render) -> an element shown under that mod in the list, or null
  const el = (tag, attrs, kids) => {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'text') e.textContent = v; else if (k === 'onclick') e.addEventListener('click', v); else e.setAttribute(k, v); });
    (kids || []).forEach(k => k && e.appendChild(k));
    return e;
  };
  // an item's icon for the list: the mod's own picture, or the frame cut out of the game's item texture
  function iconEl(it) {
    try {
      if (it.custom && iconData[it.custom]) return el('img', { class: 'ic', src: iconData[it.custom].uri, alt: '' });
      const s = scene(), f = s && s.textures && s.textures.exists('items') ? s.textures.get('items').get(s.textures.get('items').has(it.icon) ? it.icon : 'unknown') : null;
      if (!f || !f.source || !f.source.image) return el('span', { class: 'ic' });
      const cv = el('canvas', { class: 'ic', width: ICON, height: ICON });
      cv.getContext('2d').drawImage(f.source.image, f.cutX, f.cutY, f.cutWidth, f.cutHeight, Math.floor((ICON - f.cutWidth) / 2), Math.floor((ICON - f.cutHeight) / 2), f.cutWidth, f.cutHeight);
      return cv;
    } catch { return el('span', { class: 'ic' }); }
  }
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
        '#prsModsCard{box-sizing:border-box;width:min(94vw,560px);max-height:92vh;overflow:auto;padding:14px 16px;border-radius:12px;background:#2b2633;color:#f1eef5;font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none;-webkit-user-select:none}' +
        '#prsModsCard h2{margin:0 0 2px;font-size:17px}#prsModsCard p{margin:4px 0;color:#b3abc0;font-size:12.5px}' +
        '#prsModsCard .mod{margin:10px 0;padding:10px 12px;border-radius:9px;background:#1f1b26}' +
        '#prsModsCard .head{display:flex;align-items:center;gap:10px}#prsModsCard .head b{font-size:15px;flex:1}' +
        '#prsModsCard .meta{color:#b3abc0;font-size:12px}#prsModsCard .desc{margin:4px 0 6px}' +
        '#prsModsCard ul{margin:4px 0 0;padding:0;list-style:none}#prsModsCard li{margin:5px 0;font-size:12.5px;color:#d9d3e3;display:flex;gap:8px;align-items:flex-start}' +
        '#prsModsCard li i{font-style:normal;font-weight:600}#prsModsCard li small{color:#b3abc0;font-size:11.5px}#prsModsCard li div{flex:1}' +
        '#prsModsCard .ic{flex:none;width:32px;height:32px;image-rendering:pixelated;object-fit:contain}' +
        '#prsModsCard .bag{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px}#prsModsCard .bag span{display:flex;align-items:center;gap:4px;font-size:12.5px}' +
        '#prsModsCard button{padding:7px 14px;border:0;border-radius:7px;background:#6d5bd0;color:#fff;font-size:14px;cursor:pointer}' +
        '#prsModsCard button.off{background:#4a4356}#prsModsCard .row{display:flex;justify-content:flex-end;margin-top:8px}' +
        '#prsModsCard .err{color:#ff8a7a;font-size:12px}' +
        '#prsModsCard .set{margin:6px 0;padding:8px 10px;border-radius:7px;background:#2b2633}#prsModsCard .set .opts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
        '#prsModsCard .set button{padding:5px 10px;font-size:13px;background:#4a4356}#prsModsCard .set button.sel{background:#6d5bd0}';
      document.head.appendChild(css);
    }
    closePanel();
    const card = el('div', { id: 'prsModsCard' });
    const render = () => {
      card.textContent = '';
      card.appendChild(el('h2', { text: 'Mod（民间创意工坊）' }));
      card.appendChild(el('p', { text: '玩家提的点子做成的可装卸内容。每个 mod 写着它在哪种玩法里生效；开关记在这台设备上，关掉不影响存档，再打开时已经拿到的道具还在。' }));
      if (!order.length) card.appendChild(el('p', { text: '这个版本没有自带任何 mod。' }));
      order.forEach(id => {
        const m = mods[id], mf = m.manifest, on = wanted(id);
        const btn = el('button', { class: on ? '' : 'off', text: m.error ? '加载失败' : on ? '已开启' : '已关闭', onclick: () => { if (!m.error) { setOn(id, !wanted(id)); render(); } } });
        const where = m.modes.includes('solo') ? (m.modes.includes('coop') ? '单人和双人合作都生效' : '只在单人模式生效') : '只在双人合作房间里生效';
        const more = []; // what extensions add under a mod (its settings for this run ...)
        if (!m.error) for (const fn of panelFns) { const x = guard('panel row', () => fn(id, render), null); if (x) more.push(x); }
        const list = el('ul', {}, m.items.map(k => {
          const it = items[k], t = TIER[it.tier];
          const name = el('i', { text: it.name + '（' + TIER_ZH[t] + '）' });
          name.style.color = TIER_CSS[t];
          return el('li', {}, [iconEl(it), el('div', {}, [name, el('small', { text: ' ' + KIND_ZH[it.kind] + ' · 最大携带数量 ' + it.max }), el('br'), document.createTextNode(it.description.replace(/\n/g, ''))])]);
        }));
        card.appendChild(el('div', { class: 'mod' }, [
          el('div', { class: 'head' }, [el('b', { text: mf.name || id }), btn]),
          el('div', { class: 'meta', text: 'v' + (mf.version || '?') + ' · 作者：' + (mf.author || '?') + (mf.credits ? ' · ' + mf.credits : '') + ' · ' + where }),
          el('div', { class: 'desc', text: mf.description || '' }),
          ...more,
          m.error ? el('div', { class: 'err', text: '这个 mod 没能加载：' + m.error.slice(0, 160) }) : list,
        ]));
      });
      // the team bag: passive items of this run (of mods that are on)
      if (coop() && active() && partyOf(scene()).length && order.some(id => mods[id].items.some(k => items[k].kind === 'passive'))) {
        const inBag = shownBag();
        card.appendChild(el('div', { class: 'mod' }, [
          el('div', { class: 'head' }, [el('b', { text: '队伍背包（被动增益）' })]),
          inBag.length ? el('div', { class: 'bag' }, inBag.map(it => el('span', {}, [iconEl(it.def), document.createTextNode(it.def.name + ' ×' + it.count + '（最多 ' + it.def.max + (noteOf(it) ? '，' + noteOf(it) : '') + '）')])))
            : el('div', { class: 'meta', text: '这一局还没有拿到被动增益道具。' }),
        ]));
      }
      card.appendChild(el('p', { text: coop() ? '改了马上生效；奖励里的新道具从下一次战后奖励起出现。' : '现在没有开着的合作房间：只在双人合作里生效的 mod 先记下开关，开房间后生效；单人也生效的 mod 改了马上生效。' }));
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
    if (!s || !s.phaseManager) return;
    if (!coop() && !anyOn()) return; // no co-op room and no solo mod switched on: nothing is touched
    try {
      hookSave(s);
      if (s.seed && partyOf(s).length) {
        // another run, or this seed from an earlier point (the wave or the run's clock went back: loaded again,
        // or a new run on the same seed): take the items from the save again
        const wave = (s.currentBattle || {}).waveIndex || 0, time = Number(s.sessionPlayTime) || 0;
        if (s.seed !== heldSeed || (wave > 0 && wave < runMark.wave) || time < runMark.time) loadFor(s.seed);
        if (wave > 0) runMark.wave = wave;
        runMark.time = time;
      }
      if (anyOn()) {
        watchCombo(); hookPhases(s); hookPokemon(s); registerIcons(s);
        for (const fn of tickFns) guard('tick', () => fn(s));
      }
    } catch (e) { log('error', String(e)); }
    try { draw(); } catch (e) { log('overlay error', String(e)); }
  }, 200);

  const debugApi = {
    hooked: () => ({ ...hooked, save: !!(scene() && scene().gameData && scene().gameData.__coopMods) }),
    held: () => JSON.parse(JSON.stringify(held)),   // { pokemonId: { key: { n, s } } }
    bag: () => JSON.parse(JSON.stringify(bag)),     // { key: { n, s } }
    block: () => JSON.parse(JSON.stringify(exportBlock(scene()))), // what the next save will carry
    // partyIndex: place in the party (ignored for a passive item)
    give: (partyIndex, key, state) => give(scene().getPlayerParty()[partyIndex], key, state, 'debug'),
    take: (partyIndex, key, n) => take(scene().getPlayerParty()[partyIndex], key, n == null ? 1 : n),
    remove: (partyIndex, key) => remove(scene().getPlayerParty()[partyIndex], key),
    forceReward: keys => { debug.force = [].concat(keys); return debug.force.slice(); },
    chance: () => Object.fromEntries(Object.keys(items).map(k => { const t = TIER[items[k].tier], pool = POOL[t], same = Object.keys(items).filter(x => TIER[items[x].tier] === t); const w = x => Math.min(Number(items[x].weight) || 0, pool.cap); return [k, w(k) / (pool.total + same.reduce((a, x) => a + w(x), 0))]; })),
    icons: () => ({ packed: Object.keys(iconData).length, decoded: Object.keys(iconData).filter(k => iconData[k].ok).length, inTexture: iconReg.done.size }),
    events: () => EVENTS.slice(),
    battle: B,
  };

  // ---- engine extensions (engine/ext-*.js, see engine/EXT.md): what an extension gets ----
  const exts = {}; // name -> 'ok' | the error it failed with
  const X = {
    version: API_VERSION,
    scene, log, uiMode,
    // the tables (read them, do not write): items 'modId:itemId' -> definition; mods modId -> { manifest, items, ok, ... }
    items, mods, order,
    TIER, tierName: t => TIER_ZH[typeof t === 'number' ? t : TIER[t]] || '', tierColor: t => TIER_CSS[typeof t === 'number' ? t : TIER[t]] || '#f8f8f8', kindName: k => KIND_ZH[k] || '',
    STAT: statApi, cfg,
    isOn, wanted, coop, anyOn, active, itemOn,
    // 接口版本 3: a mod's values of this run (see api.runState); fn() when a new game's starter screen opens;
    // fn(modId, render) -> element for the list of mods (render() draws the list again)
    runState: id => runOf(id), inSetup: () => !!setup, onSetup(fn) { setupFns.push(fn); }, onPanel(fn) { panelFns.push(fn); }, el,
    panelOpen: () => !!panel,
    key: (modId, itemId) => modId + ':' + itemId,
    // held items and the team bag, by item key. p: the Pokémon (null for a passive item)
    give: (p, key, state, from) => give(p, key, state, from),
    take: (p, key, n) => take(p, key, n == null ? 1 : n),
    remove: (p, key) => remove(p, key),
    count: (p, key) => (!itemOn(key) ? 0 : items[key].kind === 'passive' ? bagCount(key) : countOf(p, key)), // 0 while the item's mod is off
    state: (p, key) => { const e = items[key] && items[key].kind === 'passive' ? bag[key] : entryOf(p, key); return e ? e.s : null; },
    holders: key => (itemOn(key) ? partyOf(scene()).filter(p => holds(p, key)) : []),
    heldItems: p => shownItems(p), bagItems: () => shownBag(), // [{ key, def, state, count }] of mods that are on
    canTake,
    emit, has, listeners,
    // 接口版本 3: the "run" part of the block a save was read with (by run seed), or of this device's copy; null when none
    savedRun: seed => { const c = fromSave[seed] || kept()[seed]; return c && c.block && isObj(c.block.run) ? c.block.run : null; },
    addEvent(name) { if (!/^[a-z][A-Za-z0-9]{2,39}$/.test(name)) throw new Error('bad event name ' + name); if (!EVENTS.includes(name)) EVENTS.push(name); return name; },
    extendBattle(fns) { const ks = Object.keys(fns || {}); for (const k of ks) if (k in B) throw new Error('api.battle.' + k + ' exists already'); for (const k of ks) B[k] = fns[k]; },
    extendApi(fn) { if (typeof fn !== 'function') throw new Error('extendApi needs a function (mod, api) => ({ ... })'); apiExt.push(fn); },
    onTick(fn) { tickFns.push(fn); },
    onSwitch(fn) { switchFns.push(fn); },
    // hooks: see wrapOnce / before / after above
    wrap: (obj, method, tag, make) => wrapOnce(obj, method, tag, make), before, after, guard, protoWith, gameMethod,
    // fn(p, key, max) -> number: how many of held item `key` Pokémon p may hold (max: the item's own, or what the extension before answered)
    onMax(fn) { if (typeof fn !== 'function') throw new Error('onMax needs a function (pokemon, key, max) => number'); maxFns.push(fn); },
    maxOf: (p, key) => maxOf(p, key),
    // fn(proto, phase) once, when the first phase of that class is about to start (or now, if one already has)
    phaseClass(name, fn) { (phaseClassFns[name] = phaseClassFns[name] || []).push(fn); if (phaseProtos[name]) guard('phase class ' + name, () => fn(phaseProtos[name], null)); },
    // fn(proto) once, with the game's Pokemon class (the base of the players' and the enemies' Pokémon)
    pokemonClass(fn) { pokemonClassFns.push(fn); if (pokemonProto) guard('pokemon class', () => fn(pokemonProto)); },
    // rewards: fn(phase, options) for every reward list the game makes while a mod is on; return a new list to replace it
    onRewardOptions(fn) { rewardFns.push(fn); },
    makeOption, rng, random: B.random,
    nameOf, battle: B, turnKey, phaseNow, inBattle: () => B.inBattle(),
    frameOf: key => (items[key] ? frameOf(items[key]) : 'unknown'),
    redraw() { ov.sig = ''; },
    debug(name, fn) { if (name in debugApi) throw new Error('CoopMods.debug.' + name + ' exists already'); debugApi[name] = fn; },
  };
  window.CoopModsExt = function (name, install) {
    if (typeof name !== 'string' || !name || typeof install !== 'function') { log('extension refused: CoopModsExt(name, X => { ... })'); return false; }
    if (name in exts) return false; // injected twice
    exts[name] = 'installing';
    try { install(X); exts[name] = 'ok'; log('extension ' + name + ' installed'); return true; } catch (e) {
      exts[name] = String((e && e.stack) || e).slice(0, 400);
      log('extension ' + name + ' failed to install, skipped: ' + exts[name]);
      return false;
    }
  };

  window.CoopMods = {
    apiVersion: API_VERSION,
    manifest, define, icons, openPanel, closePanel,
    // on: the switch; running: switched on and made for the way the game is being played right now
    list: () => order.map(id => ({ id, name: mods[id].manifest.name, version: mods[id].manifest.version, on: wanted(id), running: isOn(id), modes: mods[id].modes.slice(), error: mods[id].error, items: mods[id].items.slice() })),
    isOn, setOn,
    extensions: () => ({ ...exts }),
    // names of the mod items a Pokémon holds (for the phone's team sheet, host-game.js readParty)
    heldNames: p => shownItems(p).map(it => it.def.name + (it.count > 1 ? '×' + it.count : '') + (it.state && it.state.used ? '(已用)' : '')),
    // names of the passive mod items in the team bag (for the phone's team sheet, next to the game's own bag)
    bagNames: () => shownBag().map(it => it.def.name + (it.count > 1 ? '×' + it.count : '') + (noteOf(it) ? '（' + noteOf(it) + '）' : '')),
    canTake,
    tierName: X.tierName,
    // does a mod that is on refuse this move for this Pokémon? (host-game.js greys it out in 2P's pick list)
    moveBlocked(p, moveId) {
      if (!has('moveSelect')) return false;
      for (const [m, fn] of listeners('moveSelect')) { try { const no = fn({ pokemon: p, moveId }); if (typeof no === 'string' && no) return true; } catch (e) { problem(m, 'moveSelect', e); } }
      return false;
    },
    // for tests from the console; not used by the game or by mods
    debug: debugApi,
  };
  log('loader ready (interface v' + API_VERSION + ')');
})();

// ======== engine extension: b1 (engine/ext-b1.js) ========
// Engine extension of team b1: extra reward screens.
// A mod can add its own reward screens that come right after a wave's normal reward (issue #2: the 联机道具
// screen; #25 招式学习器盒; #26 进化之证). The mod says when a screen is due and what is on it; this file does
// everything that touches the game: queueing the screen behind the wave's reward phase, the list of options,
// the title on screen, the paid reroll, hiding the shop, and rolling the game's own TMs / evolution items /
// form-change items for a mod to offer.
//
// ---- For mod authors (简体中文，格式同 docs/MOD-API.md；这一段是本扩展给 mod 多加的东西) ----
//
// `api.rewardScreen(def)`：加一个「额外的奖励界面」。它排在这一层正常奖励（两位玩家都挑完）之后，
// 两位玩家照样轮流挑：先挑的人从全部选项里拿 1 个，另一位从剩下的里拿 1 个。界面上方会显示标题。
// 这个界面没有商店那一排。
//   id       小写字母、数字、短横线
//   title    显示在界面上方的标题（中文），hint 是标题下面的一行小字（可以不写）
//   count    一次出几个选项（1–8）
//   reroll   true = 左下角可以付费刷新（价格和游戏的刷新一样，从正在挑的那位玩家的钱里扣），不写 = 不能刷新
//   exclusive  true = 只要这个 mod 开着，所有 mod 道具都不再混进正常奖励，只从这种界面里出
//   when(ctx)     这一层的正常奖励排上队时问一次：返回 true 就在它后面加这个界面。ctx.wave 是层数
//   first(ctx)    谁先挑：返回 'p1' / 'p2'；不写或返回别的 = 和正常奖励一样（单数层 2P 先）
//   options(ctx)  界面要打开时问：返回这次的选项列表（数组）。每一项是一个 mod 道具的 key（`item.key`），
//                 或者 `api.gameRewards` 给的游戏道具。返回空数组 = 这次不出这个界面。
//                 ctx: wave 层数、count 要几个、round 第几轮（刷新第二位玩家的那一轮时是 2）、reroll 第几次刷新（0 = 没刷新过）、
//                 picker 现在轮到谁、random() 给 0 到 1 的数（同一局、同一层、同一次刷新永远一样）
//   opened(ctx)   界面真的打开了（有东西可挑）时调用一次；一次性的道具在这里 `item.take()`
//   emptyText     没有东西可出、这次不出界面时显示的一句话（可以不写）
//   refill        true = 轮到第二位玩家时，剩下的选项里已经没人用得上的（比如第一位刚让那只宝可梦进化了）会被拿掉，
//                 再问一次 options(ctx)（ctx.round 是 2）补上；不写 = 只拿掉、不补
// `api.gameRewards({ kinds, tier, max, who, ignoreBracelet })`：队伍里有宝可梦用得上的游戏道具，最多 max 个、互不重复。
//   kinds: 'tm' 招式学习器、'evolution' 进化道具、'form' 形态变化道具（超级石、极巨菇菇也在这一类），可以写数组；
//   tier: 'COMMON' / 'GREAT' / 'ULTRA' / 'ROGUE'，游戏给这个道具定的品质；
//   who: 'p1' / 'p2' = 只看这位玩家的宝可梦用不用得上，不写 = 两位玩家的都算；
//   ignoreBracelet: true = 没有超级手环 / 极巨腕带时，超级石和极巨菇菇也算。
//   返回的是游戏自己的对象，只能原样放进 options 的返回值里。只在奖励阶段里能用（options / when 里），别处返回空数组。
// `api.modItems()`：所有开着的 mod 的道具，`[{ key, mod, id, name, tier, kind, max, canTake(who) }]`。
// `B.rewardPicker()`：现在奖励界面轮到谁挑，'p1' / 'p2'；不在奖励界面时是 null。
// `B.sameReward(a, b)`：`api.gameRewards` 给的两个道具是不是同一个（同一个招式学习器、同一块石头）。
CoopModsExt('b1', X => {
  const T = 'b1', TAG = '__b1'; // TAG on a reward phase: { id, wave, rr, n?, copy? } = one of our extra screens
  const screens = {}, ids = []; // id -> definition (with .mod), in the order they were registered
  let started = new WeakMap(); // Battle object -> Set of screen ids that have started in that battle
  const dbg = { force: new Set(), wave: null, last: null };
  let rewardProto = null, rawOptions = null; // SelectModifierPhase.prototype / its getModifierTypeOptions before the extensions and the core wrapped it
  let rawStart = null, lastRerolls = 0; // its start before we wrapped it / the reroll count of the last reward screen that started
  let likeOption = null; // any option the game made (for X.makeOption)
  let ownsOffer = false; // we switched X.cfg.normalOffer off

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isReward = ph => !!ph && ph.phaseName === 'SelectModifierPhase';
  const tagOf = ph => (isReward(ph) && ph[TAG] && typeof ph[TAG] === 'object' ? ph[TAG] : null);
  const coopOf = ph => (ph && ph.__coop && typeof ph.__coop === 'object' ? ph.__coop : null); // host-team.js's tag (true on untagged phases)
  const defOf = ph => { const t = tagOf(ph), d = t && screens[t.id]; return d && X.isOn(d.mod) ? d : null; };
  const current = () => { try { return X.scene().phaseManager.getCurrentPhase(); } catch { return null; } };
  const waveNow = () => (dbg.wave != null ? dbg.wave : ((X.scene().currentBattle || {}).waveIndex) || 0);
  const other = w => (w === 'p1' ? 'p2' : 'p1');
  const teamCount = w => { try { return window.CoopTeam.count(w); } catch { return 1; } };
  const settings = def => ({ guaranteedModifierTypeOptions: [], fillRemaining: false, allowLuckUpgrades: false, rerollMultiplier: def && def.reroll ? undefined : -1 });

  // ---- what mods get ----
  const TIERS = ['COMMON', 'GREAT', 'ULTRA', 'ROGUE', 'MASTER'];
  const KINDS = { tm: ['TM_COMMON', 'TM_GREAT', 'TM_ULTRA'], evolution: ['EVOLUTION_ITEM', 'RARE_EVOLUTION_ITEM'], form: ['FORM_CHANGE_ITEM', 'RARE_FORM_CHANGE_ITEM'] };
  const ACCESS = ['MegaEvolutionAccessModifier', 'GigantamaxAccessModifier']; // 超级手环, 极巨腕带
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  // one real reward option of that rarity from the game's own generator (the pool a normal reward uses), or null
  function rollOne(tier) {
    const fake = Object.create(rewardProto);
    fake.__coop = null; fake[TAG] = null; // not a co-op round, not one of ours: nobody's offer or swap applies
    fake.modifierTiers = undefined; fake.rerollCount = 0; fake.isCopy = false;
    fake.customModifierSettings = { guaranteedModifierTiers: [tier], allowLuckUpgrades: false };
    const list = rawOptions.call(fake, 1);
    const o = Array.isArray(list) ? list[0] : null;
    return o && o.type ? o : null;
  }
  // The game works out what every entry of the reward pool weighs when a reward screen starts, from the party and
  // the items of that moment, and keeps it until the next screen. An entry it found nothing for then (a mega stone
  // while nobody could use one, with another Pokémon already holding a stone) weighs 0 and cannot be rolled later.
  // This makes the game weigh the pool again now: the first lines of its own start(), stopped before the screen.
  const STOP = {};
  function reweigh(rerolls) {
    if (!rawStart || !rewardProto) return false;
    const s = X.scene(), fake = Object.create(rewardProto), had = own(s, 'reroll'), was = s.reroll;
    fake.__coop = null; fake[TAG] = null;
    fake.rerollCount = Math.max(0, Number(rerolls) || 0); fake.isCopy = false; fake.modifierTiers = undefined; fake.customModifierSettings = undefined;
    fake.isPlayer = () => true;
    fake.updateSeed = () => {}; // not a new screen: the wave's seed stays as it is
    fake.getModifierCount = fake.getModifierTypeOptions = () => { throw STOP; }; // what start() does right after weighing
    try { rawStart.call(fake); } catch (e) { if (e === STOP) return true; throw e; } finally { if (had) s.reroll = was; else delete s.reroll; }
    return false;
  }
  const rewardKey = o => o.type.id + ':' + (o.type.moveId != null ? o.type.moveId : o.type.evolutionItem != null ? o.type.evolutionItem : o.type.formChangeItem != null ? o.type.formChangeItem : o.type.name);
  // Game items somebody in the party can use, found by rolling the game's generators (which only make what the
  // party can use). Own random stream by wave and arguments: the same call gives the same list after a reload,
  // and the game's random numbers are where they were afterwards.
  function gameRewards(spec) {
    const out = [];
    const o = spec || {}, tier = TIERS.indexOf(o.tier), max = Math.max(1, Math.min(Math.floor(Number(o.max) || 8), 24));
    const want = [].concat(o.kinds || []).reduce((a, k) => a.concat(KINDS[k] || []), []);
    const s = X.scene();
    if (tier < 0 || tier > 3 || !want.length || !rewardProto || !rawOptions || !s || !s.currentBattle || typeof s.executeWithSeedOffset !== 'function') return out;
    const who = o.who === 'p1' || o.who === 'p2' ? o.who : null;
    const weigh = want.some(id => !KINDS.tm.includes(id)), offset = 7000 + (hash([tier, want.join(), o.ignoreBracelet ? 1 : 0, who || ''].join('|')) % 9000);
    const seen = new Set(), quiet = console.log, hadGm = own(s, 'getModifiers'), gm = s.getModifiers, hadGp = own(s, 'getPlayerParty'), gp = s.getPlayerParty;
    console.log = () => {}; // the game logs twice per roll
    try {
      // one player's Pokémon only: for the length of these rolls the party the generators are given is theirs
      if (who && window.CoopTeam && typeof gp === 'function') s.getPlayerParty = function () {
        const all = gp.apply(this, arguments);
        return Array.isArray(all) ? all.filter(p => window.CoopTeam.ownerOf(p) === who) : all;
      };
      // the game only offers a mega stone / Max Mushrooms when the team has the bracelet / band; the stones work
      // without it. For the length of these rolls the two "have you got it" questions are answered yes.
      if (o.ignoreBracelet && typeof gm === 'function') s.getModifiers = function (cls) {
        const r = gm.apply(this, arguments);
        return Array.isArray(r) && !r.length && cls && ACCESS.includes(cls.name) ? [{}] : r;
      };
      s.executeWithSeedOffset(() => {
        if (weigh) reweigh(0); // evolution and form items: by the party as it is now (and as the two lines above show it)
        for (let i = 0; i < 400 && out.length < max; i++) {
          const opt = rollOne(tier);
          if (!opt || !want.includes(opt.type.id)) continue;
          const k = rewardKey(opt);
          if (!seen.has(k)) { seen.add(k); out.push(opt); }
        }
      }, offset, s.waveSeed);
    } catch (e) {
      console.log = quiet;
      X.log('b1: rolling game rewards failed (' + String(e).slice(0, 120) + ')'); // e.g. no reward screen yet in this session
    } finally {
      console.log = quiet;
      if (hadGm) s.getModifiers = gm; else delete s.getModifiers;
      if (hadGp) s.getPlayerParty = gp; else delete s.getPlayerParty;
      // and the weights go back to what the game itself would have for the real party and items
      if (weigh) try { s.executeWithSeedOffset(() => { reweigh(lastRerolls); }, offset, s.waveSeed); } catch (e) { X.log('b1: weighing the reward pool again failed (' + String(e).slice(0, 120) + ')'); }
    }
    if (out[0]) likeOption = out[0];
    return out;
  }
  const modItems = () => Object.keys(X.items).filter(X.itemOn).map(key => {
    const it = X.items[key];
    return { key, mod: it.mod, id: it.id, name: it.name, tier: it.tier, kind: it.kind, max: it.max, canTake: who => X.canTake(key, who) };
  });
  function rewardScreen(mod, def) {
    if (!def || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(def.id || '')) throw new Error('rewardScreen: id must be lowercase letters, digits and -');
    const id = def.id;
    if (screens[id]) throw new Error('rewardScreen ' + id + ' defined twice');
    if (!def.title || typeof def.options !== 'function' || typeof def.when !== 'function') throw new Error('rewardScreen ' + id + ': title, when(ctx) and options(ctx) are required');
    const count = Math.floor(Number(def.count));
    if (!(count >= 1 && count <= 8)) throw new Error('rewardScreen ' + id + ': count must be a whole number from 1 to 8');
    screens[id] = { id, mod: mod.id, title: String(def.title), hint: def.hint ? String(def.hint) : '', count, reroll: !!def.reroll, exclusive: !!def.exclusive,
      when: def.when, first: typeof def.first === 'function' ? def.first : null, options: def.options, opened: typeof def.opened === 'function' ? def.opened : null,
      emptyText: def.emptyText ? String(def.emptyText) : '', refill: !!def.refill };
    ids.push(id);
    return id;
  }
  X.extendApi((mod, api) => ({ rewardScreen: def => rewardScreen(mod, def), gameRewards, modItems }));
  X.extendBattle({
    rewardPicker: () => { const c = coopOf(current()); return isReward(current()) && c && (c.picker === 'p1' || c.picker === 'p2') ? c.picker : null; },
    // are two results of api.gameRewards the same item (the same TM, the same stone)?
    sameReward: (a, b) => !!(a && b && a.type && b.type) && X.guard('b1 sameReward', () => rewardKey(a) === rewardKey(b), false),
  });

  // mod items leave the normal reward while a mod with an `exclusive` screen is on (issue #2)
  function syncOffer() {
    const want = ids.some(id => screens[id].exclusive && X.isOn(screens[id].mod));
    if (want && X.cfg.normalOffer) { X.cfg.normalOffer = false; ownsOffer = true; X.log('b1: mod items only on their own reward screen now (normal offer off)'); }
    else if (!want && ownsOffer) { X.cfg.normalOffer = true; ownsOffer = false; X.log('b1: normal offer of mod items back on'); }
  }
  // A mod is switched off. From then on none of the wraps below is reached (the core calls the game's own
  // methods directly), so what this file has put into the game has to come out here:
  // - its screens that are still waiting in the queue. Left there, each would start as the game's own reward
  //   screen with an empty list: the shop and nothing else, once per player (seen on the rig);
  // - the title of a screen of its that is up right now (the title is taken off in the wrap of clear(); left
  //   there it stays over the shop row of every later reward screen).
  // A screen that is up stays up as the game's own: what is on it can still be taken.
  function modOff(modId) {
    const s = X.scene(), pm = s && s.phaseManager;
    if (!pm) return;
    const mine = p => { const t = tagOf(p), d = t && screens[t.id]; return !!d && d.mod === modId; };
    let n = 0;
    if (typeof pm.tryRemovePhase === 'function') while (n < 24 && pm.tryRemovePhase('SelectModifierPhase', mine)) n++;
    if (n) X.log('b1: mod ' + modId + ' switched off, ' + n + ' waiting screen(s) of it taken out of the queue');
    const h = ((s.ui && s.ui.handlers) || []).find(x => x && x.__b1Title);
    if (h && !defOf(current())) eraseTitle(h); // (not the title of a screen whose mod is still on)
  }
  X.onSwitch((modId, on) => X.guard('b1 switch', () => { syncOffer(); if (!on) modOff(modId); }));

  // ---- queueing: an extra screen goes right behind the wave's reward phase, the same way that one was queued ----
  // (so everything the normal reward spawns - the second player's round, a TM's learn-move phase and its copy,
  // a reroll - runs before it, and the next battle after it)
  const isBase = ph => isReward(ph) && !ph.isCopy && !ph.rerollCount && !ph[TAG] && !!coopOf(ph) && coopOf(ph).round === 1;
  function queueExtras(pm, add) {
    const s = X.scene(), b = s.currentBattle;
    if (!b) return;
    const done = started.get(b), wave = waveNow();
    for (const id of ids) {
      const def = screens[id];
      if (!X.isOn(def.mod) || (done && done.has(id))) continue;
      if (pm.hasPhaseOfType('SelectModifierPhase', p => !!p[TAG] && p[TAG].id === id)) continue;
      const due = dbg.force.has(id) || X.guard('b1 when ' + id, () => !!def.when({ wave }), false);
      if (!due) continue;
      const ph = pm.create('SelectModifierPhase', 0, undefined, settings(def), false);
      ph[TAG] = { id, wave, rr: 0 };
      add.call(pm, ph);
      X.log('b1: screen ' + id + ' queued behind the reward of wave ' + wave);
    }
  }
  function hookManager(s) {
    const pm = s.phaseManager;
    for (const method of ['pushPhase', 'unshiftPhase']) {
      X.wrap(pm, method, T, orig => function (...phases) {
        const r = orig.apply(this, phases);
        X.guard('b1 queue', () => { if (ids.length && phases.some(isBase)) queueExtras(this, orig); });
        return r;
      });
    }
    // phases made while one of our screens is up: the game's copy (kept while a TM is being learned) and
    // host-team.js's second round stay ours; a reroll (which the game makes as an ordinary random reward)
    // becomes a new list of the same screen
    X.wrap(pm, 'create', T, orig => function (name, ...args) {
      if (name !== 'SelectModifierPhase') return orig.call(this, name, ...args);
      let tag = null;
      X.guard('b1 create', () => {
        const cur = this.getCurrentPhase(), t = tagOf(cur);
        if (!t) return;
        if (args[3] === true) tag = { id: t.id, wave: t.wave, rr: t.rr || 0, copy: true, refilled: !!t.refilled };
        else if (args[0] > 0) {
          tag = { id: t.id, wave: t.wave, rr: (t.rr || 0) + 1, n: (cur.typeOptions || []).length };
          args[1] = undefined;
          args[2] = settings(screens[t.id]);
        }
      });
      const ph = orig.call(this, name, ...args);
      if (tag && ph) ph[TAG] = tag;
      return ph;
    });
  }

  // ---- a screen starts ----
  function contextFor(ph, tag, def, c, n) {
    const s = X.scene(), round = c.round === 2 ? 2 : 1;
    return { wave: tag.wave, count: n, round, reroll: tag.rr || 0, picker: c.picker, random: X.rng([s.seed, tag.wave, 'b1', def.id, round, tag.rr || 0].join(':')) };
  }
  // what a mod's options(ctx) returned -> reward options the screen can show, at most n, none twice, none of `have`
  function toOptions(list, n, have) {
    const opts = [], seen = new Set((have || []).map(optKey));
    for (const x of Array.isArray(list) ? list : []) {
      if (opts.length >= n) break;
      let opt = null;
      if (typeof x === 'string') { if (X.itemOn(x) && !seen.has('mod:' + x)) opt = X.makeOption(likeOption, x, 0); }
      else if (x && typeof x === 'object' && x.type && typeof x.type.name === 'string' && !seen.has(optKey(x))) opt = x;
      if (opt) { seen.add(optKey(opt)); opts.push(opt); }
    }
    return opts;
  }
  const optKey = o => (o.type.__coopMod ? 'mod:' + o.type.__coopMod : 'game:' + rewardKey(o));
  // can anybody in the party still use this option? (a game item that goes on a Pokémon says so itself)
  function usable(opt) {
    const type = opt && opt.type;
    if (!type) return false;
    if (type.__coopMod) return X.itemOn(type.__coopMod);
    if (typeof type.selectFilter !== 'function') return true;
    return X.scene().getPlayerParty().some(p => { try { return type.selectFilter(p) === null; } catch { return true; } });
  }
  // 'go': show it; 'skip': nothing to show, end the phase without opening anything
  function prepare(ph, tag) {
    const def = defOf(ph), c = coopOf(ph), s = X.scene();
    if (!def || !c) return 'skip'; // its mod was switched off meanwhile, or host-team.js did not tag it
    if (ph.isCopy) { // a copy shows the list it was made with (the second round: what the first player left)
      const cs = ph.customModifierSettings, list = cs && Array.isArray(cs.guaranteedModifierTypeOptions) ? cs.guaranteedModifierTypeOptions : [];
      // what nobody can use any more is taken off (the first player's pick may have evolved the Pokémon it was for)
      let rest = list.filter(usable);
      if (c.round === 2 && !tag.refilled) {
        tag.refilled = true;
        if (def.refill && rest.length < list.length) {
          const more = X.guard('b1 refill ' + def.id, () => def.options(contextFor(ph, tag, def, c, list.length)), []);
          rest = rest.concat(toOptions(more, list.length - rest.length, rest).filter(usable));
        }
      }
      if (cs && (rest.length !== list.length || rest.some((o, i) => o !== list[i]))) { // (a refilled list has the old length)
        X.log('b1: screen ' + def.id + ': ' + list.filter(o => !rest.includes(o)).length + ' of the ' + list.length + ' left can no longer be used; now: ' + (rest.map(o => o.type.name).join(' | ') || 'nothing'));
        cs.guaranteedModifierTypeOptions = rest;
      }
      tag.empty = !rest.length;
      return rest.length ? 'go' : 'skip'; // no shop on these screens: an empty round has nothing
    }
    const first = !tag.rr;
    if (first && s.currentBattle) { // from here on this battle has had this screen (looked at when another reward phase is queued)
      let done = started.get(s.currentBattle);
      if (!done) started.set(s.currentBattle, done = new Set());
      done.add(def.id);
      dbg.force.delete(def.id);
    }
    if (first) {
      let who = def.first ? X.guard('b1 first ' + def.id, () => def.first({ wave: tag.wave }), null) : null;
      if (who !== 'p1' && who !== 'p2') who = c.picker;
      if ((who === 'p1' || who === 'p2') && !teamCount(who) && teamCount(other(who))) who = other(who); // nobody to give an item to
      if (who === 'p1' || who === 'p2') c.picker = who;
    }
    const n = first ? def.count : Math.max(1, Math.min(Number(tag.n) || def.count, 8));
    const ctx = contextFor(ph, tag, def, c, n);
    const opts = toOptions(X.guard('b1 options ' + def.id, () => def.options(ctx), []), n);
    tag.empty = !opts.length;
    if (!opts.length) return 'skip';
    ph.customModifierSettings = settings(def);
    ph.customModifierSettings.guaranteedModifierTypeOptions = opts; // the game shows a set list as it is
    tag.opts = opts;
    X.log('b1: screen ' + def.id + ' wave ' + tag.wave + (tag.rr ? ' reroll ' + tag.rr : '') + ', ' + (c.picker === 'p1' ? '1P' : '2P') + ' picks' + (c.round === 2 ? ' (second round)' : ' first') + ': ' + opts.map(o => o.type.name).join(' | '));
    if (first && def.opened) X.guard('b1 opened ' + def.id, () => def.opened(ctx));
    return 'go';
  }
  function skip(ph) {
    const c = coopOf(ph), tag = tagOf(ph) || {}, def = defOf(ph);
    if (c) c.ended = true; // host-team.js: no second round for a screen that never opened
    X.log('b1: screen ' + tag.id + ' has nothing to show, skipped');
    // tell the players why nothing comes up (shown right after this phase)
    X.guard('b1 skip text', () => {
      const text = !def || !tag.empty ? '' : ph.isCopy ? '「' + def.title + '」里没有剩下能用的道具了。' : def.emptyText;
      if (text) X.scene().phaseManager.queueMessage(text, 1500); // stays up a moment after it is written out, no button needed
    });
    return ph.end();
  }
  X.phaseClass('SelectModifierPhase', proto => {
    // the two methods as they were before the core or any extension wrapped them (whatever the install order)
    if (proto !== rewardProto) { rewardProto = proto; rawOptions = X.gameMethod(proto, 'getModifierTypeOptions'); rawStart = X.gameMethod(proto, 'start'); }
    X.wrap(proto, 'start', T, orig => function () {
      const tag = tagOf(this);
      if (!this.isCopy) lastRerolls = Number(this.rerollCount) || 0; // (a copy keeps the weights of the screen it copies)
      if (!tag) return orig.apply(this, arguments);
      const what = X.guard('b1 screen start', () => prepare(this, tag), 'skip');
      return what === 'go' ? orig.apply(this, arguments) : skip(this);
    });
    // the list on screen is the one prepared above, whatever was added to it on the way (金色精灵球, 银色之羽: issue #2)
    X.before(proto, 'resetModifierSelect', T, self => {
      const tag = tagOf(self);
      if (!tag || self.isCopy || !Array.isArray(tag.opts) || !Array.isArray(self.typeOptions)) return;
      if (self.typeOptions.length !== tag.opts.length || self.typeOptions.some((o, i) => o !== tag.opts[i])) {
        X.log('b1: screen ' + tag.id + ': the list was changed on the way (' + self.typeOptions.length + ' options), put back to its ' + tag.opts.length);
        self.typeOptions = tag.opts.slice();
      }
    });
    // price of the reroll: the game's own (never the Lock Capsule's price: the screen has its own odds), or none
    X.wrap(proto, 'getRerollCost', T, orig => function () {
      if (!tagOf(this)) return orig.apply(this, arguments);
      const def = defOf(this);
      return def && def.reroll ? orig.call(this, false) : -1;
    });
  });

  // ---- on screen: the title, and no shop row ----
  function label(s, str, color, size) {
    return new Phaser.GameObjects.Text(s, 0, 0, str, { fontFamily: 'emerald', fontSize: size, color, padding: { bottom: 6 } }).setScale(1 / 6).setShadow(3, 4, '#0b0910', 0, false, true);
  }
  function eraseTitle(h) {
    const t = h.__b1Title;
    h.__b1Title = null;
    if (t && t.scene) t.destroy();
  }
  function drawTitle(h, def) {
    const s = X.scene();
    eraseTitle(h);
    if (!window.Phaser || !h.modifierContainer) return;
    const c = new Phaser.GameObjects.Container(s, 160, -164); // the band the shop row normally uses; UI coordinates, y up from the bottom edge
    const title = label(s, '— ' + def.title + ' —', '#f8d038', 96).setOrigin(0.5, 0);
    const hint = def.hint ? label(s, def.hint, '#f8f8f8', 54).setOrigin(0.5, 0) : null;
    const w = Math.ceil(Math.max(title.displayWidth, hint ? hint.displayWidth : 0)) + 14, th = Math.ceil(title.displayHeight);
    const hgt = th + (hint ? Math.ceil(hint.displayHeight) : 0) + 3;
    const g = new Phaser.GameObjects.Graphics(s);
    g.fillStyle(0x1d1824, 0.88).fillRoundedRect(-w / 2, 0, w, hgt, 3);
    g.lineStyle(1, 0xf8d038, 0.9).strokeRoundedRect(-w / 2, 0, w, hgt, 3);
    title.setPosition(0, 1);
    c.add([g, title]);
    if (hint) { hint.setPosition(0, th); c.add(hint); }
    h.modifierContainer.add(c);
    h.__b1Title = c;
    c.setAlpha(0);
    s.tweens.add({ targets: c, alpha: 1, duration: 300 });
  }
  // six options are 40 px apart and a TM's full name is twice that: under the icon only the move's name
  // (the name box above the description still shows the full name of the option the cursor is on)
  function shortLabels(h) {
    if (!Array.isArray(h.options) || h.options.length < 5) return;
    for (const o of h.options) {
      const name = o && o.modifierTypeOption && o.modifierTypeOption.type && o.modifierTypeOption.type.name, i = typeof name === 'string' ? name.lastIndexOf(' - ') : -1;
      if (i > 0 && o.itemText && typeof o.itemText.setText === 'function') o.itemText.setText(name.slice(i + 3));
    }
  }
  const ballsClosed = h => (h.options || []).some(o => o && o.pb && o.pb.scene && o.pb.frame && !/_open$/.test(String(o.pb.frame.name)));
  function hookScreen(s) {
    const h = ((s.ui && s.ui.handlers) || []).find(x => x && x.constructor && x.constructor.name === 'ModifierSelectUiHandler');
    if (!h) return;
    X.wrap(h, 'show', T, orig => function (args) {
      const def = defOf(current());
      if (!this.active) this.__b1Hold = null; // a new screen: new balls to wait for (see processInput below)
      if (!def || this.active || !Array.isArray(args) || args.length !== 4) return orig.apply(this, arguments);
      // the handler asks the game mode once, right at the start of show(), whether there is a shop
      let back = null;
      X.guard('b1 no shop', () => {
        const gm = X.scene().gameMode, had = own(gm, 'getShopStatus'), prev = gm.getShopStatus;
        gm.getShopStatus = () => false;
        back = () => { if (had) gm.getShopStatus = prev; else delete gm.getShopStatus; };
      });
      this.__b1Hold = null;
      let r;
      try { r = orig.apply(this, arguments); } finally { if (back) X.guard('b1 shop back', back); }
      if (r) X.guard('b1 title', () => { drawTitle(this, def); shortLabels(this); });
      return r;
    });
    X.wrap(h, 'clear', T, orig => function () {
      X.guard('b1 title off', () => eraseTitle(this));
      return orig.apply(this, arguments);
    });
    // The game takes input a moment before the last ball has opened, and each option still has a timer that
    // opens its ball. Leaving the screen in that moment (a reroll, a pick, a skip) destroys the options under
    // those timers; the timer then throws inside the game loop and the game stands still (seen on the game's
    // own reward screen as well, with every mod off: notes/requests-b1.md). While a mod is on, 确认 and 取消 wait
    // on every reward screen (ours and the game's own) until every ball is open, at most 3 s after the first
    // press that came too early. With every mod off this wrap is not reached and the game is as it was.
    X.wrap(h, 'processInput', T, orig => function (button) {
      if ((button === 5 || button === 6) && this.awaitingActionInput && isReward(current())) {
        const early = X.guard('b1 balls', () => {
          if (!ballsClosed(this)) return false;
          if (this.__b1Hold == null) this.__b1Hold = Date.now();
          return Date.now() - this.__b1Hold < 3000;
        }, false);
        if (early) return false;
      }
      return orig.apply(this, arguments);
    });
  }

  X.onTick(s => { syncOffer(); if (!ids.length) return; hookManager(s); hookScreen(s); });

  // ---- for tests (CoopMods.debug.*) ----
  X.debug('b1Force', list => { dbg.force = new Set([].concat(list || [])); return [...dbg.force]; }); // these screens come with the next reward, whatever when() says
  X.debug('b1Wave', n => { dbg.wave = n == null ? null : Number(n); return dbg.wave; }); // the wave number the mods are told (null: the real one)
  X.debug('b1NewBattle', () => { started = new WeakMap(); return true; }); // forget which screens this battle has had
  X.debug('b1Rewards', spec => gameRewards(spec).map(o => [o.type.id, o.type.tier, o.type.name]));
  X.debug('b1Offer', v => { if (v != null) X.cfg.normalOffer = !!v; return X.cfg.normalOffer; }); // (the next tick puts it back)
  // what a screen's options(ctx) gives, without opening anything: [[key or game id, tier, name], ...]
  X.debug('b1Options', (id, wave, n, rr, round) => {
    const def = screens[id], s = X.scene();
    if (!def) return null;
    const w = wave == null ? waveNow() : wave, r = round === 2 ? 2 : 1;
    const ctx = { wave: w, count: n || def.count, round: r, reroll: rr || 0, picker: 'p1', random: X.rng([s.seed, w, 'b1', id, r, rr || 0].join(':')) };
    return toOptions(def.options(ctx), ctx.count).map(o => [o.type.__coopMod || o.type.id, o.type.tier, o.type.name]);
  });
  X.debug('b1State', () => {
    const s = X.scene(), pm = s.phaseManager, ph = pm.getCurrentPhase(), h = s.ui.getHandler(), c = coopOf(ph), b = s.currentBattle;
    const queued = []; try { for (const lv of pm.phaseQueue.levels) for (const p of lv) if (isReward(p)) queued.push(p[TAG] ? p[TAG].id + (p[TAG].copy ? '(copy)' : '') : 'normal'); } catch {}
    return {
      screens: ids.slice(), normalOffer: X.cfg.normalOffer, wave: waveNow(), queued, started: b && started.get(b) ? [...started.get(b)] : [],
      phase: ph && ph.phaseName, tag: tagOf(ph) ? { id: ph[TAG].id, rr: ph[TAG].rr, n: ph[TAG].n, copy: !!ph[TAG].copy } : null,
      coop: c ? { round: c.round, picker: c.picker, set: !!c.set } : null,
      options: isReward(ph) && Array.isArray(ph.typeOptions) ? ph.typeOptions.map(o => [o.type.__coopMod || o.type.id, o.type.tier, o.type.name]) : null,
      cost: isReward(ph) && Array.isArray(ph.typeOptions) ? ph.getRerollCost(false) : null,
      ui: h && h.constructor.name === 'ModifierSelectUiHandler' ? { options: h.options.length, shop: h.shopOptionsRows.map(r => r.length), rerollCost: h.rerollCost, title: !!(h.__b1Title && h.__b1Title.scene), row: h.rowCursor, cursor: h.cursor } : null,
    };
  });
});

// ======== engine extension: b2 (engine/ext-b2.js) ========
// Engine extension of team b2: what the five team-bag items of better-coop-items v0.9 need from the game.
//   肉鸽骰子 rogue-dice #17        SelectModifierPhase.getRerollCost / rerollModifiers + the price label of the reward screen
//   银色之羽 silver-wing #23       SelectModifierPhase.getModifierCount
//   虹色之羽 rainbow-wing #24      the party's luck: SelectModifierPhase.getModifierTypeOptions, scene.updateAndShowText, Arena.randomSpecies
//   小小花束 tiny-bouquet #13      one more hidden roll of the reward screen that only a mint comes out of
//   捕捉口袋 catching-pocket #19   AttemptCapturePhase.start / failCatch
// The numbers (3 free rerolls, +1 option, +3 luck, x1.1, 30%) are the mod's (mod/items/b2.js); this file only
// turns the game into six events a mod can answer: rewardCount, rerollCost, rerolled, teamLuck, mintRate,
// ballThrown (described for mod authors in notes/requests-b2.md, to be taken into docs/MOD-API.md).
// Every hook passes through when nobody listens to its event, and an error in our part falls back to what
// the game (or the extension before us) answered.
CoopModsExt('b2', X => {
  const B = X.battle;
  const EVENTS = ['rewardCount', 'rerollCost', 'rerolled', 'teamLuck', 'mintRate', 'ballThrown'];
  EVENTS.forEach(n => X.addEvent(n));

  const scene = () => X.scene();
  const st = { // counters for tests (CoopMods.debug.b2())
    wraps: {}, count: 0, quotes: 0, rerolls: 0, free: 0, luckCalls: 0, luckSpecies: 0, shadows: 0, mintsFound: 0, mintsPut: 0, throws: 0, kept: 0, last: {},
  };
  const dbg = { mintRate: null }; // test override: a mint multiplier, whatever the mods say
  // every listener's answer to an event (X.emit only gives the last one); a listener's error is logged, not passed on
  function answers(name, ev) {
    const out = [];
    if (!X.has(name)) return out;
    for (const [m, fn] of X.listeners(name)) {
      const r = X.guard('b2 ' + name + ' (' + ((m && m.id) || '?') + ')', () => fn(ev));
      if (r !== undefined && r !== null) out.push(r);
    }
    return out;
  }
  // what a mod is told about the reward screen it is asked about
  function info(ph) {
    const c = ph && typeof ph.__coop === 'object' && ph.__coop ? ph.__coop : null; // host-team.js's tag (true on the prototype: not a tag)
    return { wave: B.wave(), round: c ? c.round || 0 : 0, picker: c ? c.picker || null : null, rerolls: (ph && ph.rerollCount) || 0, normal: !!ph && !ph.customModifierSettings };
  }
  const isDaily = () => { const s = scene(); return !!(s && s.gameMode && s.gameMode.isDaily); };

  // ---------------------------------------------------------------------------------------------------------
  // rerollCost / rerolled: the price of 刷新商店
  // A reroll that a mod made free does not count when the game doubles the price (2 ** rerollCount): after
  // three free ones the first paid reroll costs what the first reroll of the screen costs. The phase's own
  // rerollCount is never changed for anybody else (the seed rule, host-team.js's tag and the Voucher weight
  // read it); only the price calculation sees the smaller number, for the length of that one call.
  // A chain = one screen and its rerolls: it starts with rerollCount 0 and every reroll makes a phase with one
  // more. `chain` remembers the free rerolls of the chain on screen; a phase that is not the next link of it
  // (another wave, another round, a count that does not follow) gets the game's plain price.
  const chain = { wave: -1, round: -1, rc: 0, free: 0 };
  const roundOf = ph => info(ph).round;
  const freeIn = ph => (chain.free > 0 && ph.rerollCount > 0 && ph.rerollCount === chain.rc && chain.wave === B.wave() && chain.round === roundOf(ph) ? Math.min(chain.free, ph.rerollCount) : 0);
  const quotes = new WeakMap(); // phase -> the last { price, cost, label } we answered for it
  function gamePrice(ph, orig, args) {
    const rc = ph.rerollCount, u = freeIn(ph);
    if (!u) return orig.apply(ph, args);
    ph.rerollCount = rc - u;
    try { return orig.apply(ph, args); } finally { ph.rerollCount = rc; }
  }
  function quote(ph, price, lock) {
    const q = { price, cost: price, label: null };
    if (!(price > 0)) return q; // -1: no reroll on this screen; 0: free already
    const ev = { cost: price, price, lock: !!lock, ...info(ph) };
    for (const r of answers('rerollCost', ev)) {
      const c = typeof r === 'number' ? r : r && typeof r === 'object' ? r.cost : NaN;
      if (!Number.isFinite(c)) continue;
      q.cost = ev.cost = Math.max(0, Math.min(Math.floor(c), q.cost)); // a mod can make it cheaper, never dearer
      if (r && typeof r === 'object' && r.label != null) q.label = String(r.label);
    }
    if (q.cost === q.price) q.label = null;
    return q;
  }
  X.phaseClass('SelectModifierPhase', proto => {
    st.wraps.getRerollCost = X.wrap(proto, 'getRerollCost', 'b2', orig => function (lock) {
      const self = this, args = arguments;
      if (!X.has('rerollCost') && !freeIn(self)) return orig.apply(self, args);
      let price, got = false;
      const q = X.guard('b2 getRerollCost', () => { price = gamePrice(self, orig, args); got = true; return quote(self, price, lock); }, null);
      if (!q) return got ? price : orig.apply(self, args);
      st.quotes++; st.last.quote = q;
      quotes.set(self, q);
      return q.cost;
    });
    st.wraps.rerollModifiers = X.wrap(proto, 'rerollModifiers', 'b2', orig => function () {
      const self = this;
      let q = null;
      X.guard('b2 reroll (before)', () => {
        if (!X.has('rerollCost') && !X.has('rerolled') && !freeIn(self)) return;
        quotes.delete(self);
        self.getRerollCost(scene().lockModifierTiers); // the same question the game asks next: leaves our quote
        q = quotes.get(self) || null;
      });
      const ok = orig.apply(self, arguments); // true only when the reroll really happened (enough money, allowed)
      if (ok) X.guard('b2 reroll (after)', () => {
        const free = !!q && q.price > 0 && q.cost === 0;
        const before = freeIn(self); // free rerolls so far in this chain (0 for the first reroll of a screen)
        chain.wave = B.wave(); chain.round = roundOf(self); chain.rc = (self.rerollCount || 0) + 1; chain.free = before + (free ? 1 : 0);
        st.rerolls++; if (free) st.free++;
        if (q) X.emit('rerolled', { cost: q.cost, price: q.price, free, ...info(self) });
      });
      return ok;
    });
  });
  // the label under 刷新商店: the game writes ₽<cost>; a mod that made the reroll cheaper may give its own words
  let labelDone = false;
  function hookLabel(s) {
    if (labelDone || !s.ui || !Array.isArray(s.ui.handlers)) return;
    const h = s.ui.handlers.find(x => x && x.constructor && x.constructor.name === 'ModifierSelectUiHandler');
    const proto = h && X.protoWith(h, 'updateRerollCostText');
    if (!proto) return;
    labelDone = true;
    st.wraps.updateRerollCostText = X.after(proto, 'updateRerollCostText', 'b2', self => {
      if (!X.has('rerollCost')) return;
      const ph = scene().phaseManager.getCurrentPhase(), q = ph && quotes.get(ph);
      if (!q || !q.label || self.rerollCost !== q.cost || !self.rerollCostText) return;
      self.rerollCostText.setText(q.label);
      st.last.label = q.label;
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // rewardCount: how many options the normal reward after a battle shows. Not asked for a set list (a
  // phase with customModifierSettings: boss and rival rewards, mystery encounters, the second player's round,
  // the screens other extensions build), where the list is fixed anyway.
  X.phaseClass('SelectModifierPhase', proto => {
    st.wraps.getModifierCount = X.after(proto, 'getModifierCount', 'b2', (self, args, n) => {
      if (self.customModifierSettings || !X.has('rewardCount') || !(n > 0)) return;
      let count = n;
      const ev = { count: n, ...info(self) };
      for (const r of answers('rewardCount', ev)) if (Number.isFinite(r)) count = ev.count = Math.max(1, Math.min(Math.floor(r), 12));
      st.count++; st.last.count = [n, count];
      if (count !== n) return { value: count };
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  // teamLuck: points added to the party's luck (the game's 0..14 scale, D..SSS) wherever the game uses it:
  // rarity upgrades of reward options, the letter on the reward screen, the rarity of wild Pokémon.
  // The game's function (getPartyLuckValue) cannot be reached; it adds up getLuck() of every party member that
  // may battle and clamps the sum to 0..14. So for the length of one call one such member answers getLuck()
  // with the bonus on top (an own property on that one object, deleted again in `finally`). Nothing is
  // written to any Pokémon's luck field. A daily run takes its luck from the day's seed: left alone.
  function luckBonus() {
    if (!X.has('teamLuck') || isDaily()) return 0;
    let n = 0;
    for (const r of answers('teamLuck', { wave: B.wave() })) if (Number.isFinite(r)) n += r;
    return Math.max(0, Math.min(Math.floor(n), 14));
  }
  let luckDepth = 0;
  function withLuck(fn) {
    let p = null, bonus = 0;
    X.guard('b2 luck', () => {
      if (luckDepth) return;
      bonus = luckBonus();
      if (!(bonus > 0)) return;
      p = scene().getPlayerParty().find(q => q && typeof q.getLuck === 'function' && q.isAllowedInBattle() && !Object.prototype.hasOwnProperty.call(q, 'getLuck')) || null;
    });
    if (!p || !(bonus > 0)) return fn();
    const own = p.getLuck; // the class's method
    luckDepth++; st.luckCalls++; st.last.luck = bonus;
    p.getLuck = function () { return own.apply(this, arguments) + bonus; };
    try { return fn(); } finally { delete p.getLuck; luckDepth--; }
  }
  // the party's luck as the game adds it up (without what a timed event adds), and the same with the mods' points
  const LUCK = ['D', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+', 'A++', 'S', 'S+', 'SS', 'SS+', 'SSS'];
  function partyLuck() {
    let n = 0;
    for (const p of scene().getPlayerParty()) if (p && p.isAllowedInBattle()) n += p.getLuck();
    return Math.max(0, Math.min(n, 14));
  }
  X.extendBattle({
    // the team's luck right now, mods' points included: { value: 0..14, letter: 'D'..'SSS', bonus }
    teamLuck: () => X.guard('b2 teamLuck', () => {
      const bonus = luckBonus(), value = Math.min(14, partyLuck() + bonus);
      return { value, letter: LUCK[value], bonus };
    }, { value: 0, letter: 'D', bonus: 0 }),
  });

  // SelectModifierPhase.getModifierTypeOptions: wrapped once for the luck and for the mints (addMint, below).
  // Our wrap sits outside host-team.js's (its lure swap rolls the game's list again, with our luck) and inside
  // the core's (its offer of mod items sees our list).
  X.phaseClass('SelectModifierPhase', proto => {
    st.wraps.getModifierTypeOptions = X.wrap(proto, 'getModifierTypeOptions', 'b2', orig => function () {
      const self = this, args = arguments;
      return withLuck(() => {
        const opts = orig.apply(self, args);
        X.guard('b2 mint', () => addMint(self, opts, () => orig.apply(self, args)));
        return opts;
      });
    });
  });
  let sceneDone = null, arenaDone = null;
  function hookLuck(s) {
    if (sceneDone !== s && typeof s.updateAndShowText === 'function') { // the letter on the reward screen
      sceneDone = s;
      st.wraps.updateAndShowText = X.wrap(s, 'updateAndShowText', 'b2', orig => function () { const self = this, args = arguments; return withLuck(() => orig.apply(self, args)); });
    }
    const proto = s.arena && X.protoWith(s.arena, 'randomSpecies');
    if (proto && proto !== arenaDone) {
      arenaDone = proto;
      // randomSpecies(waveIndex, level, attempt = 0, luckValue = 0, isBoss): the callers hand the party's luck in.
      // It calls itself again with attempt + 1 and the same luck when it rolls again: only the first call adds.
      st.wraps.randomSpecies = X.before(proto, 'randomSpecies', 'b2', (self, args) => {
        if (args.length < 4 || args[2]) return; // no luck passed (幻觉 picks a species this way), or a retry
        const bonus = luckBonus();
        if (!(bonus > 0)) return;
        const next = args.slice();
        next[3] = Math.min(14, (Number(args[3]) || 0) + bonus);
        st.luckSpecies++; st.last.species = [args[3], next[3]];
        return { args: next };
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // mintRate: how many times as often a mint (薄荷) comes up among the reward options.
  // The game's pools and weights cannot be reached. Instead: when the screen the game rolled has no mint, the
  // same screen is rolled once more out of sight (on a seed of its own; the game's random sequence is put back
  // afterwards), and a mint found there is let through with chance (rate - 1). It takes the place of the
  // cheapest option of the real screen that is not above a mint's rarity (高级). The hidden roll is the game's
  // own roll, so it finds a mint exactly as often as the real one: a screen has a mint `rate` times as often
  // (less the rare case that both rolls had one). Only the normal reward and its rerolls; never a set list or
  // a copy of a screen. The game never puts two mints on one screen, and neither do we.
  const isMint = o => !!(o && o.type && (o.type.id === 'MINT' || (o.type.constructor && o.type.constructor.name === 'PokemonNatureChangeModifierType')));
  function mintRate(ph) {
    if (dbg.mintRate != null) return dbg.mintRate;
    let rate = 1;
    for (const r of answers('mintRate', info(ph))) if (Number.isFinite(r) && r > 0) rate *= r;
    return rate;
  }
  function addMint(ph, opts, rollAgain) {
    if (ph.customModifierSettings || ph.isCopy || !Array.isArray(opts) || !opts.length) return;
    if (dbg.mintRate == null && !X.has('mintRate')) return;
    if (opts.some(isMint)) return;
    const extra = Math.min(mintRate(ph) - 1, 50);
    if (!(extra > 0)) return;
    const s = scene(), wave = B.wave(), rc = ph.rerollCount || 0;
    const lock = !!(s.lockModifierTiers && ph.modifierTiers && ph.modifierTiers.length);
    const tierOf = o => (o && o.type ? o.type.tier || 0 : 99);
    // the slot a mint may take: an option of 高级 or below (never a rarer one, never a mod item); with 锁定稀有度
    // on only a 高级 one, because the rarities on screen are what the next reroll keeps and what it costs
    let at = -1;
    opts.forEach((o, i) => {
      if (!o || !o.type || o.type.__coopMod) return;
      const t = tierOf(o);
      if ((lock ? t === 2 : t <= 2) && (at < 0 || t < tierOf(opts[at]))) at = i;
    });
    if (at < 0) return;
    const k = Math.ceil(extra), chance = extra / k; // k hidden screens, each lets its mint through with extra / k
    const roll = X.rng([s.seed, wave, rc, 'b2-mint'].join(':'));
    let mint = null;
    for (let j = 0; j < k && !mint; j++) {
      const r = roll();
      let found = null;
      s.executeWithSeedOffset(() => { // an error inside would leave the game's random state changed: caught here
        try { found = (rollAgain() || []).find(isMint) || null; } catch (e) { X.log('b2 mint: hidden roll failed: ' + String(e).slice(0, 200)); }
      }, 7919 * (wave + 1) + 131 * rc + j);
      st.shadows++;
      if (!found) continue;
      st.mintsFound++;
      if (r < chance) mint = found;
    }
    if (!mint) return;
    const was = opts[at];
    opts[at] = mint;
    st.mintsPut++; st.last.mint = { wave, rc, at, was: was.type && was.type.id, mint: mint.type.name };
    X.log('b2 mint: ' + mint.type.name + ' takes slot ' + at + ' (wave ' + wave + ', reroll ' + rc + ')');
  }

  // ---------------------------------------------------------------------------------------------------------
  // ballThrown: a Poké Ball was thrown (AttemptCapturePhase.start took it out of the pouch). A listener that
  // returns true keeps the ball: it is put back inside the same call. A throw at a Pokémon that is already
  // gone takes no ball and is not reported.
  // Whose pouch: host-team.js gives each player their own balls and shows the game one pouch (a view that
  // goes by the current phase). At this moment its idea of the thrower (CoopTeam.catcher(), filled by a
  // 150 ms poll) is usually still empty or the thrower of an earlier turn, so the ball may have come out of
  // the other player's pouch (seen on the rig: 2P throws, 1P's count drops). We do not judge that: the ball
  // goes back into the very pouch it was taken from. For that write the phase manager answers
  // "a CommandPhase of that player's Pokémon" to host-team.js's question (its rule: a Pokémon choosing its
  // command is its owner's business); afterwards the pouches are compared with how they were before the throw.
  const Team = () => window.CoopTeam || null;
  const pouches = () => { const T = Team(); return T && typeof T.purse === 'function' ? T.purse().balls : null; };
  function thrower() { // the player whose Pokémon has this turn's BALL command (the other slot carries a skipped copy)
    const s = scene(), b = s.currentBattle, party = s.getPlayerParty(), T = Team();
    if (!b || !b.turnCommands || !T) return null;
    for (const slot of [0, 1]) { const c = b.turnCommands[slot]; if (c && c.command === 1 /* Command.BALL */ && !c.skip) return T.ownerOf(party[slot]) || null; }
    return null;
  }
  function asPlayer(who, fn) { // run fn while host-team.js sees `who` as the one acting
    const s = scene(), pm = s.phaseManager, T = Team();
    const i = s.getPlayerParty().findIndex(p => T.ownerOf(p) === who);
    if (i < 0) return false;
    const own = Object.prototype.hasOwnProperty.call(pm, 'getCurrentPhase'), was = pm.getCurrentPhase;
    pm.getCurrentPhase = () => ({ phaseName: 'CommandPhase', fieldIndex: i });
    try { if (T.actor() !== who) return false; fn(); return true; } finally { if (own) pm.getCurrentPhase = was; else delete pm.getCurrentPhase; }
  }
  function putBack(t, before, p0) {
    const s = scene(), p1 = pouches();
    const n = (box, who) => (box && box[who] && Number(box[who][t])) || 0;
    const lost = p0 && p1 ? ['p1', 'p2'].filter(w => n(p1, w) === n(p0, w) - 1) : [];
    let how = 'view';
    if (lost.length === 1 && n(p0, 'p1') + n(p0, 'p2') === n(p1, 'p1') + n(p1, 'p2') + 1 && asPlayer(lost[0], () => { s.pokeballCounts[t] = s.pokeballCounts[t] + 1; })) how = lost[0];
    else s.pokeballCounts[t] = before; // no split pouches to look at: the game's own pouch, as it was
    const p2 = pouches(), same = !p0 || !p2 || (n(p0, 'p1') === n(p2, 'p1') && n(p0, 'p2') === n(p2, 'p2'));
    if (!same) X.log('b2 ball: the ball is back, but not in the pouch it came from: ' + JSON.stringify([p0, p1, p2].map(x => [n(x, 'p1'), n(x, 'p2')])));
    return { how, same };
  }
  X.phaseClass('AttemptCapturePhase', proto => {
    st.wraps.captureStart = X.wrap(proto, 'start', 'b2', orig => function () {
      const self = this, s = scene(), t = self.pokeballType;
      let before = null, p0 = null;
      if (X.has('ballThrown')) X.guard('b2 ball (before)', () => { p0 = pouches(); before = s.pokeballCounts[t]; });
      const r = orig.apply(self, arguments);
      if (before != null) X.guard('b2 ball (after)', () => {
        const after = s.pokeballCounts[t];
        if (after !== before - 1) return; // no ball was taken (the target is gone), or somebody else changed the count
        const owner = thrower();
        st.throws++;
        const keep = answers('ballThrown', { ball: t, owner, wave: B.wave() }).some(x => x === true);
        st.last.ball = { ball: t, owner, catcher: (Team() && Team().catcher && Team().catcher()) || null, before, after, keep };
        if (!keep) return;
        const back = putBack(t, before, p0);
        self.__b2Kept = true;
        st.kept++; st.last.ball.back = back;
        X.log('b2 ball: kept (kind ' + t + ', thrown by ' + owner + ', back to ' + back.how + ')');
      });
      return r;
    });
    // 捡球 (Ball Fetch) hands the last ball of a failed throw back at the end of the turn: not a second time
    // when the ball was never used up
    st.wraps.failCatch = X.after(proto, 'failCatch', 'b2', self => {
      if (!self.__b2Kept) return;
      const b = scene().currentBattle;
      if (b && b.lastUsedPokeball === self.pokeballType) { b.lastUsedPokeball = null; st.last.fetchCleared = true; }
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  // A mod switched on or off while a reward screen is open: the price under 刷新商店 and the luck letter were
  // written when the screen opened, and would go on showing 免费×N (or the old ₽ price, or the old letter)
  // although the next press costs something else. Ask the game again and write both anew. Done at the switch
  // itself (switching the last mod off stops the ticks) and on the next ticks (switching the first mod on puts
  // the hooks in at the next tick only). Nothing is rolled again: the options on screen stay as they are.
  let stale = 0;
  function refreshShown(s) {
    const pm = s && s.phaseManager, ph = pm && pm.getCurrentPhase(), h = s && s.ui && typeof s.ui.getHandler === 'function' ? s.ui.getHandler() : null;
    if (!ph || ph.phaseName !== 'SelectModifierPhase' || !Array.isArray(ph.typeOptions)) return false;
    if (!h || !h.constructor || h.constructor.name !== 'ModifierSelectUiHandler' || !h.active) return false; // a party menu or a question is on top: the game writes the price again when it comes back
    if (typeof h.setRerollCost !== 'function' || typeof h.updateRerollCostText !== 'function') return false;
    h.setRerollCost(ph.getRerollCost(s.lockModifierTiers));
    h.updateRerollCostText();
    if (s.luckText && s.luckText.visible && typeof s.updateAndShowText === 'function') s.updateAndShowText(0);
    st.refreshed = (st.refreshed || 0) + 1;
    return true;
  }
  X.onSwitch(() => { stale = 3; X.guard('b2 refresh (switch)', () => refreshShown(scene())); });

  X.onTick(s => { hookLabel(s); hookLuck(s); if (stale > 0) { stale--; X.guard('b2 refresh (tick)', () => refreshShown(s)); } });

  // ---- tests (rigs/b2): CoopMods.debug.b2(), .b2Set({ mintRate }) ----
  X.debug('b2', () => JSON.parse(JSON.stringify({ ...st, freeUsed: chain.free, chain, dbg, luck: X.guard('b2 dbg', () => B.teamLuck(), null) })));
  X.debug('b2Set', o => { Object.assign(dbg, o || {}); return { ...dbg }; });
  X.debug('b2IsMint', isMint);
});

// ======== engine extension: c (engine/ext-c.js) ========
// Engine extension of team c (气势纽带 #4, 讲究望远镜 #5, 共生孢子 #6, 粉色香草 #7, 褪色魂心 #9, 队友保险 #10,
// 楔石 #12, 双人自行车 #28, 战斗节拍器 #29). Most of what these items need is in the core already (damageCalc,
// beforeDamage, moveSelect, statChange, moveUsed, the 集火 verdict). This file adds the three things it lacks
// (run on rig c: evidence/c.md):
//
//   event  fatalHit   a move hit has just taken a player's Pokémon to 0 HP and nothing of the game's own
//                     (忍耐, 结实, 气势头带) kept it standing. A listener that returns true keeps it at 1 HP.
//   event  fainted    a Pokémon has really fainted (after 复活种子 had its chance; the core's `faint` fires before)
//   B.knowsMove(p, moveId)   is the move in the Pokémon's moveset right now
//
// For mod authors (简体中文, to go into docs/MOD-API.md):
//
//   事件 `fatalHit`：我方一只宝可梦被招式打到 HP 归零的那一下（忍耐、结实、气势头带这些游戏自带的保命效果都没救下它之后）。
//     收到 `target`（被打的）`attacker`（出招的）`damage`（这一下本来要扣的量）`hp`（挨打前的 HP）
//     `rest`（留 1 点 HP 之后多出来的伤害 = damage − (hp − 1)）`then(fn)`（这一击对每个目标都结算完之后再做的事；
//     想再扣谁的血、发消息都放在这里面，不要在处理函数里直接做）。
//     返回 `true` = 让它留下 1 点 HP、不倒下；第一个返回 `true` 的处理函数说了算，后面的不再问。
//     只有招式直接打的才会来：中毒、天气、反伤、mod 自己用 `B.damage` 扣的血都不算。
//   事件 `fainted`：一只宝可梦真的倒下了（带着复活种子被救起来的不算；`faint` 事件在那之前就会来）。收到 `pokemon`。
//   `B.knowsMove(p, moveId)`：这只宝可梦现在会不会这个招式。
CoopModsExt('c', X => {
  const seen = { fatal: 0, kept: 0, fainted: 0, faintedLate: 0, lateThen: 0 }; // counters for the rig (CoopMods.debug.c())
  X.addEvent('fatalHit');
  X.addEvent('fainted');

  // ---- B.knowsMove ----
  X.extendBattle({
    knowsMove: (p, moveId) => X.guard('c knowsMove', () => p.getMoveset().some(m => m && m.moveId === moveId), false),
  });

  // ---- fainted ----
  // FaintPhase.doFaint is where the game itself reacts to a faint (魂心, 自信过度): it runs once per real faint,
  // not when 复活种子 revives and not when the phase finds the Pokémon standing again.
  // The event is sent from inside doFaint, at its pokemon.resetTera() call: after the game has queued
  // "X 倒下了！" and before it queues what follows a faint. That is where the game's own 魂心 raises its stat,
  // and it matters: when the last teammate standing is moved to the middle (ToggleDoublePositionPhase, queued
  // at the end of doFaint) its battler index changes, and a stat phase queued after that would find nobody.
  // Should resetTera ever not be called there, the event is sent when doFaint returns.
  let faintCtx = null; // the doFaint that is running: { pokemon, told }
  const tellFainted = () => {
    const c = faintCtx;
    if (!c || c.told) return;
    c.told = true;
    if (!X.has('fainted')) return;
    seen.fainted++;
    X.emit('fainted', { pokemon: c.pokemon });
  };
  X.phaseClass('FaintPhase', proto => {
    X.wrap(proto, 'doFaint', 'c', orig => function () {
      const outer = faintCtx;
      faintCtx = X.guard('c doFaint', () => { const p = this.getPokemon(); return p ? { pokemon: p, told: false } : null; }, null);
      try { return orig.apply(this, arguments); } finally {
        if (faintCtx && !faintCtx.told) { seen.faintedLate++; X.guard('c fainted (late)', tellFainted); }
        faintCtx = outer;
      }
    });
  });
  X.pokemonClass(proto => {
    X.before(proto, 'resetTera', 'c', self => { if (faintCtx && faintCtx.pokemon === self) tellFainted(); });
  });

  // ---- fatalHit ----
  // A move hit is Pokemon.damageAndUpdate(dmg, { source: attacker, ignoreFaintPhase: true }) -> Pokemon.damage(),
  // which lets 忍耐 / 结实 / 气势头带 answer first and then takes the HP. With ignoreFaintPhase nothing else has
  // happened at that point (the FaintPhase is queued later by the move, only if the target is still at 0 HP),
  // so putting the HP back to 1 there is all it takes to keep the Pokémon standing.
  // What a listener hands to ev.then() runs when the strike is over for ALL its targets (MoveEffectPhase.end),
  // not right after this target's hit. Reason (seen on rig c, evidence/c.md "Check"): 气势纽带 hands the rest of
  // the hit to the holder there; done in the middle of an enemy's spread move it knocked the holder out while
  // the holder was still a target to come, the game then queued its own FaintPhase for that target as well,
  // and the holder fainted twice ("倒下了" twice, every faint reaction twice, two switch prompts).
  let hit = null; // the move hit being carried out on a player's Pokémon right now: { target, source, done, after }
  let pending = [], strikeEnd = false; // then-callbacks waiting for the end of the strike / is MoveEffectPhase.end hooked
  const flush = () => { const list = pending; pending = []; for (const run of list) run(); };
  X.phaseClass('MoveEffectPhase', proto => { strikeEnd = X.before(proto, 'end', 'c', () => { if (pending.length) flush(); }) === true; });
  X.onTick(() => { if (pending.length && X.phaseNow() !== 'MoveEffectPhase') { seen.lateThen++; flush(); } }); // should the phase ever end another way
  X.onSwitch(() => { pending = []; }); // (a mod switched off or on: nothing is carried over)
  X.pokemonClass(proto => {
    X.wrap(proto, 'damageAndUpdate', 'c', orig => function (dmg, opts) {
      const mine = X.guard('c hit start', () => !!(opts && opts.source && dmg > 0 && this.isPlayer() && !this.switchOutStatus && X.has('fatalHit')), false);
      if (!mine) return orig.apply(this, arguments);
      const outer = hit, ctx = hit = { target: this, source: opts.source, done: false, after: null };
      let r;
      try { r = orig.apply(this, arguments); } finally { hit = outer; }
      if (ctx.after) {
        const fns = ctx.after, run = () => { for (const fn of fns) X.guard('c after fatalHit', () => fn(r)); };
        if (strikeEnd && X.phaseNow() === 'MoveEffectPhase') pending.push(run); else run(); // (not inside a strike: a direct call)
      }
      return r;
    });
    // (EnemyPokemon overrides damage and calls this one through super: the context is only ever a player's Pokémon)
    X.wrap(proto, 'damage', 'c', orig => function (dmg, ignoreSegments, preventEndure, ignoreFaintPhase) {
      const ctx = hit;
      if (!ctx || ctx.target !== this || ctx.done) return orig.apply(this, arguments);
      const hp0 = this.hp;
      const r = orig.apply(this, arguments);
      return X.guard('c fatalHit', () => {
        if (!(hp0 > 0 && this.hp <= 0 && ignoreFaintPhase === true && !preventEndure && r > 0)) return r;
        ctx.done = true;
        seen.fatal++;
        const ev = { target: this, attacker: ctx.source, damage: dmg, hp: hp0, rest: Math.max(1, Math.floor(dmg) - (hp0 - 1)), then: fn => { if (typeof fn === 'function') (ctx.after = ctx.after || []).push(fn); } };
        let keep = false;
        for (const [m, fn] of X.listeners('fatalHit')) {
          if (X.guard('mod ' + m.id + ' fatalHit', () => fn(ev) === true, false)) { keep = true; break; }
        }
        if (!keep) return r;
        seen.kept++;
        this.hp = 1;
        return r - 1;
      }, r);
    });
  });

  X.debug('c', () => ({ ...seen }));
});

// ======== engine extension: d (engine/ext-d.js) ========
// Engine extension d: HP going up and down, for 生命红绳 #15, 友谊宝珠 #16, 回复口袋 #14, 吃不完的拉面 #22.
// What it gives the mods (described for mod authors at the end of this comment, 简体中文):
//   events   healDone      a heal phase is finished (HP moved, its message queued): the place to answer a heal
//            hpLost        a Pokémon really lost HP (move hits, weather, recoil, poison, burn, Pain Split ...)
//            medicineUsed  an HP medicine was used from the reward screen or the shop
//   battle   B.canHeal(p)             can an in-battle heal restore anything for p right now
//            B.healExact(p, n, opts)  like B.heal, but exactly n HP (回复护符 does not multiply it)
//            B.restoreHp(p, n)        HP for a Pokémon outside battle (the bench), no animation
// Hooks (all wrap and pass through; with no mod on the game's own methods are called directly):
//   PokemonHealPhase.doHealPokemon / heal / getHealAmount   (tag 'd')
//   Pokemon.damage / Pokemon.damageAndUpdate                (tag 'd')
//   BattleScene.addModifier                                 (tag 'd')
// Nothing here knows an item: the items are in mod/items/d.js.
//
// ---- 给 mod 作者（接口版本 2 的补充，team d）----
// 事件
//   healDone      一次战斗中的回复做完之后（HP 已经加上，它自己的提示也排好了）。和 `heal` 的区别：`heal` 在
//                 HP 刚加上的那一瞬间来，这时再排一次回复会抢在原来那句提示前面；想「跟着回复再做点什么」用这个。
//                 只管游戏的回复阶段（招式、特性、树果、吃剩的东西、贝壳之铃、B.heal、B.healExact），
//                 分担痛楚、再生力这类直接改 HP 的不算。
//                 收到：pokemon、amount（实际回复的量，一定大于 0）、tag（B.heal / B.healExact 写的 tag，否则 null）、
//                 revive（是复活种子那样的复活）。
//   hpLost        一只宝可梦的 HP 真的减少之后（招式、天气、反伤、中毒、灼伤、分担痛楚都算）。
//                 收到：pokemon、amount（实际减少的量）、fainted（这一下倒下了）。
//   medicineUsed  在战斗外（奖励界面、商店）用了一件回复 HP 的药（伤药、好伤药、厉害伤药、全满药、全复药、
//                 活力碎片、活力块、圣灰）并且真的生效之后。
//                 收到：targets（药用在了哪些宝可梦身上；圣灰是被它救起来的那些）、revive（是复活类的药）、
//                 item（药的名字）、effectOn(p)（这件药用在 p 身上按游戏的算法能回复多少 HP，不看 p 现在缺多少）、
//                 screen（第几个奖励界面；在同一个界面上连用几件药，这个数不变）。
// 战场 api.battle
//   canHeal(p)             p 在场上、没倒下、HP 没满、没被「回复封锁」：现在给它回复有用吗
//   healExact(p, n, opts)  和 heal 一样排一次回复，但正好回复 n 点（回复护符不加成）。opts 同 heal：message、tag、quiet。
//                          回复不了（见 canHeal）或 n 不大于 0 时返回 false
//   restoreHp(p, n)        给不在战斗中的宝可梦（比如没上场的）直接加 HP，没有动画；倒下的不加。返回实际加了多少
CoopModsExt('d', X => {
  const B = X.battle;
  X.addEvent('healDone');
  X.addEvent('hpLost');
  X.addEvent('medicineUsed');

  const standing = p => !!(p && B.onField(p));
  const healBlocked = p => X.guard('d heal block', () => !!(p.getTag && p.getTag('HEAL_BLOCK')), false);
  // the team's 回复护符 multiplier (1 when there are none), read the way the game does
  const charm = () => X.guard('d charm', () => {
    const h = { value: 1 };
    (X.scene().modifiers || []).filter(m => m && m.constructor && m.constructor.name === 'HealingBoosterModifier').forEach(m => m.apply(h));
    return h.value > 0 && isFinite(h.value) ? h.value : 1;
  }, 1);

  X.extendBattle({
    canHeal: p => X.guard('d canHeal', () => standing(p) && !p.isFullHp() && !healBlocked(p), false),
    healExact(p, amount, opts) {
      return X.guard('d healExact', () => {
        const o = opts || {};
        amount = Math.floor(Number(amount) || 0);
        if (!(amount > 0) || !B.canHeal(p)) return false;
        const pm = X.scene().phaseManager;
        const ph = pm.create('PokemonHealPhase', p.getBattlerIndex(), amount, { message: o.message ? String(o.message) : undefined, showFullHpMessage: false, skipAnim: !!o.quiet });
        ph.__coopModHeal = { tag: o.tag == null ? null : String(o.tag) }; // the core's `heal` event reads the tag from here
        ph.__dExact = true;
        pm.unshiftPhase(ph);
        return true;
      }, false);
    },
    restoreHp(p, amount) {
      return X.guard('d restoreHp', () => {
        amount = Math.floor(Number(amount) || 0);
        if (!p || !(amount > 0) || p.isFainted()) return 0;
        const before = p.hp;
        p.hp = Math.min(p.hp + amount, p.getMaxHp());
        if (p.hp !== before && p.updateInfo) Promise.resolve(p.updateInfo(true)).catch(() => {});
        return p.hp - before;
      }, 0);
    },
  });

  // ---- heals: PokemonHealPhase is the one door for healing in battle ----
  X.phaseClass('PokemonHealPhase', proto => {
    // the HP really gained (the phase's own number is capped at max HP, not at what was missing)
    X.wrap(proto, 'doHealPokemon', 'd', orig => function () {
      let p = null, before = 0;
      X.guard('d heal measure', () => { p = this.getPokemon(); before = p ? p.hp : 0; });
      const r = orig.apply(this, arguments);
      X.guard('d heal measure', () => { this.__dGain = p ? p.hp - before : 0; this.__dMon = p; });
      return r;
    });
    // an exact heal (B.healExact): the number as asked, without 回复护符
    X.after(proto, 'getHealAmount', 'd', self => {
      if (!self.__dExact || self.revive) return;
      return { value: Math.min(Math.max(0, Math.floor(self.hpHealed)), self.getPokemon().getMaxHp()) };
    });
    // when heal() is through, the HP has moved and the phase's own message is queued: tell the mods
    X.wrap(proto, 'heal', 'd', orig => function () {
      const r = orig.apply(this, arguments);
      const done = () => X.guard('d healDone', () => {
        const gain = this.__dGain, p = this.__dMon;
        this.__dGain = 0;
        if (!(gain > 0) || !p || !X.has('healDone')) return;
        X.emit('healDone', { pokemon: p, amount: gain, tag: this.__coopModHeal ? this.__coopModHeal.tag : null, revive: !!this.revive });
      });
      if (r && typeof r.then === 'function') return r.then(v => { done(); return v; });
      done();
      return r;
    });
  });

  // ---- losses: every HP loss goes through Pokemon.damage; most come by way of damageAndUpdate ----
  // hpLost is told when the game's own call is through: after damageAndUpdate has returned for losses that
  // came through it, right away for the ones that call damage directly (poison, burn, Pain Split).
  let depth = 0, pending = [];
  const tell = list => { for (const ev of list) X.guard('d hpLost', () => { if (X.has('hpLost')) X.emit('hpLost', ev); }); };
  X.pokemonClass(proto => {
    X.after(proto, 'damage', 'd', (self, args, lost) => {
      if (!(lost > 0) || !X.has('hpLost')) return;
      const ev = { pokemon: self, amount: lost, fainted: self.isFainted() };
      if (depth > 0) pending.push(ev); else tell([ev]);
    });
    X.wrap(proto, 'damageAndUpdate', 'd', orig => function () {
      depth++;
      try { return orig.apply(this, arguments); } finally {
        depth--;
        if (depth <= 0) { depth = 0; if (pending.length) { const list = pending; pending = []; tell(list); } }
      }
    });
  });

  // ---- medicine: every use of an item goes through scene.addModifier ----
  const isHpMedicine = m => !!m && typeof m === 'object' && ((m.constructor && m.constructor.name === 'PokemonHpRestoreModifier')
    || ('restorePercent' in m && 'restorePoints' in m && 'fainted' in m && 'pokemonId' in m));
  let wrapped = null;
  const screen = { phase: null, n: 0 };
  X.onTick(s => {
    if (wrapped === s) return;
    const proto = X.protoWith(s, 'addModifier');
    if (!proto) return;
    X.wrap(proto, 'addModifier', 'd', orig => function (modifier) {
      let was = null;
      X.guard('d medicine', () => {
        if (!X.has('medicineUsed') || !isHpMedicine(modifier)) return;
        was = this.getPlayerParty().map(p => ({ p, hp: p.hp }));
      });
      const r = orig.apply(this, arguments); // true: the item did something to somebody (the shop takes the money on it)
      if (was && r) X.guard('d medicine', () => {
        const m = modifier, revive = !!m.fainted;
        // the Pokémon the game applied it to: the one it was used on (圣灰: everybody), alive for a potion, fainted for a revive
        const targets = was.filter(w => (m.pokemonId === -1 || w.p.id === m.pokemonId) && (w.hp <= 0) === revive).map(w => w.p);
        if (!targets.length) return;
        const mult = revive ? 1 : charm(), pts = Number(m.restorePoints) || 0, pct = Number(m.restorePercent) || 0;
        // the game's own formula (PokemonHpRestoreModifier.apply), for any Pokémon
        const effectOn = q => X.guard('d effectOn', () => Math.max(Math.ceil(Math.max(Math.floor(pct * 0.01 * q.getMaxHp()), revive ? pts : Math.floor(pts * mult))), 1), 0);
        // which reward screen this is (several medicines can be bought on one screen: the number stays the same)
        const ph = X.guard('d screen', () => this.phaseManager.getCurrentPhase(), null);
        if (ph !== screen.phase) { screen.phase = ph; screen.n++; }
        X.emit('medicineUsed', { targets, revive, item: (m.type && m.type.name) || '', effectOn, screen: screen.n });
      });
      return r;
    });
    wrapped = s;
  });

  // ---- for the rig ----
  X.debug('dCharm', () => charm());
  X.debug('dState', () => ({ depth, pending: pending.length, addModifier: !!wrapped }));
});

// ======== engine extension: e (engine/ext-e.js) ========
// Engine extension of team e: berries. For 文柚大果 #11, 哆啦A梦树果袋 #27, 异次元树果袋 #20,
// 超级巨化卡比兽玩偶 #21, 树果种植盆 #30 (mod/items/e.js). What it gives a mod (written up for mod authors, in
// 简体中文, at the end of notes/requests-e.md, ready for docs/MOD-API.md):
//   events    berryTime { pokemon }                          the game's berry moment, once per player Pokémon on the field
//             berryEaten { pokemon, berry, name, item, kept } a Pokémon really ate a berry (the game's, or a mod item used as one)
//                        (for a mod item eaten inside berryTime it is sent once that Pokémon's berryTime handlers are
//                        through, so the eater's own message and heals are queued before what a listener adds)
//   B.        hpRatio(p) berryName(t) berries(p) berryRoom(p) giveBerry(p, t) eatAsBerry(p, item) trimBerries(p)
//   api.      berryCap(item, n)                              each copy of that held item: +n to the holder's berry stacks
//             countsAsBerry(item)                            that held mod item's own max follows the same bonus (core: X.onMax)
// Hooks (all pass through; tags start with 'e'):
//   BerryPhase.eatBerries            after the game's own berries: berryEaten for what the game ate, then berryTime
//   Pokemon.recordEatenBerry         the one place every real eat goes through (BerryPhase, 大快朵颐, 茶会, 虫咬, 啄食)
//   BerryModifier.getMaxHeldItemCount  + the bonus declared with api.berryCap
//   BattleScene.tryTransferHeldItemModifier  a berry stack moved onto a Pokémon without that berry: not more than its own limit
//   gameData.parseSessionData        only reads the mod block of a save that is being loaded (see capBonus)
//   gameData.getSessionSaveData      only notes, in the cap item's state, which stacks are above the game's own limit
// With the mod off, or with none of these items held, every hook returns what the game returned.
CoopModsExt('e', X => {
  const B = X.battle;
  const scene = () => X.scene();
  const TYPES = 11; // BerryType 0..10: SITRUS LUM ENIGMA LIECHI GANLON PETAYA APICOT SALAC LANSAT STARF LEPPA
  const ZH = ['文柚果', '木子果', '谜芝果', '枝荔果', '龙睛果', '龙火果', '杏仔果', '沙鳞果', '兰萨果', '星桃果', '苹野果']; // only when the game gives no name
  const validType = t => Number.isInteger(t) && t >= 0 && t < TYPES;

  X.addEvent('berryTime');
  X.addEvent('berryEaten');

  // ---- the game's berry classes (not reachable by name: taken from a berry that exists, or made by the save reader) ----
  let TypeCtor = null; // BerryModifierType
  const isBerry = m => !!m && typeof m.is === 'function' && m.is('BerryModifier');
  function typeObj(t) {
    if (TypeCtor) return new TypeCtor(t);
    const s = scene();
    const any = (s.modifiers || []).concat(s.enemyModifiers || []).find(isBerry);
    let type = any && any.type ? new any.type.constructor(t) : null;
    if (!type) {
      // the save reader builds a BerryModifierType from its id ('BERRY') and the berry type; Cap stands in for the modifier class
      const raw = JSON.stringify({ modifiers: [{ typeId: 'BERRY', typePregenArgs: [t], args: [], stackCount: 1, className: 'BerryModifier' }] });
      const md = s.gameData.parseSessionData(raw).modifiers[0];
      const Cap = function (ty) { this.type = ty; this.stackCount = 1; };
      Cap.prototype.getMaxStackCount = () => 1;
      const got = md.toModifier(Cap);
      type = got && got.type;
    }
    if (!type || type.id !== 'BERRY') throw new Error('no BerryModifierType in this build');
    TypeCtor = type.constructor;
    return type;
  }
  const stackOf = (p, t) => scene().findModifier(m => isBerry(m) && m.berryType === t && m.pokemonId === p.id, p.isPlayer());
  // the limit of berry t for p (the game's 2 or 3, plus what the cap hook adds)
  const capOf = (p, t) => (stackOf(p, t) || typeObj(t).newModifier(p)).getMaxStackCount();
  const berryName = t => (validType(t) ? X.guard('e berryName', () => typeObj(t).name, ZH[t]) || ZH[t] : '树果');
  function berries(p) {
    const out = [];
    for (let t = 0; t < TYPES; t++) { const m = stackOf(p, t); out.push({ berry: t, name: berryName(t), count: m ? m.getStackCount() : 0, max: capOf(p, t) }); }
    return out;
  }
  // one more berry t for p, the way 收获 gives one back. false: at its limit (never the game's "stack full, take
  // a Poké Ball instead": the limit is checked here first), fainted, an enemy, or not a berry type.
  function giveBerry(p, t) {
    if (!p || !validType(t) || !p.isPlayer() || p.isFainted()) return false;
    const s = scene(), have = stackOf(p, t);
    if (have) {
      if (have.getStackCount() >= have.getMaxStackCount()) return false;
      have.stackCount++;
    } else {
      const mod = typeObj(t).newModifier(p);
      if (mod.getMaxStackCount() < 1) return false;
      s.addModifier(mod, true); // (its return value says nothing for a held item)
      if (!stackOf(p, t)) return false;
    }
    s.updateModifiers(true); // the item bar, the counts
    return true;
  }

  // ---- the berry limit: + what mods declared with api.berryCap(item, n) ----
  const caps = []; // { key, n }
  // A save that is being loaded: the game cuts every stack down to its limit while it rebuilds the items, and
  // that is before the engine has read who holds what in that save (it does so at its next tick). So the mod
  // block of the save just parsed is remembered here until the engine has caught up.
  // By run seed, because the title's slot list parses several saves before one of them is loaded.
  const pending = {}; // seed -> { pokemonId: { key: n } }
  function blockCounts(block) {
    const out = {};
    if (!block || typeof block !== 'object' || !block.held || typeof block.held !== 'object') return out;
    for (const id of Object.keys(block.held)) {
      const h = block.held[id];
      if (!h || typeof h !== 'object') continue;
      for (const k of Object.keys(h)) { const e = h[k]; const n = block.v === 1 ? (e ? 1 : 0) : e && e.n >= 1 ? Math.floor(e.n) : 0; if (n) (out[id] = out[id] || {})[k] = n; }
    }
    return out;
  }
  function notePending(r) {
    if (!r || !r.seed || !caps.length) return;
    let block = r.coopMods;
    if (!block) { try { const dev = JSON.parse(localStorage.getItem('coop-mods-held-v1') || '{}')[r.seed]; block = dev && dev.block; } catch {} } // the device copy the engine falls back on
    const seeds = Object.keys(pending);
    if (seeds.length > 12) delete pending[seeds[0]];
    pending[r.seed] = blockCounts(block);
  }
  function capBonus(p) {
    if (!p || typeof p.isPlayer !== 'function' || !p.isPlayer()) return 0;
    let sum = 0;
    for (const c of caps) {
      if (!X.itemOn(c.key)) continue;
      let n = X.count(p, c.key);
      const run = pending[scene().seed], h = run && run[p.id];
      if (h && h[c.key] > n) n = Math.min(h[c.key], X.items[c.key].max);
      sum += n * c.n;
    }
    return sum;
  }
  let capHooked = false;
  function hookCap(s) {
    if (capHooked || !caps.length) return;
    const proto = Object.getPrototypeOf(typeObj(0).newModifier({ id: 0 })); // a throw-away berry: never added to the game
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'getMaxHeldItemCount')) throw new Error('BerryModifier.getMaxHeldItemCount not found');
    // (pokemon?) -> 2 or 3. The game calls it for the holder, for every party member (the red count) and with nothing.
    capHooked = X.wrap(proto, 'getMaxHeldItemCount', 'e', orig => {
      gameCap = orig; // what was there before this wrap: the game's 2 or 3 (plus whatever another extension added before)
      return function (pokemon) {
        const base = orig.apply(this, arguments);
        if (typeof base !== 'number') return base;
        return base + X.guard('e berry cap', () => capBonus(pokemon || (this.getPokemon && this.getPokemon())), 0);
      };
    });
    // moving a berry stack onto a Pokémon that has none of that berry: the game takes the whole quantity without
    // looking at the target's limit, which only shows once limits differ between Pokémon
    const sp = X.protoWith(s, 'tryTransferHeldItemModifier');
    if (sp) X.before(sp, 'tryTransferHeldItemModifier', 'e', (self, args) => {
      const item = args[0], target = args[1];
      if (!caps.length || !isBerry(item) || !target || !target.isPlayer() || typeof item.getMaxHeldItemCount !== 'function') return;
      if (self.findModifier(m => isBerry(m) && m.berryType === item.berryType && m.pokemonId === target.id, true)) return; // the game checks this case itself
      const max = item.getMaxHeldItemCount(target), want = args[3] == null ? 1 : args[3];
      if (!(want > max)) return;
      const a = args.slice(); while (a.length < 4) a.push(undefined);
      a[3] = Math.max(1, max);
      return { args: a };
    });
    const gd = s.gameData;
    if (gd && typeof gd.parseSessionData === 'function') X.after(gd, 'parseSessionData', 'e', (self, args, r) => { notePending(r); });
    if (gd && typeof gd.getSessionSaveData === 'function') X.before(gd, 'getSessionSaveData', 'e', () => { noteOver(); });
    X.log('hooks (e): berry limit');
    // the run was loaded before this hook existed (the room was opened, or the mod switched on, afterwards)
    X.guard('e cap late start', () => { if ((s.getPlayerParty() || []).length) { restoreOver(s); s.updateModifiers(true); } });
  }
  // A run loaded while this hook was not there yet had its larger stacks cut by the game. Every save notes them
  // in the cap item's state ({ over: { berryType: count } }), and they are put back when the hook goes in late
  // (and when the mod comes back on): only a stack that sits exactly at the game's own limit (what a cut
  // leaves) is raised again, and never above today's limit.
  let gameCap = null;
  const ownStacks = (s, p) => s.findModifiers(m => isBerry(m) && m.pokemonId === p.id, true);
  function noteOver() {
    const s = scene();
    if (!capHooked || !gameCap || !s || !s.findModifiers) return;
    for (const c of caps) for (const p of s.getPlayerParty() || []) {
      const st = X.state(p, c.key), over = {}; // (the state is there while the mod is off too)
      if (!st) continue;
      for (const m of ownStacks(s, p)) if (m.stackCount > gameCap.call(m, p)) over[m.berryType] = m.stackCount;
      if (Object.keys(over).length) st.over = over; else delete st.over;
    }
  }
  function restoreOver(s) {
    if (!gameCap) return;
    let n = 0;
    for (const c of caps) for (const p of X.holders(c.key)) { // (only while the item's mod is on)
      const st = X.state(p, c.key), over = st && st.over;
      if (!over || typeof over !== 'object') continue;
      for (const m of ownStacks(s, p)) {
        const want = Math.floor(Number(over[m.berryType]) || 0);
        if (want > m.stackCount && m.stackCount === gameCap.call(m, p)) { const to = Math.min(want, m.getMaxStackCount()); n += to - m.stackCount; m.stackCount = to; }
      }
    }
    if (n) X.log('berries above the game\'s limit put back: ' + n);
  }
  X.onTick(s => {
    if (!capHooked && caps.length && s.gameData && s.modifiers) hookCap(s);
    // the engine reads a run's items in this same tick, before the extensions: from here on X.count is right
    if (s.seed && pending[s.seed] && (s.getPlayerParty() || []).length) delete pending[s.seed];
  });
  // held mod items that count as berries (文柚大果, 哆啦A梦树果袋): their max per Pokémon is the item's own plus the
  // same bonus the game's berries get from the cap items. The core asks through X.onMax wherever it compares a
  // count with the max (give, canTake, the reward pick and its 已经带满了 text).
  const likes = new Set(); // item keys
  X.onMax((p, key, max) => (likes.has(key) ? max + capBonus(p) : max));
  // copies of those items above the Pokémon's limit of the moment (a cap item was taken away): they go, like berries
  function trimLikes(p) {
    let cut = 0;
    for (const key of likes) {
      if (!X.itemOn(key)) continue;
      const over = X.count(p, key) - X.maxOf(p, key);
      if (over > 0 && X.take(p, key, over)) cut += over;
    }
    return cut;
  }
  X.extendApi(mod => ({
    // this held item of yours counts as a berry for the cap items: its max per Pokémon goes up with them
    countsAsBerry(item) {
      const key = item && item.key, it = key && X.items[key];
      if (!it || it.mod !== mod.id || it.kind !== 'held') throw new Error('countsAsBerry: pass one of your own held items');
      likes.add(key);
    },
    // each copy of this held item raises every berry stack limit of its holder by n
    berryCap(item, n) {
      const key = item && item.key;
      n = Math.floor(Number(n == null ? 1 : n) || 0);
      if (!key || String(key).indexOf(mod.id + ':') !== 0) throw new Error('berryCap: pass one of your own items');
      if (!(n > 0)) throw new Error('berryCap: n must be a whole number above 0');
      if (!caps.some(c => c.key === key)) caps.push({ key, n });
    },
  }));
  // A stack above its limit is a state the game cannot handle: its "can this Pokémon take one more" check only
  // refuses a stack that is exactly at the limit, and one more berry picked for that Pokémon then turns into
  // the game's "stack full" replacement (5 Poké Balls). So when a limit drops (the item is gone, the mod is
  // switched off) the berries above it go too: the same cut the game makes itself when it loads a save.
  function trimBerries(p) {
    const s = scene();
    if (!s || !s.findModifiers || !(s.getPlayerParty() || []).length) return 0;
    let cut = 0;
    for (const m of s.findModifiers(x => isBerry(x) && (!p || x.pokemonId === p.id), true)) {
      const max = m.getMaxStackCount();
      if (max >= 1 && m.stackCount > max) { cut += m.stackCount - max; m.stackCount = max; }
    }
    s.updateModifiers(true); // counts and tint follow at once
    if (cut) X.log('berries above the limit taken away: ' + cut);
    return cut;
  }
  // The mod that owns a cap item is switched off: note the larger stacks, then cut them. Switched on again: put
  // back what that cut took (and what the game cut if a run was loaded while it was off).
  let wasOff = false;
  X.onSwitch((id, on) => {
    if (!capHooked || !window.CoopTeam || !caps.some(c => X.items[c.key] && X.items[c.key].mod === id)) return;
    X.guard('e switch', () => {
      const s = scene();
      if (!on) { wasOff = true; noteOver(); trimBerries(null); }
      else if (wasOff) { wasOff = false; if (s && (s.getPlayerParty() || []).length) { restoreOver(s); s.updateModifiers(true); } }
    });
  });

  // ---- eating ----
  // ctx: set while BerryPhase.eatBerries runs for one Pokémon and during the berryTime that follows
  let ctx = null;
  function ate(p, berry, item, kept) {
    if (!X.has('berryEaten')) return;
    const ev = { pokemon: p, berry, name: item ? (X.items[item] || {}).name || '' : berryName(berry), item: item || null, kept };
    // inside the game's loop over the items: tell the mods when it is done. Inside this Pokémon's berryTime: tell
    // them when its handlers are through, so what the eater's own item queued (its message, its heals) comes
    // before what a listener queues (the doll's "变出了一个…").
    if (ctx && (ctx.inGame || (ctx.inTime && ctx.pokemon === p))) ctx.queue.push(ev);
    else X.emit('berryEaten', ev);
  }
  X.pokemonClass(base => {
    const proto = Object.prototype.hasOwnProperty.call(base, 'recordEatenBerry') ? base : null;
    if (!proto) { X.log('hooks (e): no Pokemon.recordEatenBerry in this build'); return; }
    // (berryType, updateHarvest = true): every real eat, never 反刍's replay, never simulated
    X.after(proto, 'recordEatenBerry', 'e', (self, args) => {
      const t = args[0];
      if (!validType(t)) return;
      ate(self, t, null, ctx && ctx.inGame && ctx.pokemon === self ? args[1] === false : null);
    });
    X.log('hooks (e): berries eaten');
  });
  X.phaseClass('BerryPhase', proto => {
    // (pokemon): once per active Pokémon of both sides, fastest first. The game's berries are eaten inside.
    X.wrap(proto, 'eatBerries', 'e', orig => function (pokemon) {
      const mine = X.guard('e eatBerries', () => {
        if (!pokemon || !(X.has('berryTime') || X.has('berryEaten'))) return null;
        const player = pokemon.isPlayer();
        // asked before the game eats: afterwards the eaten stacks no longer match. true: the game shows the
        // use-item animation (or the "too nervous" message) for this Pokémon itself.
        const real = !!scene().findModifier(m => isBerry(m) && m.shouldApply(pokemon), player);
        return { pokemon, player, real, shown: real, queue: [], inGame: true, inTime: false };
      }, null);
      const prev = ctx;
      ctx = mine;
      let r;
      try { r = orig.apply(this, arguments); } finally { if (mine) mine.inGame = false; else ctx = prev; }
      if (mine) {
        const flush = () => X.guard('e berryEaten', () => { for (const ev of mine.queue.splice(0)) X.emit('berryEaten', ev); });
        flush();
        mine.inTime = true;
        X.guard('e berryTime', () => { if (mine.player && B.onField(pokemon) && X.has('berryTime')) X.emit('berryTime', { pokemon }); });
        mine.inTime = false;
        flush(); // the mod items eaten as berries during berryTime
        ctx = prev;
      }
      return r;
    });
    X.log('hooks (e): berry phase');
  });
  const nervous = p => p.getOpponents().some(o => o && o.isActive(true) && o.hasAbilityWithAttr('PreventBerryUseAbAttr'));
  // p uses one copy of a held mod item the way a berry is eaten. 'eaten': one copy is gone; 'kept': the team's
  // 树果袋 kept it; false: nothing happened (not held, not on the field, or 紧张感 on the other side).
  function eatAsBerry(p, item) {
    const key = item && item.key ? item.key : item;
    if (!X.itemOn(key) || !B.onField(p) || X.count(p, key) < 1) return false;
    const s = scene(), c = ctx && ctx.pokemon === p ? ctx : null, bi = p.getBattlerIndex();
    if (nervous(p)) {
      if (!(c && c.shown)) s.phaseManager.queueMessage(X.nameOf(p) + '因太紧张\n而无法食用树果！');
      if (c) c.shown = true;
      return false;
    }
    const keep = { value: false };
    X.guard('e berry pouch', () => { const pouch = s.findModifier(m => m.is('PreserveBerryModifier'), true); if (pouch) pouch.apply(p, keep); });
    if (!(c && c.shown)) s.phaseManager.unshiftNew('CommonAnimPhase', bi, bi, 2000 /* CommonAnim.USE_ITEM */);
    if (c) c.shown = true;
    if (!keep.value) X.take(p, key, 1);
    X.guard('e belch', () => { p.battleData.hasEatenBerry = true; }); // 打嗝 may be used from now on, as after any berry
    ate(p, null, key, !!keep.value);
    return keep.value ? 'kept' : 'eaten';
  }

  X.extendBattle({
    // HP as a share of max HP, rounded to whole percent the way the game does for its berries (49.6% reads 0.5)
    hpRatio: p => X.guard('e hpRatio', () => p.getHpRatio(), 1),
    berryName,
    // every berry type for this Pokémon: [{ berry, name, count, max }]
    berries: p => X.guard('e berries', () => berries(p), []),
    // the berry types this Pokémon can take one more of
    berryRoom: p => X.guard('e berryRoom', () => (!p || !p.isPlayer() || p.isFainted() ? [] : berries(p).filter(b => b.count < b.max).map(b => b.berry)), []),
    giveBerry: (p, t) => X.guard('e giveBerry', () => giveBerry(p, t), false),
    eatAsBerry: (p, item) => X.guard('e eatAsBerry', () => eatAsBerry(p, item), false),
    // cut this Pokémon's berry stacks down to their limits (after a limit dropped); returns how many went
    trimBerries: p => X.guard('e trimBerries', () => (p ? (capHooked ? trimBerries(p) : 0) + trimLikes(p) : 0), 0),
  });

  // ---- for tests ----
  X.debug('eBerries', i => berries(scene().getPlayerParty()[i]).filter(b => b.count).map(b => b.name + '×' + b.count + '/' + b.max));
  X.debug('eGiveBerry', (i, t) => giveBerry(scene().getPlayerParty()[i], t));
  X.debug('eCaps', () => ({ caps: caps.slice(), likes: [...likes], hooked: capHooked, pending: Object.keys(pending), type: !!TypeCtor }));
  X.debug('eType', t => { const ty = typeObj(t); return { id: ty.id, name: ty.name, ctor: ty.constructor.name, icon: ty.iconImage }; });
});

// ======== engine extension: f (engine/ext-f.js) ========
// Engine extension of team f: what 光之黏土 (#8) and 防尘帐篷 (#18) need from the game.
// It knows no item: it turns four decisions of the game into questions a mod may answer.
//
// ---- for mod authors (接口版本 2, added by this extension; the text for docs/MOD-API.md) ----
// 事件（都用 api.on 接）：
//   screenSet     一只宝可梦用招式架起光墙、反射壁或极光幕的那一刻（还没架起来）。
//                 收到 pokemon（用招式的宝可梦）、screen（'lightScreen' 光墙 / 'reflect' 反射壁 / 'auroraVeil' 极光幕）、
//                 turns（现在要持续几回合，原版是 5）、moveId、then(fn)。
//                 返回数字 = 改成持续这么多回合（至少 1）。几个处理函数依次接着算。
//                 then(fn)：真的架起来之后再做的事，fn 收到 { turns }。这一边已经有同一种壁时招式不会生效，fn 就不会被调用，
//                 所以提示文字写在 then 里。「换场」把壁搬到对面时不会触发这个事件。
//   weatherDamage 沙暴、冰雹在回合结束时准备伤害场上的宝可梦之前，每只问一次。
//                 收到 pokemon、weather（'sandstorm' 沙暴 / 'hail' 冰雹）。返回 true = 这只这回合不受天气伤害
//                 （不扣血，也不出现「沙暴袭击了××」那行字）。本来就不怕这种天气的宝可梦也会被问到。
//   powderMove    一个粉末类招式（毒粉、麻痹粉、催眠粉、蘑菇孢子、棉孢子、粉尘、魔法粉）要对一只宝可梦生效之前。
//                 收到 user（用招式的）、target（被瞄准的）、moveId、redirect（false）。
//                 返回 true = 对 target 没有效果（和草属性宝可梦一样，显示游戏自己的「对××没有效果」）。
//                 愤怒粉：对手用了愤怒粉、target 要出单体招式时也会来问一次，这时 redirect 是 true，user 是用愤怒粉的对手，
//                 返回 true = target 的招式不会被愤怒粉吸过去。
//   effectSpore   一只宝可梦用接触类招式打中了特性是「孢子」的宝可梦，特性要判定之前。
//                 收到 pokemon（出招的）、holder（有孢子特性的）。返回 true = 这一下孢子特性不发动。
// 后三个事件是「问一句、答一句」：游戏在选招界面显示效果、AI 估算时也会来问，会被问很多次。
// 处理函数里只回答，不要发消息、不要改任何状态。有任何一个处理函数回答 true 就算 true。
// -------------------------------------------------------------------------------------------
CoopModsExt('f', X => {
  const POWDER_MOVE = 2048;   // MoveFlags.POWDER_MOVE (1 << 11)
  const TARGET_USER = 0;      // MoveTarget.USER
  const EFFECT_SPORE = 27, OVERCOAT = 142; // AbilityId
  const RAGE_POWDER = 476;    // MoveId
  const SCREENS = { LIGHT_SCREEN: 'lightScreen', REFLECT: 'reflect', AURORA_VEIL: 'auroraVeil' }; // ArenaTagType -> name for mods
  const WEATHERS = { 3: 'sandstorm', 4: 'hail' }; // WeatherType of the two damaging weathers

  X.addEvent('screenSet');
  X.addEvent('weatherDamage');
  X.addEvent('powderMove');
  X.addEvent('effectSpore');

  // what the hooks did, for the rig (CoopMods.debug.f())
  const seen = { hooks: {}, screenSet: 0, screenChanged: 0, weatherPhases: 0, weatherShadowed: 0, weatherPasses: [], weatherSkipped: 0, powderAsked: 0, powderBlocked: 0, redirectAsked: 0, redirectBlocked: 0, sporeAsked: 0, sporeBlocked: 0 };
  X.debug('f', () => JSON.parse(JSON.stringify(seen)));

  // yes/no question: true when any listener answers true. A listener that throws is logged and counts as no answer.
  function askYes(name, ev) {
    let yes = false;
    for (const [mod, fn] of X.listeners(name)) {
      if (X.guard('f ' + name + ' listener of ' + (mod && mod.id), () => fn(ev) === true, false)) yes = true;
    }
    return yes;
  }

  // ---- 1. screens: Arena.addTag(tagType, turnCount, sourceMove, sourceId, side = BOTH, quiet = false) ----
  // One call per screen a move puts up; the tag, its maxDuration, the arena flyout and the save all take the
  // number from this call. Court Change re-adds a screen with quiet = true and its remaining turns: left alone.
  function hookArena(proto) {
    return X.wrap(proto, 'addTag', 'f', orig => function (tagType, turnCount, sourceMove, sourceId, side, quiet) {
      let args = arguments; const thens = []; let turns = turnCount;
      X.guard('f screenSet', () => {
        const screen = SCREENS[tagType];
        if (!screen || quiet || !(turnCount > 0) || !X.has('screenSet')) return;
        const s = X.scene(), src = s && s.getPokemonById ? s.getPokemonById(sourceId) : null;
        if (!src) return;
        seen.screenSet++;
        for (const [mod, fn] of X.listeners('screenSet')) {
          X.guard('f screenSet listener of ' + (mod && mod.id), () => {
            const mine = [];
            const r = fn({ pokemon: src, screen, turns, moveId: sourceMove == null ? null : sourceMove, then: f => { if (typeof f === 'function') mine.push(f); } });
            if (typeof r === 'number' && isFinite(r)) turns = Math.max(1, Math.floor(r)); // 0 or less would mean "for ever" in this game
            thens.push(...mine);
          });
        }
        if (turns !== turnCount) { args = Array.prototype.slice.call(arguments); args[1] = turns; seen.screenChanged++; }
      });
      const added = orig.apply(this, args);
      // false: the side had this screen already (or the type is unknown): nothing was put up, nothing to tell
      if (added && thens.length) for (const f of thens) X.guard('f screenSet then', () => f({ turns }));
      return added;
    });
  }

  // ---- 2. weather damage: WeatherEffectPhase.start() ----
  // start() calls this.executeForAll three times: (1) abilities that suppress the weather, (2) the damage loop,
  // both synchronously, and (3) end-of-weather abilities from the callback of the weather message, later.
  // While start() runs, the phase gets its own executeForAll that leaves the protected Pokémon out of call (2).
  // When (1) finds the weather suppressed there is no second synchronous call and nothing is filtered.
  X.phaseClass('WeatherEffectPhase', proto => {
    seen.hooks.weather = X.wrap(proto, 'start', 'f', orig => function () {
      const self = this; let shadow = null, hadOwn = false, prev;
      X.guard('f weatherDamage', () => {
        seen.weatherPhases++;
        if (!X.has('weatherDamage')) return;
        const s = X.scene(), w = s && s.arena && s.arena.weather;
        if (!w || typeof w.isDamaging !== 'function' || !w.isDamaging() || typeof self.executeForAll !== 'function') return;
        const weather = WEATHERS[w.weatherType] || String(w.weatherType);
        const safe = new Set();
        for (const p of s.getField(true)) if (p && askYes('weatherDamage', { pokemon: p, weather })) safe.add(p);
        if (!safe.size) return; // nobody is protected: the game's phase runs untouched
        hadOwn = Object.prototype.hasOwnProperty.call(self, 'executeForAll'); prev = self.executeForAll;
        const exec = self.executeForAll; let n = 0;
        shadow = function (fn) {
          n++;
          if (n !== 2 || typeof fn !== 'function') return exec.apply(this, arguments);
          return exec.call(this, function (p) {
            if (safe.has(p)) { seen.weatherSkipped++; return undefined; }
            return fn.apply(this, arguments);
          });
        };
        shadow.calls = () => n;
        self.executeForAll = shadow;
        seen.weatherShadowed++;
      });
      try { return orig.apply(this, arguments); }
      finally {
        if (shadow) {
          seen.weatherPasses.push(shadow.calls()); if (seen.weatherPasses.length > 20) seen.weatherPasses.shift();
          // take our function off again before the asynchronous third pass (only if it is still ours)
          if (Object.prototype.hasOwnProperty.call(self, 'executeForAll') && self.executeForAll === shadow) {
            if (hadOwn) self.executeForAll = prev; else delete self.executeForAll;
          }
        }
      }
    });
  });

  // ---- 3. powder moves: Move.isTypeImmune(user, target) ----
  // The game's own "this move has no effect on this target because of what the target is" (Grass types against
  // powder). Asked for real hits, for the fight menu's effectiveness labels and by the enemy AI: a pure yes/no.
  function hookMove(proto) {
    return X.wrap(proto, 'isTypeImmune', 'f', orig => function (user, target) {
      const immune = X.guard('f powderMove', () => {
        if (!this.hasFlag(POWDER_MOVE) || this.moveTarget === TARGET_USER || !user || !target || user === target || !X.has('powderMove')) return false;
        seen.powderAsked++;
        return askYes('powderMove', { user, target, moveId: this.id, redirect: false });
      }, false);
      if (immune) { seen.powderBlocked++; return true; }
      return orig.apply(this, arguments);
    });
  }

  // ---- 4. Rage Powder: MovePhase.resolveRedirectTarget() ----
  // The game lets Grass types and Overcoat ignore the redirect of a Rage Powder user (and only of Rage Powder:
  // Follow Me and Spotlight keep pulling). For a protected user, answer "yes" to the Overcoat question while the
  // game's method runs; ability redirects (Lightning Rod ...) computed in the same method stay as the game decides.
  X.phaseClass('MovePhase', proto => {
    seen.hooks.redirect = X.wrap(proto, 'resolveRedirectTarget', 'f', orig => function () {
      const u = this.pokemon; let shadow = null, hadOwn = false, prev;
      X.guard('f powderMove redirect', () => {
        if (!u || !this.targets || this.targets.length !== 1 || !X.has('powderMove')) return;
        const puller = u.getOpponents(true).find(o => { const t = o.getTag('CENTER_OF_ATTENTION'); return !!(t && t.powder); });
        if (!puller) return;
        seen.redirectAsked++;
        if (!askYes('powderMove', { user: puller, target: u, moveId: RAGE_POWDER, redirect: true })) return;
        hadOwn = Object.prototype.hasOwnProperty.call(u, 'hasAbility'); prev = u.hasAbility;
        const has = u.hasAbility;
        shadow = function (id) { return id === OVERCOAT ? true : has.apply(this, arguments); };
        u.hasAbility = shadow;
        seen.redirectBlocked++;
      });
      try { return orig.apply(this, arguments); }
      finally {
        if (shadow && Object.prototype.hasOwnProperty.call(u, 'hasAbility') && u.hasAbility === shadow) {
          if (hadOwn) u.hasAbility = prev; else delete u.hasAbility;
        }
      }
    });
  });

  // ---- 5. Effect Spore: EffectSporeAbAttr.canApply({ pokemon: the ability's owner, opponent: the attacker, move, ... }) ----
  // false = the ability does nothing for this hit (the game's own exit for Grass types and Overcoat: no random
  // number is drawn, no ability bar, no message). Only this attribute class is wrapped: Static, Poison Point,
  // Flame Body are other classes.
  function hookSpore(attr) {
    const proto = attr && Object.getPrototypeOf(attr);
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'canApply')) return false;
    return X.wrap(proto, 'canApply', 'f', orig => function (params) {
      const blocked = X.guard('f effectSpore', () => {
        // (the game also runs this check when the ability's owner uses a move on itself: nobody was hit, nothing to ask)
        if (!params || !params.opponent || params.opponent === params.pokemon || !X.has('effectSpore')) return false;
        seen.sporeAsked++;
        return askYes('effectSpore', { pokemon: params.opponent, holder: params.pokemon || null });
      }, false);
      if (blocked) { seen.sporeBlocked++; return false; }
      return orig.apply(this, arguments);
    });
  }
  const sporeAttrOf = ab => { const a = ab && typeof ab.getAttrs === 'function' ? ab.getAttrs('EffectSporeAbAttr') : null; return a && a[0] ? a[0] : null; };
  let pokemonProto = null;
  X.pokemonClass(proto => { pokemonProto = proto; });

  // The Arena, Move and ability-attribute classes are not phases: find one object of each when the game has
  // them (a tick is every 200 ms while a mod is on in a co-op room) and wrap its prototype, once.
  let arenaProto = null, moveDone = false, sporeDone = false, sporeTried = false;
  X.onTick(s => {
    if (s.arena) {
      const ap = X.protoWith(s.arena, 'addTag');
      if (ap && ap !== arenaProto) { arenaProto = ap; seen.hooks.arena = hookArena(ap); }
    }
    if (moveDone && sporeDone) return;
    const party = (s.getPlayerParty && s.getPlayerParty()) || [];
    if (!moveDone) {
      for (const p of party) {
        const pm = p && p.getMoveset && p.getMoveset()[0], mv = pm && pm.getMove && pm.getMove();
        const mp = mv && X.protoWith(mv, 'isTypeImmune');
        if (mp) { moveDone = true; seen.hooks.move = hookMove(mp); break; }
      }
    }
    if (!sporeDone && pokemonProto) {
      // Pokemon.getAbility() answers allAbilities[summonData.ability] when that is set: asked on a stand-in
      // object, so no real Pokémon is touched. Tried once; after that, look at who is on the field.
      let attr = null;
      if (!sporeTried) {
        sporeTried = true;
        attr = X.guard('f effect spore lookup', () => sporeAttrOf(pokemonProto.getAbility.call({ summonData: { ability: EFFECT_SPORE } })), null);
        if (!attr) X.log('f: Effect Spore not found through getAbility, waiting for one on the field');
      } else if (s.currentBattle && s.getField) {
        attr = X.guard('f effect spore on field', () => {
          for (const p of s.getField(true)) {
            const a = sporeAttrOf(p.getAbility()) || sporeAttrOf(p.getPassiveAbility && p.getPassiveAbility());
            if (a) return a;
          }
          return null;
        }, null);
      }
      if (attr) { sporeDone = true; seen.hooks.spore = hookSpore(attr); }
    }
  });
});

// ======== engine extension: g (engine/ext-g.js) ========
// Engine extension g (接口版本 3): what a difficulty mod needs, in solo games and in co-op rooms alike.
// Asked for by B 站 Chess_大概是屑 & 深溟Ming (GitHub Chess12333), whose 进阶 (ascension) fork of the desktop build
// changed the game directly; the native option list on the starter screen, its description box, the corner
// label with its hover list and the labels on the save slots are their design, taken over from that fork.
//
//   limits (asked by the patched game through window.PRS_*; see scripts/patch-coop.mjs / patch-web.mjs)
//     event partyMax       how many Pokémon a player may have            {max}            -> 1..6
//     event starterMax     how many starters may be picked               {max}            -> 1..6
//     event starterPoints  the starter points of a classic run           {points}         -> 1..20
//     event rewardOdds     how often a reward slot is 超级 / 高级 / 肉鸽  {great, ultra, rogue} of 1024 -> {great?, ultra?, rogue?}
//   numbers of the run
//     event moneyGain      money about to be won (battle, money items)   {amount, wave, source}   -> number
//     event expGain        experience about to be given to one Pokémon   {pokemon, amount}        -> number
//     event partyHeal      the free full heal between areas, per Pokémon {pokemon, before, hp, maxHp} -> hp it ends with
//     event reviveHp       a revive (复活种子, 活力碎片 ...) is about to restore HP {pokemon, amount, source} -> number
//   encounters
//     event bossWave       is this wave a boss wave                      {wave, boss}     -> true
//     event bossSegments   how many bars a boss has                      {wave, segments} -> 1..10
//     event wildBiome      a wild Pokémon is about to be drawn           {wave, biome, random()} -> true | biome id
//     event itemAllowed    may this game item be offered / obtained      {id, name, tier, where}  -> false
//   a choice per run
//     api.runSetup(def)    a list shown once on the starter screen of a new game; the choice is kept in the run's
//                          save, shown in the corner during battle and on the save slots, and can be changed from
//                          the list of mods. api.runValue() reads it.
// Every "ask" event is asked of each listener in turn; a listener sees what the one before answered.
CoopModsExt('g', X => {
  const { scene, log, guard, el } = X;
  const num = x => typeof x === 'number' && isFinite(x);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const seen = { asks: {}, last: {}, partyHeal: 0, revive: 0, migrants: 0, banned: 0, picker: 0 }; // counters for tests (CoopMods.debug.g())
  ['partyMax', 'starterMax', 'starterPoints', 'rewardOdds', 'moneyGain', 'expGain', 'partyHeal', 'reviveHp', 'bossWave', 'bossSegments', 'wildBiome', 'itemAllowed'].forEach(n => X.addEvent(n));
  // ask every listener; take(answer, ev) folds an answer into ev
  function ask(type, ev, take) {
    if (!X.has(type)) return ev;
    seen.asks[type] = (seen.asks[type] || 0) + 1;
    const nums = () => Object.fromEntries(Object.keys(ev).filter(k => typeof ev[k] !== 'object' && typeof ev[k] !== 'function').map(k => [k, ev[k]]));
    const was = nums();
    for (const [m, fn] of X.listeners(type)) { const r = guard('mod ' + m.id + ' ' + type, () => fn(ev)); if (r !== undefined && r !== null) guard(type + ' answer', () => take(r, ev)); }
    seen.last[type] = [was, nums()];
    return ev;
  }
  const waveNow = () => guard('g wave', () => (scene().currentBattle || {}).waveIndex || 0, 0);

  // ---- limits: the patched game asks these; without the patch (an older package) nothing asks ----
  const limit = (type, key, dflt, lo, hi) => guard('g ' + type, () => ask(type, { [key]: dflt }, (r, ev) => { if (num(r)) ev[key] = clamp(Math.floor(r), lo, hi); })[key], dflt);
  const partyMax = () => limit('partyMax', 'max', 6, 1, 6);
  const starterMax = () => limit('starterMax', 'max', 6, 1, 6);
  window.PRS_PARTY_MAX = partyMax;       // a player's party is full at this many (host-team.js asks it per player)
  window.PRS_STARTER_MAX = starterMax;
  window.PRS_POINTS = () => limit('starterPoints', 'points', 10, 1, 20);
  // The game rolls 0..1023 per reward slot: 0 = 大师, 1..T0 = 肉鸽, ..T1 = 高级, ..T2 = 超级, the rest 普通
  // (T0 12, T1 60, T2 255). The event speaks in counts out of 1024: rogue 12, ultra 48, great 195.
  const ODDS = { great: 195, ultra: 48, rogue: 12 };
  function odds() {
    const ev = ask('rewardOdds', { ...ODDS }, (r, e) => {
      if (!r || typeof r !== 'object') return;
      for (const k of Object.keys(ODDS)) if (num(r[k])) e[k] = clamp(Math.floor(r[k]), 0, 1023);
    });
    if (ev.great + ev.ultra + ev.rogue > 1023) return { ...ODDS }; // more than there is: the answer is dropped
    return ev;
  }
  window.PRS_T = i => guard('g rewardOdds', () => { const o = odds(); return i === 2 ? o.rogue + o.ultra + o.great : i === 1 ? o.rogue + o.ultra : o.rogue; }, i === 2 ? 255 : i === 1 ? 60 : 12);

  // ---- money ----
  // scene.getWaveMoneyAmount is the base of prices as well as of winnings: the event is only asked while money
  // is being handed out (the battle's reward phase, a money item being used).
  let gaining = null; // 'battle' | 'item'
  X.phaseClass('MoneyRewardPhase', proto => {
    X.wrap(proto, 'start', 'g', orig => function () { const was = gaining; gaining = 'battle'; try { return orig.apply(this, arguments); } finally { gaining = was; } });
  });
  let sceneProto = null;
  function hookScene(s) {
    const proto = X.protoWith(s, 'getWaveMoneyAmount');
    if (!proto || proto === sceneProto) return;
    sceneProto = proto;
    X.after(proto, 'getWaveMoneyAmount', 'g', (self, args, res) => {
      if (!gaining || !num(res)) return;
      const ev = ask('moneyGain', { amount: res, wave: waveNow(), source: gaining }, (r, e) => { if (num(r)) e.amount = Math.max(0, Math.floor(r)); });
      return ev.amount === res ? undefined : { value: ev.amount };
    });
    // bosses: a wave a mod calls a boss wave has a boss (two bars) where the game had none
    X.after(proto, 'getEncounterBossSegments', 'g', (self, args, res) => {
      if (!num(res)) return;
      let n = res;
      const wave = args[0];
      if (n === 0 && bossWave(wave, false)) n = 2;
      if (n > 0) n = ask('bossSegments', { wave, segments: n }, (r, e) => { if (num(r)) e.segments = clamp(Math.floor(r), 1, 10); }).segments;
      return n === res ? undefined : { value: n };
    });
    // items: one a mod forbids is not obtained (wherever it comes from); a money item counts as winnings
    X.wrap(proto, 'addModifier', 'g', orig => function (modifier) {
      const t = modifier && modifier.type;
      if (t && !t.__coopMod && !allowed(t, 'gain')) { seen.banned++; log('g: ' + (t.id || t.name) + ' not obtained (a mod forbids it)'); return false; }
      if (!medProto) guard('g medicine class', () => hookMedicine(modifier)); // the first HP medicine gives its class away (for reviveHp)
      const money = !!(modifier && modifier.constructor && modifier.constructor.name === 'MoneyRewardModifier');
      if (!money) return orig.apply(this, arguments);
      const was = gaining; gaining = 'item';
      try { return orig.apply(this, arguments); } finally { gaining = was; }
    });
  }
  const bossWave = (wave, boss) => !!ask('bossWave', { wave, boss: !!boss }, (r, e) => { if (r === true) e.boss = true; }).boss;
  let modeProto = null;
  function hookGameMode(s) {
    const proto = s.gameMode && X.protoWith(s.gameMode, 'isTrainerBoss');
    if (!proto || proto === modeProto) return;
    modeProto = proto;
    X.after(proto, 'isTrainerBoss', 'g', (self, args, res) => (!res && bossWave(args[0], false) ? { value: true } : undefined));
  }

  // ---- experience ----
  const expStart = self => {
    if (!num(self.expValue) || !(self.expValue > 0)) return;
    const p = guard('g exp pokemon', () => self.getPokemon(), null);
    const ev = ask('expGain', { pokemon: p, amount: self.expValue }, (r, e) => { if (num(r)) e.amount = Math.max(0, Math.floor(r)); });
    if (ev.amount !== self.expValue) self.expValue = ev.amount;
  };
  X.phaseClass('ExpPhase', proto => { X.before(proto, 'start', 'g', expStart); });
  X.phaseClass('ShowPartyExpBarPhase', proto => { X.before(proto, 'start', 'g', expStart); });

  // ---- the free full heal between areas (PartyHealPhase sets everybody's HP to the maximum) ----
  X.phaseClass('PartyHealPhase', proto => {
    X.before(proto, 'start', 'g', self => { self.__gBefore = scene().getPlayerParty().map(p => ({ p, hp: p.hp })); });
    X.before(proto, 'end', 'g', self => {
      const was = self.__gBefore; self.__gBefore = null;
      if (!was || !X.has('partyHeal')) return;
      for (const w of was) {
        const p = w.p, max = p.getMaxHp();
        if (!(p.hp > w.hp)) continue; // not healed (a challenge kept it down, or it was full)
        const ev = ask('partyHeal', { pokemon: p, before: w.hp, hp: p.hp, maxHp: max }, (r, e) => { if (num(r)) e.hp = Math.floor(r); });
        const hp = clamp(ev.hp, Math.max(1, w.hp), max);
        if (hp !== p.hp) { p.hp = hp; seen.partyHeal++; guard('g partyHeal info', () => p.updateInfo(true)); }
      }
    });
  });

  // ---- revives: 复活种子 (a heal phase marked revive) and the revive medicines of the reward screen ----
  X.phaseClass('PokemonHealPhase', proto => {
    X.before(proto, 'start', 'g', self => {
      if (!self.revive || !num(self.hpHealed) || !X.has('reviveHp')) return;
      const p = guard('g revive pokemon', () => self.getPokemon(), null);
      const ev = ask('reviveHp', { pokemon: p, amount: self.hpHealed, source: 'seed' }, (r, e) => { if (num(r)) e.amount = Math.max(1, Math.floor(r)); });
      if (ev.amount !== self.hpHealed) { self.hpHealed = ev.amount; seen.revive++; }
    });
  });
  let medProto = null;
  function hookMedicine(modifier) { // PokemonHpRestoreModifier.prototype, from the first one the game uses
    const proto = modifier && Object.getPrototypeOf(modifier);
    if (!proto || proto === medProto || typeof proto.apply !== 'function' || !('restorePercent' in modifier && 'fainted' in modifier)) return;
    medProto = proto;
    X.wrap(proto, 'apply', 'g', orig => function (pokemon) {
      const revive = !!this.fainted && pokemon && !(pokemon.hp > 0);
      const r = orig.apply(this, arguments);
      if (revive && r && pokemon.hp > 0) guard('g revive medicine', () => {
        const ev = ask('reviveHp', { pokemon, amount: pokemon.hp, source: 'item' }, (a, e) => { if (num(a)) e.amount = Math.max(1, Math.floor(a)); });
        if (ev.amount < pokemon.hp) { pokemon.hp = ev.amount; seen.revive++; }
      });
      return r;
    });
  }

  // ---- wild Pokémon of another area ----
  let arenaProto = null;
  const pools = {}; // biome id -> its pokemonPool (null: no such biome)
  const BIOMES = [...Array.from({ length: 31 }, (_, i) => i + 1), 40, 41]; // every area but the starting town (0) and the end (50)
  const draws = { key: '', n: 0 };
  function hookArena(s) {
    const ar = s.arena, proto = ar && X.protoWith(ar, 'randomSpecies');
    if (!proto || proto === arenaProto) return;
    arenaProto = proto;
    const poolOf = (self, id) => {
      if (!(id in pools)) pools[id] = guard('g biome pool', () => { const a = new self.constructor(id); return a && a.pokemonPool ? a.pokemonPool : null; }, null);
      return pools[id];
    };
    X.wrap(proto, 'randomSpecies', 'g', orig => function (waveIndex, level, attempt) {
      if (attempt || !X.has('wildBiome')) return orig.apply(this, arguments); // (a retry of the same draw stays in the pool it was drawn from)
      let pool = null;
      guard('g wildBiome', () => {
        const key = scene().seed + ':' + waveIndex;
        if (draws.key !== key) { draws.key = key; draws.n = 0; }
        const roll = X.rng(key + ':wild:' + draws.n++);
        const ev = ask('wildBiome', { wave: waveIndex, biome: this.biomeId, random: roll, to: null }, (r, e) => { if (r === true || num(r)) e.to = r; });
        if (ev.to == null) return;
        if (ev.to === true) { for (let k = 0; k < 6 && !pool; k++) { const id = BIOMES[Math.floor(roll() * BIOMES.length)]; if (id !== this.biomeId) pool = poolOf(this, id); } }
        else if (ev.to !== this.biomeId) pool = poolOf(this, Math.floor(ev.to));
      });
      if (!pool) return orig.apply(this, arguments);
      const keep = this.pokemonPool;
      this.pokemonPool = pool; seen.migrants++;
      try { return orig.apply(this, arguments); } finally { this.pokemonPool = keep; }
    });
  }

  // ---- game items a mod forbids ----
  const TIER_NAMES = ['COMMON', 'GREAT', 'ULTRA', 'ROGUE', 'MASTER'];
  function allowed(type, where) {
    if (!X.has('itemAllowed')) return true;
    const id = String(type.id || String(type.localeKey || '').split('.').pop() || '');
    return ask('itemAllowed', { id, name: String(type.name || ''), tier: TIER_NAMES[type.tier] || null, where, ok: true }, (r, e) => { if (r === false) e.ok = false; }).ok;
  }
  X.onRewardOptions((ph, opts) => {
    if (!X.has('itemAllowed')) return;
    const kept = opts.filter(o => !o || !o.type || o.type.__coopMod || allowed(o.type, 'reward'));
    if (kept.length === opts.length || !kept.length) return; // (never an empty screen)
    seen.banned += opts.length - kept.length;
    return kept;
  });

  // ---- a choice per run: api.runSetup ----
  const setups = {}; // mod id -> { options, dflt, badge, detail, title }
  const REMEMBER = 'coop-mods-setup-v1';
  const remembered = () => { try { const o = JSON.parse(localStorage.getItem(REMEMBER) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const remember = (id, v) => { try { const o = remembered(); o[id] = v; localStorage.setItem(REMEMBER, JSON.stringify(o)); } catch {} };
  const optionsOf = id => { const d = setups[id]; const list = guard('runSetup options ' + id, () => (typeof d.options === 'function' ? d.options() : d.options), []); return (Array.isArray(list) ? list : []).filter(o => o && o.label != null).map(o => ({ value: o.value, label: String(o.label), description: o.description == null ? '' : String(o.description) })); };
  const valid = (id, v) => optionsOf(id).some(o => o.value === v);
  const valueOf = id => { const d = setups[id]; if (!d) return null; const st = X.runState(id); return 'setup' in st && valid(id, st.setup) ? st.setup : d.dflt; };
  function setValue(id, v, why) {
    if (!setups[id] || !valid(id, v)) return false;
    X.runState(id).setup = v;
    remember(id, v);
    hud.sig = '';
    log('g: ' + id + ' run setup = ' + JSON.stringify(v) + ' (' + why + ')');
    guard('runSetup changed ' + id, () => setups[id].changed && setups[id].changed(v));
    return true;
  }
  const liveSetups = () => X.order.filter(id => setups[id] && X.isOn(id));
  const badgeOf = (id, v) => guard('runSetup badge ' + id, () => { const t = setups[id].badge ? setups[id].badge(v) : ''; return typeof t === 'string' ? t.slice(0, 16) : ''; }, '');
  const detailOf = (id, v) => guard('runSetup detail ' + id, () => { const t = setups[id].detail ? setups[id].detail(v) : []; return (Array.isArray(t) ? t : [t]).filter(x => typeof x === 'string' && x).slice(0, 12).map(x => x.slice(0, 20)); }, []);
  X.extendApi(mod => ({
    runSetup(def) {
      if (setups[mod.id]) throw new Error('runSetup: one per mod');
      if (!def || !(Array.isArray(def.options) || typeof def.options === 'function')) throw new Error('runSetup needs options: [{ value, label, description }]');
      setups[mod.id] = { options: def.options, dflt: def.default === undefined ? null : def.default, badge: typeof def.badge === 'function' ? def.badge : null,
        detail: typeof def.detail === 'function' ? def.detail : null, changed: typeof def.changed === 'function' ? def.changed : null, title: String(def.title || mod.manifest.name || mod.id) };
    },
    runValue: () => valueOf(mod.id),
  }));
  // a new game's starter screen opens: every choice starts from what was chosen last time on this device
  let asked = null; // the mods whose list has been shown on this starter screen
  X.onSetup(() => {
    asked = new Set();
    for (const id of Object.keys(setups)) { const r = remembered()[id]; if (r !== undefined && valid(id, r)) X.runState(id).setup = r; }
  });

  // the game's own windows: any nine-slice drawn with a window_* texture tells which skin the player uses
  function findWindow(s) {
    let hit = null;
    const consider = o => { if (!hit && o && o.type === 'NineSlice' && o.texture && /^window_/.test(o.texture.key) && o.leftWidth > 0) hit = o; };
    const walk = (list, depth) => { if (!list || depth > 6) return; for (let i = 0; i < list.length && !hit; i++) { const o = list[i]; if (!o) continue; consider(o); if (o.list) walk(o.list, depth + 1); } };
    guard('g find window', () => walk(s.children.list, 0));
    if (!hit) guard('g find window (ui)', () => { for (const h of (s.ui && s.ui.handlers) || []) { const c = h && h.container; if (!c || hit) continue; consider(c); if (c.list) walk(c.list, 1); } });
    return hit;
  }
  function box(s, x, y, w, h) {
    const src = findWindow(s);
    return s.add.nineslice(x, y, src ? src.texture.key : 'window_1', src && src.frame ? src.frame.name : undefined, w, h, 8, 8, 8, 8).setOrigin(0);
  }
  const words = (s, x, y, str, size, color, wrap) => s.add.text(x, y, str, { fontFamily: 'emerald', fontSize: size, color: color || '#f8f8f8', padding: { bottom: 6 }, wordWrap: wrap ? { width: wrap * 6, useAdvancedWrap: true } : undefined })
    .setScale(1 / 6).setShadow(3, 4, '#0b0910', 0, false, true);
  // the description box under the list (world is 320x180, drawn 6x)
  const desc = { layer: null, text: null };
  function showDesc(s, str) {
    guard('g desc', () => {
      if (!desc.layer || !desc.layer.scene) {
        // left of the option list (which grows from the right edge with its longest label), along the bottom
        let left = 176;
        guard('g desc width', () => { const h = s.ui.getHandler(), bg = h && h.optionSelectBg; if (bg && bg.getBounds) { const x = Math.floor(bg.getBounds().x / 6); if (x > 60 && x < 320) left = x; } });
        const w = clamp(left - 7, 80, 208);
        desc.layer = s.add.container(0, 0).setScale(6).setDepth(1e6 - 2).setName('coop-mods-setup-desc');
        desc.layer.add(box(s, 4, 122, w, 52));
        desc.text = words(s, 12, 128, '', 54, '#f8f8f8', w - 16).setLineSpacing(8);
        desc.layer.add(desc.text);
      }
      desc.text.setText(str || '');
    });
  }
  const hideDesc = () => guard('g desc off', () => { if (desc.layer) { if (desc.layer.scene) desc.layer.destroy(); desc.layer = null; desc.text = null; } });
  const handlerNo = (s, name) => (s.ui.handlers || []).findIndex(h => h && h.constructor && h.constructor.name === name);
  // the game's own option list over the starter screen: its frame, cursor and keys. The last entry keeps things
  // as they are (the game picks the last entry when the cancel key is pressed).
  function openPicker(s, id, back) {
    const ui = s.ui, listMode = handlerNo(s, 'OptionSelectUiHandler'), d = setups[id];
    if (listMode < 0 || typeof ui.setModeWithoutClear !== 'function') return false;
    const NL = '\n', opts = optionsOf(id);
    if (!opts.length) return false;
    const cur = valueOf(id), curOpt = opts.find(o => o.value === cur);
    const done = v => { hideDesc(); if (v !== undefined) setValue(id, v, 'starter screen'); ui.setMode(back); return true; };
    const list = opts.map(o => ({ label: o.label, onHover: () => showDesc(s, o.description), handler: () => done(o.value) }));
    list.push({ label: '保持不变', onHover: () => showDesc(s, d.title + '：' + (curOpt ? curOpt.label : '默认') + NL + '不改，保持现在的选择。'), handler: () => done(undefined) });
    ui.setModeWithoutClear(listMode, { options: list, maxOptions: 6 });
    seen.picker++;
    log('g: run setup list of ' + id + ' opened');
    return true;
  }
  function tickSetup(s) {
    const h = guard('g handler', () => (s.ui ? s.ui.getHandler() : null), null);
    const starter = !!(h && h.constructor && h.constructor.name === 'StarterSelectUiHandler');
    if (!starter) { if (!(h && h.constructor && h.constructor.name === 'OptionSelectUiHandler')) hideDesc(); return; }
    // the starter screen is up: at most starterMax starters (the row of slots is drawn for six when the game boots)
    guard('g starter slots', () => {
      const max = starterMax();
      if (Array.isArray(h.partyStarterIds) && typeof h.popPartyStarter === 'function') { let n = 0; while (h.partyStarterIds.length > max && n++ < 12) h.popPartyStarter(h.partyStarterIds.length - 1); }
      if (Array.isArray(h.partyIcons)) h.partyIcons.forEach((ic, i) => { if (ic && ic.visible !== (i < max)) ic.setVisible(i < max); });
      const pts = window.PRS_POINTS();
      if (h.__gPoints !== pts && typeof h.tryUpdateValue === 'function') { h.__gPoints = pts; h.tryUpdateValue(0); }
    });
    if (!X.inSetup() || !asked) return;
    const next = liveSetups().find(id => !asked.has(id));
    if (!next) return;
    asked.add(next);
    guard('g picker', () => openPicker(s, next, handlerNo(s, 'StarterSelectUiHandler')));
  }

  // the label during a run (what was chosen), under the money at the top right, with the list of what it means
  // on hover / touch. Only while a battle screen is up (the reward screen writes the team's luck in that place).
  const hud = { scene: null, layer: null, sig: '' };
  const HUD_MODES = ['COMMAND', 'FIGHT', 'TARGET_SELECT', 'BALL', 'MESSAGE'];
  function tickHud(s) {
    if (!window.Phaser || !s.add) return;
    const ids = liveSetups();
    const inRun = !!(s.currentBattle && s.currentBattle.waveIndex) && !X.inSetup() && HUD_MODES.includes(X.uiMode());
    const parts = inRun ? ids.map(id => ({ id, v: valueOf(id) })).map(x => ({ ...x, badge: badgeOf(x.id, x.v) })).filter(x => x.badge) : [];
    // where: right edge and bottom of the money text (it moves down when the enemies' item bar is there)
    let right = 318, top = 22;
    if (parts.length) guard('g hud place', () => { const m = s.moneyText; if (m && m.getBounds) { const r = m.getBounds(); if (r.width > 0) { right = Math.round((r.x + r.width) / 6); top = Math.round((r.y + r.height) / 6) + 1; } } });
    const sig = parts.length ? parts.map(x => x.badge).join('|') + '@' + right + ',' + top : '';
    if (s !== hud.scene || !hud.layer || !hud.layer.scene || s.children.getIndex(hud.layer) < 0) {
      guard('g hud off', () => { if (hud.layer && hud.layer.scene) hud.layer.destroy(); });
      hud.scene = s; hud.layer = null; hud.sig = null;
    }
    if (sig === hud.sig) return;
    hud.sig = sig;
    if (hud.layer) { hud.layer.destroy(); hud.layer = null; }
    if (!parts.length) return;
    hud.layer = s.add.container(0, 0).setScale(6).setDepth(1e6 - 2).setName('coop-mods-run-label');
    const label = words(s, right, top, parts.map(x => x.badge).join(' · '), 54, '#f5c84c').setOrigin(1, 0);
    hud.layer.add(label);
    const lines = [].concat(...parts.map(x => detailOf(x.id, x.v)));
    if (lines.length) guard('g hud tip', () => {
      const w = 84, h = 11 + lines.length * 9;
      const tip = s.add.container(right - w, top + 11);
      tip.add(box(s, 0, 0, w, h));
      tip.add(words(s, 6, 5, lines.join('\n'), 48, '#f8f8f8').setLineSpacing(6));
      tip.setVisible(false);
      hud.layer.add(tip);
      label.setInteractive({ useHandCursor: true });
      label.on('pointerover', () => tip.setVisible(true));
      label.on('pointerout', () => tip.setVisible(false));
    });
  }
  // the save slots: each run's choice next to it
  function tickSlots(s) {
    const h = guard('g handler', () => (s.ui ? s.ui.getHandler() : null), null);
    if (!h || !Array.isArray(h.sessionSlots)) return;
    const ids = liveSetups();
    h.sessionSlots.forEach(slot => {
      if (!slot || typeof slot.add !== 'function') return;
      let t = slot.getData ? slot.getData('coopModsRun') : null;
      const seed = slot.saveData && slot.saveData.seed != null ? String(slot.saveData.seed) : null;
      const saved = seed ? X.savedRun(seed) : null;
      const text = saved ? ids.map(id => (saved[id] && valid(id, saved[id].setup) ? badgeOf(id, saved[id].setup) : '')).filter(Boolean).join(' · ') : '';
      if (!t) { if (!text) return; t = words(s, 288, 5, '', 72, '#f5c84c').setOrigin(1, 0); slot.add(t); guard('g slot data', () => slot.setData('coopModsRun', t)); }
      if (t.text !== text) t.setText(text);
      t.setVisible(!!text);
    });
  }
  // the list of mods: this run's choice, changeable there
  X.onPanel((id, render) => {
    if (!setups[id] || !X.wanted(id)) return null;
    const s = scene(), running = X.isOn(id), inRun = !!(s && s.currentBattle && s.currentBattle.waveIndex) || X.inSetup();
    const opts = optionsOf(id), cur = valueOf(id), curOpt = opts.find(o => o.value === cur);
    if (!running) return el('div', { class: 'set' }, [el('div', { class: 'meta', text: setups[id].title + '：这种玩法下不生效。' })]);
    if (!inRun) return el('div', { class: 'set' }, [el('div', { class: 'meta', text: setups[id].title + '：开新游戏、选宝可梦的时候会问你。' })]);
    return el('div', { class: 'set' }, [
      el('div', { text: setups[id].title + '（这一局）：' + (curOpt ? curOpt.label : '默认') }),
      el('div', { class: 'meta', text: curOpt && curOpt.description ? curOpt.description.replace(/\n/g, ' ') : '' }),
      el('div', { class: 'opts' }, opts.map(o => el('button', { class: o.value === cur ? 'sel' : '', text: o.label, onclick: () => { setValue(id, o.value, 'list of mods'); render(); } }))),
    ]);
  });

  X.onTick(s => {
    hookScene(s); hookGameMode(s); hookArena(s);
    tickSetup(s); tickHud(s); tickSlots(s);
  });
  X.onSwitch(() => { hud.sig = null; });

  X.debug('g', () => ({ ...seen, setups: Object.fromEntries(Object.keys(setups).map(id => [id, valueOf(id)])), limits: { partyMax: partyMax(), starterMax: starterMax(), points: window.PRS_POINTS(), t: [0, 1, 2].map(window.PRS_T) }, inSetup: X.inSetup() }));
  X.debug('gSet', (id, v) => setValue(id, v, 'debug'));
});

// ======== engine extension: h (engine/ext-h.js) ========
// Engine extension h: what the mod 训练家提升 (trainer-growth) needs. Written by chenjunjue (GitHub xiaochen2245),
// sent as pokerogue-desktop pull request #1 (coop/ext-trainer-growth.js there); moved here with its name changed and one addition (below), so that the desktop and the mobile build both carry it. Comments are the author's (简体中文).
//   api.meta() / api.metaSave()   a mod's own data outside any run (per device, localStorage prs-mod-meta-<id>)
//   api.metaPanel(def)            lines a player upgrades with points, drawn in the list of mods
//   api.dexProgress(), api.dexTotal(), api.rng
//   events pokemonCaught, gachaEggTier, gachaEggBoosted, gachaEggMark, gachaPull, pokemonStatBonus, itemInfo
// Added here: when a mod is switched off, the stat bonus and the icon are taken away at once (X.onSwitch at the end).
// 引擎扩展（本地）：「训练家提升」要用的几个钩子，普通 mod 接口里没有，另外还提供一个局外数据仓库。
//
//   1. 捕捉到宝可梦：游戏里所有「这只宝可梦被收下了」都走 GameData.setPokemonCaught()
//      （src/system/game-data.ts）。第一次记下图鉴的那一次就是「第一次捕捉」。
//   2. 扭蛋机的蛋：Egg.prototype.rollEggTier()（src/data/egg.ts）是抽蛋时定稀有度的地方。
//      游戏的稀有度概率（src/data/balance/rates.ts）：普通 204/256、高级 44/256、超级 7/256、大师 1/256。
//      蛋的名字是 Egg.prototype.getEggDescriptor()（扭蛋机结果页、背包里的蛋列表都用它）：
//      被加成升过档的蛋，名字后面加个「+」，这样一眼能看出是哪几只。
//   3. 常驻能力值：游戏算一只宝可梦的能力值只有一处 Pokemon.calculateStats()
//      （src/field/pokemon.ts）：升级、进化、换算都会重算。加成加在重算之后，所以是「永久」的：
//      宝可梦自己的数值变大，换宝可梦也照样有（每只自己的都吃到）。
//   4. 局外数据：每个 mod 一份，存 localStorage（关掉游戏、换存档都还在）。
//   5. 成长线面板：mod 用 api.metaPanel() 描述它的成长线，这里负责画出来、扣点、升级。
//   6. 道具「训练家提升」：图标画在游戏左上角的道具栏里（和游戏自己的道具排在一起），
//      指上去/点一下，右上角出现游戏自己的道具说明面板，里面写着现在各项加了多少。
//
// 用 window.CoopModsExt 注册，和别的 engine/ext-*.js 是同一套机制，由 tools/assemble.mjs 接在引擎核心后面。
(function () {
  if (!window.CoopModsExt) return; // 引擎还没起来（顺序不对）
  window.CoopModsExt('h', function (X) {
    const log = (...a) => X.log('ext', ...a);
    const TIER_ZH = ['普通', '高级', '超级', '大师']; // EggTier: COMMON / RARE / EPIC / LEGENDARY
    const GACHA_SOURCE = [0, 1, 2]; // EggSourceType: GACHA_MOVE / GACHA_LEGENDARY / GACHA_SHINY
    const EGG_MARK = '+'; // 蛋名后面的标记：这只蛋是被加成升过档的（游戏那个像素字体里有这个字）

    // ---- 事件 ----
    X.addEvent('pokemonCaught'); // 获得一只宝可梦：{ speciesId, name, kind, first, rarity }
                                // kind: 'catch' 野外捕捉 / 'egg' 孵蛋 / 'evolution' 进化
    X.addEvent('gachaEggTier');  // 扭蛋机抽到的蛋：{ tier, sourceType, n }，返回更高的 tier（0..3）就是升级
    X.addEvent('gachaEggBoosted'); // 蛋真的被升了一档：{ tier, newTier, sourceType, n, egg }
    X.addEvent('gachaEggMark');    // 这只蛋要不要加标记：{ id, tier, boosted, egg }，返回 true 就加
    X.addEvent('gachaPull');       // 扭蛋机要抽蛋了：{ count }（这一批几个蛋）
    X.addEvent('pokemonStatBonus'); // 常驻能力值加成：{ pokemon, bonus }，往 bonus 里写比例（0.1 = +10%）
    X.addEvent('itemInfo');    // 道具说明面板里写什么：返回一段文字（mod 自己最清楚它的成长线）

    // ---- 局外数据：每个 mod 一份 ----
    const metas = {};
    const metaKey = id => 'prs-mod-meta-' + id;
    function metaOf(id) {
      if (metas[id]) return metas[id];
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(metaKey(id)) || 'null'); } catch {}
      const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      if (typeof m.points !== 'number' || !isFinite(m.points)) m.points = 0;
      if (!m.lines || typeof m.lines !== 'object') m.lines = {};
      if (!m.caught || typeof m.caught !== 'object') m.caught = {};
      m.v = 1;
      return (metas[id] = m);
    }
    function saveMeta(id) {
      try { localStorage.setItem(metaKey(id), JSON.stringify(metaOf(id))); } catch {}
    }

    // ---- 成长线面板 ----
    const panels = {};
    function costOf(line, lv) { return Math.max(0, Math.floor(typeof line.cost === 'function' ? line.cost(lv) : line.cost)); }
    X.onPanel((id, render) => {
      const def = panels[id];
      if (!def) return null;
      const m = metaOf(id);
      const on = X.isOn(id);
      const lines = def.lines || [];
      // 成长线有十来条，全展开面板很长：默认只留顶上这几行，点一下「展开」才铺开。
      // 展开状态记在局外数据里（m.open），下次打开面板还是原来那样。
      const expanded = !!m.open;
      const rows = [];
      // 顶上一行：成长点 + 展开/收起
      rows.push(X.el('div', { class: 'set' }, [
        X.el('div', { text: (def.title || '成长点') + '：' + Math.floor(m.points) + ' 点' }),
        X.el('div', { class: 'opts' }, [X.el('button', {
          text: expanded ? '收起成长线 ▲' : '展开成长线 ▼（' + lines.length + ' 条）',
          onclick: () => {
            m.open = !expanded;
            saveMeta(id);
            render();
          },
        })]),
      ]));
      if (!on) rows.push(X.el('div', { class: 'meta', text: '（打开这个 mod 才能用）' }));
      // 现在这些成长线加在一起是什么效果（mod 自己给一行汇总）
      if (def.summary) {
        const s = String(X.guard('metaPanel summary', () => def.summary(), '') || '');
        if (s) rows.push(X.el('div', { class: 'meta', text: '当前效果：' + s }));
      }
      // 刚点了升级：告诉玩家升到了几级（面板会重画，这一行留在最上面）
      if (def.lastMsg) rows.push(X.el('div', { class: 'meta', text: def.lastMsg }));
      // mod 自己想多写一行（比如「已捕捉多少种」）：note() 返回空字符串就不画
      if (def.note) {
        const nt = String(X.guard('metaPanel note', () => def.note(), '') || '');
        if (nt) rows.push(X.el('div', { class: 'meta', text: nt }));
      }
      // 收起来的时候下面什么都不画
      for (const line of expanded ? lines : []) {
        const lv = Math.max(0, Math.min(line.max || 99, Math.floor(Number(m.lines[line.id]) || 0)));
        const cost = costOf(line, lv);
        const full = lv >= (line.max || 99);
        const can = !full && m.points >= cost;
        const btn = X.el('button', {
          class: can ? '' : 'off',
          text: full ? '已满级' : '升级（' + cost + ' 点）',
          onclick: () => {
            if (full || m.points < cost) return;
            m.points -= cost;
            m.lines[line.id] = lv + 1;
            saveMeta(id);
            def.lastMsg = '刚升级：' + line.name + ' → Lv' + (lv + 1) + '/' + (line.max || 99);
            log('成长线 ' + line.id + ' → Lv' + (lv + 1));
            if (def.onChange) X.guard('metaPanel onChange', () => def.onChange(line.id, lv + 1, 'up'));
            render();
          },
        });
        if (!can) btn.setAttribute('disabled', 'disabled');
        const opts = [btn];
        // 退款：退一级，把当初升这一级花的点数原样还回来（等级降了，效果也就跟着降）
        if (lv > 0) {
          const back = costOf(line, lv - 1); // 从 lv-1 升到 lv 当时花的点数
          opts.push(X.el('button', {
            class: 'off',
            text: '退款（+' + back + ' 点）',
            onclick: () => {
              if (lv <= 0) return;
              m.points += back;
              m.lines[line.id] = lv - 1;
              saveMeta(id);
              def.lastMsg = '已退款：' + line.name + ' → Lv' + (lv - 1) + '/' + (line.max || 99);
              log('成长线 ' + line.id + ' 退了一级 → Lv' + (lv - 1));
              if (def.onChange) X.guard('metaPanel onChange', () => def.onChange(line.id, lv - 1, 'down'));
              render();
            },
          }));
        }
        rows.push(X.el('div', { class: 'set' }, [
          X.el('div', { text: line.name + '  Lv' + lv + '/' + (line.max || 99) }),
          X.el('div', { class: 'meta', text: typeof line.desc === 'function' ? String(line.desc(lv)) : String(line.desc || '') }),
          X.el('div', { class: 'opts' }, opts),
        ]));
      }
      return X.el('div', {}, rows);
    });

    X.extendApi(mod => ({
      // 局外数据（live 对象）：改了之后调 api.metaSave() 存起来
      meta: () => metaOf(mod.id),
      metaSave: () => saveMeta(mod.id),
      // 图鉴里一共有多少种：游戏自己的数据（GameData.dexData 每个物种一条），拿不到就 0
      dexTotal: () => {
        try {
          const gd = X.scene() && X.scene().gameData;
          if (gd && gd.dexData) {
            const n = Object.keys(gd.dexData).length;
            if (n > 0) return n;
          }
        } catch {}
        return 0;
      },
      // 图鉴进度：游戏自己记的「抓到过多少种 / 图鉴一共多少种」。
      // mod 用它算「图鉴越全，抓到的新宝可梦越值钱」的倍率。
      dexProgress: () => {
        let caught = 0, total = 0;
        try {
          const gd = X.scene() && X.scene().gameData;
          if (gd) {
            if (gd.dexData) total = Object.keys(gd.dexData).length;
            if (typeof gd.getSpeciesCount === 'function') {
              // 游戏统计页数「抓到多少种」用的就是这个（src/system/game-data.ts）
              caught = gd.getSpeciesCount(d => !!(d && d.caughtAttr)) || 0;
            } else if (gd.dexData) {
              caught = Object.keys(gd.dexData).filter(k => gd.dexData[k] && gd.dexData[k].caughtAttr).length;
            }
          }
        } catch {}
        const progress = total > 0 ? Math.max(0, Math.min(1, caught / total)) : 0;
        return { caught, total, progress };
      },
      // 和引擎一样的种子随机数（同样的字符串总是同样的数）：mod 用来掷骰子
      rng: X.rng,
      // 成长线面板：def = { title, summary(), note(), lines: [{ id, name, max, cost, desc(lv) }], onChange(id, lv, kind) }
      // kind 是 'up'（升级了）或 'down'（退款了）
      metaPanel(def) {
        if (panels[mod.id]) throw new Error('metaPanel: one per mod');
        if (!def || !Array.isArray(def.lines)) throw new Error('metaPanel needs lines');
        panels[mod.id] = def;
      },
    }));

    // ---- 捕捉到宝可梦 ----
    function rarityOf(gd, pokemon) {
      const species = pokemon && pokemon.species;
      if (!species) return null;
      const speciesId = species.speciesId;
      let first = true;
      try { const entry = gd && gd.dexData ? gd.dexData[speciesId] : null; first = !(entry && entry.caughtAttr); } catch {}
      let starterCost = 0; // 初始宝可梦在游戏里值几个点（1..10）：越贵越稀有
      try {
        // 第二个参数传 0：只看这只宝可梦「本来」值几个点，不算玩家用糖果降过的那部分，
        // 否则越常用的初始宝可梦反而点越少。
        if (gd && gd.starterData && gd.starterData[speciesId] && typeof gd.getSpeciesStarterValue === 'function') {
          const v = gd.getSpeciesStarterValue(speciesId, 0);
          if (Number.isFinite(v) && v > 0) starterCost = v;
        }
      } catch {}
      let baseTotal = 0;
      try { baseTotal = species.baseTotal || (species.getTotalStat ? species.getTotalStat() : 0) || 0; } catch {}
      return {
        speciesId, name: species.name || '', first,
        rarity: {
          mythical: !!species.mythical, legendary: !!species.legendary, subLegendary: !!species.subLegendary,
          baseTotal, starterCost,
        },
      };
    }
    function hookGameData(s) {
      const gd = s && s.gameData;
      if (!gd) return;
      const proto = Object.getPrototypeOf(gd);
      if (!proto || typeof proto.setPokemonCaught !== 'function') return;
      X.wrap(proto, 'setPokemonCaught', 'tg', orig => function (...args) {
        try {
          const pokemon = args[0], incrementCount = args[1], fromEgg = args[2];
          // 游戏自己的规矩（src/system/game-data.ts 的 setPokemonCaught）：
          //   incrementCount=true  是真的「获得」：野外捕捉、孵蛋、神秘遭遇，游戏都会记图鉴；
          //   incrementCount=false 是形态变化/进化，游戏只有在「根形态已经捕捉过」时才记图鉴，
          //                       否则那只是租借/借用来的，图鉴不动。
          // 所以这里照抄游戏的判断：算不算一次「获得」，和游戏自己记不记图鉴是一致的。
          let kind = null;
          if (incrementCount !== false) kind = fromEgg ? 'egg' : 'catch';
          else {
            let rootCaught = false;
            try {
              const rootId = pokemon.species.getRootSpeciesId();
              const entry = this.dexData && this.dexData[rootId];
              rootCaught = !!(entry && entry.caughtAttr);
            } catch {}
            if (rootCaught) kind = 'evolution'; // 进化出新形态
          }
          if (kind) {
            const info = rarityOf(this, pokemon);
            if (info) {
              info.kind = kind;
              for (const [m, fn] of X.listeners('pokemonCaught')) X.guard('pokemonCaught (' + (m && m.id) + ')', () => fn(info));
            }
          }
        } catch (e) { log('捕捉钩子出错：' + String((e && e.stack) || e).slice(0, 200)); }
        return orig.apply(this, args);
      });
    }

    // ---- 扭蛋机的蛋 ----
    const pulls = { n: 0 };
    let eggProto = null;
    function installEgg(proto) {
      if (!proto || eggProto === proto) return;
      eggProto = proto;
      X.wrap(proto, 'rollEggTier', 'tg', orig => function (...args) {
        const tier = orig.apply(this, args);
        try {
          if (!GACHA_SOURCE.includes(this._sourceType)) return tier; // 只有扭蛋机抽的蛋才算
          const ev = { tier, sourceType: this._sourceType, n: ++pulls.n };
          let best = tier;
          for (const [m, fn] of X.listeners('gachaEggTier')) {
            const r = X.guard('gachaEggTier (' + (m && m.id) + ')', () => fn(ev));
            if (Number.isFinite(r) && r > best) best = Math.min(3, Math.floor(r));
          }
          if (best !== tier) {
            // 记在这只蛋身上：等它的名字被画出来的时候，后面加个「+」
            this.__tgBoosted = { from: tier, to: best };
            log('蛋升了一档：' + TIER_ZH[tier] + ' -> ' + TIER_ZH[best]);
            const bev = { tier, newTier: best, sourceType: this._sourceType, n: ev.n, egg: this };
            for (const [m, fn] of X.listeners('gachaEggBoosted')) {
              X.guard('gachaEggBoosted (' + (m && m.id) + ')', () => fn(bev));
            }
          }
          return best;
        } catch (e) { log('扭蛋机钩子出错：' + String((e && e.stack) || e).slice(0, 200)); }
        return tier;
      });
      // 蛋的名字：扭蛋机结果页和背包里的蛋列表都是用它画的。
      // 被加成升过档的，后面加个「+」；问一遍开着 mod，它说自己认得这只蛋就标上
      // （mod 把自己升过档的蛋的编号记下来了，所以重开游戏以后还标得出来）。
      X.wrap(proto, 'getEggDescriptor', 'tg', orig => function (...args) {
        const s = orig.apply(this, args);
        try {
          const ev = { id: this._id, tier: this._tier, boosted: !!this.__tgBoosted, egg: this };
          let marked = ev.boosted;
          for (const [m, fn] of X.listeners('gachaEggMark')) {
            const r = X.guard('gachaEggMark (' + (m && m.id) + ')', () => fn(ev));
            if (r === true) marked = true;
          }
          return marked ? s + EGG_MARK : s;
        } catch (e) { log('蛋的标记出错：' + String((e && e.stack) || e).slice(0, 200)); }
        return s;
      });
    }
    function findEgg(s) {
      const gd = s && s.gameData;
      const eggs = gd && gd.eggs;
      if (eggs && eggs.length) installEgg(Object.getPrototypeOf(eggs[0])); // 玩家已经有蛋了
      // 扭蛋机：包住 pullEggs。抽之前先告诉 mod「这一批要抽几个」，
      // 抽完第一批就知道游戏里「蛋」这个类了（那一批还是原来的稀有度）。
      const handlers = (s.ui && s.ui.handlers) || [];
      const h = handlers.find(x => x && x.constructor && x.constructor.name === 'EggGachaUiHandler');
      if (!h || h.__tgEggHooked) return;
      h.__tgEggHooked = true;
      const orig = h.pullEggs;
      if (typeof orig !== 'function') return;
      h.pullEggs = function (...args) {
        try {
          const ev = { count: Number(args[0]) || 0 };
          for (const [m, fn] of X.listeners('gachaPull')) {
            X.guard('gachaPull (' + (m && m.id) + ')', () => fn(ev));
          }
        } catch {}
        const eggs = orig.apply(this, args);
        try { if (eggs && eggs[0]) installEgg(Object.getPrototypeOf(eggs[0])); } catch {}
        return eggs;
      };
    }

    // ---- 常驻能力值加成 ----
    // 游戏的 Pokemon.calculateStats() 按「等级 + 个体值 + 性格 + 道具」重算一只宝可梦的能力值，
    // 结果存在 pokemon.stats 里（存档也存这份）。加成加在重算之后：数值直接变大，永久有效。
    const STAT_NUM = { hp: 0, atk: 1, def: 2, spatk: 3, spdef: 4, spd: 5 };
    const applied = new WeakMap(); // 宝可梦 -> 已经算进去的加成（用来发现「该重算了」）
    const sigOf = bonus => Object.keys(bonus).sort().map(k => k + ':' + (Number(bonus[k]) || 0)).join(',');

    // 现在该加多少：问一遍在跑的 mod（没开的 mod 不在 listeners 里）
    function bonusOf(pokemon) {
      const bonus = {};
      const ev = { pokemon, bonus };
      for (const [m, fn] of X.listeners('pokemonStatBonus')) {
        X.guard('pokemonStatBonus (' + (m && m.id) + ')', () => fn(ev));
      }
      return bonus;
    }
    // 把加成加到这只宝可梦身上（只有玩家自己的宝可梦；HP 不动）
    function applyBonus(pokemon) {
      if (!pokemon || typeof pokemon.isPlayer !== 'function' || !pokemon.isPlayer()) return;
      const bonus = bonusOf(pokemon);
      applied.set(pokemon, sigOf(bonus));
      for (const key of Object.keys(bonus)) {
        const num = STAT_NUM[key];
        if (!num) continue; // HP（0）不加
        const pct = Number(bonus[key]);
        if (!isFinite(pct) || !pct) continue;
        const cur = typeof pokemon.getStat === 'function' ? pokemon.getStat(num) : (pokemon.stats || [])[num];
        if (!(cur > 0)) continue;
        const next = Math.max(1, Math.round(cur * (1 + pct)));
        if (typeof pokemon.setStat === 'function') pokemon.setStat(num, next);
        else if (pokemon.stats) pokemon.stats[num] = next;
      }
    }
    X.pokemonClass(proto => {
      X.wrap(proto, 'calculateStats', 'tg', orig => function (...args) {
        const r = orig.apply(this, args);
        try { applyBonus(this); } catch (e) { log('能力值加成出错：' + String((e && e.stack) || e).slice(0, 200)); }
        return r;
      });
    });
    // 队伍里有宝可梦是引擎找到 Pokemon 这个类之前就有的（开局选初始宝可梦那会儿），或者刚点了升级：
    // 这两种时候能力值都还没算上加成，重算一遍就补上了。
    function refreshParty() {
      let party = [];
      try { party = X.battle.party(); } catch { return; }
      for (const p of party) {
        if (!p || typeof p.isPlayer !== 'function' || !p.isPlayer()) continue;
        if (typeof p.calculateStats !== 'function') continue;
        let want = '';
        try { want = sigOf(bonusOf(p)); } catch { continue; }
        if ((applied.get(p) || '') === want) continue; // 已经是对的
        try { p.calculateStats(); applied.set(p, want); } catch (e) { log('重算能力值出错：' + String((e && e.stack) || e).slice(0, 200)); }
      }
    }

    // ---- 道具「训练家提升」 ----
    // 图标画在游戏左上角的道具栏里（就是游戏自己那排道具图标 modifier-bar 的后面），
    // 画法、位置、点开的样子都和游戏自己的道具一样：指上去/点一下，右上角出现说明面板。
    const ITEM_KEY = 'trainer-growth:boost';
    const itemView = { scene: null, icon: null, sprite: null, tip: false };

    // 道具说明面板里写什么：问一遍在跑的 mod（mod 自己最清楚每条成长线是什么）
    function itemText() {
      for (const [m, fn] of X.listeners('itemInfo')) {
        const r = X.guard('itemInfo (' + (m && m.id) + ')', () => fn(), '');
        if (typeof r === 'string' && r) return r;
      }
      return '';
    }

    // 说明面板：完全用游戏自己那一套（同样的位置规则、同样的显示/隐藏），
    // 别的道具指上去是什么样，这个就是什么样。
    function showItemInfo(s) {
      const ui = s.ui;
      if (!ui || typeof ui.showTooltip !== 'function') return;
      const it = X.items[ITEM_KEY];
      const text = itemText();
      itemView.tip = true;
      try { ui.showTooltip(it ? it.name : '训练家提升', text || '（还没有内容）'); } catch (e) { log('说明面板打不开：' + String((e && e.stack) || e).slice(0, 120)); }
    }
    function hideItemInfo(s) {
      itemView.tip = false;
      try { if (s.ui && typeof s.ui.hideTooltip === 'function') s.ui.hideTooltip(); } catch {}
    }
    // 鼠标还指着这个图标吗（图标被游戏重建以后，指针不会自己再触发一次 pointerover）
    function pointerOn(s, icon) {
      try {
        const p = s.input && s.input.activePointer;
        if (!p || typeof s.input.hitTestPointer !== 'function') return false;
        return s.input.hitTestPointer(p, icon).length > 0;
      } catch { return false; }
    }

    function drawItem(s) {
      if (!s || !s.add || !window.Phaser) return;
      const it = X.items[ITEM_KEY];
      const bar = typeof s.getModifierBar === 'function' ? s.getModifierBar() : null;
      let party = [];
      try { party = (s.getPlayerParty && s.getPlayerParty()) || []; } catch { party = []; }
      // 只有这一局真的在跑、mod 也开着的时候才画
      const on = !!it && X.isOn('trainer-growth') && X.active() && party.length > 0;
      if (!bar || !on) {
        if (itemView.icon) { try { itemView.icon.destroy(); } catch {} }
        itemView.icon = null;
        itemView.sprite = null;
        hideItemInfo(s); // 面板别留在屏幕上
        return;
      }
      // 游戏每次刷新道具栏都会把里面的图标全清掉重建，我们的也得跟着重建
      const rebuilt = !itemView.icon || !itemView.icon.scene || bar.list.indexOf(itemView.icon) < 0;
      const wasTip = itemView.tip; // 销毁图标不会触发 pointerout，面板得自己收拾
      if (rebuilt) {
        const c = new Phaser.GameObjects.Container(s, 0, 0);
        const sp = new Phaser.GameObjects.Sprite(s, 0, 12, 'items', X.frameOf(ITEM_KEY));
        sp.setOrigin(0, 0.5);
        sp.setScale(0.7); // 游戏自己的道具图标大多 22x22，我们的格子是 32x32，缩一点才一样大
        c.add(sp);
        c.setInteractive(new Phaser.Geom.Rectangle(0, 0, 32, 24), Phaser.Geom.Rectangle.Contains);
        c.on('pointerover', () => showItemInfo(s));
        c.on('pointerout', () => hideItemInfo(s));
        bar.add(c);
        itemView.icon = c;
        itemView.sprite = sp;
        itemView.scene = s;
      }
      // 图标是后来才进到游戏的道具贴图里的：贴图好了就把帧换上去
      try {
        const frame = X.frameOf(ITEM_KEY);
        if (itemView.sprite && itemView.sprite.frame.name !== frame) itemView.sprite.setFrame(frame);
      } catch {}
      // 位置：跟在游戏自己的道具后面（游戏自己的排法：每行 12 个，间隔 26 像素）
      const idx = bar.list.indexOf(itemView.icon);
      const count = bar.list.length;
      const rowIcons = 12 + 6 * Math.max(Math.ceil(Math.min(count, 24) / 12) - 2, 0);
      itemView.icon.setPosition((idx % rowIcons) * 26 / (rowIcons / 12), Math.floor(idx / rowIcons) * 20);
      itemView.icon.setVisible(true);
      // 刚重建过：说明面板得自己收拾一下（图标被销毁时不会触发 pointerout）
      if (rebuilt && wasTip) {
        if (pointerOn(s, itemView.icon)) showItemInfo(s); // 鼠标还指着它：面板留着
        else hideItemInfo(s); // 已经不在上面了：面板关掉
      }
      // 道具一直在队伍背包里：这样它就是一个真的道具（面板里能看到，也就不会被当成随机奖励发出去）
      try { if (X.count(null, ITEM_KEY) < 1) X.give(null, ITEM_KEY, {}, 'mod'); } catch {}
    }
    X.debug('tgItemInfo', () => itemText()); // 给测试用：说明面板里现在写着什么

    X.onTick(s => {
      try { hookGameData(s); findEgg(s); refreshParty(); drawItem(s); } catch (e) { log('扩展出错：' + String((e && e.stack) || e).slice(0, 200)); }
    });
    // 开关变了（工坊这边加的）：单人模式里把最后一个 mod 关掉以后引擎就不再每拍跑了，
    // 所以关的那一下要自己收拾一次：能力值重算回原样，道具栏里的图标拿掉。
    X.onSwitch(() => {
      const s = X.scene();
      if (!s) return;
      try { refreshParty(); drawItem(s); } catch (e) { log('开关收尾出错：' + String((e && e.stack) || e).slice(0, 200)); }
    });
  });
})();
