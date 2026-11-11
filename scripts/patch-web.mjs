#!/usr/bin/env node
// Apply this project's additions to the game build in app/src/main/assets/web (run by scripts/sync-pokerogue.sh
// after every sync, or alone: node scripts/patch-web.mjs). Safe to run again: every step checks if it is done.
// 1. Co-op hooks in assets/battle-scene-*.js (same three as the desktop app; they change nothing while no
//    room is open): doubles + doubled starter points only while window.PRS_COOP_TEAMS is set, and the battle
//    scene exposed as window.PRS_SCENE.
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

const PATCHES = [
  ['doubles', 'doCheckDoubleOverride(e){switch(bl.FIELD_SIZE_OVERRIDE){', 'doCheckDoubleOverride(e){switch(window.PRS_COOP_TEAMS?`double`:bl.FIELD_SIZE_OVERRIDE){'],
  ['scene', 'window.gameInfo=t}getActiveKeys(){', 'window.gameInfo=t;window.PRS_SCENE=this}getActiveKeys(){'],
  ['points', 'default:e.value=10}return In(1,e),e.value}', 'default:e.value=10}return In(1,e),e.value*(window.PRS_COOP_TEAMS?2:1)}'],
]
const files = readdirSync(path.join(web, 'assets')).filter(f => /^battle-scene-.*\.js$/.test(f))
if (files.length !== 1) fail(`expected one assets/battle-scene-*.js in ${web}, found ${files.length}`)
const file = path.join(web, 'assets', files[0])
let code = readFileSync(file, 'utf8')
const done = []
for (const [name, from, to] of PATCHES) {
  const nFrom = count(code, from), nTo = count(code, to)
  if (nFrom === 0 && nTo === 1) { done.push(name + ' (already)'); continue }
  if (nFrom !== 1 || nTo !== 0) fail(`patch "${name}" found ${nFrom} times (patched form ${nTo} times), expected 1 and 0; the game build changed, update scripts/patch-web.mjs. Nothing written.`)
  code = code.replace(from, () => to)
  done.push(name)
}

const START = '<!-- prs:compat -->', END = '<!-- /prs:compat -->', TAG = '<script defer src="./coop/qrcode.js"></script><script defer src="./coop/mobile.js"></script>'
const indexFile = path.join(web, 'index.html')
let html = readFileSync(indexFile, 'utf8')
const a = html.indexOf(START), b = html.indexOf(END)
if (a >= 0 && b > a) html = html.slice(0, a) + html.slice(b + END.length) // drop the old block, re-add the current one
html = html.split(TAG).join('')
if (count(html, '<head>') !== 1 || count(html, '</head>') !== 1) fail('index.html: expected exactly one <head> and </head>')
const compat = readFileSync(path.join(root, 'coop-web/compat.js'), 'utf8')
if (compat.includes('</script')) fail('compat.js must not contain </script')
html = html.replace('<head>', () => `<head>${START}<script>\n${compat}</script>${END}`).replace('</head>', () => `${TAG}</head>`)

if (done.some(d => !d.endsWith('(already)'))) writeFileSync(file, code)
writeFileSync(indexFile, html)
cpSync(path.join(root, 'coop-web'), path.join(web, 'coop'), { recursive: true, filter: src => !src.endsWith('compat.js') })
console.log(`patch-web: ${files[0]}: ${done.join(', ')}; index.html + coop/ updated`)
