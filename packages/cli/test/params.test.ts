// C4 on the command line: a plugin's owner command declares its arguments, and the command line reads
// the words by that declaration: a switch never takes the word after it, a list takes the words up to
// the next flag. A call that does not fit exits 1 with the usage line, which help shows too. What the
// kernel checks in a call is packages/kernel/test/params.test.ts's.
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ARGV, writePlugin } from './fixtures/machine-plugins.js'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string

beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  writePlugin(join(sb.home, '.pneuma-base', 'plugins', 'argv'), ARGV)
  expect(sb.run(['init', lib, '--bare']).code).toBe(0)
  expect(sb.run(['plugin', 'enable', 'argv', '--library', lib]).code).toBe(0)
})

const argv = (args: string[]) => sb.run(['--library', lib, 'argv', 'show', ...args, '--json'])
const given = (args: string[]) => {
  const r = argv(args)
  expect(r.code, r.stderr).toBe(0)
  return r.json().data
}

const USAGE = '用法：argv show <路径> [<更多>…] [--force] [--tags <标签>…] [--mode a|b]'

describe('a plugin command with params on the command line', () => {
  it('reads a switch before the path as a switch, not as the path; a list up to the next flag; the rest as positionals', () => {
    expect(given(['--force', 'site/a'])).toEqual({ positional: ['site/a'], flags: { force: true }, values: { path: 'site/a', more: [], force: true, tags: [], mode: null } })
    expect(given(['site/a', '--tags', 'x', 'y', '--force', 'b', 'c']).values).toEqual({ path: 'site/a', more: ['b', 'c'], force: true, tags: ['x', 'y'], mode: null })
    expect(given(['--mode', 'b', 'site/a', '--tags=z']).values).toEqual({ path: 'site/a', more: [], force: false, tags: ['z'], mode: 'b' })
  })

  it('answers a call that does not fit with exit 1, what is wrong and the usage line, for its own commands as for the kernel’s; help lists that line', () => {
    const plugin = argv(['site', '--colour', 'red'])
    expect(plugin.code, plugin.stdout).toBe(1)
    expect(plugin.stderr).toContain(`argv show 不认识 --colour。\n${USAGE}`)
    const kernel = sb.run(['--library', lib, 'grant', 'create', 'reader'])
    expect(kernel.code).toBe(1)
    expect(kernel.stderr).toContain('要写 --agent <给谁>。\n用法：grant create <授权名> --agent <给谁> [--area <子文件夹>] [--read-only]')
    expect(sb.run(['--help', '--library', lib]).stdout).toContain(`  argv show ${USAGE.slice('用法：argv show '.length)}\n      交回收到的参数（argv）`)
  })
})
