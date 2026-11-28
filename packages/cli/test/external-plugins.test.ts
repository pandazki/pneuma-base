// C3, K8: a plugin in the owner's $PNEUMA_BASE_HOME/plugins/<name>/index.js is installed with
// `plugin enable` and hooked to the verbs; it gets a cache directory outside the library. One that
// fails to load fails no command: it is listed as a problem, and `plugin enable` says why. The loader's
// refusals of the shapes it checks (no contract, contract 1, a name another plugin holds) and a plugin
// refusing its removal are packages/kernel/test/contract.test.ts's.
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

  it('is added by name, joins the description, hears its say kind, and gets a cache directory outside the library, made by the plugin when it first uses it', () => {
    const add = run(['plugin', 'enable', 'echo'])
    expect(add.code, add.stdout + add.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual(['echo'])
    expect(readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')).toContain('## 回声')
    const cache = join(home, 'cache', libraryId(), 'echo')
    expect(existsSync(cache)).toBe(false)
    const r = run(['say', 'echo', 'hi'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toEqual({ outcome: 'heard', by: 'echo', note: '回声：hi', problems: [] })
    expect(readFileSync(join(cache, 'last.txt'), 'utf8')).toBe('hi')
  })

  it('that breaks after it was added fails no command and is listed as a problem with the reason', () => {
    run(['plugin', 'enable', 'echo'])
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
  it('fails no command of a library that does not use it; plugin enable refuses it, saying why; under a built-in plugin’s name it shadows nothing', () => {
    plugin('broken', BROKEN)
    const find = run(['find'])
    expect(find.code, find.stderr).toBe(0)
    expect(find.json().problems).toEqual([])
    const r = run(['plugin', 'enable', 'broken'])
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'plugin-failed-to-load' })
    expect(r.json().text).toContain('broken on purpose')
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base/config.json'), 'utf8')).plugins).toEqual([])

    plugin('ledger', BROKEN)
    expect(run(['plugin', 'enable', 'ledger']).code).toBe(0)
    expect(run(['find']).json().problems).toEqual([])
  })
})
