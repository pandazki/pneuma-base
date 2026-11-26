// Times `sync now` with nothing changed on a large library against an empty one. The large library is
// the browser tests' generator (about 20,000 things and 100,000 facts by default), and the sync's own
// facts naming every one of its files as a registered thing, written straight into the sync's facts:
// the sync learns things from the puts it hears, and a put per thing would take hours. Each library
// is synced once and once more before the timed runs, so the timed ones find nothing changed. Run
// after `pnpm build`:
//   node scripts/bench-sync.mjs [days] [sessions per day] [notes per session] [--keep]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { writeHistory } from '../packages/viewer/e2e/month.ts'

const args = process.argv.slice(2).filter((a) => a !== '--keep')
const [days = 760, sessions = 14, talk = 5.2] = args.map(Number)
const home = mkdtempSync(join(tmpdir(), 'pb-bench-sync-'))
const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url))
const env = { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base') }
const cli = (...a) => execFileSync(process.execPath, [bin, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
const time = (f) => {
  const t = performance.now()
  f()
  return performance.now() - t
}
const ms = (n) => `${n.toFixed(0)} ms`

/** The library paths of every file of the content and the archive. */
function filesOf(lib) {
  return readdirSync(lib, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(lib.length + 1))
    .filter((p) => !p.startsWith('.pneuma-base/') && p !== 'PNEUMA-BASE.md')
}

/** The sync's facts that these paths are registered things, a thousand to a fact, as storage lays facts out. */
function registerForSync(lib, paths) {
  const at = new Date().toISOString()
  const dir = join(lib, '.pneuma-base/sync/facts', at.slice(0, 10))
  mkdirSync(dir, { recursive: true })
  const lines = []
  for (let i = 0; i < paths.length; i += 1000) lines.push(JSON.stringify({ kind: 'things', id: `bench-${i}`, at, machine: 'bench', by: 'owner', paths: paths.slice(i, i + 1000) }))
  writeFileSync(join(dir, `${at.replace(/[^0-9]/g, '')}-bench00-000000.jsonl`), `${lines.join('\n')}\n`)
}

function library(name, large) {
  const lib = join(home, name)
  const target = join(home, `${name}-target`)
  cli('init', lib)
  // The generator writes facts of agents with these grants; grant names are this machine's, so only one library has them.
  if (large) for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) cli('--library', lib, 'grant', 'issue', grant, '--agent', agent)
  cli('plugin', 'add', 'sync', '--library', lib)
  cli('sync', 'target', 'set', '--kind', 'dir', '--to', target, '--library', lib)
  if (large) {
    const made = writeHistory(lib, { days, sessions, talk, seed: 7 })
    const paths = filesOf(lib)
    registerForSync(lib, paths)
    console.log(`${name}: ${made.things} things in the ledger, ${made.facts} facts, ${paths.length} files registered for the sync`)
    console.log(`${name}: first command, folding the ledger's facts: ${ms(time(() => cli('--library', lib, 'ledger', 'stats', '--period', '7d')))}`)
  }
  console.log(`${name}: first sync now, carrying everything: ${ms(time(() => cli('sync', 'now', '--library', lib)))}`)
  cli('sync', 'now', '--library', lib)
  const runs = [0, 1, 2, 3, 4].map(() => time(() => cli('sync', 'now', '--library', lib)))
  const status = [0, 1, 2].map(() => time(() => cli('sync', 'status', '--library', lib)))
  console.log(`${name}: sync now with nothing changed: ${ms(median(runs))} (runs ${runs.map(ms).join(', ')}); sync status: ${ms(median(status))}`)
  return median(runs)
}

const empty = library('empty', false)
const large = library('large', true)
console.log(`large / empty: ${(large / empty).toFixed(2)}`)

if (process.argv.includes('--keep')) console.log(`kept: ${home}`)
else rmSync(home, { recursive: true, force: true })
