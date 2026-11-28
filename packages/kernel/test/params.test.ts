// C4 at the kernel: a command with `params` is checked at the owner face's one entry before `run`,
// which gets the values by name; a call that does not fit is refused as usage with the usage line
// made from the params; the sdk's form for the command fills a call the kernel reads the same way.
import { describe, expect, it } from 'vitest'
import { defineCommand, formOf, ownerFace, type Call, type OwnerCall, type OwnerValues } from '../src/index.js'
import { fixture, plugin, type Fixture } from './support.js'

const seen: OwnerValues[] = []
const shape = defineCommand({
  name: 'shape run',
  summary: '',
  destructive: false,
  ownerOnly: false,
  params: {
    positional: [
      { name: 'path', hint: '路径', required: true, pattern: '[a-z/]+' },
      { name: 'more', hint: '更多', many: true },
    ],
    flags: [
      { name: 'force', hint: '强行', kind: 'boolean' },
      { name: 'tags', hint: '标签', kind: 'list' },
      { name: 'mode', hint: '方式', kind: 'value', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] },
      { name: 'to', hint: '去哪', kind: 'value', required: true },
    ],
  },
  run: async (values) => {
    seen.push(values)
    return { outcome: 'done', text: 'ran' }
  },
})

const USAGE = '用法：shape run <路径> [<更多>…] [--force] [--tags <标签>…] [--mode a|b] --to <去哪>'

async function shaped(): Promise<{ f: Fixture; run(positional: string[], flags: Record<string, string[] | true>): Promise<unknown> }> {
  const f = await fixture([plugin('shape', { ownerCommands: [shape] })])
  const call: OwnerCall = { ctx: f.ctx, table: new Map(), env: {}, viaGrant: false, confirm: async () => true }
  return { f, run: (positional, flags) => ownerFace.dispatch(call, 'shape run', { positional, flags }) }
}

describe('a command with params', () => {
  it('gets the values by name: positionals, the rest, a switch, a list and a value', async () => {
    const { run } = await shaped()
    seen.length = 0
    expect(await run(['a/b', 'x', 'y'], { force: true, tags: ['t1', 't2'], mode: ['b'], to: ['there'] })).toMatchObject({ outcome: 'done' })
    expect(seen).toEqual([{ path: 'a/b', more: ['x', 'y'], force: true, tags: ['t1', 't2'], mode: 'b', to: 'there' }])
  })

  it('takes what was left out, and a form’s empty fields, as not given', async () => {
    const { run } = await shaped()
    seen.length = 0
    await run(['a'], { to: ['t'] })
    await run(['a', ''], { force: ['no'], tags: [''], mode: [''], to: ['t'] })
    await run(['a'], { force: ['yes'], to: ['t'] })
    expect(seen).toEqual([
      { path: 'a', more: [], force: false, tags: [], mode: null, to: 't' },
      { path: 'a', more: [], force: false, tags: [], mode: null, to: 't' },
      { path: 'a', more: [], force: true, tags: [], mode: null, to: 't' },
    ])
  })

  it('refuses a call that does not fit, as usage, naming what is wrong, with the usage line; run is not called', async () => {
    const { run } = await shaped()
    seen.length = 0
    const cases: [string[], Record<string, string[] | true>, string][] = [
      [[], { to: ['t'] }, 'shape run 缺少 <路径>。'],
      [['A'], { to: ['t'] }, '<路径> 的值「A」无效，须完整匹配 [a-z/]+。'],
      [['a'], {}, '缺少 --to <去哪>。'],
      [['a'], { to: [''] }, '缺少 --to <去哪>。'],
      [['a'], { to: ['t'], colour: ['red'] }, 'shape run 不支持 --colour。'],
      [['a'], { to: ['t'], mode: ['c'] }, '--mode 只能为 a、b：c'],
      [['a'], { to: ['t', 'u'] }, '--to 只接受一个值。'],
      [['a'], { to: ['t'], force: ['maybe'] }, '--force 不接受值。'],
    ]
    for (const [positional, flags, text] of cases) {
      expect(await run(positional, flags)).toMatchObject({ outcome: 'refused', reason: 'usage', text: `${text}\n${USAGE}` })
    }
    expect(seen).toEqual([])
  })

  it('lists its usage, made from the params, in the owner face', async () => {
    const { f } = await shaped()
    const info = ownerFace.commands(f.library.plugins).find((c) => c.name === 'shape run')
    expect(info).toMatchObject({ usage: USAGE.slice('用法：shape run '.length), params: shape.params })
  })
})

/** What the page does to a call before it sends it: each `{input}` replaced, a multiple input's lines one element each. */
function fill(call: Call, values: Record<string, string>, multiple: string[]): Call {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{([^{}]+)\}/g, (whole, name: string) => values[name] ?? whole)
    if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' && multiple.includes(x.slice(1, -1)) ? (values[x.slice(1, -1)] ?? '').split('\n').filter((l) => l !== '') : [walk(x)]))
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(call) as Call
}

describe('the form the sdk makes from params', () => {
  it('asks for each argument, labelled by its hint, with its pattern and options, and its call reads as the command line’s', async () => {
    const { inputs, call } = formOf(shape)
    expect(inputs.map((i) => [i.name, i.label, i.multiple ?? false, i.pattern ?? null, i.options?.map((o) => o.value) ?? null])).toEqual([
      ['path', '路径', false, '[a-z/]+', null],
      ['more', '更多', true, null, null],
      ['force', '强行', false, null, ['no', 'yes']],
      ['tags', '标签', true, null, null],
      ['mode', '方式', false, null, ['a', 'b']],
      ['to', '去哪', false, null, null],
    ])
    const filled = fill(call, { path: 'a/b', more: 'x\ny', force: 'yes', tags: 't1\nt2', mode: 'b', to: 'there' }, ['more', 'tags'])
    expect(filled.face).toBe('owner')
    const { run } = await shaped()
    seen.length = 0
    if (filled.face !== 'owner') return
    await run(filled.args.positional, filled.args.flags)
    await run(['a/b', 'x', 'y'], { force: true, tags: ['t1', 't2'], mode: ['b'], to: ['there'] })
    expect(seen[0]).toEqual(seen[1])
  })

  it('leaves out what the caller fixes, and fills what it is given', () => {
    const { inputs, call } = formOf(shape, { fixed: { path: 'a', force: true, more: [] }, values: { to: 'here' } })
    expect(inputs.map((i) => i.name)).toEqual(['tags', 'mode', 'to'])
    expect(inputs.find((i) => i.name === 'to')?.value).toBe('here')
    expect(call).toEqual({ face: 'owner', command: 'shape run', args: { positional: ['a'], flags: { force: true, tags: ['{tags}'], mode: ['{mode}'], to: ['{to}'] } } })
  })
})
