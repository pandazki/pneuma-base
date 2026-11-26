// Times the ledger on a large library: about 20,000 things and 100,000 facts by default, written as
// two years of use by three agents and the owner (the browser tests' generator). Reports the first
// and a later read of the facts in one process, the fold, the statistics of each period with their
// page, and `ledger stats` run as a command. Run after `pnpm build`:
//   node scripts/bench-ledger.mjs [days] [sessions per day] [notes per session] [--keep]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { readFacts } from '../packages/plugin-ledger/dist/facts.js'
import { fold } from '../packages/plugin-ledger/dist/fold.js'
import { statsAnswer } from '../packages/plugin-ledger/dist/stats-page.js'
import { statsOf } from '../packages/plugin-ledger/dist/stats.js'
import { writeHistory } from '../packages/viewer/e2e/month.ts'

const args = process.argv.slice(2).filter((a) => a !== '--keep')
const [days = 760, sessions = 14, talk = 5.2] = args.map(Number)
const home = mkdtempSync(join(tmpdir(), 'pb-bench-'))
const lib = join(home, 'lib')
const bin = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url))
const env = { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base') }
const cli = (...a) => execFileSync(process.execPath, [bin, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
const time = (f) => {
  const t = performance.now()
  f()
  return performance.now() - t
}
const ms = (n) => `${n.toFixed(0)} ms`

cli('init', lib)
for (const [grant, agent] of [['claude', 'claude-code'], ['codex', 'codex'], ['gemini', 'gemini']]) cli('--library', lib, 'grant', 'issue', grant, '--agent', agent)
const made = writeHistory(lib, { days, sessions, talk, seed: 7 })
console.log(`library: ${made.things} things, ${made.facts} facts, in ${lib}`)

const dir = join(lib, '.pneuma-base/ledger')
let t = performance.now()
const facts = await readFacts(dir)
console.log(`read the facts, first time in this process: ${ms(performance.now() - t)}`)
t = performance.now()
await readFacts(dir)
console.log(`read the facts again (files parsed once are kept): ${ms(performance.now() - t)}`)
console.log(`fold: ${ms(median([0, 1, 2].map(() => time(() => fold(facts)))))}`)
for (const period of ['7d', '30d', 'all']) console.log(`statistics and page, ${period}: ${ms(median([0, 1, 2, 3, 4].map(() => time(() => statsAnswer(statsOf(facts, period, new Date()))))))}`)
for (const period of ['30d', 'all']) console.log(`ledger stats --period ${period} as a command: ${ms(time(() => cli('--library', lib, 'ledger', 'stats', '--period', period)))}`)

if (process.argv.includes('--keep')) console.log(`kept: ${home}`)
else rmSync(home, { recursive: true, force: true })
