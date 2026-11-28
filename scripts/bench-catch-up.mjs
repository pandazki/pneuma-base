// What each built-in plugin knows of a library it is added to after 2,000 things were registered, and
// what catching up costs: a library with only the ledger gets 1,990 notes and 10 sites registered, then
// version, sync, deploy and search are added one after another. For each: the time `plugin enable` takes,
// what it said, how many storage calls the plugin made in it (PNEUMA_BASE_TOOL_LOG) and per page of the
// register, then whether it knows an old thing: search finds one by a word in it, sync carries the old
// things to its target, a version is taken of an old note, an old site is deployed. Last, on a fresh
// copy, search's catching up is stopped after its first page (SIGINT, as Ctrl-C) and goes on with
// `plugin backfill search`. Run after `pnpm build`:
//   node scripts/bench-catch-up.mjs [--bin <path to bin.js>] [--keep]
// `--bin` runs another build, such as one from before catching up existed, to see what plugins knew then.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const bin = value('--bin', fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'pb-catch-up-'))
const NOTES = 1990
const SITES = 10

function machine(name) {
  const home = join(scratch, `home-${name}`)
  mkdirSync(home, { recursive: true })
  return { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), PNEUMA_BASE_TOOL_LOG: join(home, 'tools.jsonl') }
}

const call = (env, lib, args, opts = {}) => {
  const t = performance.now()
  const r = spawnSync(process.execPath, [bin, '--library', lib, ...args], { env: { ...env, ...(opts.agent ? { CLAUDE_CODE_SESSION_ID: 'bench-catch-up' } : {}) }, cwd: lib, input: opts.input ?? '', encoding: 'utf8', maxBuffer: 1 << 26 })
  return { ms: performance.now() - t, code: r.status, out: r.stdout, err: r.stderr }
}

/** The storage calls a plugin made since the log had `from` lines. */
function callsOf(env, plugin, from) {
  const lines = readFileSync(env.PNEUMA_BASE_TOOL_LOG, 'utf8').split('\n').filter(Boolean).slice(from)
  return lines.map((l) => JSON.parse(l)).filter((c) => c.plugin === plugin)
}
const logLength = (env) => {
  try {
    return readFileSync(env.PNEUMA_BASE_TOOL_LOG, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/** A library with only the ledger: 1,990 notes, each with its own word, registered a page at a time, and 10 sites, each with a file three levels down. */
function library(env, lib) {
  execFileSync(process.execPath, [bin, 'init', lib], { env, stdio: 'ignore' })
  call(env, lib, ['put', '-', '--to', 'notes/n0000.md', '--generated'], { agent: true, input: 'note 0 word0\n' })
  for (let i = 1; i < NOTES; i++) writeFileSync(join(lib, 'notes', `n${String(i).padStart(4, '0')}.md`), `note ${i} word${i}\n`)
  for (let i = 0; i < Math.ceil(NOTES / 200); i++) call(env, lib, ['put', 'notes', '--generated'], { agent: true })
  for (let s = 0; s < SITES; s++) {
    const site = join(scratch, `site-${s}`)
    mkdirSync(join(site, 'a/b'), { recursive: true })
    writeFileSync(join(site, 'index.html'), `<h1>site ${s}</h1>\n`)
    writeFileSync(join(site, 'a/b/deep.txt'), `deep ${s} sitedeep${s}\n`)
    call(env, lib, ['put', site, '--to', `sites/s${s}`, '--generated'], { agent: true })
  }
}

const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !e.parentPath.includes('.pneuma-sync')).length
const saidLine = (text) => text.split('\n').find((l) => l.includes('补')) ?? text.split('\n')[0]

const env = machine('main')
const lib = join(scratch, 'lib')
const t0 = performance.now()
library(env, lib)
console.log(`library: ${NOTES} notes and ${SITES} sites registered in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
const copy = join(scratch, 'lib-copy')
cpSync(lib, copy, { recursive: true })

const outside = join(scratch, 'outside')
mkdirSync(join(outside, 'sync'), { recursive: true })
mkdirSync(join(outside, 'sites'), { recursive: true })

const rows = []
for (const plugin of ['version', 'sync', 'deploy', 'search']) {
  const from = logLength(env)
  const added = call(env, lib, ['plugin', 'enable', plugin])
  const calls = callsOf(env, plugin, from)
  const keeper = callsOf(env, 'ledger', from)
  // One report before the first page, one after each; storage's progress joins a report with ' · '.
  const pages = Math.max(0, added.err.split('\n').filter((l) => l.includes('补上装上之前登记的东西：') && !l.includes(' · ')).length - 1)
  let knows
  if (plugin === 'search') {
    const found = call(env, lib, ['find', 'word1234'], { agent: true }).out
    const deep = call(env, lib, ['find', 'sitedeep7'], { agent: true }).out
    knows = `find word1234 ${found.includes('notes/n1234.md') ? 'finds notes/n1234.md' : 'finds nothing'}; find sitedeep7 ${deep.includes('sites/s7') ? 'finds sites/s7' : 'finds nothing'}`
  } else if (plugin === 'sync') {
    call(env, lib, ['sync', 'target', 'set', '--kind', 'dir', '--to', join(outside, 'sync')])
    const now = call(env, lib, ['sync', 'now'])
    const count = (dir) => (existsSync(join(outside, 'sync', dir)) ? readdirSync(join(outside, 'sync', dir)).length : 0)
    knows = `sync now ${now.ms.toFixed(0)} ms: ${count('notes')} of ${NOTES} notes and ${count('sites')} of ${SITES} sites at the target (${filesUnder(join(outside, 'sync'))} files)`
  } else if (plugin === 'version') {
    const said = call(env, lib, ['say', 'versioned', 'notes/n0777.md'], { agent: true })
    knows = `say versioned notes/n0777.md: ${said.out.trim().split('\n')[0]}`
  } else {
    call(env, lib, ['deploy', 'target', 'set', '--kind', 'dir', '--to', join(outside, 'sites')])
    call(env, lib, ['say', 'deployable', 'sites/s3'], { agent: true })
    const on = call(env, lib, ['deploy', 'on', 'sites/s3'])
    knows = `deploy on sites/s3: ${on.out.trim().split('\n').at(-1)}`
  }
  rows.push({ plugin, ms: added.ms, said: saidLine(added.out), calls: calls.length, keeper: keeper.length, pages, knows })
}
console.log('| plugin | plugin enable | what it said | its storage calls (the ledger\'s) | pages | per page | what it knows of the old things |\n| --- | --- | --- | --- | --- | --- | --- |')
for (const r of rows) console.log(`| ${r.plugin} | ${r.ms.toFixed(0)} ms | ${r.said} | ${r.calls} (${r.keeper}) | ${r.pages} | ${r.pages > 0 ? `${(r.ms / r.pages).toFixed(0)} ms, ${((r.calls + r.keeper) / r.pages).toFixed(1)} calls` : ''} | ${r.knows} |`)

// Stopped after the first page, then gone on with.
{
  const env2 = machine('copy')
  const t = performance.now()
  const child = spawn(process.execPath, [bin, '--library', copy, 'plugin', 'enable', 'search'], { env: env2, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (b) => (out += b))
  await new Promise((done) => {
    child.stderr.on('data', (b) => {
      const first = err === ''
      err += b
      if (first && err.includes('补上装上之前登记的东西')) child.kill('SIGINT')
    })
    child.on('close', done)
  })
  const stopped = performance.now() - t
  const line = call(env2, copy, ['find', 'word1234'], { agent: true }).out.trim().split('\n').at(-1)
  const resumed = call(env2, copy, ['plugin', 'backfill', 'search'])
  const after = call(env2, copy, ['find', 'word1234'], { agent: true }).out
  console.log(`stopped: plugin enable search ${stopped.toFixed(0)} ms: ${out.trim().split('\n').find((l) => l.includes('补')) ?? out.trim()}`)
  console.log(`meanwhile find's last line: ${line}`)
  console.log(`plugin backfill search ${resumed.ms.toFixed(0)} ms: ${resumed.out.trim() || resumed.err.trim()}`)
  console.log(`then find word1234 ${after.includes('notes/n1234.md') ? 'finds notes/n1234.md' : 'finds nothing'}${after.includes('接着补') ? ', still with the line' : ''}`)
}

if (argv.includes('--keep')) console.log(`kept: ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
