// C11, K4: the kernel imports no plugin and not the command line; plugins reach the kernel only
// through its package. The lint rule goes red on deliberate violations.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))

async function restrictedImports(code: string, file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(code, { filePath: join(root, file) })
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message)
}

describe('dependency direction', () => {
  it('flags the kernel importing a plugin package', async () => {
    const messages = await restrictedImports(`import { ledger } from '@pneuma-base/plugin-ledger'\nexport { ledger }\n`, 'packages/kernel/src/violation.ts')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('K4')
  })

  it('flags the kernel importing the command line by a relative path', async () => {
    const messages = await restrictedImports(`export * from '../../cli/src/main.js'\n`, 'packages/kernel/src/violation.ts')
    expect(messages).toHaveLength(1)
  })

  it('flags a plugin importing kernel files instead of the kernel package', async () => {
    const messages = await restrictedImports(`export * from '../../kernel/src/types.js'\n`, 'packages/plugin-ledger/src/violation.ts')
    expect(messages).toHaveLength(1)
  })

  it('flags a plugin importing another plugin', async () => {
    const messages = await restrictedImports(`export * from '@pneuma-base/plugin-other'\n`, 'packages/plugin-ledger/src/violation.ts')
    expect(messages).toHaveLength(1)
  })

  it('allows a plugin to import the kernel package', async () => {
    const messages = await restrictedImports(`export type { Plugin } from '@pneuma-base/kernel'\n`, 'packages/plugin-ledger/src/ok.ts')
    expect(messages).toEqual([])
  })

  it('the kernel package declares no dependency at all', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/kernel/package.json'), 'utf8'))
    expect(pkg.dependencies ?? {}).toEqual({})
  })
})
