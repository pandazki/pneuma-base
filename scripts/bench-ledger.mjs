// Times the ledger on a large library: about 20,000 things and 100,000 facts by default, written as
// two years of use by three agents and the owner (the browser tests' generator). Reports the first
// command, which folds every fact into the ledger's rows once, then the statistics of each period
// and their page as commands, which read only the rows of the period. Run after `pnpm build`:
//   node scripts/bench-ledger.mjs [days] [sessions per day] [notes per session] [--keep]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
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

console.log(`first command, folding every fact into the rows: ${ms(time(() => cli('--library', lib, 'ledger', 'stats', '--period', '7d')))}`)
for (const period of ['7d', '30d', 'all']) {
  console.log(`ledger stats --period ${period}: ${ms(median([0, 1, 2].map(() => time(() => cli('--library', lib, 'ledger', 'stats', '--period', period)))))}`)
  console.log(`show ledger.stats --period ${period}: ${ms(median([0, 1, 2].map(() => time(() => cli('--library', lib, 'show', 'ledger.stats', '--period', period)))))}`)
}

if (process.argv.includes('--keep')) console.log(`kept: ${home}`)
else rmSync(home, { recursive: true, force: true })
