// C11, K4: the kernel imports no plugin, not the command line and not the viewer; plugins reach the
// kernel only through its package. Run 2 C9: the viewer imports no plugin package, and its page
// takes only types from the kernel. The lint rules go red on deliberate violations.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))

async function restrictedImports(code: string, file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(code, { filePath: join(root, file) })
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === '@typescript-eslint/no-restricted-imports').map((m) => m.message)
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

  it('flags the kernel importing the viewer, by package or by path', async () => {
    expect(await restrictedImports(`export { startServer } from '@pneuma-base/viewer'\n`, 'packages/kernel/src/violation.ts')).toHaveLength(1)
    expect(await restrictedImports(`export * from '../../viewer/src/server/index.js'\n`, 'packages/kernel/src/violation.ts')).toHaveLength(1)
  })

  it('flags the viewer importing a plugin, by package or by path, or the kernel by path', async () => {
    expect(await restrictedImports(`export { ledger } from '@pneuma-base/plugin-ledger'\n`, 'packages/viewer/src/server/violation.ts')).toHaveLength(1)
    expect(await restrictedImports(`export * from '../../../plugin-ledger/src/index.js'\n`, 'packages/viewer/src/server/violation.ts')).toHaveLength(1)
    expect(await restrictedImports(`export * from '../../../kernel/src/types.js'\n`, 'packages/viewer/src/server/violation.ts')).toHaveLength(1)
    expect(await restrictedImports(`import type { Plugin } from '@pneuma-base/plugin-ledger'\nexport type P = Plugin\n`, 'packages/viewer/web/src/violation.tsx')).toHaveLength(1)
  })

  it('flags the page importing the kernel’s code, and allows its types', async () => {
    expect(await restrictedImports(`import { agentFace } from '@pneuma-base/kernel'\nexport const f = agentFace\n`, 'packages/viewer/web/src/violation.tsx')).toHaveLength(1)
    expect(await restrictedImports(`import type { Block } from '@pneuma-base/kernel'\nexport type B = Block\n`, 'packages/viewer/web/src/ok.tsx')).toEqual([])
  })

  it('flags a plugin importing the viewer', async () => {
    expect(await restrictedImports(`export { startServer } from '@pneuma-base/viewer'\n`, 'packages/plugin-ledger/src/violation.ts')).toHaveLength(1)
  })

  it('the viewer package depends on the kernel and on no plugin', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/viewer/package.json'), 'utf8'))
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@pneuma-base/kernel'])
    expect(Object.keys(pkg.devDependencies ?? {}).filter((d) => d.startsWith('@pneuma-base/'))).toEqual([])
  })

  it('the kernel package declares no dependency at all', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/kernel/package.json'), 'utf8'))
    expect(pkg.dependencies ?? {}).toEqual({})
  })
})
