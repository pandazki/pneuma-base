import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformance } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('构建产物通过 Pneuma Base 的插件符合性检查', async () => {
  const report = await conformance(dist, {
    async setup({ sandbox }) {
      const put = await sandbox.agent('author', 'seed', [
        'put', '-', '--to', 'docs/start.md', '--generated',
      ], { input: '[待补充](details.md)\n' })
      assert.equal(put.code, 0, put.stderr)
    },
  })
  assert.ok(report.ok, report.text)
})
