// `pneuma-base plugin new`: a plugin project written from the templates beside this package. It
// builds into a plugin directory, passes its own tests, and installs with `plugin install`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_NAME, PNEUMA_BASE_VERSION, RESERVED_PLUGIN_NAMES } from '@pneuma-base/kernel'
import { NODE_FLOOR } from './node-floor.js'

export const KINDS = ['blank', 'deploy'] as const
export type Kind = (typeof KINDS)[number]

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url))
/** Where `pnpm pack:dist` puts the package files, when this command line runs from the repository it was built in. */
const OWN_PACKAGES = fileURLToPath(new URL('../../../dist-packages/', import.meta.url))
const PACKAGE_FILES = { 'pneuma-base': `pneuma-base-${PNEUMA_BASE_VERSION}.tgz`, '@pneuma-base/sdk': `pneuma-base-sdk-${PNEUMA_BASE_VERSION}.tgz` }

/**
 * The plugin standard: at the root of the package file this command line was installed from, or at
 * the root of the repository it was built in. A project finds it in node_modules/pneuma-base/.
 */
export const STANDARD = ['../PLUGINS.md', '../../../PLUGINS.md'].map((p) => fileURLToPath(new URL(p, import.meta.url))).find((p) => existsSync(p)) ?? null

/** What a project needs from the registry: the bundler, the type checker, and Node's types. */
const TOOLS = { esbuild: '0.28.2', typescript: '6.0.3', '@types/node': '26.6.10' }

export type Scaffolded =
  | { ok: true; dir: string; name: string; kind: Kind; files: string[]; packages: string | null; standard: string | null }
  | { ok: false; reason: 'usage' | 'not-empty' | 'no-package-files'; text: string }

const hasPackageFiles = (dir: string) => Object.values(PACKAGE_FILES).every((file) => existsSync(join(dir, file)))

/** Each template file of `kind` by its path in the project: the common ones and the kind's, `_`-named parts left out. */
function templateFiles(kind: Kind): Map<string, string> {
  const files = new Map<string, string>()
  for (const base of ['common', kind]) {
    const root = join(TEMPLATES, base)
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('_')) continue
      const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')
      files.set(path === 'gitignore' ? '.gitignore' : path, join(root, path))
    }
  }
  return files
}

/**
 * Writes the project `kind` for the plugin `name` (the directory's name when null) into `dir`, which
 * must be missing or empty. It depends on the two package files in `packages`; when that is null, on
 * those `pnpm pack:dist` built beside this command line, else on the packages by name.
 */
export function scaffold(opts: { dir: string; kind: Kind; name: string | null; packages: string | null }): Scaffolded {
  const name = opts.name ?? basename(opts.dir)
  if (!PLUGIN_NAME.test(name)) return { ok: false, reason: 'usage', text: `插件名 ${name} 不行：小写字母开头，只用小写字母、数字和连字符。用 --name 给一个。` }
  if (RESERVED_PLUGIN_NAMES.includes(name)) return { ok: false, reason: 'usage', text: `插件名 ${name} 是命令行或内核自己用的词。用 --name 换一个。` }
  if (existsSync(opts.dir) && readdirSync(opts.dir).length > 0) return { ok: false, reason: 'not-empty', text: `${opts.dir} 不是空的，什么都没写。换一个目录。` }
  if (opts.packages !== null && !hasPackageFiles(opts.packages)) {
    return { ok: false, reason: 'no-package-files', text: `${opts.packages} 里没有 ${Object.values(PACKAGE_FILES).join(' 和 ')}。在 Pneuma Base 仓库里 pnpm pack:dist 打出它们。` }
  }
  const packages = opts.packages ?? (hasPackageFiles(OWN_PACKAGES) ? OWN_PACKAGES : null)
  const dependency = (pkg: keyof typeof PACKAGE_FILES) =>
    packages === null ? `^${PNEUMA_BASE_VERSION}` : `file:${relative(opts.dir, join(packages, PACKAGE_FILES[pkg])).split(sep).join('/')}`
  const manifest = {
    name: `pneuma-base-plugin-${name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: `Pneuma Base 插件 ${name}`,
    engines: { node: `>=${NODE_FLOOR}` },
    scripts: {
      build: 'tsc && node scripts/build.mjs',
      test: 'npm run build && node --test --test-reporter=spec "test/*.test.ts"',
      'install-local': 'npm run build && pneuma-base plugin install dist',
    },
    devDependencies: { '@pneuma-base/sdk': dependency('@pneuma-base/sdk'), 'pneuma-base': dependency('pneuma-base'), ...TOOLS },
  }
  const kindFiles = readFileSync(join(TEMPLATES, opts.kind, '_files.md'), 'utf8').trimEnd()
  const written = new Map<string, string>([['package.json', `${JSON.stringify(manifest, null, 2)}\n`]])
  for (const [path, source] of templateFiles(opts.kind)) {
    written.set(path, readFileSync(source, 'utf8').replaceAll('{{name}}', name).replace('{{kindFiles}}', kindFiles))
  }
  for (const [path, text] of written) {
    mkdirSync(dirname(join(opts.dir, path)), { recursive: true })
    writeFileSync(join(opts.dir, path), text)
  }
  return { ok: true, dir: opts.dir, name, kind: opts.kind, files: [...written.keys()].sort(), packages, standard: STANDARD }
}
