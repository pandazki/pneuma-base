// A folder that already had files when it became a library: the ledger asks the owner about each place
// (ARCHITECTURE.md「问主人」): a directory nobody looked into is one question with three
// answers, and registering everything in it is a named act over all of it, in one run of one process,
// a fact for every few hundred so an interrupted run keeps what it did.
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
  it('show home asks with the three answers as commands; registering everything inside settles it and says how many', () => {
    lib = folder(3)
    ok(sb.run(['init', lib]))
    const home = ok(owner(['show', 'home'])).stdout
    expect(home).toContain('d0/ 没登记：3 个文件。')
    expect(home).toContain('$ put d0 --imported --by owner  # 登记成一样东西')
    expect(home).toContain('$ ledger register d0 --recursive  # 登记里面的文件（只给主人）；先问：要登记 d0/ 里任意深处的全部文件：3 个，不含噪音。')
    expect(home).toContain('$ ignore add d0  # 不用管')
    expect(home).not.toContain('没登记的目录')
    const registered = ok(owner(['ledger', 'register', 'd0', '--recursive']))
    expect(registered.stdout).toContain('已把 d0/里的 3 个文件记为主人带进来的。')
    expect(registered.stderr).toContain('要登记 d0/里的全部文件：3 个')
    expect(ok(owner(['show', 'home'])).stdout).not.toContain('还没登记')
    expect(ok(owner(['inspect', 'd0/f1.txt'])).stdout).toContain('带进来的，主人给的')
  })

  it('registers two thousand files in one run, five hundred to a fact', () => {
    lib = folder(2_000)
    ok(sb.run(['init', lib]))
    expect(ok(owner(['ledger', 'register', '.', '--recursive', '--json'])).json().data).toEqual({ registered: 2_000 })
    const facts = join(lib, '.pneuma-base/ledger/facts')
    const lines = readdirSync(facts, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .flatMap((e) => readFileSync(join(e.parentPath, e.name), 'utf8').trimEnd().split('\n'))
      .map((l) => JSON.parse(l) as { kind: string; items?: unknown[] })
    expect(lines.filter((f) => f.kind === 'items.enter').map((f) => f.items?.length)).toEqual([500, 500, 500, 500])
    expect(lines.filter((f) => f.kind === 'item.enter')).toEqual([])
    expect(ok(owner(['show', 'home'])).stdout).not.toContain('还没登记')
  })
})
