// The standard's behavioural rules, as the test kit checks them for a third party, over the five
// built-in plugins; and over plugins that break them, so each check is seen to catch what it names.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deploy } from '@pneuma-base/plugin-deploy'
import { ledger } from '@pneuma-base/plugin-ledger'
import { search } from '@pneuma-base/plugin-search'
import { sync } from '@pneuma-base/plugin-sync'
import { version } from '@pneuma-base/plugin-version'
import type { Plugin } from '@pneuma-base/kernel'
import { conformance, type ConformanceOptions, type SetupContext } from '@pneuma-base/sdk/testkit'
import { tempDir } from './helpers.js'

const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/breakers/${name}/`, import.meta.url))

const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/** A site in the library at sites/shop, and its next version beside the agent, as the version and deploy examples assume. */
async function shop({ sandbox, cwd }: SetupContext) {
  write(join(sandbox.work, 'shop-first/index.html'), '<h1>小店</h1>')
  expect((await sandbox.agent('setup', 'setup', ['put', join(sandbox.work, 'shop-first'), '--to', 'sites/shop', '--made'])).code).toBe(0)
  write(join(cwd, 'shop/index.html'), '<h1>小店，换了配色</h1>')
}

const target = (plugin: string) => async ({ sandbox }: SetupContext) => {
  expect((await sandbox.owner([plugin, 'target', 'set', '--kind', 'dir', '--to', await tempDir(`pb-${plugin}-`)])).code).toBe(0)
}

/** What each built-in's examples stand on. The ledger's bring a page with curl, which here prints instead of fetching. */
const SETUP: Record<string, ConformanceOptions['setup']> = {
  async ledger({ sandbox, cwd, bin }) {
    write(join(bin, 'curl'), '#!/bin/sh\nfor last; do :; done\nprintf "<html>%s</html>" "$last"\n')
    chmodSync(join(bin, 'curl'), 0o755)
    write(join(cwd, 'comparison.md'), '# 支付服务对比\n')
    const put = ['put', '-', '--to', 'payments/sources/paddle-pricing.html', '--brought', '--source', 'https://www.paddle.com/pricing']
    expect((await sandbox.agent('setup', 'setup', put, { input: '<html>paddle</html>' })).code).toBe(0)
  },
  version: shop,
  sync: target('sync'),
  async deploy(s) {
    await shop(s)
    await target('deploy')(s)
  },
  search: undefined,
}

describe('conformance over the built-in plugins', () => {
  for (const plugin of [ledger, version, sync, deploy, search] as Plugin[]) {
    it(`${plugin.name} passes every check`, async () => {
      const setup = SETUP[plugin.name]
      const r = await conformance({ builtin: plugin }, { cli, ...(setup ? { setup } : {}) })
      expect(r.checks.filter((c) => !c.ok), r.text).toEqual([])
    })
  }
})

describe('conformance over plugins that break the rules', () => {
  it('names each rule a loaded plugin breaks, with what is wrong and the rule', async () => {
    const r = await conformance(fixture('rule-breaker'), { cli })
    const failed = Object.fromEntries(r.checks.filter((c) => !c.ok).map((c) => [c.name, c.problems.join('\n')]))
    expect(Object.keys(failed).sort()).toEqual(['blocks', 'cache', 'cognition', 'examples', 'hooks', 'remove', 'writes'])
    expect(failed.cognition).toContain('不是「## <它带来什么>：<怎么用>」这样的标题')
    expect(failed.cognition).toContain('用了占位 {{库}}')
    expect(failed.cognition).toContain('--include-archived')
    expect(failed.examples).toContain('pneuma-base @{{库}} say nonsense')
    expect(failed.hooks).toContain('空库上的 find')
    expect(failed.writes).toContain('stray.txt')
    expect(failed.writes).toContain('.pneuma-base/rule-breaker/last.json 被改写了')
    expect(failed.writes).toContain('打开视图和条目面板时')
    expect(failed.cache).toContain('find 符合性')
    expect(failed.blocks).toContain('missing.html')
    expect(failed.remove).toContain('conformance/moved.md 不在了')
    expect(r.text).toContain(`规则：${r.checks.find((c) => c.name === 'writes')?.rule}`)
  })

  it('stops at loading a plugin named after a word of the command line', async () => {
    const r = await conformance(fixture('reserved-name'), { cli })
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'names')?.problems).toEqual(['插件名 find 是命令行或内核自己用的词'])
    expect(r.checks.find((c) => c.name === 'loads')?.problems.join('\n')).toContain('命令行或内核自己用的词')
    expect(r.checks.find((c) => c.name === 'hooks')?.problems).toEqual(['没有查：插件没装上'])
  })
})
