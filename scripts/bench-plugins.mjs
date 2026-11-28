// Times what the built-in plugins add to an agent's and the owner's commands, with all four of them
// (version, sync, deploy, search) installed beside the ledger: `put` of one file, `find`, `inspect`,
// `check`, a version snapshot of one thing (`say versioned`), `deploy sync`, and `sync now` with
// nothing changed. On an empty library and on a large synthetic one (about 20,000 registered things
// and 100,000 facts as two years of use, plus a closed directory of 60,000 files made unreadable),
// the median wall time and the peak memory of each. The plugins learn what is registered from the puts
// they hear, so the synthetic library's directories are put once, as an agent would register them.
// Every listing, read and probe a plugin asks storage for is logged (PNEUMA_BASE_TOOL_LOG), and the
// script says whether any of them reached into the closed directory. Run after `pnpm build`:
//   node scripts/bench-plugins.mjs [--runs 5] [--keep] [--no-synthetic]
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { writeHistory } from '../packages/viewer/e2e/month.ts'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const runs = Number(value('--runs', '5'))
const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'pb-plugins-'))
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
const PLUGINS = ['version', 'sync', 'deploy', 'search']

/** A fresh machine for one library: its own HOME and PNEUMA_BASE_HOME, and the log of what plugins ask storage. */
function machine(name) {
  const home = join(scratch, `home-${name}`)
  mkdirSync(home, { recursive: true })
  return { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), PNEUMA_BASE_TOOL_LOG: join(home, 'tools.jsonl') }
}

/** Runs of one command, the first left out as a warm-up: median wall time, peak resident memory, and the first failure. */
function measure(perRun) {
  const times = []
  let rss = 0
  let failed = null
  for (let i = 0; i <= runs; i++) {
    const { env, args, input, cwd } = perRun(i)
    const t = performance.now()
    const run = spawnSync('/usr/bin/time', ['-l', process.execPath, bin, ...args], { env, cwd, input: input ?? '', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
    const ms = performance.now() - t
    const err = String(run.stderr)
    if (run.status !== 0 && run.status !== 3) failed ??= `exit ${run.status}: ${(String(run.stdout) + err).split('\n').find((l) => l.trim() !== '')?.slice(0, 120) ?? ''}`
    if (i === 0) continue
    times.push(ms)
    rss = Math.max(rss, Number(/(\d+)\s+maximum resident set size/.exec(err)?.[1] ?? 0))
  }
  return { ms: median(times), rss, failed }
}

/** A library with the ledger and the four plugins, and the outside folders the owner sets as targets. */
function prepare(name, lib, fill) {
  const env = machine(name)
  const owner = (...a) => execFileSync(process.execPath, [bin, '--library', lib, ...a], { env, stdio: 'pipe', encoding: 'utf8' })
  execFileSync(process.execPath, [bin, 'init', lib], { env, stdio: 'ignore' })
  for (const p of PLUGINS) owner('plugin', 'enable', p)
  fill?.(lib, env)
  const outside = join(scratch, `outside-${name}`)
  mkdirSync(join(outside, 'sync'), { recursive: true })
  mkdirSync(join(outside, 'sites'), { recursive: true })
  owner('sync', 'target', 'set', '--kind', 'dir', '--to', join(outside, 'sync'))
  owner('deploy', 'target', 'set', '--kind', 'dir', '--to', join(outside, 'sites'))
  return { env, owner }
}

async function bench(name, lib, env, owner) {
  // An agent works in the library: a relative path it types names a place there.
  const agent = (i, tag, args, input) => ({ env: { ...env, CLAUDE_CODE_SESSION_ID: `bench-${tag}-${i}` }, args: ['--library', lib, ...args], input, cwd: lib })
  const quiet = (args, input) => spawnSync(process.execPath, [bin, '--library', lib, ...args], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'bench-setup' }, cwd: lib, input: input ?? '', stdio: ['pipe', 'ignore', 'ignore'] })
  const note = '# 一页笔记\n\n用来量放入、查找和版本。\n'
  quiet(['put', '-', '--to', 'bench/known.md', '--generated', '--note', '一页笔记'], note)
  for (let i = 0; i <= runs; i++) quiet(['put', '-', '--to', `bench/versioned-${i}.md`, '--generated'], `${note}${i}\n`)
  const site = join(scratch, `site-${name}`)
  mkdirSync(site, { recursive: true })
  writeFileSync(join(site, 'index.html'), '<h1>一页</h1>\n')
  quiet(['put', site, '--to', 'bench/site', '--generated'])
  quiet(['say', 'deployable', 'bench/site'])
  owner('deploy', 'on', 'bench/site')
  const t = performance.now()
  const once = spawnSync(process.execPath, [bin, '--library', lib, 'sync', 'now'], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26 })
  const first = { ms: performance.now() - t, files: filesUnder(join(scratch, `outside-${name}`, 'sync')), failed: once.status === 0 || once.status === 3 ? null : `exit ${once.status}: ${once.stdout.slice(0, 120)}` }
  const rows = {
    'put one file': measure((i) => agent(i, 'put', ['put', '-', '--to', `bench/put-${i}-${Date.now()}.md`, '--generated'], note)),
    find: measure((i) => agent(i, 'find', ['find', '笔记'])),
    inspect: measure((i) => agent(i, 'inspect', ['inspect', 'bench/known.md'])),
    check: measure((i) => agent(i, 'check', ['check'])),
    'version snapshot of one thing': measure((i) => agent(i, 'versioned', ['say', 'versioned', `bench/versioned-${i}.md`])),
    'deploy sync': measure(() => ({ env, args: ['--library', lib, 'deploy', 'sync'] })),
    'sync now, nothing changed': measure(() => ({ env, args: ['--library', lib, 'sync', 'now'] })),
  }
  return { name, rows, first }
}

/** How many files are under `dir`, its own record folder left out: what a sync carried to its target. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !e.parentPath.includes('.pneuma-sync')).length
}

/** The directories of a library that hold files, outside its record area and its archive, for the puts that register them. */
function dirsWithFiles(lib, rel = '') {
  const out = []
  const entries = readdirSync(join(lib, rel), { withFileTypes: true })
  if (rel !== '' && entries.some((e) => e.isFile())) out.push(rel)
  for (const e of entries) {
    if (!e.isDirectory() || (rel === '' && ['.pneuma-base', '_archive', 'exports'].includes(e.name))) continue
    out.push(...dirsWithFiles(lib, rel === '' ? e.name : `${rel}/${e.name}`))
  }
  return out
}

function synthetic(lib, env) {
  const cli = (...a) => execFileSync(process.execPath, [bin, '--library', lib, ...a], { env, stdio: 'ignore' })
  for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) cli('grant', 'create', grant, '--agent', agent)
  const made = writeHistory(lib, { days: 760, sessions: 14, talk: 5.2, seed: 7 })
  const t = performance.now()
  const dirs = dirsWithFiles(lib)
  for (const dir of dirs) {
    const put = spawnSync(process.execPath, [bin, '--library', lib, 'put', dir, '--generated'], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'bench-register' }, cwd: lib, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26 })
    if (put.status !== 0 && put.status !== 3) throw new Error(`put ${dir} exited ${put.status}:\n${put.stdout.slice(-2000)}\n${put.stderr.slice(-4000)}`)
  }
  console.log(`synthetic: ${made.things} things, ${made.facts} facts; ${dirs.length} directories put in ${((performance.now() - t) / 1000).toFixed(1)} s`)
  const closed = join(lib, 'exports')
  for (let d = 0; d < 60; d++) {
    const dir = join(closed, `batch-${String(d).padStart(2, '0')}`)
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 1000; f++) writeFileSync(join(dir, `row-${f}.csv`), '')
  }
  chmodSync(closed, 0o000)
  return closed
}

const results = []
const closedDirs = []
{
  const lib = join(scratch, 'empty')
  const { env, owner } = prepare('empty', lib)
  results.push({ ...(await bench('empty', lib, env, owner)), log: env.PNEUMA_BASE_TOOL_LOG })
}
if (!flag('--no-synthetic')) {
  const lib = join(scratch, 'synthetic')
  let closed = null
  const { env, owner } = prepare('synthetic', lib, (l, e) => (closed = synthetic(l, e)))
  closedDirs.push(closed)
  results.push({ ...(await bench('synthetic', lib, env, owner)), log: env.PNEUMA_BASE_TOOL_LOG, closed: 'exports' })
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`
console.log('| library | command | time | peak memory |\n| --- | --- | --- | --- |')
for (const r of results) {
  console.log(`| ${r.name} | first sync now, once (${r.first.files} files at the target after it) | ${r.first.ms.toFixed(0)} ms | |${r.first.failed ? ` failed: ${r.first.failed.replaceAll('|', '/')} |` : ''}`)
  for (const [cmd, m] of Object.entries(r.rows)) console.log(`| ${r.name} | ${cmd} | ${m.ms.toFixed(0)} ms | ${mb(m.rss)} |${m.failed ? ` failed: ${m.failed.replaceAll('|', '/')} |` : ''}`)
}
for (const r of results.filter((x) => x.closed)) {
  const lines = existsSync(r.log) ? readFileSync(r.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const inside = lines.filter((c) => c.area === 'content' && typeof c.place === 'string' && (c.place === r.closed || c.place.startsWith(`${r.closed}/`)))
  const most = lines.filter((c) => c.area === 'content' && c.tool === 'overview').reduce((n, c) => Math.max(n, c.entries ?? 0), 0)
  console.log(`${r.name}: ${lines.length} storage calls by plugins logged; ${inside.length} at or below ${r.closed}/; the largest page of the content a plugin took: ${most} entries`)
}
for (const closed of closedDirs) if (closed) chmodSync(closed, 0o755)
if (flag('--keep')) console.log(`kept: ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
