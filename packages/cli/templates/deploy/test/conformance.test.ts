// The standard's behavioural rules, checked on the built plugin (npm test builds it first). When a
// check fails, report.text says what is wrong and what the rule is.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformance } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('the plugin follows the standard', async () => {
  const report = await conformance(dist, {
    // What the kit's examples stand on: a site (a directory put in whole) at sites/shop, and a target the owner set.
    async setup({ sandbox }) {
      await mkdir(join(sandbox.work, 'shop'), { recursive: true })
      await writeFile(join(sandbox.work, 'shop', 'index.html'), '<h1>小店</h1>\n')
      const put = await sandbox.agent('setup', 'setup', ['put', join(sandbox.work, 'shop'), '--to', 'sites/shop', '--generated'])
      assert.equal(put.code, 0, put.stderr)
      const set = await sandbox.owner(['{{name}}', 'target', 'set', '--to', join(sandbox.work, 'published')])
      assert.equal(set.code, 0, set.stderr)
    },
    // The kit replaces its configuration file whole when the owner sets a target.
    configuration: ['config.json'],
  })
  assert.ok(report.ok, report.text)
})
