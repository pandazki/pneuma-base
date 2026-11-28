// What the conformance runs over the five built-in plugins stand on: each built-in's setup, and one
// call that runs every check over one of them. Each built-in has its own test file, so the runs, the
// longest of the suite, go to different workers.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { deploy } from '@pneuma-base/plugin-deploy'
import { ledger } from '@pneuma-base/plugin-ledger'
import { search } from '@pneuma-base/plugin-search'
import { sync } from '@pneuma-base/plugin-sync'
import { version } from '@pneuma-base/plugin-version'
import type { Plugin } from '@pneuma-base/kernel'
import { conformance, type ConformanceOptions, type SetupContext } from '@pneuma-base/sdk/testkit'
import { tempDir } from './helpers.js'

const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/** A site in the library at sites/shop, and its next version beside the agent, as the version and deploy examples assume. */
async function shop({ sandbox, cwd }: SetupContext) {
  write(join(sandbox.work, 'shop-first/index.html'), '<h1>小店</h1>')
  expect((await sandbox.agent('setup', 'setup', ['put', join(sandbox.work, 'shop-first'), '--to', 'sites/shop', '--generated'])).code).toBe(0)
  write(join(cwd, 'shop/index.html'), '<h1>小店，换了配色</h1>')
}

/** A target in a directory outside the library, of the plugin's kind for one: sync's `dir`, deploy's `folder`. */
const target = (plugin: string, kind: string) => async ({ sandbox }: SetupContext) => {
  expect((await sandbox.owner([plugin, 'target', 'set', '--kind', kind, '--to', await tempDir(`pb-${plugin}-`)])).code).toBe(0)
}

/** What each built-in's examples stand on. The ledger's bring a page with curl, which here prints instead of fetching. */
const SETUP: Record<string, ConformanceOptions['setup']> = {
  async ledger({ sandbox, cwd, bin }) {
    write(join(bin, 'curl'), '#!/bin/sh\nfor last; do :; done\nprintf "<html>%s</html>" "$last"\n')
    chmodSync(join(bin, 'curl'), 0o755)
    write(join(cwd, 'comparison.md'), '# 支付服务对比\n')
    const put = ['put', '-', '--to', 'payments/sources/paddle-pricing.html', '--imported', '--source', 'https://www.paddle.com/pricing']
    expect((await sandbox.agent('setup', 'setup', put, { input: '<html>paddle</html>' })).code).toBe(0)
  },
  version: shop,
  sync: target('sync', 'dir'),
  async deploy(s) {
    await shop(s)
    await target('deploy', 'folder')(s)
  },
  search: undefined,
}

const BUILTINS: Record<string, Plugin> = { ledger, version, sync, deploy, search }

/** Runs every conformance check over a built-in plugin and expects none to fail. */
export async function passesEveryCheck(name: keyof typeof SETUP): Promise<void> {
  const setup = SETUP[name]
  const r = await conformance({ builtin: BUILTINS[name] as Plugin }, { cli, ...(setup ? { setup } : {}) })
  expect(r.checks.filter((c) => !c.ok), r.text).toEqual([])
}
