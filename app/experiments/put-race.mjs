// Can a watcher take an agent's put for a file the owner copied in? Two experiments on a library:
//
//   node app/experiments/put-race.mjs window <library> [puts]
//     While an agent puts files one after another, polls as fast as it can for the new file and for
//     a new ledger fact: the time between the two is how long the file is in the library as nobody's.
//
//   node app/experiments/put-race.mjs app <library>
//     With the app running on <library>, an agent puts files the way the cognition says (from
//     outside the library), and also writes files in place with its own tools and registers them
//     after a delay. Then it reads each file's origin: brought by the owner means the watcher took it.
//
// PNEUMA_BASE_HOME must be set; the command line is this checkout's packages/cli/dist/bin.js.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/cli/dist/bin.js')
const [mode, library, count = '40'] = process.argv.slice(2)
if (!library || !process.env.PNEUMA_BASE_HOME || !['window', 'app'].includes(mode)) {
  console.error('usage: PNEUMA_BASE_HOME=<home> node put-race.mjs window|app <library> [puts]')
  process.exit(1)
}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|ANTIGRAVITY|PNEUMA_BASE_SESSION)/.test(k)))
const pb = (...args) => spawnSync(process.execPath, [CLI, '--library', library, ...args], { env, encoding: 'utf8' })
const agentPut = (from, to) => pb('--as', 'race-agent', 'put', from, '--to', to, '--made', '--json')
const outside = mkdtempSync(join(tmpdir(), 'put-race-'))
const factsDir = join(library, '.pneuma-base/ledger/facts')

if (mode === 'window') {
  // Polls the target path and the fact files as fast as it can while the put runs: the time between
  // the file appearing and the first new fact is the window in which the file is nobody's.
  const n = Number(count)
  const big = join(outside, 'big.bin')
  writeFileSync(big, Buffer.alloc(50 * 1024 * 1024, 7))
  const factFiles = () => readdirSync(factsDir).reduce((sum, scene) => sum + readdirSync(join(factsDir, scene)).length, 0)
  const rows = []
  for (let i = 0; i < n; i++) {
    const kind = i % 4 === 3 ? 'big' : 'small'
    const from = kind === 'big' ? big : join(outside, `s${i}.txt`)
    if (kind === 'small') writeFileSync(from, `small ${i}\n`)
    const to = `race/${kind}-${process.pid}-${i}${kind === 'big' ? '.bin' : '.txt'}`
    const before = factFiles()
    const child = spawn(process.execPath, [CLI, '--library', library, '--as', 'race-agent', 'put', from, '--to', to, '--made'], { env, stdio: 'ignore' })
    const started = performance.now()
    let appeared = null
    let recorded = null
    while (performance.now() - started < 10_000 && (appeared === null || recorded === null)) {
      if (appeared === null && existsSync(join(library, to))) appeared = performance.now()
      if (recorded === null && factFiles() > before) recorded = performance.now()
    }
    await new Promise((ok) => child.on('exit', ok))
    rows.push({ kind, window: appeared !== null && recorded !== null ? recorded - appeared : null })
  }
  for (const kind of ['small', 'big']) {
    const windows = rows.filter((r) => r.kind === kind && r.window !== null).map((r) => r.window).sort((a, b) => a - b)
    const pct = (p) => windows[Math.min(windows.length - 1, Math.floor(p * windows.length))].toFixed(1)
    console.log(`${kind}: ${windows.length} puts; file in place with no fact for median ${pct(0.5)} ms, max ${pct(1)} ms`)
  }
  console.log(`fact files in the ledger now: ${factFiles()}`)
} else {
  const placed = []
  for (let i = 0; i < 20; i++) {
    const from = join(outside, `p${i}.txt`)
    writeFileSync(from, `placed ${i} ${Date.now()}\n`)
    const to = `race-app/placed-${process.pid}-${i}.txt`
    agentPut(from, to)
    placed.push(to)
  }
  // Written in place with the agent's own tools and registered `delay` seconds later, one at a time
  // with the library quiet in between, as an agent that ignores the cognition would.
  const inPlace = []
  for (const delay of [2, 5, 10, 20]) {
    await new Promise((ok) => setTimeout(ok, 12_000))
    const to = `race-app/in-place-${process.pid}-${delay}s.txt`
    execFileSync('/bin/mkdir', ['-p', join(library, 'race-app')])
    writeFileSync(join(library, to), `written in place, registered after ${delay}s\n`)
    await new Promise((ok) => setTimeout(ok, delay * 1000))
    pb('--as', 'race-agent', 'put', to, '--made', '--json')
    inPlace.push({ to, delay })
  }
  await new Promise((ok) => setTimeout(ok, 10_000))
  const originOf = (path) => {
    const r = JSON.parse(pb('inspect', path, '--json').stdout)
    const view = r.sections.find((s) => s.title === '来历')?.data
    if (view?.kind !== 'item') return `no item (${view?.kind ?? 'nothing'})`
    const noted = view.said.some((s) => s.text === '自动登记') || view.versions.some((v) => v.note === '自动登记')
    const who = view.entered.actor.name
    return who === 'owner' ? 'taken for the owner\'s (brought by owner); the agent\'s put only added a note' : `${view.origin.kind} by ${who}${noted ? ', with a note from the watcher' : ''}`
  }
  const placedOrigins = placed.map(originOf)
  const takenPlaced = placedOrigins.filter((o) => !o.includes('race-agent')).length
  console.log(`placed from outside: ${placed.length} puts, ${takenPlaced} taken for the owner's`)
  for (const { to, delay } of inPlace) console.log(`written in place, registered after ${delay}s: ${originOf(to)}`)
}
