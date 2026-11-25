// Help lists the owner commands the owner face has for the library at hand: the kernel's without a
// library, and with one, those of the plugins it has installed, each with how it is gated.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sandbox, tempDir } from './helpers.js'

describe('--help', () => {
  const sb = sandbox()
  const lib = join(tempDir(), 'lib')
  expect(sb.run(['init', lib]).code).toBe(0)

  it('without a library lists the kernel’s owner commands and says how to see a library’s', () => {
    const r = sb.run(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('  grant issue <授权名> --agent <给谁> [--area <子文件夹>] [--read-only]')
    expect(r.stdout).toMatch(/ {2}archive purge\n {6}清空归档区；会丢数据，只有主人能做，要当面确认/)
    expect(r.stdout).toContain('pneuma-base --help --library <库的目录>')
    expect(r.stdout).not.toContain('held')
  })

  it('with a library lists its plugins’ commands, and follows plugin add', () => {
    expect(sb.run(['--help', '--library', lib]).stdout).toMatch(/ {2}held restore <库内路径\|条目号> \[--fingerprint <指纹>\] --to <库内路径>\n {6}把一份留存取回到一个新路径；只有主人能做（ledger）/)
    expect(sb.run(['--help', '--library', lib]).stdout).not.toContain('deploy on')
    expect(sb.run(['plugin', 'add', 'deploy', '--library', lib]).code).toBe(0)
    const r = sb.run(['--library', lib, '--help'])
    expect(r.stdout).toMatch(/ {2}deploy on <库内路径>\n {6}[^\n]*；只有主人能做（deploy）/)
    expect(r.stdout).toMatch(/ {2}deploy sync\n {6}[^\n]*跑几遍结果都一样（deploy）/)
  })
})
