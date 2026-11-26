// Times an agent's `check` on a large library (about 20,000 registered things and 100,000 facts, the
// browser tests' generator) when nothing changed, after one change and after 1,000 changes to registered
// files, with a long-lived process listening to the library and without one. With a listener, check
// learns what changed from the log storage keeps and looks only there; without, storage cannot say
// within check's budget and every registered place's token is compared. Run after `pnpm build`:
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
function heard(cursor) {
  const places = []
  for (let at = cursor; ; ) {
    const a = storage('changed', { cursor: at, budget: 0, limit: 10000 })
    if (a.outcome !== 'done') return null
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
for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) cli(['grant', 'issue', grant, '--agent', agent])
const made = writeHistory(lib, { days: 760, sessions: 14, talk: 5.2, seed: 7 })
const files = contentFiles(lib)
console.log(`library: ${made.things} things, ${made.facts} facts, ${files.length} files in the content`)
cli(['check'], 'bench-setup')

let next = 0
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
    const times = []
    for (let r = 0; r <= runs; r++) {
      const from = storage('changed', {}).cursor
      const changed = Array.from({ length: n }, () => files[next++ % files.length])
      for (const path of changed) appendFileSync(join(lib, path), '\n')
      if (listener)
        await until(
          () => {
            const places = heard(from)
            return places !== null && changed.every((p) => places.includes(p))
          },
          () => {
            const places = heard(from)
            return places === null ? 'the listener cannot say' : `${n} changed, heard ${places.length}, missing ${changed.filter((p) => !places.includes(p)).slice(0, 3).join(', ')}`
          },
        )
      const t = performance.now()
      cli(['check'], `bench-check-${mode.length}-${n}-${r}`)
      if (r > 0) times.push(performance.now() - t)
    }
    results[n] = { ...results[n], [mode]: median(times) }
  }
}
listener?.kill()

console.log('| changed before check | without a listener | with a listener |\n| --- | --- | --- |')
for (const n of [0, 1, 1000]) console.log(`| ${n} | ${results[n]['without a listener'].toFixed(0)} ms | ${results[n]['with a listener'].toFixed(0)} ms |`)
if (argv.includes('--keep')) console.log(`kept: ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
