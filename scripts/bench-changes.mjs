// Times an agent's `start` and `check` and the owner's `show home` on a large library (about 20,000
// registered things and 100,000 facts, the browser tests' generator) when nothing changed, after one
// change and after 1,000 changes to registered files, with a long-lived process listening to the library
// and without one. With a listener, each learns what changed from the log storage keeps and looks only
// there; without, storage cannot say within the budget and every registered place's token is compared,
// inside storage. Run after `pnpm build`:
//   node scripts/bench-changes.mjs [--runs 5] [--keep] [--bin <bin.js>]
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { writeHistory } from '../packages/viewer/e2e/month.ts'

const argv = process.argv.slice(2)
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const runs = Number(value('--runs', '5'))
const bin = value('--bin', fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)))
const core = process.env.PNEUMA_BASE_CORE ?? fileURLToPath(new URL('../core/target/release/pneuma-base-core', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'pb-changes-'))
const home = join(scratch, 'home')
mkdirSync(home)
const env = { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base') }
const lib = join(scratch, 'lib')
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]

/** A command as the owner, or with `session` as an agent's. */
const cli = (args, session) => {
  const r = spawnSync(process.execPath, [bin, '--library', lib, ...args], { env: session === undefined ? env : { ...env, CLAUDE_CODE_SESSION_ID: session }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`${args.join(' ')}: ${String(r.stderr).slice(0, 200)}`)
  return r
}
const storage = (op, request) => JSON.parse(spawnSync(core, [op, '--root', lib, JSON.stringify(request)], { encoding: 'utf8' }).stdout)

/** The places storage reports since `cursor` without replaying: from a live listener's log, or null. */
let refusal = null
function heard(cursor) {
  const places = []
  for (let at = cursor; ; ) {
    const a = storage('changed', { cursor: at, budget: 0, limit: 10000 })
    if (a.outcome !== 'done') {
      refusal = a
      return null
    }
    places.push(...a.places)
    if (!a.more) return places
    at = a.cursor
  }
}

async function until(f, what) {
  for (let i = 0; i < 1000; i++) {
    const found = f()
    if (found) return found
    await sleep(20)
  }
  throw new Error(`not within twenty seconds: ${what()}`)
}

/**
 * Makes `n` changes to registered files and, with a listener, waits until its log has them all, a place
 * standing for its directory (STORAGE.md `changed`). When the log no longer covers the round (it lost
 * events and raised its floor) or has not heard all of it within twenty seconds, an untimed check takes
 * the ledger's mark past the round and the round is made again.
 */
async function change(n) {
  for (let attempt = 0; ; attempt++) {
    const from = storage('changed', {}).cursor
    const changed = Array.from({ length: n }, () => files[next++ % files.length])
    for (const path of changed) appendFileSync(join(lib, path), '\n')
    if (!listener) return
    const covered = (places, p) => places.some((q) => q === p || p.startsWith(`${q}/`))
    const got = await until(
      () => {
        const places = heard(from)
        return places === null ? 'lost' : changed.every((p) => covered(places, p)) ? 'all' : null
      },
      () => '',
    ).catch(() => 'late')
    if (got === 'all') return
    if (attempt === 3) throw new Error(`the listener missed a round four times (${got}): ${JSON.stringify(refusal)}`)
    lost++
    cli(['check'], 'bench-setup')
  }
}

/** The registered things' files: the content outside the record area, the archive and noise. */
function contentFiles(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return []
    const path = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) return contentFiles(dir, path)
    return e.isFile() && path !== 'PNEUMA-BASE.md' ? [path] : []
  })
}

spawnSync(process.execPath, [bin, 'init', lib], { env, stdio: 'ignore' })
for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) cli(['grant', 'create', grant, '--agent', agent])
const made = writeHistory(lib, { days: 760, sessions: 14, talk: 5.2, seed: 7 })
const files = contentFiles(lib)
console.log(`library: ${made.things} things, ${made.facts} facts, ${files.length} files in the content`)
cli(['check'], 'bench-setup')

/** What is timed: an agent's start and check, the owner's home page as text. */
const COMMANDS = [
  ['start', ['start', '看看库里有什么'], true],
  ['check', ['check'], true],
  ['show home', ['show', 'home'], false],
]
let next = 0
let lost = 0
let listener = null
const results = {}
for (const mode of ['without a listener', 'with a listener']) {
  if (mode === 'with a listener') {
    listener = spawn(core, ['serve', '--root', lib], { stdio: ['pipe', 'ignore', 'ignore'] })
    listener.stdin.write(`${JSON.stringify({ id: 'sub', op: 'subscribe' })}\n`)
    await until(
      () => heard(storage('changed', {}).cursor) !== null,
      () => 'the listener never answered',
    )
  }
  cli(['check'], 'bench-setup')
  for (const n of [0, 1, 1000]) {
    for (const [name, args, agent] of COMMANDS) {
      const times = []
      for (let r = 0; r <= runs; r++) {
        await change(n)
        const t = performance.now()
        cli(args, agent ? `bench-${name}-${mode.length}-${n}-${r}` : undefined)
        if (r > 0) times.push(performance.now() - t)
      }
      results[`${name}|${n}`] = { ...results[`${name}|${n}`], [mode]: median(times) }
    }
  }
}
listener?.kill()

console.log('| command | changed before it | without a listener | with a listener |\n| --- | --- | --- | --- |')
for (const [name] of COMMANDS) for (const n of [0, 1, 1000]) console.log(`| ${name} | ${n} | ${results[`${name}|${n}`]['without a listener'].toFixed(0)} ms | ${results[`${name}|${n}`]['with a listener'].toFixed(0)} ms |`)
if (lost > 0) console.log(`rounds made again because the listener lost events or was late: ${lost}`)
if (argv.includes('--keep')) console.log(`kept: ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
