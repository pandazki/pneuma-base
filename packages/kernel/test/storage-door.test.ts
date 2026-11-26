// tmp/run-7: the kernel and the ledger read the library's folder and record area only through the
// storage door. The lint rule goes red on deliberate violations in any of their files, and leaves alone
// the few that touch only what is no library's (eslint.config.js lists them with the reason).
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
  it('flags any ledger file reading files itself', async () => {
    for (const file of ['sparse.ts', 'held.ts', 'index.ts', 'audit.ts', 'a-new-file.ts']) {
      const faults = await doorFaults(`import { readFile } from 'node:fs/promises'\nexport const f = readFile\n`, `packages/plugin-ledger/src/${file}`)
      expect(faults, file).toHaveLength(1)
      expect(faults[0]).toContain('storage door')
    }
  })

  it('flags a ledger file using the kernel helpers that read the folder', async () => {
    expect(await doorFaults(`import { thingAt } from '@pneuma-base/kernel'\nexport const f = thingAt\n`, 'packages/plugin-ledger/src/state.ts')).toHaveLength(1)
    expect(await doorFaults(`import { abs } from '@pneuma-base/kernel'\nexport const f = abs\n`, 'packages/plugin-ledger/src/views.ts')).toHaveLength(1)
  })

  it('flags a ledger file asking the contract-1 tools', async () => {
    for (const tool of ['things', 'fingerprint', 'copyOut', 'abs', 'putting']) {
      expect(await doorFaults(`export const f = (ctx: { tools: Record<string, () => unknown> }) => ctx.tools.${tool}()\n`, 'packages/plugin-ledger/src/since.ts'), tool).toHaveLength(1)
    }
  })

  it('flags any kernel file reading the folder past the door', async () => {
    for (const file of ['start.ts', 'home.ts', 'put.ts', 'archive.ts', 'viewer.ts', 'agent.ts', 'requests.ts', 'library.ts', 'a-new-file.ts']) {
      expect(await doorFaults(`import { readdir } from 'node:fs/promises'\nexport const f = readdir\n`, `packages/kernel/src/${file}`), file).toHaveLength(1)
    }
    expect(await doorFaults(`import { spawn } from 'node:child_process'\nexport const f = spawn\n`, 'packages/kernel/src/agent.ts')).toHaveLength(1)
    expect(await doorFaults(`import { writeAtomic } from './machine-files.js'\nexport const f = writeAtomic\n`, 'packages/kernel/src/library.ts')).toHaveLength(1)
    expect(await doorFaults(`import { abs } from './paths.js'\nexport const f = abs\n`, 'packages/kernel/src/viewer.ts')).toHaveLength(1)
  })

  it('keeps the package boundaries', async () => {
    expect(await doorFaults(`export * from '@pneuma-base/plugin-other'\n`, 'packages/plugin-ledger/src/views.ts')).toHaveLength(1)
    expect(await doorFaults(`export { ledger } from '@pneuma-base/plugin-ledger'\n`, 'packages/kernel/src/places.ts')).toHaveLength(1)
  })

  it('allows the door and the files that touch only what is no library', async () => {
    expect(await doorFaults(`import { spawn } from 'node:child_process'\nimport { existsSync } from 'node:fs'\nexport const f = [spawn, existsSync]\n`, 'packages/kernel/src/storage.ts')).toEqual([])
    for (const file of ['address.ts', 'outside.ts', 'grants.ts', 'secrets.ts', 'machine-files.ts']) {
      expect(await doorFaults(`import { stat } from 'node:fs/promises'\nexport const f = stat\n`, `packages/kernel/src/${file}`), file).toEqual([])
    }
    expect(await doorFaults(`import { readFile } from 'node:fs/promises'\nexport const f = readFile\n`, 'packages/plugin-ledger/src/conversation.ts')).toEqual([])
  })
})
