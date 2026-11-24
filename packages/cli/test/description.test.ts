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
const SAME_NAME_REVISE = part('kernel/cognition/3-same-name-with-revise.txt')

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

  it('of a default library carries the ledger section and lists the plugin; with no revise the bare same-name sentence', () => {
    const lib = join(root, 'default')
    expect(sb.run(['init', lib]).code).toBe(0)
    const text = description(lib)
    expect(text).toContain(LEDGER_SECTION)
    expect(text).toContain('- `ledger`：记账与对账')
    expect(text).toContain(SAME_NAME_BARE)
    expect(text).not.toContain('没有装任何插件')
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual(['ledger'])
  })

  it('gains the ledger section on plugin add and loses it on plugin remove', () => {
    const lib = join(root, 'lib')
    sb.run(['init', lib, '--bare'])
    const bare = description(lib)
    const add = sb.run(['plugin', 'add', 'ledger', '--library', lib])
    expect(add.code, add.stderr).toBe(0)
    expect(description(lib)).toContain(LEDGER_SECTION)
    const remove = sb.run(['plugin', 'remove', 'ledger', '--library', lib])
    expect(remove.code, remove.stderr).toBe(0)
    expect(description(lib)).toBe(bare)
  })

  it('uses the revise sentence exactly when an installed plugin provides revise', () => {
    const lib = join(root, 'lib')
    sb.runWithTestPlugins(['init', lib, '--bare'])
    expect(sb.runWithTestPlugins(['plugin', 'add', 'thrower', '--library', lib]).code).toBe(3)
    expect(description(lib)).toContain(SAME_NAME_REVISE)
    expect(description(lib)).not.toContain(SAME_NAME_BARE)
    sb.runWithTestPlugins(['plugin', 'remove', 'thrower', '--library', lib])
    expect(description(lib)).toContain(SAME_NAME_BARE)
  })
})

describe('plugin add and remove', () => {
  it('refuses an unknown plugin and removing one not installed, with exit 2', () => {
    const lib = join(root, 'lib')
    sb.run(['init', lib, '--bare'])
    expect(sb.run(['plugin', 'add', 'nope', '--library', lib]).stdout).toContain('unknown-plugin')
    expect(sb.run(['plugin', 'add', 'nope', '--library', lib]).code).toBe(2)
    expect(sb.run(['plugin', 'remove', 'ledger', '--library', lib]).code).toBe(2)
  })

  it('adding twice is accepted and changes nothing', () => {
    const lib = join(root, 'lib')
    sb.run(['init', lib])
    expect(sb.run(['plugin', 'add', 'ledger', '--library', lib]).code).toBe(0)
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual(['ledger'])
  })

  it('removing keeps the directory under the plugin name', () => {
    const lib = join(root, 'lib')
    sb.run(['init', lib])
    sb.run(['plugin', 'remove', 'ledger', '--library', lib])
    expect(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).toContain('"plugins": []')
    expect(() => readFileSync(join(lib, '.pneuma-base/ledger'))).toThrow(/EISDIR/)
  })
})
