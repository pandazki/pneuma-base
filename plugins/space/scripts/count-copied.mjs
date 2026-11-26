// Counts the lines of src/ that appear in the Pneuma Base sources the first version copied from (the
// table in FRICTION.md, and its rerun in FRICTION-RESOLVED.md): verbatim (trimmed, 8 or more
// characters), and again after normalizing the renames made while adapting the deploy plugin
// (site→app, fingerprint→bundle, run.d→run.r, deploy→space). Every file of src/ is compared with all
// of those sources, since the rebuilt files no longer map one to one onto them. The sources are read
// as they were at PNEUMA_BASE_REV, by default e864a12, the commit the first version was built against.
// usage: PNEUMA_BASE_REPO=/path/to/pneuma-base node scripts/count-copied.mjs [--show]
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const repo = process.env.PNEUMA_BASE_REPO
if (!repo) throw new Error('set PNEUMA_BASE_REPO to a pneuma-base checkout')
const rev = process.env.PNEUMA_BASE_REV ?? 'e864a12'
const here = new URL('..', import.meta.url).pathname
const SOURCES = [
  'kernel/src/types.ts',
  'kernel/src/paths.ts',
  'kernel/src/things.ts',
  'plugin-deploy/src/model.ts',
  'plugin-deploy/src/facts.ts',
  'plugin-deploy/src/targets.ts',
  'plugin-deploy/src/reconcile.ts',
  'plugin-deploy/src/commands.ts',
  'plugin-deploy/src/views.ts',
  'plugin-deploy/src/index.ts',
  'plugin-deploy/cognition/deploy-section.md',
]
const verbatim = (l) => l.trim()
const renamed = (l) =>
  verbatim(l)
    .replace(/\bdeploy\b/g, 'space')
    .replace(/Deployments/g, 'Records')
    .replace(/\brun\.d\b/g, 'run.r')
    .replace(/\bd\.(things|byPath|alias|sites)/g, 'r.$1')
    .replace(/SiteName/g, 'AppName')
    .replace(/Fingerprint/g, 'BundleId')
    .replace(/fingerprint/g, 'bundle')
    .replace(/\bsites?\b/g, 'app')
    .replace(/\bunpublish\b/g, 'remove')
    .replace(/[\s;]+/g, ' ')

const theirs = SOURCES.flatMap((s) => execFileSync('git', ['-C', repo, 'show', `${rev}:packages/${s}`], { encoding: 'utf8' }).split('\n'))
const pools = { verbatim: new Set(theirs.map(verbatim).filter((l) => l.length >= 8)), renamed: new Set(theirs.map(renamed).filter((l) => l.length >= 8)) }
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))

const totals = { verbatim: 0, renamed: 0, lines: 0 }
for (const file of files(join(here, 'src')).sort()) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  const count = (norm) => lines.filter((l) => norm(l).length >= 8 && pools[norm === verbatim ? 'verbatim' : 'renamed'].has(norm(l)))
  const row = { verbatim: count(verbatim).length, renamed: count(renamed).length, lines: lines.length }
  for (const k of Object.keys(totals)) totals[k] += row[k]
  console.log(`${relative(here, file).padEnd(18)} verbatim ${String(row.verbatim).padStart(3)}  renamed ${String(row.renamed).padStart(3)}  of ${String(row.lines).padStart(4)}`)
  if (process.argv.includes('--show')) for (const l of count(renamed)) console.log(`    ${l.trim()}`)
}
console.log(`${'total'.padEnd(18)} verbatim ${String(totals.verbatim).padStart(3)}  renamed ${String(totals.renamed).padStart(3)}  of ${String(totals.lines).padStart(4)}`)
