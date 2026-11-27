// A plugin added to a library already in use learns what was registered before it from the register,
// a page at a time, as a named act that says how far it got, stops when asked and goes on later.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox

const run = (lib: string, args: string[], input?: string) => {
  const r = sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], input === undefined ? {} : { input })
  expect(r.code, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}
const owner = (lib: string, args: string[]) => {
  const r = sb.run(['--library', lib, ...args])
  expect(r.code, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}

/** A library with only the ledger, holding `files` registered notes, each with its own word, and a directory thing. */
function library(files: number): string {
  const lib = join(tempDir(), 'lib')
  expect(sb.run(['init', lib]).code).toBe(0)
  run(lib, ['put', '-', '--to', 'notes/opener.md', '--made'], 'the opener\n')
  for (let i = 0; i < files - 1; i++) writeFileSync(join(lib, 'notes', `n${i}.md`), `note ${i} word${i}\n`)
  // A put of an open directory registers its loose files, a page at a time.
  for (let i = 0; i < Math.ceil(files / 200); i++) run(lib, ['put', 'notes', '--made'])
  const site = join(tempDir(), 'site')
  mkdirSync(join(site, 'a/b'), { recursive: true })
  writeFileSync(join(site, 'index.html'), '<h1>site</h1>\n')
  writeFileSync(join(site, 'a/b/deep.txt'), 'deepword inside the site\n')
  run(lib, ['put', site, '--to', 'web/site', '--made'])
  return lib
}

beforeAll(() => {
  sb = sandbox()
})

describe('a plugin added to a library already in use', () => {
  it('search finds what was put before it, once plugin add has caught up', () => {
    const lib = library(600)
    const added = owner(lib, ['plugin', 'add', 'search'])
    expect(added.stdout).toContain('search 补上了装上之前登记的 601 样。')
    expect(added.stderr).toContain('search 补上装上之前登记的东西：0 / 601 样')
    expect(run(lib, ['find', 'word377']).stdout).toContain('notes/n377.md')
    expect(run(lib, ['find', 'deepword']).stdout).toContain('web/site')
    // Catching up again changes nothing it knows.
    expect(owner(lib, ['plugin', 'catch-up', 'search']).stdout).toContain('search 补上了装上之前登记的 601 样。')
    expect(run(lib, ['find', 'word377']).stdout.match(/notes\/n377\.md/g)).toHaveLength(1)
  })

  it('sync carries what was put before it', () => {
    const lib = library(300)
    owner(lib, ['plugin', 'add', 'sync'])
    owner(lib, ['sync', 'target', 'set', '--kind', 'dir', '--to', tempDir()])
    const now = owner(lib, ['sync', 'now', '--json']).stdout
    expect(JSON.parse(now).data.counts.pushed).toBeGreaterThanOrEqual(301)
  })

  it('stops when asked, says how far it got in its answers, and goes on with plugin catch-up', async () => {
    const lib = library(2000)
    const child = sb.start(['--library', lib, 'plugin', 'add', 'search'])
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    await new Promise<void>((done) => {
      child.stderr.on('data', (b: Buffer) => {
        const first = stderr === ''
        stderr += b.toString()
        if (first && stderr.includes('补上装上之前登记的东西')) child.kill('SIGINT')
      })
      child.on('close', () => done())
    })
    expect(stdout).toMatch(/search 补了装上之前登记的 \d+ \/ 2001 样；接着补：pneuma-base plugin catch-up search/)
    const found = run(lib, ['find', 'word1998']).stdout
    expect(found).toMatch(/装上之前登记的 2001 样补了 \d+ 样；接着补：pneuma-base plugin catch-up search/)

    const resumed = owner(lib, ['plugin', 'catch-up', 'search'])
    expect(resumed.stdout).toContain('search 补上了装上之前登记的 2001 样。')
    const after = run(lib, ['find', 'word1998']).stdout
    expect(after).toContain('notes/n1998.md')
    expect(after).not.toContain('接着补')
  })

  it('refuses plugin catch-up for a plugin that does not learn from the register', () => {
    const lib = library(1)
    owner(lib, ['plugin', 'add', 'version'])
    const r = sb.run(['--library', lib, 'plugin', 'catch-up', 'version'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('插件 version 不从放里学库里登记了什么，没有要补的。')
  })
})
