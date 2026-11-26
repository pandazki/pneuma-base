// The three kinds of directory come from the records, and the management UI's change stamp looks at
// where each plugin's facts end and at the open directories, nothing else.
import { describe, expect, it } from 'vitest'
import { changeStamp, dirKind, openDirsOf, pluginContext, type LibraryPath, type PluginName } from '../src/index.js'
import { fixture, plugin } from './support.js'

const p = (s: string) => s as LibraryPath

describe('the kinds of directory', () => {
  it('are open above a registered place, a thing when registered as one, closed otherwise; the root is always open', () => {
    const open = openDirsOf([p('notes/deep/a.md'), p('sites/shop')])
    expect([...open].sort()).toEqual(['', 'notes', 'notes/deep', 'sites'])
    const registered = { open, things: new Set(['sites/shop']) }
    expect(dirKind('', { open: new Set(), things: new Set() })).toBe('open')
    expect(dirKind('notes/deep', registered)).toBe('open')
    expect(dirKind('sites/shop', registered)).toBe('thing')
    expect(dirKind('vendor', registered)).toBe('closed')
  })
})

describe('the change stamp', () => {
  it('stays the same while nothing changes, and changes with a new fact, a new entry of an open directory, not one of a closed directory', async () => {
    const f = await fixture([plugin('keeper', { openDirs: async () => [p('notes')] })])
    f.write('notes/a.md', 'a')
    f.write('vendor/x.js', 'x')
    // The first ask starts the kernel's cursor; the next may still learn of the writes just made.
    let first = await changeStamp(f.ctx)
    for (let settled = await changeStamp(f.ctx), i = 0; settled !== first && i < 5; first = settled, settled = await changeStamp(f.ctx), i++);
    expect(await changeStamp(f.ctx)).toBe(first)
    await pluginContext(f.ctx, 'keeper' as PluginName).tools.storage.records.append([{ said: 'something' }])
    const second = await changeStamp(f.ctx)
    expect(second).not.toBe(first)
    f.write('vendor/y.js', 'y')
    expect(await changeStamp(f.ctx)).toBe(second)
    f.write('notes/b.md', 'b')
    expect(await changeStamp(f.ctx)).not.toBe(second)
  })
})
