// Times what an agent and the owner do most: an agent's `start`, `check`, `inspect`, `find`, a `put` of
// one file and an `archive`, the owner's `show home`, and the home page's request to the management UI
// (and its poll), on an empty library, on a large
// synthetic one (about 20,000 registered things and 100,000 facts as two years of use, plus a closed
// directory of 60,000 files made unreadable), and on any library given with --real. For each: the
// median wall time, the output's size, and the peak memory of the process. Run after `pnpm build`:
//   node scripts/bench-line.mjs [--real <library folder>] [--no-synthetic] [--runs 5] [--keep] [--bin <bin.js>] [--listener]
// --listener keeps a process listening to each library while its commands run, as the management UI's
// server does; the page's server listens to its library in any case.
// A --real library is used in place: the commands write their facts into it, so give it a copy.
// --bin measures another build, such as the code before a change, on the same libraries.
// A read that fails is shown as failed with what it answered, the others still measured.
/* global fetch, Buffer */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { writeHistory } from '../packages/viewer/e2e/month.ts'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const runs = Number(value('--runs', '5'))
const bin = value('--bin', fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)))
const core = process.env.PNEUMA_BASE_CORE ?? fileURLToPath(new URL('../core/target/release/pneuma-base-core', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'pb-line-'))
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]

/** A fresh machine for one library: its own HOME and PNEUMA_BASE_HOME, nothing of this one's. */
function machine(name) {
  const home = join(scratch, `home-${name}`)
  mkdirSync(home, { recursive: true })
  return { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base') }
}

/**
 * Runs of one read, the first left out as a warm-up: median wall time and bytes printed, and the peak
 * resident memory `time -l` reports. A run that exits with an error makes the read failed, with its first words.
 */
function measure(perRun) {
  const results = []
  let rss = 0
  let failed = null
  for (let i = 0; i <= runs; i++) {
    const { env, args } = perRun(i)
    const t = performance.now()
    const run = spawnSync('/usr/bin/time', ['-l', process.execPath, bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
    const ms = performance.now() - t
    const err = String(run.stderr)
    const peak = /(\d+)\s+maximum resident set size/.exec(err)
    if (run.status !== 0) failed ??= `exit ${run.status}: ${err.split('\n').find((l) => l.trim() !== '')?.slice(0, 100) ?? ''}`
    if (i === 0) continue
    results.push({ ms, bytes: run.stdout.length })
    rss = Math.max(rss, Number(peak?.[1] ?? 0))
  }
  return { ms: median(results.map((r) => r.ms)), bytes: median(results.map((r) => r.bytes)), rss, failed }
}

/** The management UI's server for the library, and the home page's request to it. */
async function homeRequest(env, lib) {
  const server = spawn(process.execPath, [bin, 'view', lib, '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const url = await new Promise((resolve, reject) => {
    let text = ''
    server.stdout.on('data', (chunk) => {
      text += chunk
      const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([0-9a-f]+)/.exec(text)
      if (m) resolve({ origin: m[1], token: m[2] })
    })
    server.on('exit', () => reject(new Error(`the server stopped: ${text}`)))
  })
  const get = async (path) => {
    const t = performance.now()
    const res = await fetch(`${url.origin}${path}${path.includes('?') ? '&' : '?'}token=${url.token}`, { headers: { host: url.origin.slice(7) } })
    const body = await res.arrayBuffer()
    if (!res.ok) throw new Error(`${path}: ${res.status} ${Buffer.from(body).toString()}`)
    return { ms: performance.now() - t, bytes: body.byteLength }
  }
  const series = async (path) => {
    const out = []
    try {
      for (let i = 0; i <= runs; i++) {
        const r = await get(path)
        if (i > 0) out.push(r)
      }
    } catch (error) {
      return { ms: 0, bytes: 0, failed: (error instanceof Error ? error.message : String(error)).slice(0, 160) }
    }
    return { ms: median(out.map((r) => r.ms)), bytes: median(out.map((r) => r.bytes)), failed: null }
  }
  try {
    const view = await series('/api/view?view=home')
    const rev = await series('/api/rev')
    const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)], { encoding: 'utf8' }).trim()) * 1024
    return { view: { ...view, rss }, rev: { ...rev, rss } }
  } finally {
    server.kill()
  }
}

/** A process listening to the library, as the management UI's server does, once storage says it answers from what it heard. */
async function listener(lib) {
  const child = spawn(core, ['serve', '--root', lib], { stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin.write(`${JSON.stringify({ id: 'sub', op: 'subscribe' })}\n`)
  const ask = (request) => JSON.parse(spawnSync(core, ['changed', '--root', lib, JSON.stringify(request)], { encoding: 'utf8' }).stdout)
  for (let i = 0; i < 500 && ask({ cursor: ask({}).cursor, budget: 0 }).outcome !== 'done'; i++) await sleep(20)
  return child
}

async function bench(name, lib) {
  const listening = flag('--listener') ? await listener(lib) : null
  try {
    return await benchCommands(name, lib)
  } finally {
    listening?.kill()
  }
}

async function benchCommands(name, lib) {
  const env = machine(name)
  const agent = (i, tag) => ({ env: { ...env, CLAUDE_CODE_SESSION_ID: `bench-${tag}-${i}` }, args: ['--library', lib, ...(tag === 'start' ? ['start', '看看库里有什么'] : ['check'])] })
  const as = (i, tag, args) => ({ env: { ...env, CLAUDE_CODE_SESSION_ID: `bench-${tag}-${i}` }, args: ['--library', lib, ...args] })
  // What inspect, put and archive act on: one file put first, and one file per archive run, put but not timed.
  const source = join(scratch, `source-${name}.md`)
  writeFileSync(source, '# 一页笔记\n\n用来量放入。\n')
  const quiet = (args) => spawnSync(process.execPath, [bin, '--library', lib, ...args], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'bench-setup' }, stdio: 'ignore' })
  quiet(['put', source, '--to', 'bench/known.md', '--imported', '--note', '一页笔记'])
  for (let i = 0; i <= runs; i++) quiet(['put', source, '--to', `bench/old-${i}.md`, '--imported'])
  const rows = {
    start: measure((i) => agent(i, 'start')),
    check: measure((i) => agent(i, 'check')),
    'show home': measure(() => ({ env, args: ['--library', lib, 'show', 'home'] })),
    inspect: measure((i) => as(i, 'inspect', ['inspect', 'bench/known.md'])),
    find: measure((i) => as(i, 'find', ['find', '笔记'])),
    'put one file': measure((i) => as(i, 'put', ['put', source, '--to', `bench/put-${i}-${Date.now()}.md`, '--imported'])),
    archive: measure((i) => as(i, 'archive', ['archive', `bench/old-${i}.md`])),
  }
  const home = await homeRequest(env, lib)
  rows['home page'] = home.view
  rows['page poll'] = home.rev
  return { name, rows }
}

function emptyLibrary() {
  const lib = join(scratch, 'empty')
  execFileSync(process.execPath, [bin, 'init', lib], { env: machine('init-empty'), stdio: 'ignore' })
  return lib
}

function syntheticLibrary() {
  const lib = join(scratch, 'synthetic')
  const env = machine('init-synthetic')
  const cli = (...a) => execFileSync(process.execPath, [bin, ...a], { env, stdio: 'ignore' })
  cli('init', lib)
  for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) cli('--library', lib, 'grant', 'create', grant, '--agent', agent)
  const made = writeHistory(lib, { days: 760, sessions: 14, talk: 5.2, seed: 7 })
  // A folder nobody registered, too large to walk and closed to everyone: nothing may open it.
  const closed = join(lib, 'exports')
  for (let d = 0; d < 60; d++) {
    const dir = join(closed, `batch-${String(d).padStart(2, '0')}`)
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 1000; f++) writeFileSync(join(dir, `row-${f}.csv`), '')
  }
  chmodSync(closed, 0o000)
  console.log(`synthetic: ${made.things} things, ${made.facts} facts, and exports/ with 60,000 files, unreadable`)
  return { lib, closed }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`
const libraries = [['empty', emptyLibrary()]]
let closed = null
if (!flag('--no-synthetic')) {
  const s = syntheticLibrary()
  closed = s.closed
  libraries.push(['synthetic', s.lib])
}
if (value('--real', null)) libraries.push(['real', value('--real', null)])
const results = []
for (const [name, lib] of libraries) {
  try {
    results.push(await bench(name, lib))
  } catch (error) {
    results.push({ name, error: error instanceof Error ? error.message.split('\n')[0] : String(error) })
  }
}
console.log('| library | read | time | output | peak memory |\n| --- | --- | --- | --- | --- |')
for (const r of results) {
  if (r.error) console.log(`| ${r.name} | failed | ${r.error.slice(0, 120)} | | |`)
  else for (const [read, m] of Object.entries(r.rows)) console.log(`| ${r.name} | ${read} | ${m.ms.toFixed(1)} ms | ${kb(m.bytes)} | ${mb(m.rss)} |${m.failed ? ` failed: ${m.failed.replaceAll('|', '/')} |` : ''}`)
}
if (closed) chmodSync(closed, 0o755)
if (flag('--keep')) console.log(`kept: ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
