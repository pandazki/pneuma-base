// A change deep inside a directory registered as one thing, its first level untouched: the acts whose
// correctness needs it (a sync, a version taken, a deployment) look at every file's state and see it;
// check does not go deep, and with a listener learns of it from the change log.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

const CORE = process.env.PNEUMA_BASE_CORE ?? fileURLToPath(new URL('../../../core/target/release/pneuma-base-core', import.meta.url))

let sb: Sandbox
const listeners: ChildProcessWithoutNullStreams[] = []

afterEach(() => {
  for (const child of listeners.splice(0)) child.kill('SIGKILL')
})

const run = (lib: string, args: string[], env: Record<string, string> = {}) => {
  const r = sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], { env })
  expect(r.code, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
  return r.stdout
}
const owner = (lib: string, args: string[], env: Record<string, string> = {}) => {
  const r = sb.run(['--library', lib, ...args], { env })
  expect(r.code, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
  return r.stdout
}

const DEEP = 'web/site/a/b/deep.txt'

/** A library with sync, versions and deployment, each with a target, and a site registered as one thing, versioned, online and synced. */
function library(): { lib: string; synced: string; deployed: string } {
  const lib = join(tempDir(), 'lib')
  const synced = tempDir()
  const deployed = tempDir()
  expect(sb.run(['init', lib]).code).toBe(0)
  for (const plugin of ['sync', 'version', 'deploy']) owner(lib, ['plugin', 'enable', plugin])
  owner(lib, ['sync', 'target', 'set', '--kind', 'dir', '--to', synced])
  owner(lib, ['deploy', 'target', 'set', '--kind', 'folder', '--to', deployed])
  const site = join(tempDir(), 'site')
  mkdirSync(join(site, 'a/b'), { recursive: true })
  writeFileSync(join(site, 'index.html'), '<h1>site</h1>\n')
  writeFileSync(join(site, 'a/b/deep.txt'), 'first\n')
  run(lib, ['put', site, '--to', 'web/site', '--generated'])
  run(lib, ['say', 'versioned', 'web/site'])
  run(lib, ['say', 'deployable', 'web/site'])
  owner(lib, ['deploy', 'publish', 'web/site'])
  owner(lib, ['sync', 'now'])
  return { lib, synced, deployed }
}

/** The places storage reports since `cursor` with no budget to replay: from a live listener's log, or null. */
function heard(lib: string, cursor: string): string[] | null {
  const a = JSON.parse(spawnSync(CORE, ['changed', '--root', lib, JSON.stringify({ cursor, budget: 0 })], { encoding: 'utf8' }).stdout) as { outcome: string; places?: string[] }
  return a.outcome === 'done' ? (a.places ?? []) : null
}
const cursorOf = (lib: string): string => JSON.parse(spawnSync(CORE, ['changed', '--root', lib, '{}'], { encoding: 'utf8' }).stdout).cursor

async function until<T>(f: () => T | undefined): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const found = f()
    if (found !== undefined) return found
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('not within ten seconds')
}

/** What check lists as changed outside the tool, as data. */
const changedOutside = (lib: string): string[] => {
  const sections = JSON.parse(run(lib, ['check', '--json'])).sections as { title: string; body: string }[]
  return sections.filter((s) => s.title === '外部修改').flatMap((s) => s.body.split('\n').map((l) => l.trim()))
}

/** How deep inspect says the last look at web/site went, as data. */
const lastLook = (lib: string) => JSON.parse(run(lib, ['inspect', 'web/site', '--json'])).sections.find((s: { plugin: string }) => s.plugin === 'ledger').data.looked

describe('a file three levels down in a directory thing, edited in place', () => {
  // One library for the file; each test starts from what the one before left and edits the file anew.
  let lib: string
  let synced: string
  let deployed: string
  beforeAll(() => {
    sb = sandbox()
    ;({ lib, synced, deployed } = library())
  })

  it('is carried by sync now, kept by a version taken, and published by deploy sync', () => {
    writeFileSync(join(lib, DEEP), 'second, longer\n')

    owner(lib, ['sync', 'now'])
    expect(readFileSync(join(synced, DEEP), 'utf8')).toBe('second, longer\n')
    expect(run(lib, ['say', 'version', 'web/site', '深处改了'])).toContain('web/site 已被外部修改，已先记录为版本 2')
    expect(owner(lib, ['deploy', 'sync'])).toContain('已发布 web/site')
    expect(readFileSync(join(deployed, 'web-site/a/b/deep.txt'), 'utf8')).toBe('second, longer\n')
  })

  it('is not read again by deploy sync while every file in it is as it was', () => {
    owner(lib, ['deploy', 'sync'])
    const log = join(tempDir(), 'tools.jsonl')
    writeFileSync(log, '')
    owner(lib, ['deploy', 'sync'], { PNEUMA_BASE_TOOL_LOG: log })
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { plugin: string; area: string; tool: string; place?: string; deep?: true })
    const deploy = calls.filter((c) => c.plugin === 'deploy')
    expect(deploy.filter((c) => c.area === 'content' && (c.tool === 'content' || c.tool === 'read'))).toEqual([])
    expect(deploy.filter((c) => c.tool === 'look' && c.deep)).toHaveLength(1)
  })

  it('is not seen by check without a listener, and inspect says the last look went to the first level', () => {
    run(lib, ['check'])
    writeFileSync(join(lib, DEEP), 'third, longer still\n')
    expect(changedOutside(lib)).not.toContain('web/site')
    expect(lastLook(lib)).toMatchObject({ how: 'level' })
  })

  it.runIf(process.platform === 'darwin')('is seen by check with a listener, from the change log', async () => {
    const child = spawn(CORE, ['serve', '--root', lib], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.write(`${JSON.stringify({ id: 'sub', op: 'subscribe' })}\n`)
    listeners.push(child)
    await until(() => (heard(lib, cursorOf(lib)) === null ? undefined : true))
    run(lib, ['check'])
    const from = cursorOf(lib)
    writeFileSync(join(lib, DEEP), 'fourth, the longest yet\n')
    await until(() => (heard(lib, from)?.includes(DEEP) ? true : undefined))
    expect(changedOutside(lib)).toContain('web/site')
    expect(lastLook(lib)).toMatchObject({ how: 'log' })
  })
})
