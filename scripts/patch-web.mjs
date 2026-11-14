#!/usr/bin/env node
// Apply this project's additions to the game build in app/src/main/assets/web (run by scripts/sync-pokerogue.sh
// after every sync, or alone: node scripts/patch-web.mjs). Safe to run again: every step checks if it is done.
// 1. Co-op hooks in the game scripts (the same list as the desktop app's scripts/patch-coop.mjs; they change
//    nothing while no room is open): doubles only while window.PRS_COOP_TEAMS is set, the battle scene exposed
//    as window.PRS_SCENE, and "party full, release one?" asked by window.PRS_COOP_FULL() while a room is open
//    (each player may have six), after a catch (assets/battle-scene-*.js) and in mystery encounters
//    (assets/loading-scene-*.js). The doubled starter points of earlier versions are taken out again.
// 2. coop-web/ is copied to web/coop/ (host scripts, QR encoder, the "联机" panel).
// 3. index.html gets coop-web/compat.js inlined at the top of <head> (message instead of a blank screen on
//    system browsers that are too old, reload button when the game fails to load) and a tag for coop/mobile.js.
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
  // after a catch: "party full, release one?" is asked when the catcher has their six (the hook), not at six in all
  ['full', 'battle-scene', 'if(B.getPlayerParty().length===6){let e={options:[{label:q.t(`partyUiHandler:summary`)', 'if((window.PRS_COOP_TEAMS&&window.PRS_COOP_FULL?window.PRS_COOP_FULL():B.getPlayerParty().length===6)){let e={options:[{label:q.t(`partyUiHandler:summary`)',
    ['if(B.getPlayerParty().length===6||window.PRS_COOP_FULL&&window.PRS_COOP_FULL()){let e={options:[{label:q.t(`partyUiHandler:summary`)']],
  // the same question for a Pokémon obtained in a mystery encounter
  ['mefull', 'loading-scene', 'if(b.getPlayerParty().length===6){let t={options:[{label:k.t(`partyUiHandler:summary`)', 'if((window.PRS_COOP_TEAMS&&window.PRS_COOP_FULL?window.PRS_COOP_FULL():b.getPlayerParty().length===6)){let t={options:[{label:k.t(`partyUiHandler:summary`)', []],
  // taken out again (until 11-14 the starter points limit was doubled; now each player has their own round)
  ['points-off', 'battle-scene', null, 'default:e.value=10}return In(1,e),e.value}', ['default:e.value=10}return In(1,e),e.value*(window.PRS_COOP_TEAMS?2:1)}']],
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

const START = '<!-- prs:compat -->', END = '<!-- /prs:compat -->', TAG = '<script defer src="./coop/qrcode.js"></script><script defer src="./coop/mobile.js"></script><script defer src="./coop/gamepad.js"></script>'
const indexFile = path.join(web, 'index.html')
let html = readFileSync(indexFile, 'utf8')
const a = html.indexOf(START), b = html.indexOf(END)
if (a >= 0 && b > a) html = html.slice(0, a) + html.slice(b + END.length) // drop the old block, re-add the current one
html = html.replace(/<script defer src="\.\/coop\/[\w-]+\.js"><\/script>/g, '') // drop tags from an earlier run
if (count(html, '<head>') !== 1 || count(html, '</head>') !== 1) fail('index.html: expected exactly one <head> and </head>')
const compat = readFileSync(path.join(root, 'coop-web/compat.js'), 'utf8')
if (compat.includes('</script')) fail('compat.js must not contain </script')
html = html.replace('<head>', () => `<head>${START}<script>\n${compat}</script>${END}`).replace('</head>', () => `${TAG}</head>`)

writeFileSync(indexFile, html)
cpSync(path.join(root, 'coop-web'), path.join(web, 'coop'), { recursive: true, filter: src => !src.endsWith('compat.js') })
console.log(`patch-web: ${patched}; index.html + coop/ updated`)
