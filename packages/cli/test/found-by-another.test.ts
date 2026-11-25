// A thing only the search plugin found reads like one the ledger also matched: under the heading of
// the scene it was made in, with its origin, then what search found in it.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sandbox, tempDir } from './helpers.js'

it('a sentence only search matches gives the item under its scene with its origin, in the same form as an exact word', () => {
  const sb = sandbox()
  const lib = join(tempDir(), 'lib')
  const outside = tempDir('pb-outside-')
  const ok = (args: string[]) => {
    const r = sb.run(args, { cwd: outside })
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
    return r.stdout.split('\n').filter((line) => line !== '')
  }
  const as = (agent: string, session: string, args: string[]) => ok(['--library', lib, '--as', agent, '--session', session, ...args])
  ok(['init', lib])
  writeFileSync(join(outside, 'coffee.md'), '手冲咖啡要注意水温和研磨度，闷蒸三十秒。\n')
  as('claude-code', 's1', ['say', 'doing', '写咖啡笔记'])
  as('claude-code', 's1', ['put', join(outside, 'coffee.md'), '--to', 'notes/coffee.md', '--made'])
  ok(['plugin', 'add', 'search', '--library', lib])
  ok(['search', 'embedder', 'set', '--kind', 'hash', '--library', lib])

  const exact = as('codex', 's2', ['find', '水温'])
  expect(exact).toHaveLength(2)
  expect(exact[0]).toMatch(/^场景 s1 · claude-code · \d{4}-\d\d-\d\d \d\d:\d\dZ · 在做：写咖啡笔记$/)
  expect(exact[1]).toBe('  notes/coffee.md  做出来的  正文：手冲咖啡要注意水温和研磨度，闷蒸三十秒。')
  expect(as('codex', 's2', ['find', '怎么冲出好喝的咖啡'])).toEqual(exact)
})
