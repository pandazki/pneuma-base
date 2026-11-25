// The plugin contract as a third party builds against it: the sdk's root export, re-exported by the kernel.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as sdk from '@pneuma-base/sdk'
import { describe, expect, it } from 'vitest'
import * as kernel from '../src/index.js'
import { tempDir } from './support.js'

describe('the sdk', () => {
  it('names the contract version, types a plugin as it is, and builds the branded values a plugin makes', () => {
    expect(sdk.CONTRACT).toBe(1)
    const plugin = { contract: sdk.CONTRACT, name: sdk.pluginName('echo'), cognition: null, storage: [], statements: [], ownerCommands: [] }
    expect(sdk.definePlugin(plugin)).toBe(plugin)
    expect(() => sdk.pluginName('Echo')).toThrow()
    expect(sdk.instant(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(() => sdk.instant('not a date')).toThrow()
  })

  it('is what the kernel exports, so imports from the kernel keep working', () => {
    expect(kernel.CONTRACT).toBe(1)
    expect(kernel.pluginName).toBe(sdk.pluginName)
    expect(kernel.definePlugin).toBe(sdk.definePlugin)
  })
})

describe('a plugin’s hooks', () => {
  it('are checked strictly: a hook that takes a narrower argument than the contract gives does not type-check', () => {
    const base = { contract: 1, name: sdk.pluginName('narrow'), cognition: null, storage: [], statements: [], ownerCommands: [] }
    const onPut = async (req: Extract<sdk.AcceptedPut, { kind: 'place' }>) => ({ text: req.source.kind })
    // @ts-expect-error onPut is given every kind of accepted put, not only a place
    const narrow: sdk.Plugin = { ...base, onPut }
    const run = async (_args: sdk.OwnerArgs, ctx: sdk.PluginContext & { extra: string }) => ({ outcome: 'done' as const, text: ctx.extra })
    // @ts-expect-error an owner command's run is given the plugin context, nothing more
    const command: sdk.OwnerCommand = { name: 'narrow x', summary: '', destructive: false, ownerOnly: false, run }
    expect([narrow, command]).toHaveLength(2)
  })
})

describe('the loader of a plugin outside the repository', () => {
  const GOOD = {
    contract: 1,
    name: 'echo',
    version: '0.1.0',
    summary: '回一句话',
    cognition: { title: '回声', text: '## 回声' },
    storage: [{ dir: 'state', kind: 'body' }],
    statements: ['echo'],
    ownerCommands: [{ name: 'echo now', summary: '', destructive: false, ownerOnly: false, run: 'RUN' }],
    views: [{ id: 'echo.page', title: '回声', icon: 'repeat', nav: true, filters: [] }],
    onSay: 'HOOK',
  }

  /** Why `index.js` exporting `parts` over GOOD does not load; null when it loads. Functions are written as the strings RUN and HOOK. */
  async function why(parts: Record<string, unknown>, drop: string[] = []): Promise<string | null> {
    const home = tempDir('pb-k-home-')
    const value = Object.fromEntries(Object.entries({ ...GOOD, ...parts }).filter(([k]) => !drop.includes(k)))
    const source = `export default ${JSON.stringify(value).replaceAll('"RUN"', 'async () => ({ outcome: "done", text: "" })').replaceAll('"HOOK"', 'async () => null')}\n`
    mkdirSync(join(home, 'plugins', 'echo'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'echo', 'index.js'), source)
    const table = await kernel.loadPlugins(home, new Map())
    const reason = await kernel.whyNotLoaded(home, 'echo')
    expect(table.has('echo')).toBe(reason === null)
    return reason
  }

  it('loads a plugin that declares a contract this kernel supports', async () => {
    expect(await why({})).toBeNull()
  })

  it('refuses one without a contract, or with one it does not support, saying so in Chinese', async () => {
    expect(await why({}, ['contract'])).toMatch(/没有写 contract.*第 1 版/)
    expect(await why({ contract: 2 })).toMatch(/contract 是 2.*只认识第 1 版/)
  })

  it('refuses the shapes it can check without calling a hook, naming each', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: 'other' }, /目录名 echo/],
      [{ statements: 'echo' }, /statements 不是列表/],
      [{ storage: [{ dir: 'state', kind: 'forever' }] }, /storage/],
      [{ cognition: { title: '回声' } }, /cognition/],
      [{ views: [{ id: 'other.page', title: '', icon: '', nav: true, filters: [] }] }, /视图 other\.page 不以 echo\. 开头/],
      [{ ownerCommands: [{ ...GOOD.ownerCommands[0], name: 'now' }] }, /主人命令「now」不以「echo 」开头/],
      [{ ownerCommands: [{ ...GOOD.ownerCommands[0], run: 'not a function' }] }, /run/],
      [{ onSay: 'not a function' }, /onSay 不是函数/],
      [{ statements: ['echo', 'echo'] }, /echo.*写了两次/],
      [{ version: 1 }, /version 不是文字/],
    ]
    for (const [parts, reason] of cases) expect(await why(parts), JSON.stringify(parts)).toMatch(reason)
  })

  it('refuses a command name the kernel uses', async () => {
    const home = tempDir('pb-k-home-')
    mkdirSync(join(home, 'plugins', 'plugin'), { recursive: true })
    const command = '{ name: "plugin add", summary: "", destructive: false, ownerOnly: false, run: async () => ({ outcome: "done", text: "" }) }'
    writeFileSync(join(home, 'plugins', 'plugin', 'index.js'), `export default { contract: 1, name: 'plugin', cognition: null, storage: [], statements: [], ownerCommands: [${command}] }\n`)
    expect(await kernel.whyNotLoaded(home, 'plugin')).toMatch(/主人命令「plugin add」是内核自己的/)
  })
})
