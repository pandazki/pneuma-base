// The standard's behavioural rules, checked on the built plugin (npm test builds it first), once for
// each kind of target, each with PneumaSpace in memory (fake-space.ts, fake-cloudflare.ts), so it
// needs no running service. A site is switched on first, so the views are checked with an app online.
// When a check fails, report.text says what and why.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformance, type Sandbox } from '@pneuma-base/sdk/testkit'
import { fakeCloudflare } from './fake-cloudflare.ts'
import { fakeSpace } from './fake-space.ts'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

/** Conformance with a site switched on after `target`, which sets the target and answers its arguments of `space target set`. */
async function check(target: (sandbox: Sandbox) => Promise<string[]>) {
  const report = await conformance(dist, {
    async setup({ sandbox }) {
      await mkdir(join(sandbox.work, 'shop'), { recursive: true })
      await writeFile(join(sandbox.work, 'shop', 'index.html'), '<h1>小店</h1>\n')
      const agent = (...args: string[]) => sandbox.agent('setup', 'setup', args)
      const owner = (...args: string[]) => sandbox.owner(args)
      for (const r of [
        await agent('put', join(sandbox.work, 'shop'), '--to', 'sites/shop', '--made'),
        await agent('say', 'deployable', 'sites/shop'),
        await owner('space', 'target', 'set', ...(await target(sandbox))),
        await owner('space', 'on', 'sites/shop'),
      ]) {
        assert.equal(r.code, 0, r.stdout + r.stderr)
      }
    },
    configuration: ['config.json'],
  })
  console.log(report.text)
  assert.ok(report.ok, report.text)
}

test('the plugin follows the standard, publishing to PneumaSpace on a machine', () =>
  check(async (sandbox) => ['--kind', 'machine', '--admin', await sandbox.serve(fakeSpace()), '--prefix', 'pbs-conf']))

test('the plugin follows the standard, publishing to PneumaSpace on Cloudflare', () =>
  check(async (sandbox) => {
    const fake = fakeCloudflare()
    const origin = await sandbox.serve(fake.handler)
    await writeFile(join(sandbox.work, 'credentials.json'), JSON.stringify({ origin, account: fake.account, key: fake.key }))
    return ['--kind', 'cloudflare', '--credentials', join(sandbox.work, 'credentials.json'), '--prefix', 'pbs-conf']
  }))
