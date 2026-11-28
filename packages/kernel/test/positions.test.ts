// ARCHITECTURE.md「每个动作在每种位置上做什么」: what each action does at each kind of place, the kernel's cells.
// A place is a registered file, a directory registered as one thing, an open directory (one with
// registered things in it), a directory nobody looked into (closed), or noise. "Registered" is a
// plugin's word: here a contract-2 watcher plugin says which directories are open. The cells of
// start, check and the deep check are the ledger's, tested there; find walks no place (find.test.ts).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { agentFace, type AcceptedPut, type InspectResult, type PlaceOverExisting, type Plugin, type PutResult } from '../src/index.js'
import { fixture, plugin, type Fixture } from './support.js'

const brought = { kind: 'brought', source: null, by: null } as const
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** A contract-2 plugin that records what it is told, says `notes` is open, and keeps a copy before any replacement. */
function watcher(seen: AcceptedPut[], revised: PlaceOverExisting[] = []): Plugin {
  return plugin('watcher', {
    contract: 2,
    onPut: async (req) => (seen.push(req), null),
    openDirs: async () => ['notes' as never],
    revise: async (req) => (revised.push(req), { outcome: 'held', note: null }),
  })
}

const locked: string[] = []
afterEach(() => {
  for (const p of locked.splice(0)) chmodSync(p, 0o644)
})
/** Makes a file unreadable: an act that reads it fails, one that only looks at it does not. */
function unreadable(f: Fixture, path: string) {
  const abs = join(f.root, path)
  chmodSync(abs, 0o000)
  locked.push(abs)
}

function outsideDir(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'pb-k-src-')), 'site')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const outcome = (r: PutResult) => (r.outcome === 'refused' ? `refused:${r.reason}` : 'accepted')

async function setUp() {
  const seen: AcceptedPut[] = []
  const revised: PlaceOverExisting[] = []
  const f = await fixture([watcher(seen, revised)])
  f.write('a.md', 'a')
  f.write('notes/one.md', '1')
  f.write('notes/two.md', '2')
  f.write('notes/deeper/three.md', '3')
  f.write('site/index.html', '<p>')
  f.write('site/.pneuma-item', '{"format":1}\n')
  f.write('closed/x.txt', 'x')
  f.write('node_modules/m.js', 'm')
  return { f, seen, revised }
}

// One test per action, walking the kinds of place it meets.
describe('put, copying in from outside the library', () => {
  it('replaces a registered file with what it expects there and a directory registered as one thing by the content rule, puts into an open directory and into one nobody looked into, and refuses an ignored place', async () => {
    const { f, seen, revised } = await setUp()
    const stdin = (text: string) => ({ kind: 'stdin', content: Buffer.from(text) }) as const
    expect(outcome(await agentFace.put({ kind: 'place', from: stdin('new'), to: 'a.md', origin: brought }, f.ctx))).toBe('accepted')
    expect(revised).toHaveLength(1)
    expect(revised[0]?.token).toBeTruthy()
    const put = seen.at(-1)
    expect(put?.kind === 'place' && put.fingerprint).toBe(sha('new'))
    expect(put?.kind === 'place' && put.previous?.token).toBe(revised[0]?.token)
    expect(f.read('a.md')).toBe('new')

    const from = outsideDir({ 'index.html': '<h1>', '.gitignore': 'build/\n', 'build/out.js': 'o' })
    expect(outcome(await agentFace.put({ kind: 'place', from: { kind: 'directory', path: from }, to: 'site', origin: brought }, f.ctx))).toBe('accepted')
    expect(f.read('site/index.html')).toBe('<h1>')
    expect(existsSync(join(f.root, 'site', '.pneuma-item'))).toBe(true)
    expect(seen.at(-1)?.kind).toBe('place')

    expect(outcome(await agentFace.put({ kind: 'place', from: stdin('n'), to: 'notes/new.md', origin: brought }, f.ctx))).toBe('accepted')
    expect(f.read('notes/new.md')).toBe('n')
    expect(outcome(await agentFace.put({ kind: 'place', from: stdin('y'), to: 'closed/y.txt', origin: brought }, f.ctx))).toBe('accepted')
    expect(f.read('closed/y.txt')).toBe('y')
    expect(outcome(await agentFace.put({ kind: 'place', from: stdin('z'), to: 'node_modules/z.js', origin: brought }, f.ctx))).toBe('refused:ignored')
  })
})

describe('put, registering what is already there', () => {
  it("corrects the origin of a registered file and registers a bundle again, reading none of either; registers an open directory's loose files of its one level as files; registers a directory nobody looked into as one thing, reading none of it; refuses an ignored place", async () => {
    const { f, seen } = await setUp()
    unreadable(f, 'a.md')
    expect(outcome(await agentFace.put({ kind: 'register', path: 'a.md', origin: { kind: 'brought', source: 'mail', by: null } }, f.ctx))).toBe('accepted')
    const file = seen.at(-1)
    expect(file).toMatchObject({ kind: 'register', path: 'a.md', fingerprint: null, origin: { source: 'mail' } })
    expect(file?.kind === 'register' && file.now.token).toBeTruthy()

    expect(outcome(await agentFace.put({ kind: 'register', path: 'site', origin: brought }, f.ctx))).toBe('accepted')
    expect(seen.at(-1)).toMatchObject({ kind: 'register', path: 'site', fingerprint: null, now: { kind: 'bundle' } })

    expect(outcome(await agentFace.put({ kind: 'register', path: 'notes', origin: brought }, f.ctx))).toBe('accepted')
    const loose = seen.at(-1)
    expect(loose?.kind).toBe('register-files')
    expect(loose?.kind === 'register-files' && loose.files.map((x) => x.path)).toEqual(['notes/one.md', 'notes/two.md'])
    expect(loose?.kind === 'register-files' && loose.files.every((x) => x.now.token !== '')).toBe(true)
    expect(existsSync(join(f.root, 'notes', '.pneuma-item'))).toBe(false)

    unreadable(f, 'closed/x.txt')
    expect(outcome(await agentFace.put({ kind: 'register', path: 'closed', origin: brought }, f.ctx))).toBe('accepted')
    expect(seen.at(-1)).toMatchObject({ kind: 'register', path: 'closed', fingerprint: null, now: { kind: 'bundle' } })
    expect(existsSync(join(f.root, 'closed', '.pneuma-item'))).toBe(true)

    expect(outcome(await agentFace.put({ kind: 'register', path: 'node_modules/m.js', origin: brought }, f.ctx))).toBe('refused:ignored')
  })
})

describe('inspect', () => {
  it('gives a registered file as storage says it is, its content unread; a bundle and an open directory with their first level; a directory nobody looked into probed within a budget, with the project markers at its top; an ignored place as ignored, and by which rule', async () => {
    const { f } = await setUp()
    const inspect = (target: string): Promise<InspectResult> => agentFace.inspect({ target }, f.ctx)
    unreadable(f, 'a.md')
    const file = await inspect('a.md')
    expect(file.file).toMatchObject({ path: 'a.md', kind: 'file', size: 1, fingerprint: null })
    expect(file.file?.token).toBeTruthy()

    const bundle = await inspect('site')
    expect(bundle.file?.kind).toBe('bundle')
    expect(bundle.file?.level?.entries.map((e) => e.name)).toEqual(['index.html'])

    const open = await inspect('notes')
    expect(open.file).toBeNull()
    expect(open.place?.kind).toBe('open')
    expect(open.place?.kind === 'open' && open.place.level.entries.map((e) => e.name)).toEqual(['deeper', 'one.md', 'two.md'])

    f.write('big/package.json', '{}')
    for (let i = 0; i < 600; i++) f.write(`big/src/f${i}.js`, '')
    const closed = await inspect('big')
    expect(closed.place?.kind).toBe('closed')
    expect(closed.place?.kind === 'closed' && closed.place.exceeded).toBe(true)
    expect(closed.place?.kind === 'closed' && closed.place.markers).toContain('package.json')

    expect((await inspect('node_modules')).place).toEqual({ kind: 'ignored', path: 'node_modules', by: { name: 'node_modules' } })
  })
})

describe('archive', () => {
  it('moves a registered file with what it expects at both ends, and a directory registered as one thing; refuses an open directory and one nobody looked into, neither being one thing, and an ignored place', async () => {
    const { f } = await setUp()
    const archive = (path: string) => agentFace.archive({ kind: 'archive', path }, f.ctx)
    expect(await archive('a.md')).toMatchObject({ outcome: 'accepted', from: 'a.md', to: '_archive/a.md', moved: true })
    expect(f.read('_archive/a.md')).toBe('a')
    expect(await archive('site')).toMatchObject({ outcome: 'accepted', to: '_archive/site', moved: true })
    expect((await archive('notes')).outcome).toBe('refused')
    expect((await archive('closed')).outcome).toBe('refused')
    expect(existsSync(join(f.root, 'notes', 'one.md'))).toBe(true)
    expect(await archive('node_modules/m.js')).toMatchObject({ outcome: 'refused', reason: 'ignored' })
  })
})
