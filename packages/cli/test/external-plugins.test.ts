// C3, K8: a plugin in the owner's $PNEUMA_BASE_HOME/plugins/<name>/index.js is installed with
// `plugin add` and hooked to the verbs; it gets a cache directory outside the library. One that
// fails to load fails no command: it is listed as a problem, and `plugin add` says why.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

const ECHO = `import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export default {
  contract: 2,
  name: 'echo',
  cognition: { title: '回声', text: '## 回声\\n\\n用 say echo "<一句话>" 它就回一句。' },
  storage: [],
  statements: ['echo'],
  ownerCommands: [],
  async onSay(req, ctx) {
    await mkdir(ctx.cacheDir, { recursive: true })
    await writeFile(join(ctx.cacheDir, 'last.txt'), req.text ?? '')
    return { outcome: 'heard', note: '回声：' + req.text }
  },
}
`
const BROKEN = `throw new Error('broken on purpose')\n`
const NO_CONTRACT = ECHO.replace('  contract: 2,\n', '')

let sb: Sandbox
let lib: string
let home: string

beforeEach(() => {
  sb = sandbox()
  home = join(sb.home, '.pneuma-base')
  lib = join(tempDir(), 'lib')
  expect(sb.run(['init', lib, '--bare']).code).toBe(0)
})

function plugin(name: string, source: string): void {
  mkdirSync(join(home, 'plugins', name), { recursive: true })
  writeFileSync(join(home, 'plugins', name, 'index.js'), source)
}

const run = (args: string[]) => sb.run(['--library', lib, ...args, '--json'], { cwd: tempDir('pb-outside-') })
const libraryId = () => JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).id as string

describe('a plugin from the owner’s plugin directory', () => {
  beforeEach(() => plugin('echo', ECHO))

  it('is not heard before it is added', () => {
    expect(run(['say', 'echo', 'hi']).json()).toMatchObject({ outcome: 'not-heard', reason: 'no-plugin-for-kind' })
  })

  it('is added by name, joins the description, and hears its say kind', () => {
    const add = run(['plugin', 'add', 'echo'])
    expect(add.code, add.stdout + add.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual(['echo'])
    expect(readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')).toContain('## 回声')
    const r = run(['say', 'echo', 'hi'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toEqual({ outcome: 'heard', by: 'echo', note: '回声：hi', problems: [] })
  })

  it('gets a cache directory outside the library, made by the plugin when it first uses it', () => {
    run(['plugin', 'add', 'echo'])
    const cache = join(home, 'cache', libraryId(), 'echo')
    expect(existsSync(cache)).toBe(false)
    run(['say', 'echo', 'hello'])
    expect(readFileSync(join(cache, 'last.txt'), 'utf8')).toBe('hello')
  })

  it('that breaks after it was added fails no command and is listed as a problem with the reason', () => {
    run(['plugin', 'add', 'echo'])
    plugin('echo', BROKEN)
    const find = run(['find'])
    expect(find.code).toBe(3)
    expect(find.json().problems).toHaveLength(1)
    expect(find.json().problems[0]).toMatchObject({ plugin: 'echo' })
    expect(find.json().problems[0].message).toContain('broken on purpose')
    expect(run(['say', 'echo', 'hi']).json()).toMatchObject({ outcome: 'not-heard', reason: 'no-plugin-for-kind' })
  })
})

describe('a plugin that fails to load', () => {
  beforeEach(() => plugin('broken', BROKEN))

  it('fails no command of a library that does not use it', () => {
    const r = run(['find'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json().problems).toEqual([])
  })

  it('is refused by plugin add, which says why', () => {
    const r = run(['plugin', 'add', 'broken'])
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'plugin-failed-to-load' })
    expect(r.json().text).toContain('broken on purpose')
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual([])
  })

  it('is refused by plugin add when it declares no contract, saying so in Chinese', () => {
    plugin('echo', NO_CONTRACT)
    const r = run(['plugin', 'add', 'echo'])
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'plugin-failed-to-load' })
    expect(r.json().text).toContain('没有写 contract')
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual([])
  })

  it('is refused by plugin add when it is written against contract 1, with the section of the standard to read', () => {
    plugin('echo', ECHO.replace('  contract: 2,\n', '  contract: 1,\n'))
    const r = run(['plugin', 'add', 'echo'])
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'plugin-failed-to-load' })
    expect(r.json().text).toContain('contract 是 1：这个 pneuma-base 只跑第 2 版插件契约。要改的地方见插件规范 PLUGINS.md 的「从第 1 版到第 2 版」一节')
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual([])
  })

  it('cannot shadow a built-in plugin', () => {
    plugin('ledger', BROKEN)
    expect(run(['plugin', 'add', 'ledger']).code).toBe(0)
    expect(run(['find']).json().problems).toEqual([])
  })
})

describe('plugin add and plugin remove through the command line', () => {
  const SPACE = `export default {
  contract: 2,
  name: 'space',
  cognition: null,
  storage: [],
  statements: ['deployable'],
  ownerCommands: [],
  async onSay() { return { outcome: 'heard', note: '记下了' } },
  async onRemove() { return { refuse: '还有网站在线；先 space off，它们才会下线。' } },
}
`
  const installed = () => JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins

  it('refuses a plugin whose say kind an installed plugin holds, naming the holder', () => {
    plugin('space', SPACE)
    expect(run(['plugin', 'add', 'deploy']).code).toBe(0)
    const r = run(['plugin', 'add', 'space'])
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'name-taken' })
    expect(r.json().text).toContain('「说」的种类「deployable」已归插件 deploy')
    expect(installed()).toEqual(['deploy'])
  })

  it('lets a plugin refuse its removal, and removes it with --anyway, repeating what it warned about', () => {
    plugin('space', SPACE)
    expect(run(['plugin', 'add', 'space']).code).toBe(0)
    const refused = run(['plugin', 'remove', 'space'])
    expect(refused.code).toBe(2)
    expect(refused.json()).toMatchObject({ outcome: 'refused', reason: 'plugin-refused' })
    expect(refused.json().text).toContain('还有网站在线')
    expect(installed()).toEqual(['space'])
    const anyway = sb.run(['--library', lib, 'plugin', 'remove', '--anyway', 'space'], { cwd: tempDir('pb-outside-') })
    expect(anyway.code, anyway.stderr).toBe(0)
    expect(anyway.stdout).toContain('它卸下前提醒过：还有网站在线')
    expect(installed()).toEqual([])
  })
})
