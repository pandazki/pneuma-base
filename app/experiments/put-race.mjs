// Can a watcher take an agent's put for a file the owner copied in? Two experiments on a library:
//
//   node app/experiments/put-race.mjs window <library> [puts]
//     While an agent puts files one after another, polls as fast as it can for the new file and for
//     a new ledger fact: the time between the two is how long the file is in the library unrecorded.
//
//   node app/experiments/put-race.mjs marks <library> [puts]
//     Without the app: while an agent puts files one after another, two readers read the ledger's
//     standing page back to back, as the watcher does. A put marks its paths before it places them,
//     so no path should ever be listed as nobody's while its put runs. Files written in place now
//     and then, with no put, are the control: the readers must list those.
//
//   node app/experiments/put-race.mjs app <library> [puts]
//     With the app running on <library>, an agent puts files the way the cognition says (from
//     outside the library), small ones and 50 MB ones, each after a pause just about as long as the
//     watcher waits for quiet, so its looks fall on puts in progress. Then it also writes files in
//     place with its own tools and registers them after a delay. It reads each file's origin, and
//     from the app's log how many of the watcher's looks ran while a put did.
//
// PNEUMA_BASE_HOME must be set to the app's; the command line is this checkout's packages/cli/dist/bin.js.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/cli/dist/bin.js')
const [mode, library, count = '40', outFile, stopFile] = process.argv.slice(2)
if (!library || !process.env.PNEUMA_BASE_HOME || !['window', 'marks', 'app', 'read'].includes(mode)) {
  console.error('usage: PNEUMA_BASE_HOME=<home> node put-race.mjs window|marks|app <library> [puts]')
  process.exit(1)
}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|ANTIGRAVITY|PNEUMA_BASE_SESSION)/.test(k)))
const pb = (...args) => spawnSync(process.execPath, [CLI, '--library', library, ...args], { env, encoding: 'utf8' })
const outside = mkdtempSync(join(tmpdir(), 'put-race-'))
const factsDir = join(library, '.pneuma-base/ledger/facts')
// Wall-clock milliseconds, the clock of the app's log and of the readers.
const now = () => performance.timeOrigin + performance.now()
// The paths a section of the standing page lists, as the watcher reads them.
const listed = (json, title) => {
  try {
    return JSON.parse(json)
      .blocks.filter((b) => b.kind === 'section' && b.title === title)
      .flatMap((b) => b.blocks)
      .flatMap((b) => b.items ?? [])
      .map((item) => item.cell.link?.params?.path ?? item.cell.text)
  } catch {
    return []
  }
}

if (mode === 'read') {
  // One reader of the marks experiment: reads the standing page until told to stop.
  while (!existsSync(stopFile)) {
    const t0 = now()
    const out = pb('show', 'ledger.standing', '--json').stdout
    appendFileSync(outFile, JSON.stringify({ t0, t1: now(), nobodys: listed(out, '没人登记过的') }) + '\n')
  }
  process.exit(0)
}

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
} else if (mode === 'marks') {
  const n = Number(count)
  const big = join(outside, 'big.bin')
  writeFileSync(big, Buffer.alloc(50 * 1024 * 1024, 7))
  const factFiles = () => readdirSync(factsDir).reduce((sum, scene) => sum + readdirSync(join(factsDir, scene)).length, 0)
  const stop = join(outside, 'stop')
  const outs = [0, 1].map((i) => join(outside, `reader-${i}.jsonl`))
  const readers = outs.map((out) => spawn(process.execPath, [fileURLToPath(import.meta.url), 'read', library, '0', out, stop], { env, stdio: 'ignore' }))
  await new Promise((ok) => setTimeout(ok, 1500))
  mkdirSync(join(library, 'race-marks'), { recursive: true })
  const gaps = []
  const controls = []
  for (let i = 0; i < n; i++) {
    if (i % 8 === 4) {
      const control = `race-marks/control-${process.pid}-${i}.txt`
      writeFileSync(join(library, control), `written in place ${i}\n`)
      controls.push(control)
    }
    const kind = i % 4 === 3 ? 'big' : 'small'
    const from = kind === 'big' ? big : join(outside, `m${i}.txt`)
    if (kind === 'small') writeFileSync(from, `small ${i}\n`)
    const to = `race-marks/${kind}-${process.pid}-${i}${kind === 'big' ? '.bin' : '.txt'}`
    const before = factFiles()
    const child = spawn(process.execPath, [CLI, '--library', library, '--as', 'race-agent', 'put', from, '--to', to, '--made'], { env, stdio: 'ignore' })
    const started = now()
    let appeared = null
    let recorded = null
    while (now() - started < 15_000 && (appeared === null || recorded === null)) {
      if (appeared === null && existsSync(join(library, to))) appeared = now()
      if (recorded === null && factFiles() > before) recorded = now()
    }
    await new Promise((ok) => child.on('exit', ok))
    gaps.push({ to, kind, started, appeared, recorded })
  }
  await new Promise((ok) => setTimeout(ok, 1500))
  writeFileSync(stop, '')
  await Promise.all(readers.map((r) => new Promise((ok) => r.on('exit', ok))))
  const reads = outs.flatMap((out) => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []))
  const putPaths = new Set(gaps.map((g) => g.to))
  const wronglyListed = new Set(reads.flatMap((r) => r.nobodys.filter((p) => putPaths.has(p))))
  const inGap = reads.filter((r) => gaps.some((g) => g.appeared !== null && g.recorded !== null && r.t0 <= g.recorded && r.t1 >= g.appeared)).length
  const inPut = reads.filter((r) => gaps.some((g) => r.t0 <= (g.recorded ?? g.started) && r.t1 >= g.started)).length
  const seenControls = controls.filter((c) => reads.some((r) => r.nobodys.includes(c))).length
  const windows = gaps.filter((g) => g.appeared !== null && g.recorded !== null).map((g) => g.recorded - g.appeared).sort((a, b) => a - b)
  console.log(`${n} puts (${gaps.filter((g) => g.kind === 'big').length} of 50 MB); file in place with no fact for median ${windows[Math.floor(windows.length / 2)].toFixed(1)} ms, max ${windows[windows.length - 1].toFixed(1)} ms`)
  console.log(`${reads.length} reads of the standing page by two readers; ${inPut} ran while a put did, ${inGap} spanned a moment when a put's file was in place with no fact`)
  console.log(`paths of puts ever listed as nobody's: ${wronglyListed.size}${wronglyListed.size ? ` (${[...wronglyListed].join(', ')})` : ''}`)
  console.log(`control, files written in place with no put: ${seenControls} of ${controls.length} listed as nobody's`)
} else {
  const n = Number(count === '40' ? 30 : count)
  const big = join(outside, 'big.bin')
  writeFileSync(big, Buffer.alloc(50 * 1024 * 1024, 7))
  const run = (args) =>
    new Promise((ok) => {
      const child = spawn(process.execPath, [CLI, '--library', library, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.on('exit', () => ok(out))
    })
  const placed = []
  const puts = []
  for (let i = 0; i < n; i++) {
    await new Promise((ok) => setTimeout(ok, 2800 + Math.random() * 1000))
    const kind = i % 3 === 2 ? 'big' : 'small'
    const from = kind === 'big' ? big : join(outside, `p${i}.txt`)
    if (kind === 'small') writeFileSync(from, `placed ${i} ${Date.now()}\n`)
    const to = `race-app/${kind}-${process.pid}-${i}${kind === 'big' ? '.bin' : '.txt'}`
    const started = now()
    await run(['--as', 'race-agent', 'put', from, '--to', to, '--made', '--json'])
    puts.push([started, now()])
    placed.push(to)
  }
  // Written in place with the agent's own tools and registered `delay` seconds later, one at a time
  // with the library quiet in between, as an agent that ignores the cognition would.
  const inPlace = []
  for (const delay of [1, 2, 5, 10, 20]) {
    await new Promise((ok) => setTimeout(ok, 8_000))
    const to = `race-app/in-place-${process.pid}-${delay}s.txt`
    execFileSync('/bin/mkdir', ['-p', join(library, 'race-app')])
    writeFileSync(join(library, to), `written in place, registered after ${delay}s\n`)
    await new Promise((ok) => setTimeout(ok, delay * 1000))
    pb('--as', 'race-agent', 'put', to, '--made', '--json')
    inPlace.push({ to, delay })
  }
  await new Promise((ok) => setTimeout(ok, 8_000))
  const originOf = (path) => {
    const r = JSON.parse(pb('inspect', path, '--json').stdout)
    const view = r.sections.find((s) => s.title === '来历')?.data
    if (view?.kind !== 'item') return { text: `no item (${view?.kind ?? 'nothing'})`, agents: false, corrected: false }
    const who = view.entered.actor.name
    const earlier = Array.isArray(view.earlier) ? view.earlier[0] : undefined
    const corrected = earlier !== undefined
    const noted = view.versions.some((v) => v.note === '自动登记' && v.actor.kind === 'owner')
    const text = who === 'owner' ? "taken for the owner's and left so" : `${view.origin.kind} by ${who}${corrected ? `, corrected from the watcher's ${earlier.origin.kind} by ${earlier.actor.name} (${earlier.how})` : noted ? ', with a note from the watcher' : ''}`
    return { text, agents: who === 'race-agent', corrected }
  }
  // The watcher's looks, from the app's log: `watcher: looking` to `watcher: looked`.
  const log = readFileSync(join(process.env.PNEUMA_BASE_HOME, 'app/app.log'), 'utf8').split('\n')
  const looks = []
  let from = null
  for (const line of log) {
    const at = Number(line.split(' ')[0]) * 1000
    if (line.includes('watcher: looking')) from = at
    else if (line.includes('watcher: looked') && from !== null) {
      looks.push([from, at])
      from = null
    }
  }
  const span = [puts[0][0], puts[puts.length - 1][1]]
  const during = looks.filter(([a, b]) => b >= span[0] && a <= span[1])
  const overlapping = during.filter(([a, b]) => puts.some(([s, e]) => a <= e && b >= s))
  const placedOrigins = placed.map(originOf)
  console.log(`placed from outside: ${placed.length} puts (${placed.filter((p) => p.endsWith('.bin')).length} of 50 MB), ${placedOrigins.filter((o) => !o.agents).length} not the agent's, ${placedOrigins.filter((o) => o.corrected).length} first taken by the watcher`)
  console.log(`the watcher looked ${during.length} times while they ran; ${overlapping.length} of those looks overlapped a put in progress`)
  for (const { to, delay } of inPlace) console.log(`written in place, registered after ${delay}s: ${originOf(to).text}`)
}
