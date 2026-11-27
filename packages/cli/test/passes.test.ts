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
  for (const plugin of ['version', 'search']) ok(['--library', lib, 'plugin', 'add', plugin])
  ok(['--library', lib, '--as', 'claude-code', 'put', '-', '--to', 'notes/opener.md', '--made'], 'the opener\n')
  for (let i = 0; i < 299; i++) writeFileSync(join(lib, 'notes', `n${i}.md`), `note ${i} word${i}\n`)
  for (let i = 0; i < 2; i++) ok(['--library', lib, '--as', 'claude-code', 'put', 'notes', '--made'])
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
    expect(whole.stderr).toContain('要按内容读整个库有版本的东西：1 样。')
    expect(whole.stderr).toContain('有版本的东西已按内容查 1 / 1 样')
    // The ledger's pass reports first; asked to stop there, the version plugin reads nothing and says so.
    const stopped = await stoppedAtFirstReport(['--library', lib, '--as', 'claude-code', 'check', '--deep', '.'])
    expect(stopped.stdout).toContain('停下了：有版本的东西按内容查了 0 / 1 样。')
  })

  it('search rebuild reads every registered thing, saying how many first, and stops when asked, leaving the rest to find', async () => {
    const whole = ok(['--library', lib, 'search', 'rebuild'])
    expect(whole.stderr).toContain('要重建查找的索引：读 300 样登记过的东西。')
    expect(whole.stderr).toContain('已读 300 / 300 样')
    const stopped = await stoppedAtFirstReport(['--library', lib, 'search', 'rebuild'])
    expect(stopped.stdout).toContain('停下了：读了 100 / 300 样，其余的下次 find 时接着读。')
    expect(ok(['--library', lib, 'search', 'status']).stdout).toContain('待读：200 样东西')
  })
})
