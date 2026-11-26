// Times registering a large directory already in a library, both ways architecture.md section 5 gives:
// as one thing (`put <dir>`: a glance and the marker), and "everything inside" (`ledger register <dir>
// --inside`: an overview of each directory, a level at a time). Each runs on its own copy-on-write clone
// of the library (APFS `cp -c`), so the library given is never written. With --lock, every file under the
// directory is made unreadable in the clone first: a registration that read any content would fail.
//   node scripts/bench-register.mjs --library <library folder> --dir <path in it> [--lock] [--keep] [--bin <bin.js>]
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const library = value('--library', null)
const dir = value('--dir', null)
if (library === null || dir === null) throw new Error('usage: node scripts/bench-register.mjs --library <library folder> --dir <path in it> [--lock] [--keep]')
const bin = value('--bin', fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'pb-register-'))

function clone(name) {
  const lib = join(scratch, name)
  execFileSync('cp', ['-c', '-R', library, lib])
  // A copy is a new place: the machine-local cache of the original does not come along.
  if (argv.includes('--lock')) execFileSync('find', [join(lib, dir), '-type', 'f', '-exec', 'chmod', 'a-r', '{}', '+'])
  const home = join(scratch, `home-${name}`)
  mkdirSync(home, { recursive: true })
  return { lib, env: { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base') } }
}

function timed(env, args) {
  const t = performance.now()
  const run = spawnSync('/usr/bin/time', ['-l', process.execPath, bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 })
  const ms = performance.now() - t
  const err = String(run.stderr)
  const rss = Number(/(\d+)\s+maximum resident set size/.exec(err)?.[1] ?? 0)
  return { ms, rss, status: run.status, out: String(run.stdout).trim(), progress: err.split('\n').filter((l) => /登记|要登记/.test(l)).slice(-2) }
}

const files = Number(execFileSync('sh', ['-c', `find "${join(library, dir)}" -type f | wc -l`], { encoding: 'utf8' }).trim())
console.log(`${dir}: ${files} files${argv.includes('--lock') ? ', each made unreadable in the clones' : ''}`)
const one = clone('one')
const asOne = timed(one.env, ['--library', one.lib, 'put', dir, '--brought', '--by', 'owner'])
const all = clone('all')
const inside = timed(all.env, ['--library', all.lib, 'ledger', 'register', dir, '--inside'])
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`
console.log('| registration | time | peak memory | exit | answer |\n| --- | --- | --- | --- | --- |')
console.log(`| as one thing | ${asOne.ms.toFixed(0)} ms | ${mb(asOne.rss)} | ${asOne.status} | ${asOne.out.split('\n')[0]?.slice(0, 100)} |`)
console.log(`| everything inside | ${inside.ms.toFixed(0)} ms | ${mb(inside.rss)} | ${inside.status} | ${inside.out.split('\n')[0]?.slice(0, 100)} |`)
for (const line of inside.progress) console.log(`  ${line}`)
if (argv.includes('--lock')) execFileSync('chmod', ['-R', 'u+rw', scratch])
if (argv.includes('--keep')) console.log(`kept: ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
