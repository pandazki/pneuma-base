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
    expect(r.stdout).toContain('  grant create <授权名称> --agent <授权对象> [--area <子文件夹>] [--read-only]')
    expect(r.stdout).toMatch(/ {2}archive purge\n {6}清空归档；将丢失数据，仅所有者可执行，需当面确认/)
    expect(r.stdout).toContain('pneuma-base --help --library <资料库目录>')
    expect(r.stdout).not.toContain('held')
  })

  it('with a library lists its plugins’ commands, and follows plugin enable', () => {
    expect(sb.run(['--help', '--library', lib]).stdout).toMatch(/ {2}ledger copies restore <库内路径或条目编号> \[--fingerprint <内容哈希>\] --to <新路径>\n {6}将一个历史副本恢复到新路径；仅所有者可执行（ledger）/)
    expect(sb.run(['--help', '--library', lib]).stdout).not.toContain('deploy publish')
    expect(sb.run(['plugin', 'enable', 'deploy', '--library', lib]).code).toBe(0)
    const r = sb.run(['--library', lib, '--help'])
    expect(r.stdout).toMatch(/ {2}deploy publish <库内路径>\n {6}[^\n]*；仅所有者可执行（deploy）/)
    expect(r.stdout).toMatch(/ {2}deploy sync\n {6}[^\n]*重复执行结果相同（deploy）/)
  })
})
