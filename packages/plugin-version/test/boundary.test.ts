// K4 for this package: the existing lint rule covers it. It goes red when the plugin imports
// another plugin, the command line, the viewer or kernel files, and stays quiet for the kernel package.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))

async function restricted(code: string, file: string): Promise<string[]> {
  const [result] = await new ESLint({ cwd: root }).lintText(code, { filePath: join(root, file) })
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message)
}

describe('the version plugin reaches the kernel only through its package', () => {
  it('flags imports of another plugin, the command line, the viewer, or kernel files', async () => {
    for (const code of [
      `export { ledger } from '@pneuma-base/plugin-ledger'\n`,
      `export * from '../../plugin-ledger/src/index.js'\n`,
      `export * from '@pneuma-base/cli'\n`,
      `export { startServer } from '@pneuma-base/viewer'\n`,
      `export * from '../../kernel/src/put.js'\n`,
    ]) {
      expect(await restricted(code, 'packages/plugin-version/src/violation.ts'), code).toHaveLength(1)
    }
  })

  it('allows the kernel package, and the package depends on nothing else', async () => {
    expect(await restricted(`export { agentFace } from '@pneuma-base/kernel'\n`, 'packages/plugin-version/src/ok.ts')).toEqual([])
    const pkg = JSON.parse(readFileSync(join(root, 'packages/plugin-version/package.json'), 'utf8'))
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@pneuma-base/kernel'])
    expect(pkg.devDependencies).toBeUndefined()
  })
})
