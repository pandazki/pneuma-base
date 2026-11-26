// tmp/run-7: the files rebuilt on storage read the library's folder and record area only through the
// storage door. The lint rule goes red on deliberate violations in them, and leaves the files not yet
// moved alone.
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

describe('the storage door', () => {
  it('flags a rebuilt ledger file reading files itself', async () => {
    const faults = await doorFaults(`import { readFile } from 'node:fs/promises'\nexport const f = readFile\n`, 'packages/plugin-ledger/src/sparse.ts')
    expect(faults).toHaveLength(1)
    expect(faults[0]).toContain('storage door')
  })

  it('flags a rebuilt ledger file using the kernel helpers that read the folder', async () => {
    expect(await doorFaults(`import { thingAt } from '@pneuma-base/kernel'\nexport const f = thingAt\n`, 'packages/plugin-ledger/src/state.ts')).toHaveLength(1)
    expect(await doorFaults(`import { onDisk } from './disk.js'\nexport const f = onDisk\n`, 'packages/plugin-ledger/src/unowned.ts')).toHaveLength(1)
  })

  it('flags a rebuilt ledger file asking the old tools for the folder', async () => {
    expect(await doorFaults(`export const f = (ctx: { tools: { things(): unknown } }) => ctx.tools.things()\n`, 'packages/plugin-ledger/src/since.ts')).toHaveLength(1)
  })

  it('flags a rebuilt kernel file reading the folder past the door', async () => {
    expect(await doorFaults(`import { libraryFiles } from './things.js'\nexport const f = libraryFiles\n`, 'packages/kernel/src/start.ts')).toHaveLength(1)
    expect(await doorFaults(`import { readdir } from 'node:fs/promises'\nexport const f = readdir\n`, 'packages/kernel/src/home.ts')).toHaveLength(1)
  })

  it('keeps the package boundaries in the rebuilt files', async () => {
    expect(await doorFaults(`export * from '@pneuma-base/plugin-other'\n`, 'packages/plugin-ledger/src/views.ts')).toHaveLength(1)
    expect(await doorFaults(`export { ledger } from '@pneuma-base/plugin-ledger'\n`, 'packages/kernel/src/places.ts')).toHaveLength(1)
  })

  it('allows the door itself and the files not moved yet', async () => {
    expect(await doorFaults(`import { spawn } from 'node:child_process'\nimport { existsSync } from 'node:fs'\nexport const f = [spawn, existsSync]\n`, 'packages/kernel/src/storage.ts')).toEqual([])
    expect(await doorFaults(`import { readFile } from 'node:fs/promises'\nexport const f = readFile\n`, 'packages/plugin-ledger/src/held.ts')).toEqual([])
  })
})
