// Whoever stays listens, whoever runs once compares (ARCHITECTURE.md「变化由谁来学」): `check` says the same about
// the same outside changes whether a long-lived process listens to the library or nobody does. With a
// listener, `check` learns what changed from the log it keeps; without one, storage cannot say within
// the command's budget and `check` compares the state of what it looks after.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

const CORE = process.env.PNEUMA_BASE_CORE ?? fileURLToPath(new URL('../../../core/target/release/pneuma-base-core', import.meta.url))

type Answer = { outcome: string; reason?: string; places?: string[]; cursor: string; more?: boolean }

/** One storage operation in a process of its own, as a command makes it. */
const storage = (lib: string, op: string, request: object): Answer => JSON.parse(spawnSync(CORE, [op, '--root', lib, JSON.stringify(request)], { encoding: 'utf8' }).stdout)

/** A long-lived process listening to the library, as the management UI's server does. */
function listen(lib: string): ChildProcessWithoutNullStreams {
  const child = spawn(CORE, ['serve', '--root', lib], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.write(`${JSON.stringify({ id: 'sub', op: 'subscribe' })}\n`)
  return child
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Asks `f` every 20 ms until it gives something, for up to ten seconds. */
async function until<T>(f: () => T | undefined): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const found = f()
    if (found !== undefined) return found
    await wait(20)
  }
  throw new Error('not within ten seconds')
}

/** The places storage reports since `cursor` with no budget to replay: from a live listener's log, or null. */
function heard(lib: string, cursor: string): string[] | null {
  const places: string[] = []
  for (let at = cursor; ; ) {
    const a = storage(lib, 'changed', { cursor: at, budget: 0 })
    if (a.outcome !== 'done') return null
    places.push(...(a.places ?? []))
    if (!a.more) return places
    at = a.cursor
  }
}

let sb: Sandbox
const listeners: ChildProcessWithoutNullStreams[] = []

afterEach(() => {
  for (const child of listeners.splice(0)) child.kill('SIGKILL')
})

const run = (lib: string, args: string[], input?: string) => {
  const r = sb.run(['--library', lib, '--as', 'claude-code', '--session', 's1', ...args], input === undefined ? {} : { input })
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r
}

/** What `check` says, as data: its sections' titles and rows, without the ids each library gives its things. */
const check = (lib: string) =>
  (run(lib, ['check', '--json']).json().sections as { title: string; data: unknown }[]).map(({ title, data }) => ({
    title,
    data: JSON.parse(JSON.stringify(data, (key, value: unknown) => (key === 'item' ? undefined : value))) as unknown,
  }))

/** A library as both runs start: registered things, an open directory, a closed one and noise. */
function library(): string {
  const lib = join(tempDir(), 'lib')
  expect(sb.run(['init', lib]).code).toBe(0)
  for (const name of ['kept', 'edited', 'moved']) run(lib, ['put', '-', '--to', `${name}.md`, '--imported'], `${name} 1234`)
  run(lib, ['put', '-', '--to', 'elsewhere/anchor.md', '--imported'], 'anchor')
  mkdirSync(join(lib, 'closed/inner'), { recursive: true })
  writeFileSync(join(lib, 'closed/inner/x.txt'), 'x')
  mkdirSync(join(lib, 'node_modules/pkg'), { recursive: true })
  return lib
}

/** The same outside changes, made by hand. */
function changeByHand(lib: string): void {
  writeFileSync(join(lib, 'dropped.md'), 'nobody registered me')
  writeFileSync(join(lib, 'edited.md'), 'edited 9876')
  renameSync(join(lib, 'moved.md'), join(lib, 'elsewhere/moved.md'))
  mkdirSync(join(lib, 'newdir'))
  writeFileSync(join(lib, 'newdir/inside.md'), 'in a new directory')
  writeFileSync(join(lib, 'closed/inner/y.txt'), 'below a closed directory')
  writeFileSync(join(lib, 'node_modules/pkg/index.js'), 'noise')
}

describe('who learns of change', () => {
  // A listener needs a change journal, which only the macOS provider has; elsewhere only comparing answers.
  it.runIf(process.platform === 'darwin')('check says the same with a live listener as without one', async () => {
    sb = sandbox()
    const listened = library()
    const alone = library()
    listeners.push(listen(listened))
    // Live: storage answers from its log, not by replaying, while nobody listens to the other.
    await until(() => (heard(listened, storage(listened, 'changed', {}).cursor) === null ? undefined : true))
    expect(heard(alone, storage(alone, 'changed', {}).cursor)).toBeNull()

    expect(check(listened)).toEqual(check(alone))
    const from = storage(listened, 'changed', {}).cursor
    changeByHand(listened)
    changeByHand(alone)
    // The listener has heard all of it before the command runs.
    const wanted = ['dropped.md', 'edited.md', 'moved.md', 'elsewhere/moved.md', 'newdir/inside.md', 'closed/inner/y.txt']
    const places = await until(() => {
      const p = heard(listened, from)
      return p !== null && wanted.every((w) => p.includes(w)) ? p : undefined
    })
    expect(places.some((p) => p.startsWith('node_modules'))).toBe(false)

    const withListener = check(listened)
    expect(withListener).toEqual(check(alone))
    const titles = withListener.map((s) => s.title)
    expect(titles).toEqual(['未登记', '未登记的目录', '外部修改', '已移动'])
    expect(JSON.stringify(withListener)).not.toContain('node_modules')
    expect(JSON.stringify(withListener)).not.toContain('y.txt')
    // And the next check, with nothing changed since, agrees too.
    expect(check(listened)).toEqual(check(alone))
    expect(existsSync(join(listened, '.pneuma-base/cache/changes/log.sqlite'))).toBe(true)
    expect(existsSync(join(alone, '.pneuma-base/cache/changes'))).toBe(false)
  })
})
