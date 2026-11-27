// PLUGINS.md, the plugin standard, kept true: every conformance check it names exists and each is
// named with the rule its report states; every TypeScript example compiles against the sdk with the
// scaffold's compiler options, and every example plugin passes the loader; every shell block runs as
// written from the state the five minutes leave (the blocks that install from the registry run in
// plugins-doc.slow.test.ts); the icon, frame class and frame token lists are the sdk's; and the
// conformance test it shows is the one plugin new writes.
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { CONTRACT, PNEUMA_BASE_VERSION } from '@pneuma-base/kernel'
import { ICON_NAMES } from '@pneuma-base/sdk'
import { FRAME_CLASSES, FRAME_TOKENS } from '@pneuma-base/sdk/frame'
import { CHECKS, RULES } from '@pneuma-base/sdk/testkit'
import { BROWSER_SHIMS, OUTPUT, SLOW, STANDARD, fences, runBlock, unprinted } from './plugins-doc.js'
import { tempDir } from './helpers.js'

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const SDK = fileURLToPath(new URL('../../sdk/', import.meta.url))
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const SCAFFOLD_TSCONFIG = fileURLToPath(new URL('../templates/common/tsconfig.json', import.meta.url))
const SCAFFOLD_CONFORMANCE = fileURLToPath(new URL('../templates/blank/test/conformance.test.ts', import.meta.url))

const text = readFileSync(STANDARD, 'utf8')
const blocks = fences(text)
const ts_ = blocks.filter((b) => b.lang === 'ts')
const sh = blocks.filter((b) => b.lang === 'sh')

/** The section of the text under the heading that starts with `heading`, up to the next heading of its level. */
function section(heading: string): string {
  const start = text.indexOf(`\n${heading}`)
  const level = /^#+/.exec(heading)?.[0] as string
  const next = text.slice(start + 1).search(new RegExp(`\\n${level} `))
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next)
}

const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/** The sdk as a plugin directory's own dependency: its manifest and its built files. */
function vendorSdk(dir: string): void {
  const to = join(dir, 'node_modules/@pneuma-base/sdk')
  mkdirSync(to, { recursive: true })
  cpSync(join(SDK, 'package.json'), join(to, 'package.json'))
  cpSync(join(SDK, 'dist'), join(to, 'dist'), { recursive: true })
}

/** TypeScript to the ES module Node runs: types erased, imports as written, as the scaffold's esbuild leaves them. */
const transpile = (source: string) =>
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true } }).outputText

describe('PLUGINS.md', () => {
  it('names every conformance check on the rules it enforces and no other, and lists them in section 7 in their order, each with the rule its report states word for word', () => {
    const named = [...text.matchAll(/（检查：([^）]+)）/g)].flatMap((m) => [...(m[1] as string).matchAll(/`([^`]+)`/g)].map((n) => n[1] as string))
    expect(named.filter((n) => !(CHECKS as readonly string[]).includes(n))).toEqual([])
    expect([...new Set(named)].sort()).toEqual([...CHECKS].sort())
    const rows = [...section('## 7. ').matchAll(/^\| `([a-z]+)` \| (.+?) \| .+ \|$/gm)].map((m) => [m[1], m[2]])
    expect(rows).toEqual(CHECKS.map((name) => [name, RULES[name]]))
  })

  /** The backticked names in the table row whose first cell is `cell`. */
  const rowNames = (cell: string, name: RegExp) => {
    const row = text.split('\n').find((l) => l.startsWith(`| ${cell} |`)) ?? ''
    return [...row.matchAll(name)].map((m) => m[1])
  }

  it('lists every icon name a view or a cell may use, and every class and token the frame kit gives, as the sdk gives them', () => {
    expect(rowNames('`IconName`', /`([a-z][a-z0-9-]*)`/g)).toEqual([...ICON_NAMES])
    expect(rowNames('`frame.css` 的类（`FRAME_CLASSES`）', /`([a-z][a-z-]*)`/g)).toEqual([...FRAME_CLASSES])
    expect(rowNames('`frame.css` 的变量（`FRAME_TOKENS`）', /`(--[a-z0-9-]+)`/g)).toEqual([...FRAME_TOKENS])
  })

  it('names this version and contract, and points into no source file of this repository, nor to it for the package files', () => {
    expect(text).toContain(`契约第 ${CONTRACT} 版`)
    expect(text).toContain(`pneuma-base ${PNEUMA_BASE_VERSION}`)
    expect(text).toContain(`pneuma-base-${PNEUMA_BASE_VERSION}.tgz`)
    expect(text.match(/(?<!dist-)packages\/[\w./-]*|\w+\.ts:\d+/g)).toBeNull()
    expect(text.match(/pack:dist|dist-packages/g)).toBeNull()
  })

  it('shows the conformance test plugin new writes, word for word', () => {
    const line = text.slice(0, text.indexOf('生成的 `test/conformance.test.ts` 就是这样用它的')).split('\n').length
    const shown = ts_.find((b) => b.line > line)
    expect(shown?.body).toBe(readFileSync(SCAFFOLD_CONFORMANCE, 'utf8').trimEnd())
  })

  it('has no shell block that no test runs: each is plain or marked to run with the registry, and each output follows a block', () => {
    expect(blocks.filter((b) => ['bash', 'shell', 'console', 'zsh'].includes(b.lang))).toEqual([])
    expect(sh.filter((b) => b.marker !== null && b.marker !== SLOW)).toEqual([])
    expect(sh.filter((b) => b.marker === SLOW).length).toBeGreaterThan(0)
    const outputs = blocks.flatMap((b, i) => (b.marker === OUTPUT ? [{ b, before: blocks[i - 1] }] : []))
    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs.filter(({ b, before }) => b.lang !== 'text' || before?.lang !== 'sh').map(({ b }) => b.line)).toEqual([])
  })

  it('compiles every TypeScript example against the sdk with the compiler options plugin new writes', () => {
    expect(ts_.length).toBeGreaterThanOrEqual(10)
    const dir = tempDir('pb-doc-ts-')
    write(join(dir, 'package.json'), '{ "type": "module" }\n')
    mkdirSync(join(dir, 'node_modules/@pneuma-base'), { recursive: true })
    mkdirSync(join(dir, 'node_modules/@types'), { recursive: true })
    symlinkSync(SDK, join(dir, 'node_modules/@pneuma-base/sdk'))
    symlinkSync(join(REPO, 'node_modules/@types/node'), join(dir, 'node_modules/@types/node'))
    const files = ts_.map((b) => {
      const file = join(dir, `example-line-${b.line}.ts`)
      writeFileSync(file, b.body)
      return file
    })
    const raw = ts.parseConfigFileTextToJson(SCAFFOLD_TSCONFIG, readFileSync(SCAFFOLD_TSCONFIG, 'utf8')).config as { compilerOptions: unknown }
    const { options, errors } = ts.convertCompilerOptionsFromJson(raw.compilerOptions, dir)
    expect(errors).toEqual([])
    const program = ts.createProgram(files, options)
    const host = { getCanonicalFileName: (f: string) => f, getCurrentDirectory: () => dir, getNewLine: () => '\n' }
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.formatDiagnostic(d, host).replace(`${dir}/`, 'PLUGINS.md, '))
    expect(diagnostics).toEqual([])
  }, 120_000)

  it('installs every example plugin: each passes the checks the loader makes', () => {
    const plugins = ts_.filter((b) => /^export default /m.test(b.body))
    expect(plugins.length).toBeGreaterThanOrEqual(8)
    const root = tempDir('pb-doc-plugins-')
    const env = { PATH: process.env.PATH ?? '', HOME: root, PNEUMA_BASE_HOME: join(root, '.pneuma-base') }
    const installed = plugins.map((b) => {
      const dir = join(root, `example-line-${b.line}`)
      write(join(dir, 'index.js'), transpile(b.body))
      vendorSdk(dir)
      const r = spawnSync(process.execPath, [BIN, 'plugin', 'install', dir, '--json'], { cwd: root, env, encoding: 'utf8' })
      expect(r.status, `the example at line ${b.line}: ${r.stdout}${r.stderr}`).toBe(0)
      return JSON.parse(r.stdout).data.name as string
    })
    expect(new Set(installed).size).toBe(installed.length)
  }, 120_000)

  describe('every shell block, run as written in marks/ after the five minutes', () => {
    // The state section 1 leaves, without the registry: `plugin new marks` beside the package files,
    // built by erasing the types and vendoring the sdk (what esbuild bundles in), installed, and a
    // library ../lib with the ledger and marks, notes/plan.md and one mark in it.
    let base: string

    beforeAll(() => {
      base = tempDir('pb-doc-scene-')
      const packages = join(base, 'packages')
      for (const file of [`pneuma-base-${PNEUMA_BASE_VERSION}.tgz`, `pneuma-base-sdk-${PNEUMA_BASE_VERSION}.tgz`]) write(join(packages, file), '')
      const env = sceneEnv(base)
      const sh = (cwd: string, line: string) => {
        const r = spawnSync('sh', ['-e', '-c', line], { cwd, env, encoding: 'utf8' })
        expect(r.status, `${line}\n${r.stdout}${r.stderr}`).toBe(0)
      }
      sh(packages, 'pneuma-base plugin new marks --packages .')
      const marks = join(packages, 'marks')
      write(join(marks, 'dist/index.js'), transpile(readFileSync(join(marks, 'src/index.ts'), 'utf8')))
      cpSync(join(marks, 'src/cognition.md'), join(marks, 'dist/cognition.md'))
      cpSync(join(marks, 'src/ui'), join(marks, 'dist/ui'), { recursive: true })
      vendorSdk(join(marks, 'dist'))
      sh(marks, 'pneuma-base plugin install dist')
      sh(marks, 'pneuma-base init ../lib')
      sh(marks, 'pneuma-base plugin add marks --library ../lib')
      sh(marks, "echo '# 计划' | pneuma-base --library ../lib --as claude-code put - --to notes/plan.md --made")
      sh(marks, 'pneuma-base --library ../lib --as claude-code say marks notes/plan.md "第三节的数字还没核对"')
    }, 120_000)

    it('shows the cognition section plugin new writes for marks, word for word', () => {
      const written = readFileSync(join(base, 'packages/marks/src/cognition.md'), 'utf8')
        .replace(/<!--[\s\S]*?-->\n*/g, '')
        .trim()
      expect(blocks.find((b) => b.lang === 'md')?.body).toBe(written)
    })

    // Each block in a copy of the scene of its own, all at once.
    it('runs every shell block as written, printing what its output block shows, and opens no browser', async () => {
      const runnable = sh.filter((b) => b.marker === null)
      expect(runnable.length).toBeGreaterThan(0)
      const failures = await Promise.all(
        runnable.map(async (block) => {
          const root = tempDir('pb-doc-block-')
          cpSync(base, root, { recursive: true })
          const script = join(root, 'block.sh')
          writeFileSync(script, `${block.body}\n`)
          const r = await runBlock(script, { cwd: join(root, 'packages/marks'), env: sceneEnv(root), timeout: 90_000 })
          const shown = `PLUGINS.md line ${block.line}\n${block.body}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`
          if (r.code !== 0) return `${shown}\n--- exited ${r.code}`
          const missing = unprinted(blocks, block, r)
          if (missing.length > 0) return `${shown}\n--- did not print\n${missing.join('\n')}`
          return existsSync(join(root, 'opened')) ? `${shown}\n--- opened a browser` : null
        }),
      )
      expect(failures.filter((f) => f !== null).join('\n\n')).toBe('')
    }, 120_000)
  })
})

/** The environment of a scene under `root`: `pneuma-base` on the PATH as the five minutes install it, a home of its own, and no browser. */
function sceneEnv(root: string): Record<string, string> {
  const bin = join(root, 'bin')
  if (!existsSync(join(bin, 'pneuma-base'))) {
    write(join(bin, 'pneuma-base'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`)
    for (const name of BROWSER_SHIMS) write(join(bin, name), '#!/bin/sh\necho "$1" >> "$PNEUMA_DOC_OPENED"\n')
    for (const name of ['pneuma-base', ...BROWSER_SHIMS]) chmodSync(join(bin, name), 0o755)
  }
  const passed = Object.fromEntries(['LANG', 'LC_ALL', 'TMPDIR'].flatMap((n) => (process.env[n] === undefined ? [] : [[n, process.env[n] as string]])))
  return { ...passed, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: join(root, 'home'), PNEUMA_BASE_HOME: join(root, 'home/.pneuma-base'), PNEUMA_DOC_OPENED: join(root, 'opened') }
}
