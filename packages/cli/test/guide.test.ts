// The guide an agent reads to connect itself: `pneuma-base guide [<产品>]` prints what the local
// endpoint serves at `/guide` and `/guide/<产品>`. With an endpoint running for the library, the
// guide gives its addresses; without, only the command-line forms.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { instant, recordEndpoint } from '@pneuma-base/kernel'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string

const origin = 'http://127.0.0.1:7638'
const pbHome = () => join(sb.home, '.pneuma-base')
const launcher = () => join(pbHome(), 'bin', 'pneuma-base')
const serve = (library = lib) => recordEndpoint(pbHome(), { url: origin, port: 7638, pid: process.pid, library, at: instant(Date.now()) })

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}${r.stderr}`).toBe(0)
  return r
}

// One library for the file: the tests with no endpoint come first, then one is recorded for the rest.
beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  ok(sb.run(['init', lib]))
})

describe('pneuma-base guide with no endpoint running', () => {
  it('gives the library, the command this machine runs, and the command-line form of pairing only', () => {
    const text = ok(sb.run(['guide', '--library', lib])).stdout
    expect(text).toMatch(/^# Pneuma Base：lib\n/)
    expect(text).toContain(lib)
    expect(text).toContain(`${launcher()} pair request <产品> "<为什么>" --library ${lib}`)
    expect(text).toContain(`${launcher()} @<授权名> start "<一句话>"`)
    expect(text).toContain(join(lib, 'PNEUMA-BASE.md'))
    expect(text).toContain(`${launcher()} @<授权名> mcp`)
    expect(text).toContain('pneuma-base guide claude-code')
    expect(text).not.toContain('http://')
    expect(existsSync(launcher())).toBe(true)
  })

  it('for Codex says what its sandbox needs, the library among its writable directories included', () => {
    const text = ok(sb.run(['guide', 'codex', '--library', lib])).stdout
    expect(text).toContain('沙箱')
    expect(text).toContain(`codex --add-dir ${lib}`)
    expect(text).not.toContain('http://')
  })

  it('refuses a name that cannot be a product, asks for --library, and has no address to give', () => {
    const bad = sb.run(['guide', 'My Agent', '--library', lib])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('不是一个产品名：My Agent')
    const none = sb.run(['guide'])
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('没有开着的 Pneuma Base 地址，用 --library <库的目录> 指明是哪个库')
    const notLibrary = sb.run(['guide', '--library', tempDir()])
    expect(notLibrary.code).toBe(2)
    expect(notLibrary.stdout).toContain('not-a-library')
    const url = sb.run(['guide', '--url'])
    expect(url.code).toBe(2)
    expect(url.stdout).toContain('no-endpoint')
  })
})

describe('pneuma-base guide with an endpoint running', () => {
  beforeAll(async () => {
    await serve()
  })

  it('gives its pairing, guide and MCP addresses, and needs no --library', () => {
    const text = ok(sb.run(['guide'])).stdout
    expect(text).toContain(`curl -s -X POST ${origin}/pair -H 'content-type: application/json' -d '{"product": "<产品>", "why": "<一句话>"}'`)
    expect(text).toContain(`${origin}/pair/<id>`)
    expect(text).toContain(`${launcher()} pair request <产品> "<为什么>" --library ${lib}`)
    expect(text).toContain(`${origin}/guide/claude-code`)
    expect(text).toContain(`${origin}/guide/codex`)
    expect(text).toContain(`${origin}/mcp/<授权名>`)
  })

  it('for Claude Code: its way of connecting here, where it is written, its pairing filled in, and what is known of it', () => {
    const text = ok(sb.run(['guide', 'claude-code'])).stdout
    expect(text).toMatch(/^# Pneuma Base：lib（给 Claude Code）\n/)
    expect(text).toContain('~/.claude/skills/pneuma-base-claude-code/SKILL.md')
    expect(text).toContain(`"product": "claude-code"`)
    expect(text).toContain(`${launcher()} pair request claude-code "<为什么>" --library ${lib}`)
    expect(text).toContain(`${launcher()} @claude-code start "<一句话>"`)
    expect(text).toContain('WebFetch')
    expect(text).toContain('CLAUDE_CODE_SESSION_ID')
  })

  it('--url prints the running endpoint’s guide address, and with --json the sentence the owner says', () => {
    expect(ok(sb.run(['guide', '--url'])).stdout.trim()).toBe(`${origin}/guide`)
    expect(ok(sb.run(['guide', '--url', '--json'])).json()).toEqual({ url: `${origin}/guide`, port: 7638, library: lib, sentence: `读一下 ${origin}/guide，接上我的 Pneuma Base 库。` })
  })
})
