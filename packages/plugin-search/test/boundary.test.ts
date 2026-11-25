// K4: the lint rule for plugins covers this package. It goes red when the search plugin imports
// another plugin, the command line or the kernel's files, and stays quiet for the kernel package.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))

async function restrictedImports(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(code, { filePath: join(root, 'packages/plugin-search/src/violation.ts') })
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message)
}

describe('the search plugin’s imports', () => {
  it('may not reach another plugin, the command line or the kernel’s files', async () => {
    expect(await restrictedImports(`export { ledger } from '@pneuma-base/plugin-ledger'\n`)).toHaveLength(1)
    expect(await restrictedImports(`export * from '@pneuma-base/cli'\n`)).toHaveLength(1)
    expect(await restrictedImports(`export * from '../../kernel/src/types.js'\n`)).toHaveLength(1)
  })

  it('may reach the kernel package', async () => {
    expect(await restrictedImports(`export type { Plugin } from '@pneuma-base/kernel'\n`)).toEqual([])
  })
})
