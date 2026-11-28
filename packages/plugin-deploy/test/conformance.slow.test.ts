// The standard's behavioural rules, checked on the built-in plugin through the built command line, once
// for each kind of PneumaSpace, each with PneumaSpace in memory (fake-space.ts, fake-cloudflare.ts), so
// it needs no running service. A site is switched on first, so the views are checked with an app
// online. When a check fails, report.text says what and why. The local directory's run is
// packages/cli/test/conformance-deploy.test.ts.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { conformance, type Sandbox } from '@pneuma-base/sdk/testkit'
import { expect, it } from 'vitest'
import { deploy } from '../src/index.js'
import { fakeCloudflare } from './fake-cloudflare.js'
import { fakeSpace } from './fake-space.js'

const cli = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))

/** Conformance with a site switched on after `target`, which sets the target and answers its arguments of `deploy target set`. */
async function check(target: (sandbox: Sandbox) => Promise<string[]>) {
  const report = await conformance({ builtin: deploy }, {
    cli,
    async setup({ sandbox }) {
      await mkdir(join(sandbox.work, 'shop'), { recursive: true })
      await writeFile(join(sandbox.work, 'shop', 'index.html'), '<h1>小店</h1>\n')
      const agent = (...args: string[]) => sandbox.agent('setup', 'setup', args)
      const owner = (...args: string[]) => sandbox.owner(args)
      for (const r of [
        await agent('put', join(sandbox.work, 'shop'), '--to', 'sites/shop', '--generated'),
        await agent('say', 'deployable', 'sites/shop'),
        await owner('deploy', 'target', 'set', ...(await target(sandbox))),
        await owner('deploy', 'publish', 'sites/shop'),
      ]) {
        assert.equal(r.code, 0, r.stdout + r.stderr)
      }
    },
    configuration: ['config.json'],
  })
  expect(report.checks.filter((c) => !c.ok), report.text).toEqual([])
}

it('the plugin follows the standard, publishing to PneumaSpace on a machine', () =>
  check(async (sandbox) => ['--kind', 'self-hosted', '--admin', await sandbox.serve(fakeSpace()), '--prefix', 'pbs-conf']))

it('the plugin follows the standard, publishing to PneumaSpace on Cloudflare', () =>
  check(async (sandbox) => {
    const fake = fakeCloudflare()
    const origin = await sandbox.serve(fake.handler)
    await writeFile(join(sandbox.work, 'credentials.json'), JSON.stringify({ origin, account: fake.account, key: fake.key }))
    return ['--kind', 'cloudflare', '--credentials', join(sandbox.work, 'credentials.json'), '--prefix', 'pbs-conf']
  }))
