// The named whole passes of the version and search plugins say how much they will do, report as they
// go and stop when asked, keeping what they did, like the ledger's.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string

const ok = (args: string[], input?: string) => {
  const r = sb.run(args, input === undefined ? {} : { input })
  expect(r.code, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}

/** A library with the version and search plugins, 300 registered notes, and the first of them declared versioned: built once for the file. */
function library(): string {
  const lib = join(tempDir(), 'lib')
  ok(['init', lib])
  for (const plugin of ['version', 'search']) ok(['--library', lib, 'plugin', 'enable', plugin])
  ok(['--library', lib, '--as', 'claude-code', 'put', '-', '--to', 'notes/opener.md', '--generated'], 'the opener\n')
  for (let i = 0; i < 299; i++) writeFileSync(join(lib, 'notes', `n${i}.md`), `note ${i} word${i}\n`)
  for (let i = 0; i < 2; i++) ok(['--library', lib, '--as', 'claude-code', 'put', 'notes', '--generated'])
  ok(['--library', lib, '--as', 'claude-code', 'say', 'versioned', 'notes/opener.md'])
  return lib
}

/** Runs the command, asks it to stop as a person does once its first report is on standard error, and answers what it printed. */
async function stoppedAtFirstReport(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const child = sb.start(args)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
  await new Promise<void>((done) => {
    child.stderr.on('data', (b: Buffer) => {
      const first = !stderr.includes('Ctrl-C')
      stderr += b.toString()
      if (first && stderr.includes('Ctrl-C')) child.kill('SIGINT')
    })
    child.on('close', () => done())
  })
  return { stdout, stderr }
}

beforeAll(() => {
  sb = sandbox()
  lib = library()
})

describe('a named whole pass of a plugin', () => {
  it('check --deep reads the versioned things by content, saying how many first, and stops when asked', async () => {
    const whole = ok(['--library', lib, '--as', 'claude-code', 'check', '--deep', '.'])
    expect(whole.stderr).toContain('将读取整个资料库中受版本管理的条目：1 个。')
    expect(whole.stderr).toContain('受版本管理的条目已检查 1 / 1 个')
    // The ledger's pass reports first; asked to stop there, the version plugin reads nothing and says so.
    const stopped = await stoppedAtFirstReport(['--library', lib, '--as', 'claude-code', 'check', '--deep', '.'])
    expect(stopped.stdout).toContain('已停止：受版本管理的条目已检查 0 / 1 个。')
  })

  it('search rebuild reads every registered thing, saying how many first, and stops when asked, leaving the rest to find', async () => {
    const whole = ok(['--library', lib, 'search', 'rebuild'])
    expect(whole.stderr).toContain('将重建搜索索引：读取 300 个已登记条目。')
    expect(whole.stderr).toContain('已读取 300 / 300 个')
    const stopped = await stoppedAtFirstReport(['--library', lib, 'search', 'rebuild'])
    expect(stopped.stdout).toContain('已停止：已读取 100 / 300 个，其余的在下次 find 时继续读取。')
    expect(ok(['--library', lib, 'search', 'status']).stdout).toContain('待索引：200 个条目')
  })
})
