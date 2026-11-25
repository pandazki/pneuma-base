// Builds the two package files a plugin project depends on, from the workspace as built:
//   pneuma-base-<version>.tgz      the command line, with the kernel, the built-in plugins and the
//                                  viewer bundled inside, so `npm install <tgz>` needs nothing else,
//                                  and the plugin standard PLUGINS.md
//   pneuma-base-sdk-<version>.tgz  @pneuma-base/sdk: the contract, the kit and the test kit
// Nothing is published. usage: node scripts/pack-dist.mjs [--out <directory>]   (default dist-packages/)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const at = process.argv.indexOf('--out')
const out = resolve(at === -1 ? join(repo, 'dist-packages') : process.argv[at + 1])
const pkg = (name) => join(repo, 'packages', name)
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

const { PNEUMA_BASE_VERSION: version } = await import(pathToFileURL(join(pkg('sdk'), 'dist/index.js')).href)
const { engines } = readJson(join(repo, 'package.json'))

/** The workspace packages the command line carries inside its package file, by directory. */
const BUNDLED = ['sdk', 'kernel', 'plugin-ledger', 'plugin-version', 'plugin-sync', 'plugin-deploy', 'plugin-search', 'viewer']

for (const name of [...BUNDLED, 'cli']) {
  const declared = readJson(join(pkg(name), 'package.json')).version
  if (declared !== version) throw new Error(`packages/${name}/package.json says ${declared}; the sdk's PNEUMA_BASE_VERSION is ${version}. Make them one.`)
}

/** `from`'s published files copied to `to` (source maps left out), with its package.json rewritten by `manifest`. */
function stage(from, to, manifest) {
  const json = readJson(join(from, 'package.json'))
  mkdirSync(to, { recursive: true })
  for (const entry of json.files ?? []) {
    if (existsSync(join(from, entry))) cpSync(join(from, entry), join(to, entry), { recursive: true, filter: (src) => !src.endsWith('.map') })
  }
  const published = { ...json, version }
  for (const key of ['private', 'devDependencies', 'scripts']) delete published[key]
  if (json.dependencies) published.dependencies = Object.fromEntries(Object.keys(json.dependencies).map((dep) => [dep, version]))
  writeFileSync(join(to, 'package.json'), `${JSON.stringify(manifest(published), null, 2)}\n`)
}

function pack(dir) {
  const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], { cwd: dir, encoding: 'utf8' }))
  return join(out, filename)
}

const work = join(out, '.stage')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
try {
  const sdk = join(work, 'sdk')
  stage(pkg('sdk'), sdk, (m) => ({
    ...m,
    description: 'The Pneuma Base plugin contract: types, the kit, and the test kit.',
    engines,
    // The test kit runs the command line of the pneuma-base package the plugin project depends on.
    peerDependencies: { 'pneuma-base': version },
    peerDependenciesMeta: { 'pneuma-base': { optional: true } },
  }))

  const cli = join(work, 'pneuma-base')
  const inside = Object.fromEntries(BUNDLED.map((name) => [readJson(join(pkg(name), 'package.json')).name, name]))
  stage(pkg('cli'), cli, (m) => ({
    ...m,
    name: 'pneuma-base',
    description: 'Pneuma Base: an agent’s own library of what it brought in and what it made.',
    engines,
    // The test kit reads the command line's bin from here.
    exports: { ...m.exports, './package.json': './package.json' },
    dependencies: Object.fromEntries(Object.keys(inside).map((name) => [name, version])),
    bundleDependencies: Object.keys(inside),
    // The plugin standard, which `plugin new` names and a plugin project finds in node_modules/pneuma-base/.
    files: [...m.files, 'PLUGINS.md'],
  }))
  cpSync(join(repo, 'PLUGINS.md'), join(cli, 'PLUGINS.md'))
  for (const [name, dir] of Object.entries(inside)) stage(pkg(dir), join(cli, 'node_modules', name), (m) => m)

  for (const file of [pack(sdk), pack(cli)]) console.log(file)
} finally {
  rmSync(work, { recursive: true, force: true })
}
