// C9 on the command line: the owner sets a plugin's credential from standard input, never from the
// arguments; it is kept on this machine outside every library, listed by name only, read by the
// plugin, refused to agents, and never carried by the sync plugin.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { VAULT, writePlugin } from './fixtures/machine-plugins.js'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

const TOKEN = 'tok-9f2a-never-synced'

let sb: Sandbox
let home: string
let lib: string

beforeEach(() => {
  sb = sandbox()
  home = join(sb.home, '.pneuma-base')
  lib = join(tempDir(), 'lib')
  writePlugin(join(home, 'plugins', 'vault'), VAULT)
  expect(sb.run(['init', lib]).code).toBe(0)
  expect(sb.run(['plugin', 'add', 'vault', '--library', lib]).code).toBe(0)
})

/** Every file under `dir`, with its content. */
const contents = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))

const set = (input: string, env: Record<string, string> = {}) => sb.run(['secret', 'set', 'vault', 'token', '--json'], { input, env })
const show = () => sb.run(['--library', lib, 'vault', 'show', '--json']).json().data.token as string | null

describe('secret set', () => {
  it('takes the value from standard input, without a library, keeps it readable only by the user, and the plugin reads it', () => {
    expect(show()).toBeNull()
    const r = set(`${TOKEN}\n`)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).not.toContain(TOKEN)
    const file = join(home, 'secrets', 'vault', 'token')
    expect(readFileSync(file, 'utf8')).toBe(TOKEN)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(show()).toBe(TOKEN)
  })

  it('never takes the value from the arguments', () => {
    const r = sb.run(['secret', 'set', 'vault', 'token', TOKEN])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('多了参数')
    expect(existsSync(join(home, 'secrets'))).toBe(false)
  })

  it('is refused in an agent session, and nothing is read or written', () => {
    const r = set(TOKEN, { CLAUDE_CODE_SESSION_ID: 's-1' })
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    expect(existsSync(join(home, 'secrets'))).toBe(false)
  })

  it('stays out of the library and out of what the sync plugin carries', () => {
    const target = join(tempDir('pb-sync-'), 'remote')
    expect(sb.run(['plugin', 'add', 'sync', '--library', lib]).code).toBe(0)
    expect(sb.run(['sync', 'target', 'set', '--kind', 'dir', '--to', target, '--library', lib]).code).toBe(0)
    expect(sb.run(['secret', 'set', 'vault', 'token', '--library', lib], { input: TOKEN }).code).toBe(0)
    const synced = sb.run(['sync', 'now', '--library', lib, '--json'])
    expect(synced.code, synced.stdout + synced.stderr).toBe(0)
    expect(contents(target).length).toBeGreaterThan(0)
    expect(contents(target).some((text) => text.includes(TOKEN))).toBe(false)
    expect(contents(lib).some((text) => text.includes(TOKEN))).toBe(false)
    expect(show()).toBe(TOKEN)
  })
})

describe('secret list and secret remove', () => {
  it('list prints names only; remove takes it away', () => {
    set(TOKEN)
    const listed = sb.run(['secret', 'list', 'vault'])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('token')
    expect(listed.stdout).not.toContain(TOKEN)
    expect(sb.run(['secret', 'remove', 'vault', 'token']).code).toBe(0)
    expect(show()).toBeNull()
    expect(sb.run(['secret', 'list', 'vault']).stdout).toContain('还没设的：token')
  })
})
