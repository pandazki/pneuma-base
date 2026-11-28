// The standard's behavioural rules, as the test kit checks them for a third party, over plugins that
// break them, so each check is seen to catch what it names. The five built-in plugins passing every
// check: conformance-<plugin>.test.ts, one file each.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { conformance } from '@pneuma-base/sdk/testkit'

const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/breakers/${name}/`, import.meta.url))

// The tests run concurrently where there are cores for it (vitest's maxConcurrency at a time): the kit keeps no process state, and
// each check works in temporary libraries of its own. On CI's two cores they run one after another, each with room to finish.
const together = process.env.CI ? describe : describe.concurrent
together('conformance over plugins that break the rules', { timeout: 180_000 }, () => {
  it('names each rule a loaded plugin breaks, with what is wrong and the rule', async () => {
    const r = await conformance(fixture('rule-breaker'), { cli })
    const failed = Object.fromEntries(r.checks.filter((c) => !c.ok).map((c) => [c.name, c.problems.join('\n')]))
    expect(Object.keys(failed).sort()).toEqual(['blocks', 'cache', 'catchup', 'cognition', 'examples', 'hooks', 'remove', 'writes'])
    expect(failed.cognition).toContain('不是「## <功能>：<用法>」形式的标题')
    expect(failed.cognition).toContain('使用了占位符 {{库}}')
    expect(failed.cognition).toContain('--include-archived')
    expect(failed.examples).toContain('pneuma-base @{{库}} say nonsense')
    expect(failed.hooks).toContain('空资料库上的 find')
    expect(failed.writes).toContain('stray.txt')
    expect(failed.writes).toContain('.pneuma-base/rule-breaker/last.json 被改写')
    expect(failed.writes).toContain('打开视图和条目面板时')
    // A destructive owner command, confirmed as a person confirms it, may drop the plugin's own files, and change nothing else.
    expect(failed.writes).toContain('所有者命令 rule-breaker drop时，dropped.txt 被创建')
    expect(failed.writes).not.toContain('rule-breaker drop时，插件自身目录中已有的')
    expect(failed.cache).toContain('find 符合性')
    // What it knows comes from its cache of the puts it heard, so in a library it is added to later it knows nothing.
    expect(failed.catchup).toContain('后启用并补录后，find 符合性早先 的答复与启用状态下添加时不同')
    expect(failed.blocks).toContain('missing.html')
    expect(failed.blocks).toContain('custom 块指向 silent.html：页面未载入 /plugin-kit/frame.js')
    expect(failed.blocks).toContain('custom 块指向 silent.html：页面脚本未调用 pneuma.onData')
    expect(failed.blocks).not.toContain('custom 块指向 framed.html')
    expect(failed.blocks).toContain('缺少 text')
    expect(failed.blocks).toContain('操作「去哪」调用的所有者命令「rule-breaker nowhere」在此资料库中不存在')
    expect(failed.remove).toContain('conformance/moved.md 已缺失或已修改')
    expect(r.text).toContain(`规则：${r.checks.find((c) => c.name === 'writes')?.rule}`)
  })

  it('names a plugin that pages through the library’s directories: what it took past a page, and the directories nobody registered it looked in', async () => {
    const r = await conformance(fixture('walker'), { cli })
    const failed = Object.fromEntries(r.checks.filter((c) => !c.ok).map((c) => [c.name, c.problems.join('\n')]))
    expect(Object.keys(failed), r.text).toEqual(['bounded'])
    expect(failed.bounded).toMatch(/check时，插件对资料库内容的一览和探查共获取 \d+ 条，超过一页（1000 条）/)
    expect(failed.bounded).toContain('check时，插件对未登记的目录 conformance-heap 执行一览：conformance-heap')
    expect(failed.bounded).toContain('check时，插件对未登记的目录 conformance-locked 执行一览：conformance-locked')
    expect(r.text).toContain(`规则：${r.checks.find((c) => c.name === 'bounded')?.rule}`)
  })

  it('lets a plugin probe a directory nobody registered, once and budgeted, and names any look below it', async () => {
    const r = await conformance(fixture('peeker'), { cli })
    const failed = Object.fromEntries(r.checks.filter((c) => !c.ok).map((c) => [c.name, c.problems]))
    expect(Object.keys(failed), r.text).toEqual(['bounded'])
    expect(failed.bounded).toContain('check时，插件对未登记的目录 conformance-heap 执行探查：conformance-heap/below')
    expect(failed.bounded).toContain('check时，插件对未登记的目录 conformance-heap 执行读取：conformance-heap/0.txt')
    expect(failed.bounded?.filter((p) => p.endsWith('：conformance-heap'))).toEqual([])
  })

  it('leaves a plugin no way to write a record place not its own', async () => {
    const r = await conformance(fixture('trespasser'), { cli })
    const failed = Object.fromEntries(r.checks.filter((c) => !c.ok).map((c) => [c.name, c.problems]))
    expect(Object.keys(failed), r.text).toEqual(['hooks'])
    expect(failed.hooks?.join('\n')).toMatch(/没能写别的记录处：.*append.*；.*write/)
  })

  it('names a plugin that learns what is registered from puts and does not catch up', async () => {
    const r = await conformance(fixture('forgetful'), { cli })
    const failed = Object.fromEntries(r.checks.filter((c) => !c.ok).map((c) => [c.name, c.problems]))
    expect(Object.keys(failed), r.text).toEqual(['catchup'])
    expect(failed.catchup).toContain('后启用并补录后，条目面板 conformance/early.md 的答复与启用状态下添加时不同')
  })

  it('stops at loading a plugin written against contract 1, or named after a word of the command line', async () => {
    const [old, reserved] = await Promise.all([conformance(fixture('old-contract'), { cli }), conformance(fixture('reserved-name'), { cli })])
    expect(old.checks.find((c) => c.name === 'loads')?.ok, old.text).toBe(false)
    expect(old.checks.find((c) => c.name === 'hooks')?.problems).toEqual(['未检查：插件加载失败'])
    expect(reserved.ok).toBe(false)
    expect(reserved.checks.find((c) => c.name === 'names')?.problems).toEqual(['插件名称 find 为命令行或内核保留'])
    expect(reserved.checks.find((c) => c.name === 'loads')?.problems.join('\n')).toContain('为命令行或内核保留')
    expect(reserved.checks.find((c) => c.name === 'hooks')?.problems).toEqual(['未检查：插件加载失败'])
  })
})
