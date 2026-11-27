// ARCHITECTURE.md「不变式」: nothing above storage reads or writes the library's folder and record area but through the
// kernel's door. The lint rule goes red on deliberate violations in the runtime sources of every
// package, the examples under plugins/ and the scaffold's templates included, and leaves alone the files
// eslint.config.js lists as touching only what is no library's, a package reading its own files, tests
// and scripts.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))

async function doorFaults(code: string, file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(code, { filePath: join(root, file) })
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax').map((m) => m.message)
}

/** A source file of each package, and a new one, so the rule follows every file and not a list. */
const EVERY_PACKAGE = [
  'packages/kernel/src/start.ts',
  'packages/kernel/src/a-new-file.ts',
  'packages/plugin-ledger/src/sparse.ts',
  'packages/plugin-version/src/index.ts',
  'packages/plugin-version/src/a-new-file.ts',
  'packages/plugin-sync/src/index.ts',
  'packages/plugin-search/src/index.ts',
  'packages/plugin-deploy/src/index.ts',
  'packages/plugin-other/src/index.ts',
  'packages/sdk/src/kit/records.ts',
  'packages/sdk/src/kit/deploy/reconcile.ts',
  'packages/viewer/src/server/api.ts',
  'packages/viewer/src/server/agent.ts',
  'packages/cli/src/format.ts',
  'plugins/space/src/views.ts',
  'plugins/pulse/src/index.ts',
  'plugins/links/src/links.js',
  'plugins/another/src/index.ts',
  'packages/cli/templates/blank/src/index.ts',
  'packages/cli/templates/deploy/src/index.ts',
]

describe('the storage door', () => {
  it('flags a runtime file of any package that writes or lists files itself', async () => {
    for (const file of EVERY_PACKAGE) {
      const faults = await doorFaults(`import { writeFileSync } from 'node:fs'\nexport const f = writeFileSync\n`, file)
      expect(faults, file).toHaveLength(1)
      expect(faults[0]).toContain('storage door')
      expect(await doorFaults(`import { readdir } from 'node:fs/promises'\nexport const f = readdir\n`, file), file).toHaveLength(1)
      expect(await doorFaults(`import * as fs from 'node:fs'\nexport const f = fs\n`, file), file).toHaveLength(1)
    }
  })

  it('flags one that starts a program, or reaches the file system another way', async () => {
    for (const file of ['packages/plugin-sync/src/index.ts', 'plugins/links/src/links.js', 'packages/cli/templates/blank/src/index.ts']) {
      expect(await doorFaults(`import { spawn } from 'node:child_process'\nexport const f = spawn\n`, file), file).toHaveLength(1)
      expect(await doorFaults(`export const f = await import('node:fs')\n`, file), file).toHaveLength(1)
      expect(await doorFaults(`export const f = process.getBuiltinModule('node:fs')\n`, file), file).toHaveLength(1)
    }
  })

  it('lets a package read its own files, and nothing else, with readFileSync', async () => {
    for (const file of EVERY_PACKAGE) {
      expect(await doorFaults(`import { readFileSync } from 'node:fs'\nexport const text = readFileSync(new URL('./cognition.md', import.meta.url), 'utf8')\n`, file), file).toEqual([])
      expect(await doorFaults(`import { readFileSync } from 'node:fs'\nexport const f = (ctx: { library: { root: string } }) => readFileSync(ctx.library.root + '/a.md')\n`, file), file).toHaveLength(1)
    }
  })

  it('flags the tools of contract 1 and the context’s dir, which contract 2 has not', async () => {
    for (const tool of ['things', 'files', 'fingerprint', 'copyOut', 'abs', 'putting', 'manifest']) {
      expect(await doorFaults(`export const f = (ctx: { tools: Record<string, () => unknown> }) => ctx.tools.${tool}()\n`, 'plugins/links/src/scan.js'), tool).toHaveLength(1)
    }
    expect(await doorFaults(`export const f = (ctx: { dir: string }) => ctx.dir\n`, 'packages/plugin-search/src/config.ts')).toHaveLength(1)
  })

  it('flags a file using the kernel’s helpers that touched the folder', async () => {
    expect(await doorFaults(`import { thingAt } from '@pneuma-base/kernel'\nexport const f = thingAt\n`, 'packages/plugin-ledger/src/state.ts')).toHaveLength(1)
    expect(await doorFaults(`import { abs } from '@pneuma-base/kernel'\nexport const f = abs\n`, 'packages/plugin-version/src/views.ts')).toHaveLength(1)
    expect(await doorFaults(`import { writeAtomic } from './machine-files.js'\nexport const f = writeAtomic\n`, 'packages/kernel/src/library.ts')).toHaveLength(1)
    expect(await doorFaults(`import { abs } from './paths.js'\nexport const f = abs\n`, 'packages/kernel/src/viewer.ts')).toHaveLength(1)
  })

  it('keeps the package boundaries', async () => {
    expect(await doorFaults(`export * from '@pneuma-base/plugin-other'\n`, 'packages/plugin-ledger/src/views.ts')).toHaveLength(1)
    expect(await doorFaults(`export { ledger } from '@pneuma-base/plugin-ledger'\n`, 'packages/kernel/src/places.ts')).toHaveLength(1)
    expect(await doorFaults(`export { kernel } from '@pneuma-base/kernel'\n`, 'packages/sdk/src/kit/records.ts')).toHaveLength(1)
    expect(await doorFaults(`import { ownerFace } from '@pneuma-base/kernel'\nexport const f = ownerFace\n`, 'packages/viewer/src/server/agent.ts')).toHaveLength(1)
  })

  it('allows the door, the files that touch only what is no library’s, tests and scripts', async () => {
    const stat = `import { stat } from 'node:fs/promises'\nexport const f = stat\n`
    expect(await doorFaults(`import { spawn } from 'node:child_process'\nimport { existsSync } from 'node:fs'\nexport const f = [spawn, existsSync]\n`, 'packages/kernel/src/storage.ts')).toEqual([])
    for (const file of ['packages/kernel/src/address.ts', 'packages/kernel/src/secrets.ts', 'packages/plugin-ledger/src/conversation.ts', 'packages/sdk/src/kit/deploy/content.ts', 'packages/plugin-deploy/src/targets.ts', 'packages/sdk/src/testkit/sandbox.ts', 'packages/viewer/src/server/files.ts', 'plugins/space/src/cloudflare.ts']) {
      expect(await doorFaults(stat, file), file).toEqual([])
    }
    for (const file of ['packages/cli/test/a.test.ts', 'packages/plugin-sync/test/story.test.ts', 'plugins/space/scripts/build.mjs', 'scripts/bench-line.mjs']) {
      expect(await doorFaults(stat, file), file).toEqual([])
    }
  })

  it('leaves the Mac app no look at a library but through storage: each line that reaches files itself reaches what is no library’s', () => {
    const sources = join(root, 'app/Sources/PneumaBase')
    const reaches = /FileManager\.default\.\w+\(|\bfm\.\w+\(|getxattr\(|listxattr\(|contentsOf:|FileHandle\(for|opendir\(|downloadAddress\(of:/
    const mayReach: [file: string, line: RegExp][] = [
      // The app's own Node and command line, its preferences and log under $PNEUMA_BASE_HOME/app.
      ['Config.swift', /atPath: (node|cli)\)|Data\(contentsOf: url\(config\)\)|at: config\.appDir|FileHandle\(forWritingTo: url\)/],
      // The link to the launcher in a folder on PATH.
      ['Settings.swift', /./],
      ['MainWindow.swift', /Bundle\.main/],
      // A file dropped from outside, before it comes in.
      ['App.swift', /getxattr\(url\.path|downloadAddress\(of: url\)/],
      // The provider's input.
      ['Watcher.swift', /input\.write\(contentsOf:/],
      // Opening a conversation again: its .command file in the app's temporary folder, whether the
      // session's directory and its transcript are there; the applications 打开方式 names.
      ['Files.swift', /contentsOf: commandFile|atPath: run\.cwd|atPath: reveal|fm\.(createDirectory|contentsOfDirectory)\(at: dir|fm\.removeItem\(at: old\)|ofItemAtPath: file\.path|displayName\(atPath: \$0\.path\)/],
      // The thumbnails' cache under $PNEUMA_BASE_HOME/app/cache; the library's files reach the system's thumbnail service by their fs.path.
      ['Thumbnails.swift', /at: root,|at: library,|removeItem\(at: entry\)|createDirectory\(at: dir|contentsOf: cached|ofItemAtPath: cached\.path/],
    ]
    const direct = readdirSync(sources).flatMap((file) =>
      readFileSync(join(sources, file), 'utf8')
        .split('\n')
        .map((line, i) => ({ at: `${file}:${i + 1}`, file, line: line.trim() }))
        .filter(({ file, line }) => !line.startsWith('//') && reaches.test(line) && !mayReach.some(([f, ok]) => f === file && ok.test(line))),
    )
    expect(direct.map(({ at, line }) => `${at} ${line}`)).toEqual([])
  })
})
