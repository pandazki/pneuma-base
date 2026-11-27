// Which tests a change needs: those of the packages it touches, plus a short fixed set that crosses
// the layers when the change is below the command line. The whole suite runs for a release (the Full
// workflow, or `pnpm test`), not for every change.
//   node scripts/affected-tests.mjs [--base <ref>] [--run] [--github]
// Prints the test paths and whether the browser tests and the slow tests are needed. --run runs
// vitest on the paths (nothing to run is a success). --github writes e2e= and slow= to $GITHUB_OUTPUT.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main'

const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  .split('\n')
  .filter((line) => line !== '')

const cliTests = (...names) => names.map((name) => `packages/cli/test/${name}.test.ts`)
/** The tests that cross the layers: a whole task as an agent, the sparse rules, the faces agreeing. */
const ACROSS = cliTests('whole-story', 'sparse', 'start', 'put-and-archive', 'mcp', 'buttons')
/** The command line's tests that go through the UI server: its page, HTTP and endpoint faces agreeing with the command line. */
const THROUGH_SERVER = cliTests('buttons', 'endpoint-story', 'mcp-http', 'view')
const UNIT = readdirSync('packages').map((pkg) => `packages/${pkg}/test`).filter((dir) => existsSync(dir))

const paths = new Set()
let e2e = false
let slow = false
for (const file of changed) {
  const pkg = /^packages\/([^/]+)\//.exec(file)?.[1]
  if (pkg !== undefined && existsSync(`packages/${pkg}/test`)) paths.add(`packages/${pkg}/test`)
  // Below the command line: what it does to a whole task is checked by the few tests that cross the layers.
  if (/^(core\/|packages\/(kernel|sdk|plugin-[^/]+)\/src\/)/.test(file)) for (const test of ACROSS) paths.add(test)
  if (file.startsWith('core/')) for (const dir of ['packages/kernel/test', 'packages/plugin-ledger/test']) paths.add(dir)
  if (file.startsWith('packages/viewer/src/')) for (const test of THROUGH_SERVER) paths.add(test)
  // The deploy kit is the sdk's, and its tests are the deploy plugin's.
  if (file.startsWith('packages/sdk/src/kit/')) paths.add('packages/plugin-deploy/test')
  // The workspace's dependencies and test configuration reach every test.
  if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|vitest\.[\w.-]+\.ts)$/.test(file)) {
    for (const dir of UNIT) paths.add(dir)
    e2e = slow = true
  }
  if (file === 'PLUGINS.md') paths.add('packages/cli/test/plugins-doc.test.ts')
  // What a person sees: the pages, and whatever gives them their blocks.
  if (/^packages\/viewer\//.test(file) || /\/src\/(ui|views|viewer|blocks|home|[a-z-]*page[a-z-]*)\.ts$/.test(file) || file === 'packages/sdk/src/types.ts') e2e = true
  // What a plugin author gets: the sdk, the scaffold, the example plugins, the packages.
  if (/^(packages\/sdk\/|plugins\/|packages\/cli\/src\/scaffold|scripts\/(pack|test-example-plugins))/.test(file)) slow = true
}

const list = [...paths].filter((path) => existsSync(path)).sort()
console.log(`changed since ${base}: ${changed.length} files`)
console.log(`tests: ${list.length === 0 ? 'none' : list.join(' ')}`)
console.log(`browser tests: ${e2e ? 'yes' : 'no'}; slow tests: ${slow ? 'yes' : 'no'}`)
if (flag('--github') && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `e2e=${e2e}\nslow=${slow}\n`)
if (flag('--run') && list.length > 0) {
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...list], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}
