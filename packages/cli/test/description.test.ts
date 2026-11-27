// C8, K6: the description promises only what the installed plugins provide.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

const packages = fileURLToPath(new URL('../..', import.meta.url))
const part = (path: string) => readFileSync(join(packages, path), 'utf8').trimEnd().replaceAll('{{授权的名字}}', '<你的授权名>')
const LEDGER_SECTION = part('plugin-ledger/cognition/2-ledger-section.md')
const SAME_NAME_BARE = part('kernel/cognition/3-same-name-bare.txt')
const SAME_NAME_SOME = part('kernel/cognition/3-same-name-some.txt')
const SAME_NAME_EVERY = part('kernel/cognition/3-same-name-every.txt')

let sb: Sandbox
let root: string
beforeEach(() => {
  sb = sandbox()
  root = tempDir()
})

const description = (lib: string) => readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')

describe('the description', () => {
  it('of a bare library is the kernel parts and the bare configuration, and makes no ledger promise', () => {
    const lib = join(root, 'bare')
    expect(sb.run(['init', lib, '--bare']).code).toBe(0)
    const text = description(lib)
    const rules = part('kernel/cognition/3-kernel-rules.md').replace('{{同名时怎么办}}', SAME_NAME_BARE)
    expect(text).toBe(`${[part('kernel/cognition/1-kernel-intro.md'), rules, part('kernel/cognition/4-config-bare.md')].join('\n\n')}\n`)
    for (const promise of ['回到', '可能过期', '记账', 'start', '来自', '依据']) expect(text).not.toContain(promise)
    expect(text).not.toContain('{{')
    expect(text).toContain('你的授权名在你的技能文件里')
  })

  it('says what happens to replaced content as the plugins change: refused with no plugin that revises, some kept, or every one kept (K6); plugin add brings a plugin’s section and lists it, plugin remove takes both away', () => {
    const lib = join(root, 'lib')
    sb.runWithTestPlugins(['init', lib, '--bare'])
    const bare = description(lib)
    const sentence = () => [SAME_NAME_BARE, SAME_NAME_SOME, SAME_NAME_EVERY].filter((s) => description(lib).includes(s))
    expect(sentence()).toEqual([SAME_NAME_BARE])
    // A plugin that revises without saying what it keeps keeps only some, as far as the description promises.
    expect(sb.runWithTestPlugins(['plugin', 'add', 'thrower', '--library', lib]).code).toBe(3)
    expect(sentence()).toEqual([SAME_NAME_SOME])
    sb.runWithTestPlugins(['plugin', 'remove', 'thrower', '--library', lib])
    // The version plugin keeps only what agents declared versioned; the ledger keeps every replaced thing.
    expect(sb.run(['plugin', 'add', 'version', '--library', lib]).code).toBe(0)
    expect(sentence()).toEqual([SAME_NAME_SOME])
    expect(sb.run(['plugin', 'add', 'ledger', '--library', lib]).code).toBe(0)
    expect(sentence()).toEqual([SAME_NAME_EVERY])
    expect(description(lib)).toContain(LEDGER_SECTION)
    expect(description(lib)).toContain('- `ledger`：记账与对账')
    expect(sb.run(['plugin', 'remove', 'ledger', '--library', lib]).code).toBe(0)
    expect(sb.run(['plugin', 'remove', 'version', '--library', lib]).code).toBe(0)
    expect(description(lib)).toBe(bare)
  })

  it('with only the version plugin, an undeclared thing is refused as the description says, and the answer says why', () => {
    const lib = join(root, 'lib')
    sb.run(['init', lib, '--bare'])
    expect(sb.run(['plugin', 'add', 'version', '--library', lib]).code).toBe(0)
    const agent = (args: string[], input: string) => sb.run(['--library', lib, '--as', 'claude-code', ...args], { input })
    expect(agent(['put', '-', '--to', 'a.md', '--made'], 'one').code).toBe(0)
    const refused = agent(['put', '-', '--to', 'a.md', '--made'], 'two')
    expect(refused.code).toBe(2)
    expect(refused.stdout).toContain('没有插件替它留住旧内容')
    expect(refused.stdout).toContain('version：a.md 没有声明有版本。要改它并留住旧版，先 say versioned a.md，再放。')
    expect(agent(['say', 'versioned', 'a.md'], '').code).toBe(0)
    expect(agent(['put', '-', '--to', 'a.md', '--made'], 'two').code).toBe(0)
  })
})

describe('plugin add and remove', () => {
  it('refuses an unknown plugin and removing one not installed, with exit 2; adding twice changes nothing; removing keeps the directory under the plugin name', () => {
    const lib = join(root, 'lib')
    sb.run(['init', lib])
    const unknown = sb.run(['plugin', 'add', 'nope', '--library', lib])
    expect(unknown.code).toBe(2)
    expect(unknown.stdout).toContain('unknown-plugin')
    expect(sb.run(['plugin', 'add', 'ledger', '--library', lib]).code).toBe(0)
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual(['ledger'])
    expect(sb.run(['plugin', 'remove', 'ledger', '--library', lib]).code).toBe(0)
    expect(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).toContain('"plugins": []')
    expect(() => readFileSync(join(lib, '.pneuma-base/ledger'))).toThrow(/EISDIR/)
    expect(sb.run(['plugin', 'remove', 'ledger', '--library', lib]).code).toBe(2)
  })
})
