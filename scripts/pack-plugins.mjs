// Builds each plugin under plugins/ against the package files in dist-packages/ and writes the
// directory `pneuma-base plugin install` takes to dist-packages/plugins/<name>/, for people who install
// a plugin without building it. Needs `pnpm pack:dist` first, and the npm registry for each plugin's
// own dev dependencies. usage: node scripts/pack-plugins.mjs
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const packages = join(repo, 'dist-packages')
const out = join(packages, 'plugins')
if (!existsSync(packages) || !readdirSync(packages).some((f) => /^pneuma-base-\d.*\.tgz$/.test(f))) {
  console.error('dist-packages/ has no package files: run pnpm pack:dist first')
  process.exit(1)
}

const run = (cwd, args) => execFileSync('npm', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
const plugins = readdirSync(join(repo, 'plugins'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(repo, 'plugins', e.name, 'package.json')))
  .map((e) => e.name)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const name of plugins) {
  const dir = join(repo, 'plugins', name)
  // The package files are rebuilt under the same version, so an install already there is taken out first.
  for (const stale of ['node_modules/pneuma-base', 'node_modules/@pneuma-base/sdk', 'node_modules/.package-lock.json']) rmSync(join(dir, stale), { recursive: true, force: true })
  run(dir, ['install', '--no-audit', '--no-fund', '--no-package-lock'])
  run(dir, ['run', 'build'])
  cpSync(join(dir, 'dist'), join(out, name), { recursive: true })
  console.log(join(out, name))
}
