// A scene points back to its conversation: inspect <scene> and the scene page say where the
// transcript is, whether it is on this machine now, and how to resume it. The product's folder is
// faked under the sandbox's HOME with an empty file; no transcript is read.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

const id = '11111111-2222-4333-8444-555555555555'
let sb: Sandbox
let lib: string
let project: string
let file: string
let path: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  project = join(sb.home, 'shop')
  mkdirSync(project)
  const folder = project.replace(/[^a-zA-Z0-9]/g, '-')
  file = join(sb.home, '.claude/projects', folder, `${id}.jsonl`)
  path = `~/.claude/projects/${folder}/${id}.jsonl`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}

describe('a scene’s conversation', () => {
  it('is recorded as a pointer and shown with whether it is here and how to resume it', () => {
    ok(sb.run(['--library', lib, 'put', '-', '--to', 'a.md', '--generated'], { cwd: project, env: { CLAUDE_CODE_SESSION_ID: id }, input: 'a' }))
    const resume = `cd ~/shop && claude --resume ${id}`

    const text = ok(sb.run(['--library', lib, 'inspect', id])).stdout
    expect(text).toContain(`对话：${path}（在本机）\n继续对话：${resume}`)
    const data = ok(sb.run(['--library', lib, 'inspect', id, '--json'])).json().sections[0].data
    expect(data.conversation).toEqual({ path, resume, machine: expect.any(String), status: 'here' })

    const fields = (ok(sb.run(['--library', lib, 'show', 'ledger.scene', '--scene', id, '--json'])).json().blocks as any[]).filter((b) => b.kind === 'fields').flatMap((b) => b.fields) as any[]
    expect(fields).toEqual(expect.arrayContaining([
      // The page, not the verb, says how the Mac app opens it again: Claude Code's resume in the directory it ran in.
      { label: '对话', value: { text: path, mono: true, copy: true, tag: { text: '在本机', tone: 'neutral' }, reopen: { url: null, run: { command: `claude --resume ${id}`, cwd: project }, reveal: file } } },
      { label: '继续对话', value: { text: resume, mono: true, copy: true } },
    ]))

    rmSync(file)
    expect(ok(sb.run(['--library', lib, 'inspect', id])).stdout).toContain(`对话：${path}（已缺失）\n`)
    expect(ok(sb.run(['--library', lib, 'inspect', id])).stdout).not.toContain('继续对话')
  })

  it('is not there for a session no product gave', () => {
    ok(sb.run(['--library', lib, 'put', '-', '--to', 'a.md', '--generated', '--session', id], { cwd: project, input: 'a' }))
    expect(ok(sb.run(['--library', lib, 'inspect', id])).stdout).not.toContain('对话')
    expect(ok(sb.run(['--library', lib, 'inspect', id, '--json'])).json().sections[0].data.conversation).toBeNull()
  })
})
