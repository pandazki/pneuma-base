// inspect --content: an agent that cannot read files (over MCP) reads a thing through inspect. A
// file's text when it is UTF-8 within the limit, else its size and kind; a bundle's files, or one of
// them. A grant limited to an area reads no content outside it; the facts are given as before.
// One library for the file.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const owner = (args: string[], input?: string | Buffer) => sb.run(['--library', lib, ...args], { cwd: outside, ...(input === undefined ? {} : { input }) })
const content = (r: Run) => r.json().content

beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  ok(sb.run(['init', lib]))
  ok(owner(['put', '-', '--to', 'notes/a.md', '--generated'], '# 甲\n下单流程\n'))
  ok(owner(['put', '-', '--to', 'pic.png', '--imported'], Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])))
  ok(owner(['put', '-', '--to', 'big.txt', '--generated'], 'x'.repeat(300 * 1024)))
  const site = join(outside, 'site')
  mkdirSync(join(site, 'css'), { recursive: true })
  writeFileSync(join(site, 'index.html'), '<h1>店</h1>\n')
  writeFileSync(join(site, 'css/a.css'), 'h1{}\n')
  ok(owner(['put', site, '--to', 'site', '--generated']))
  // A read-only grant on notes/, and things outside it and archived inside it.
  ok(owner(['put', '-', '--to', 'other.md', '--generated'], 'outside'))
  ok(owner(['put', '-', '--to', 'notes/old.md', '--generated'], 'archived inside'))
  ok(owner(['archive', 'notes/old.md']))
  ok(owner(['grant', 'create', 'g', '--agent', 'claude', '--area', 'notes', '--read-only']))
})

describe('inspect --content', () => {
  it('gives a file’s UTF-8 text, in the answer and in the result object, and only when asked; says what anything else is: not UTF-8 text, or over the limit, with its size and kind', () => {
    expect(ok(owner(['inspect', 'notes/a.md', '--content'])).stdout).toContain('内容（UTF-8 文本，19 字节）：\n# 甲\n下单流程\n')
    expect(content(ok(owner(['inspect', 'notes/a.md', '--content', '--json'])))).toEqual({ kind: 'text', path: 'notes/a.md', size: 19, text: '# 甲\n下单流程\n' })
    expect(ok(owner(['inspect', 'notes/a.md', '--json'])).json()).not.toHaveProperty('content')

    expect(content(ok(owner(['inspect', 'pic.png', '--content', '--json'])))).toEqual({ kind: 'other', path: 'pic.png', size: 12, type: 'image/png', why: 'not-utf8' })
    expect(ok(owner(['inspect', 'pic.png', '--content'])).stdout).toContain('内容：非 UTF-8 文本，image/png，12 字节，未返回。')
    expect(content(ok(owner(['inspect', 'big.txt', '--content', '--json'])))).toEqual({ kind: 'other', path: 'big.txt', size: 307200, type: null, why: 'too-large' })
    expect(ok(owner(['inspect', 'big.txt', '--content'])).stdout).toContain('内容：超过 256 KB 上限，307200 字节，未返回。')
  })

  it('lists a bundle’s first level, reads one of its files by its path in the bundle, and says when there is no such file; takes a file in a bundle only with --content, and only for a bundle', () => {
    const listed = ok(owner(['inspect', 'site', '--content']))
    expect(listed.stdout).toContain('第一层，共 2 项：\n  css/\n  index.html  13 字节\n查看其中一个文件：inspect site --content <文件>')
    const json = ok(owner(['inspect', 'site', '--content', '--json'])).json()
    expect(json.content).toMatchObject({ kind: 'level', path: 'site', level: { entries: [{ name: 'css', kind: 'dir' }, { name: 'index.html', kind: 'file', size: 13 }], more: 0 } })
    expect(json.file.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(content(ok(owner(['inspect', 'site', '--content', 'index.html', '--json'])))).toEqual({ kind: 'text', path: 'site/index.html', size: 13, text: '<h1>店</h1>\n' })
    expect(content(ok(owner(['inspect', 'site/css/a.css', '--content', '--json'])))).toMatchObject({ kind: 'text', path: 'site/css/a.css' })
    expect(content(ok(owner(['inspect', 'site', '--content', '../notes/a.md', '--json'])))).toEqual({ kind: 'unavailable', path: 'site', reason: 'no-such-file' })
    expect(ok(owner(['inspect', 'site', '--content', 'nope.html'])).stdout).toContain('内容：site 中不存在 nope.html。')

    expect(owner(['inspect', 'notes/a.md', 'b.md']).code).toBe(1)
    expect(content(ok(owner(['inspect', 'notes/a.md', '--content', 'b.md', '--json'])))).toEqual({ kind: 'unavailable', path: 'notes/a.md', reason: 'not-a-bundle' })
  })

  it('reads no content outside the area of the caller’s grant; the facts are given as before', () => {
    expect(content(ok(sb.run(['@g', 'inspect', 'notes/a.md', '--content', '--json'])))).toMatchObject({ kind: 'text', text: '# 甲\n下单流程\n' })
    expect(content(ok(sb.run(['@g', 'inspect', 'notes/old.md', '--content', '--json'])))).toMatchObject({ kind: 'text', path: '_archive/notes/old.md', text: 'archived inside' })
    const refused = ok(sb.run(['@g', 'inspect', 'other.md', '--content', '--json'])).json()
    expect(refused.content).toEqual({ kind: 'unavailable', path: 'other.md', reason: 'outside-grant' })
    expect(refused.file).toMatchObject({ path: 'other.md' })
    expect(ok(sb.run(['@g', 'inspect', 'other.md', '--content'])).stdout).toContain('内容：other.md 超出当前授权范围，不返回内容。')
  })
})
