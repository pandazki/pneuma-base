// The standard's behavioural rules, checked on the built plugin (npm test builds it first). When a
// check fails, report.text says what is wrong and what the rule is.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformance } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('the plugin follows the standard', async () => {
  const report = await conformance(dist, {
    // pulse's cognition has no command examples, so the fresh library needs nothing; one put gives the
    // views and the cache check something recorded to show.
    async setup({ sandbox }) {
      const put = await sandbox.agent('setup', 'setup', ['put', '-', '--to', 'notes/plan.md', '--generated'], { input: '# 计划\n' })
      assert.equal(put.code, 0, put.stderr)
    },
    // Both of pulse's directories are append-only records; it has no file it replaces whole.
    configuration: [],
  })
  assert.ok(report.ok, report.text)
})
