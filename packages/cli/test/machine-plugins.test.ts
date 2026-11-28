// B3, B4, D9: a plugin is a directory (index.js, what it imports, an optional ui/) the owner installs
// on this machine, replaces, lists and uninstalls; a running UI server uses a changed plugin on its
// next request, and sets a plugin's secret from the page into the store the command line reads. That
// these are the owner's alone is packages/kernel/test/owner.test.ts's.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PNEUMA_BASE_VERSION } from '@pneuma-base/kernel'
import { pager, VAULT, writePlugin } from './fixtures/machine-plugins.js'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let home: string
let lib: string

beforeEach(() => {
  sb = sandbox()
  home = join(sb.home, '.pneuma-base')
  lib = join(tempDir(), 'lib')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const source = (files: Record<string, string>) => writePlugin(join(tempDir('pb-src-'), 'dist'), files)
const install = (dir: string) => sb.run(['plugin', 'install', dir, '--json'])

describe('plugin install', () => {
  it('copies a plugin directory, with the modules it imports and its ui, onto this machine, and says its version; over an installed one it replaces it and says which version replaced which', () => {
    const r = install(source(pager('第一版', '0.1.0')))
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'done', data: { name: 'pager', version: '0.1.0', replaced: null } })
    expect(r.json().text).toContain('pager 0.1.0')
    const dir = join(home, 'plugins', 'pager')
    expect(readFileSync(join(dir, 'lib', 'words.js'), 'utf8')).toContain('第一版')
    expect(existsSync(join(dir, 'ui', 'page.html'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({ type: 'module' })
    expect(sb.run(['plugin', 'enable', 'pager', '--library', lib]).code).toBe(0)

    const again = install(source(pager('第二版', '0.2.0')))
    expect(again.code, again.stderr).toBe(0)
    expect(again.json()).toMatchObject({ data: { version: '0.2.0', replaced: '0.1.0' } })
    expect(again.json().text).toContain('pager 0.2.0 装到这台机器上，换掉了原来的 0.1.0')
    expect(readFileSync(join(dir, 'lib', 'words.js'), 'utf8')).toContain('第二版')
  })

  it('refuses a name a built-in plugin holds, a directory that is no plugin, and a command that declares no params, at add too when put in place by hand, leaving the installed one as it was', () => {
    install(source(pager('第一版', '0.1.0')))
    const builtIn = install(source({ 'index.js': "export default { contract: 2, name: 'ledger', cognition: null, storage: [], statements: [], ownerCommands: [] }\n" }))
    expect(builtIn.json()).toMatchObject({ outcome: 'refused', reason: 'built-in-name' })
    const bad = pager('坏的', '9.9.9')
    const broken = install(source({ ...bad, 'index.js': (bad['index.js'] as string).replace('contract: 2', 'contract: 7') }))
    expect(broken.json()).toMatchObject({ outcome: 'refused', reason: 'plugin-failed-to-load' })
    expect(broken.json().text).toContain('contract 是 7')
    const badParams = source({
      'index.js': `export default { contract: 2, name: 'odd', cognition: null, storage: [], statements: [], ownerCommands: [
  { name: 'odd go', summary: '', destructive: false, ownerOnly: false, params: { flags: [{ name: 'quiet', hint: '安静', kind: 'boolean', required: true }] }, run: async () => ({ outcome: 'done', text: '' }) },
] }\n`,
    })
    expect(install(badParams).json().text).toContain('--quiet 是开关，不能 required')
    expect(install(join(tempDir('pb-empty-'))).json()).toMatchObject({ outcome: 'refused', reason: 'plugin-failed-to-load' })
    expect(readFileSync(join(home, 'plugins', 'pager', 'lib', 'words.js'), 'utf8')).toContain('第一版')
    expect(existsSync(join(home, 'plugins', 'odd'))).toBe(false)

    const LOOSE = {
      'package.json': '{ "type": "module" }\n',
      'index.js': `export default { contract: 2, name: 'loose', cognition: null, storage: [], statements: [], ownerCommands: [
  { name: 'loose go', summary: '', destructive: false, ownerOnly: false, run: async () => ({ outcome: 'done', text: '' }) },
] }\n`,
    }
    const loose = install(source(LOOSE))
    expect(loose.json()).toMatchObject({ outcome: 'refused', reason: 'plugin-failed-to-load' })
    expect(loose.json().text).toContain('主人命令「loose go」没有 params：每条命令都声明它的参数，什么都不带的写 params: {}')
    expect(existsSync(join(home, 'plugins', 'loose'))).toBe(false)
    writePlugin(join(home, 'plugins', 'loose'), LOOSE)
    const added = sb.run(['plugin', 'enable', 'loose', '--library', lib, '--json'])
    expect(added.json()).toMatchObject({ outcome: 'refused', reason: 'plugin-failed-to-load' })
    expect(added.json().text).toContain('主人命令「loose go」没有 params')
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')).plugins).toEqual(['ledger'])
  })
})

describe('plugin list', () => {
  it('lists the built-in plugins and the installed ones with version, contract, the name a person says with its short line and its whole text, and which a library has', () => {
    install(source(pager('第一版', '0.1.0')))
    const machine = sb.run(['plugin', 'list'])
    expect(machine.code, machine.stderr).toBe(0)
    expect(machine.stdout).toContain('pager 0.1.0  契约 2 · 装上来的\n    一页字\n')
    expect(machine.stdout).toMatch(/ledger 0\.9\.0 {2}契约 2 · 自带\n {4}记账：[^\n]+\n {4}记下每样东西是哪次会话/)
    expect(machine.stdout).not.toContain('这个库装了')
    sb.run(['plugin', 'enable', 'pager', '--library', lib])
    const listed = sb.run(['plugin', 'list', '--library', lib, '--json']).json().data.plugins
    expect(listed).toContainEqual({ name: 'pager', version: '0.1.0', contract: 2, title: null, summary: '一页字', about: null, origin: 'machine', enabled: true, failed: null })
    expect(listed).toContainEqual(expect.objectContaining({ name: 'ledger', origin: 'built-in', enabled: true }))
    expect(listed).toContainEqual(expect.objectContaining({ name: 'deploy', origin: 'built-in', enabled: false }))
    // Each built-in plugin: a title, a short line of twenty characters at most, and its whole text in sentences.
    const titles = Object.fromEntries(listed.map((p: { name: string; title: string | null }) => [p.name, p.title]))
    expect([titles.ledger, titles.version, titles.sync, titles.deploy, titles.search]).toEqual(['记账', '版本', '同步', '部署', '查找'])
    for (const name of ['ledger', 'version', 'sync', 'deploy', 'search']) {
      const p = listed.find((q: { name: string }) => q.name === name)
      expect(p, name).toMatchObject({ version: PNEUMA_BASE_VERSION, summary: expect.stringMatching(/^[^\n。]{1,20}$/u), about: expect.stringMatching(/^[^\n]+。$/u) })
    }
  })
})

describe('plugin uninstall', () => {
  it('refuses while the library given still has it, then removes it, and a library that has it reports it unavailable; refuses a built-in plugin and one this machine does not have', () => {
    install(source(pager('第一版', '0.1.0')))
    sb.run(['plugin', 'enable', 'pager', '--library', lib])
    const held = sb.run(['plugin', 'uninstall', 'pager', '--library', lib, '--json'])
    expect(held.json()).toMatchObject({ outcome: 'refused', reason: 'still-enabled' })
    const r = sb.run(['plugin', 'uninstall', 'pager', '--json'])
    expect(r.json()).toMatchObject({ outcome: 'done' })
    expect(r.json().text).toContain('别的库装着它的，会报它不可用')
    expect(existsSync(join(home, 'plugins', 'pager'))).toBe(false)
    const find = sb.run(['--library', lib, 'find', '--json'])
    expect(find.json().problems).toContainEqual(expect.objectContaining({ plugin: 'pager' }))
    expect(sb.run(['plugin', 'uninstall', 'ledger', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'built-in' })
    expect(sb.run(['plugin', 'uninstall', 'nobody', '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-on-machine' })
  })
})

// ---- the UI's server ----

const running: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGINT')
})

/** Starts `pneuma-base view` and answers its address and token once it printed them. */
function serve(): Promise<{ origin: string; token: string }> {
  const child = sb.start(['view', lib, '--no-open', '--port', '0'])
  running.push(child)
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([0-9a-f]+)/.exec(out)
      if (match) resolve({ origin: match[1] as string, token: match[2] as string })
    })
    child.once('exit', (code) => reject(new Error(`view exited with ${code}: ${out}`)))
  })
}

async function api(server: { origin: string; token: string }, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${server.origin}${path}${path.includes('?') ? '&' : '?'}token=${server.token}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return res.json()
}

const textOf = (view: any) => view.blocks.find((b: any) => b.kind === 'text')?.text

describe('a running UI server', () => {
  it('uses a plugin’s changed files on its next request, without a restart', async () => {
    install(source(pager('第一版', '0.1.0')))
    sb.run(['plugin', 'enable', 'pager', '--library', lib])
    const server = await serve()
    expect(textOf(await api(server, '/api/view?view=pager.page'))).toBe('第一版')
    install(source(pager('第二版', '0.2.0')))
    expect(textOf(await api(server, '/api/view?view=pager.page'))).toBe('第二版')
    writePlugin(join(home, 'plugins', 'pager'), { 'lib/words.js': "export const WORDS = '第三版'\nexport const VERSION = '0.3.0'\n" })
    expect(textOf(await api(server, '/api/view?view=pager.page'))).toBe('第三版')
    const page = await fetch(`${server.origin}/plugin-ui/pager/page.html`)
    expect(await page.text()).toContain('第二版')
  })

  it('shows a plugin’s secrets on the configuration page and sets one from its form into the store the command line reads', async () => {
    writePlugin(join(home, 'plugins', 'vault'), VAULT)
    sb.run(['plugin', 'enable', 'vault', '--library', lib])
    const server = await serve()
    const section = () => api(server, '/api/view?view=settings').then((v) => v.blocks.find((b: any) => b.title === '密钥'))
    const before = await section()
    const row = before.blocks[0].items[0]
    expect(row).toMatchObject({ cell: { text: 'token', tag: { text: '没设' } }, note: 'vault', about: '外面服务的令牌' })
    const [setter] = row.actions
    expect(setter.inputs).toEqual([{ name: 'value', label: '值', placeholder: null, value: null, options: null, secret: true }])
    expect(setter.call).toEqual({ face: 'owner', command: 'secret set', args: { positional: ['vault', 'token'], flags: {} }, stdin: '{value}' })
    const reply = await api(server, '/api/call', { call: { ...setter.call, stdin: 'tok-from-the-page' }, confirmed: false })
    expect(reply.result).toMatchObject({ outcome: 'done' })
    expect(JSON.stringify(reply)).not.toContain('tok-from-the-page')
    expect(statSync(join(home, 'secrets', 'vault', 'token')).mode & 0o777).toBe(0o600)
    expect(sb.run(['--library', lib, 'vault', 'show', '--json']).json().data.token).toBe('tok-from-the-page')
    // Set is the usual state and goes unsaid; replacing it and removing it are in the row's 「···」.
    const after = (await section()).blocks[0].items[0]
    expect(after.cell.tag).toBeUndefined()
    expect(after.actions.map((a: { label: string }) => a.label)).toEqual(['换一个', '删掉'])
  })
})
