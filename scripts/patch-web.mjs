#!/usr/bin/env node
// Apply this project's additions to the game build in app/src/main/assets/web (run by scripts/sync-pokerogue.sh
// after every sync, or alone: node scripts/patch-web.mjs). Safe to run again: every step checks if it is done.
// 1. Co-op hooks in the game scripts (the same list as the desktop app's scripts/patch-coop.mjs; they change
//    nothing while no room is open): doubles only while window.PRS_COOP_TEAMS is set, the battle scene exposed
//    as window.PRS_SCENE, and "party full, release one?" asked by window.PRS_COOP_FULL() while a room is open
//    (each player may have six), after a catch (assets/battle-scene-*.js) and in mystery encounters
//    (assets/loading-scene-*.js). The doubled starter points of earlier versions are taken out again.
//    Since 11-18 (mod interface v3) four numbers the game has written in are asked of the mod engine when it is
//    there: starter points (window.PRS_POINTS), how many starters (PRS_STARTER_MAX), the rarity thresholds of a
//    reward slot (PRS_T), and the party size outside a room (PRS_PARTY_MAX). Asked for by Chess12333's 进阶 mod.
// 2. coop-web/ is copied to web/coop/ (host scripts, QR encoder, the "联机" panel).
// 3. index.html gets coop-web/compat.js inlined at the top of <head> (message instead of a blank screen on
//    system browsers that are too old, reload button when the game fails to load) and a tag for coop/mobile.js.
//    Since 11-18 the mod engine and the mods (coop/host-mods.js, coop/mods-bundle.js) are loaded with every page
//    too: a mod may run in a single-player game (mod interface v3). With no mod switched on they touch nothing.
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.resolve(process.argv[2] || path.join(root, 'app/src/main/assets/web'))
const count = (s, sub) => s.split(sub).length - 1
const fail = msg => { console.error('patch-web: ' + msg); process.exit(1) }

// [name, file (assets/<file>-*.js), original text, patched text, earlier patched forms that are brought up to date]
const PATCHES = [
  ['doubles', 'battle-scene', 'doCheckDoubleOverride(e){switch(bl.FIELD_SIZE_OVERRIDE){', 'doCheckDoubleOverride(e){switch(window.PRS_COOP_TEAMS?`double`:bl.FIELD_SIZE_OVERRIDE){', []],
  ['scene', 'battle-scene', 'window.gameInfo=t}getActiveKeys(){', 'window.gameInfo=t;window.PRS_SCENE=this}getActiveKeys(){', []],
  // after a catch: "party full, release one?" is asked when the catcher has their six (the hook), not at six in all.
  // Without a room: at window.PRS_PARTY_MAX() in the party (the mod engine; six when no mod says otherwise)
  ['full', 'battle-scene', 'if(B.getPlayerParty().length===6){let e={options:[{label:q.t(`partyUiHandler:summary`)', 'if((window.PRS_COOP_TEAMS&&window.PRS_COOP_FULL?window.PRS_COOP_FULL():B.getPlayerParty().length>=(window.PRS_PARTY_MAX?window.PRS_PARTY_MAX():6))){let e={options:[{label:q.t(`partyUiHandler:summary`)',
    ['if(B.getPlayerParty().length===6||window.PRS_COOP_FULL&&window.PRS_COOP_FULL()){let e={options:[{label:q.t(`partyUiHandler:summary`)',
      'if((window.PRS_COOP_TEAMS&&window.PRS_COOP_FULL?window.PRS_COOP_FULL():B.getPlayerParty().length===6)){let e={options:[{label:q.t(`partyUiHandler:summary`)']],
  // the same question for a Pokémon obtained in a mystery encounter
  ['mefull', 'loading-scene', 'if(b.getPlayerParty().length===6){let t={options:[{label:k.t(`partyUiHandler:summary`)', 'if((window.PRS_COOP_TEAMS&&window.PRS_COOP_FULL?window.PRS_COOP_FULL():b.getPlayerParty().length>=(window.PRS_PARTY_MAX?window.PRS_PARTY_MAX():6))){let t={options:[{label:k.t(`partyUiHandler:summary`)',
    ['if((window.PRS_COOP_TEAMS&&window.PRS_COOP_FULL?window.PRS_COOP_FULL():b.getPlayerParty().length===6)){let t={options:[{label:k.t(`partyUiHandler:summary`)']],
  // limits a mod may change (mod interface v3, coop/host-mods.js defines the window.PRS_* functions; each answers
  // the game's own number while no mod says otherwise). points: the starter points of a classic run (until
  // 11-14 this place doubled them in a room: that form is brought up to date too)
  ['points', 'battle-scene', 'default:e.value=10}return In(1,e),e.value}', 'default:e.value=(window.PRS_POINTS?window.PRS_POINTS():10)}return In(1,e),e.value}', ['default:e.value=10}return In(1,e),e.value*(window.PRS_COOP_TEAMS?2:1)}']],
  // how many starters may be picked (adding one, and the "random" button)
  ['starteradd', 'battle-scene', 'this.partyStarterIds.length<6', 'this.partyStarterIds.length<(window.PRS_STARTER_MAX?window.PRS_STARTER_MAX():6)', []],
  ['starterrand', 'battle-scene', 'this.partyStarterIds.length>=6', 'this.partyStarterIds.length>=(window.PRS_STARTER_MAX?window.PRS_STARTER_MAX():6)', []],
  // the rarity of a reward slot: the roll of 0..1023 against three thresholds
  ['rewardtier', 'loading-scene', 't>255?0:t>60?1:t>12?2:t?3:4', 't>(window.PRS_T?window.PRS_T(2):255)?0:t>(window.PRS_T?window.PRS_T(1):60)?1:t>(window.PRS_T?window.PRS_T(0):12)?2:t?3:4', []],
]

// Apply PATCHES to the game build in <dir>/assets. Every patch must be found exactly once in exactly one file
// (as the original text, as the patched text, or as one earlier patched form); otherwise nothing is written.
function patchGame(dir, tag) {
  const assets = path.join(dir, 'assets'), all = readdirSync(assets), code = {}, changed = new Set(), done = []
  const fail = msg => { console.error(`${tag}: ${msg}. The game build changed: update the patches in scripts/${tag}.mjs. Nothing written.`); process.exit(1) }
  for (const [name, prefix, from, to, earlier] of PATCHES) {
    const hits = []
    for (const f of all.filter(f => f.startsWith(prefix + '-') && f.endsWith('.js'))) {
      code[f] ??= readFileSync(path.join(assets, f), 'utf8')
      const forms = [from, to, ...earlier].map(t => (t == null ? 0 : count(code[f], t)))
      if (forms.some(Boolean)) hits.push([f, forms])
    }
    if (hits.length !== 1) fail(`patch "${name}" matches ${hits.length} files named ${prefix}-*.js, expected 1`)
    const [f, forms] = hits[0], which = forms.findIndex(Boolean)
    if (forms.reduce((a, b) => a + b, 0) !== 1) fail(`patch "${name}" found ${forms.join('/')} times in ${f} (original/patched/earlier forms), expected exactly one`)
    if (which === 1) { done.push(name + ' (already)'); continue }
    code[f] = code[f].replace([from, to, ...earlier][which], () => to)
    changed.add(f)
    done.push(name + (which > 1 ? ' (updated)' : ''))
  }
  for (const f of changed) writeFileSync(path.join(assets, f), code[f])
  return `${[...changed].join(' + ') || 'nothing to write'}: ${done.join(', ')}`
}
const patched = patchGame(web, 'patch-web')

const START = '<!-- prs:compat -->', END = '<!-- /prs:compat -->', TAG = '<script defer src="./coop/qrcode.js"></script><script defer src="./coop/host-mods.js"></script><script defer src="./coop/mods-bundle.js"></script><script defer src="./coop/mobile.js"></script><script defer src="./coop/gamepad.js"></script>'
const indexFile = path.join(web, 'index.html')
let html = readFileSync(indexFile, 'utf8')
const a = html.indexOf(START), b = html.indexOf(END)
if (a >= 0 && b > a) html = html.slice(0, a) + html.slice(b + END.length) // drop the old block, re-add the current one
html = html.replace(/<script defer src="\.\/coop\/[\w-]+\.js"><\/script>/g, '') // drop tags from an earlier run
if (count(html, '<head>') !== 1 || count(html, '</head>') !== 1) fail('index.html: expected exactly one <head> and </head>')
const compat = readFileSync(path.join(root, 'coop-web/compat.js'), 'utf8')
if (compat.includes('</script')) fail('compat.js must not contain </script')
// save-guard.js needs the version of the bundled game: the one the game itself compares saves with
const gameVersion = JSON.parse(readFileSync(path.join(root, 'pokerogue-version.json'), 'utf8')).pokerogueVersion
if (!/^\d+(\.\d+)+$/.test(gameVersion || '')) fail('pokerogue-version.json: no pokerogueVersion')
if (!readdirSync(path.join(web, 'assets')).some(f => f.endsWith('.js') && readFileSync(path.join(web, 'assets', f), 'utf8').includes('.gameVersion,`' + gameVersion + '`)'))) fail(`the game build does not check saves against ${gameVersion}: update pokerogue-version.json`)
const guard = readFileSync(path.join(root, 'coop-web/save-guard.js'), 'utf8')
if (guard.includes('</script')) fail('save-guard.js must not contain </script')
html = html.replace('<head>', () => `<head>${START}<script>\n${compat}</script><script>window.PRS_GAME_VERSION=${JSON.stringify(gameVersion)};\n${guard}</script>${END}`).replace('</head>', () => `${TAG}</head>`)

writeFileSync(indexFile, html)
cpSync(path.join(root, 'coop-web'), path.join(web, 'coop'), { recursive: true, filter: src => !src.endsWith('compat.js') && !src.endsWith('save-guard.js') })
console.log(`patch-web: ${patched}; index.html + coop/ updated`)
