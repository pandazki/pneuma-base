// C4 on the command line: a plugin's owner command declares its arguments, and the command line
// reads them by that declaration. A switch never takes the argument after it, a list takes exactly
// its values, a call that does not fit is a usage error with the usage line, and help shows that line.
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ARGV, writePlugin } from './fixtures/machine-plugins.js'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  writePlugin(join(sb.home, '.pneuma-base', 'plugins', 'argv'), ARGV)
  expect(sb.run(['init', lib, '--bare']).code).toBe(0)
  expect(sb.run(['plugin', 'add', 'argv', '--library', lib]).code).toBe(0)
})

const argv = (args: string[]) => sb.run(['--library', lib, 'argv', 'show', ...args, '--json'])
const given = (args: string[]) => {
  const r = argv(args)
  expect(r.code, r.stderr).toBe(0)
  return r.json().data
}
const values = (args: string[]) => given(args).values

const USAGE = '用法：argv show <路径> [<更多>…] [--force] [--tags <标签>…] [--mode a|b]'

describe('a plugin command with params on the command line', () => {
  it('reads a switch before the path as a switch, not as the path', () => {
    expect(given(['--force', 'site/a'])).toEqual({ positional: ['site/a'], flags: { force: true }, values: { path: 'site/a', more: [], force: true, tags: [], mode: null } })
  })

  it('reads a list up to the next flag, and the rest as positionals', () => {
    expect(values(['site/a', '--tags', 'x', 'y', '--force', 'b', 'c'])).toEqual({ path: 'site/a', more: ['b', 'c'], force: true, tags: ['x', 'y'], mode: null })
    expect(values(['--mode', 'b', 'site/a', '--tags=z'])).toEqual({ path: 'site/a', more: [], force: false, tags: ['z'], mode: 'b' })
  })

  it('answers a call that does not fit with a usage error naming what is wrong, and the usage line', () => {
    const cases: [string[], string][] = [
      [[], 'argv show 少了 <路径>。'],
      [['Site'], '<路径> 写的「Site」不对'],
      [['site', '--mode', 'c'], '--mode 只能是 a、b：c'],
      [['site', '--colour', 'red'], 'argv show 不认识 --colour。'],
      [['site', '--force=yes'], '--force 不带值'],
    ]
    for (const [args, text] of cases) {
      const r = argv(args)
      expect(r.code, r.stdout).toBe(1)
      expect(r.stderr).toContain(text)
      if (!text.startsWith('--force')) expect(r.stderr).toContain(USAGE)
    }
  })

  it('is listed in help with the usage line made from its params', () => {
    const r = sb.run(['--help', '--library', lib])
    expect(r.stdout).toContain(`  argv show ${USAGE.slice('用法：argv show '.length)}\n      交回收到的参数（argv）`)
  })
})

describe('the kernel’s own commands, with params too', () => {
  it('refuse a missing argument with the usage line', () => {
    const r = sb.run(['--library', lib, 'grant', 'issue', 'reader'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('要写 --agent <给谁>。\n用法：grant issue <授权名> --agent <给谁> [--area <子文件夹>] [--read-only]')
  })
})
