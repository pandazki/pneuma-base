// A folder that already had files when it became a library: the ledger asks the owner once whether
// they are all the owner's, brought in, and one owner command registers them all, however many, in
// one run of one process. ARCHITECTURE.md section 6.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string

const ok = (r: Run) => {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return r
}
const owner = (args: string[]) => sb.run(['--library', lib, ...args])

/** `count` files in folders of a hundred, made before the folder becomes a library. */
function folder(count: number): string {
  const dir = join(tempDir(), 'lib')
  for (let i = 0; i < count; i++) {
    const sub = join(dir, `d${Math.floor(i / 100)}`)
    if (i % 100 === 0) mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, `f${i}.txt`), `file ${i}`)
  }
  return dir
}

beforeEach(() => {
  sb = sandbox()
})

describe('things nobody registered, settled by the owner at once', () => {
  it('show home asks with both answers as commands; ledger register settles it and says how many', () => {
    lib = folder(3)
    ok(sb.run(['init', lib]))
    const home = ok(owner(['show', 'home'])).stdout
    expect(home).toContain('这里原来有 3 样东西，还没登记。都记为你带进来的吗？')
    expect(home).toContain('$ ledger register  # 都记为我带进来的')
    expect(home).toContain('$ ledger leave  # 不登记，不再问')
    expect(home).not.toContain('没人登记过的')
    expect(ok(owner(['ledger', 'register'])).stdout).toContain('已把 3 样东西记为主人带进来的。')
    expect(ok(owner(['show', 'home'])).stdout).not.toContain('还没登记')
    expect(ok(owner(['inspect', 'd0/f1.txt'])).stdout).toContain('带进来的，主人给的')
  })

  it('registers two thousand files in one run, written as one fact', () => {
    lib = folder(2_000)
    ok(sb.run(['init', lib]))
    expect(ok(owner(['ledger', 'register', '--json'])).json().data).toEqual({ registered: 2_000 })
    const facts = join(lib, '.pneuma-base/ledger/facts')
    const lines = readdirSync(facts, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .flatMap((e) => readFileSync(join(e.parentPath, e.name), 'utf8').trimEnd().split('\n'))
      .map((l) => JSON.parse(l) as { kind: string; items?: unknown[] })
    expect(lines.filter((f) => f.kind === 'items.enter').map((f) => f.items?.length)).toEqual([2_000])
    expect(lines.filter((f) => f.kind === 'item.enter')).toEqual([])
    expect(ok(owner(['show', 'home'])).stdout).not.toContain('还没登记')
  })
})
