// tmp/run-7 architecture.md section 5: what each action does at each kind of place, the kernel's cells.
// A place is a registered file, a directory registered as one thing, an open directory (one with
// registered things in it), a directory nobody looked into (closed), or noise. "Registered" is a
// plugin's word: here a contract-2 watcher plugin says which directories are open. The cells of
// start, check and the deep check are the ledger's, tested there.
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

describe('put, copying in from outside the library', () => {
  it('replaces a registered file with what it expects there, and fingerprints it in the same pass', async () => {
    const { f, seen, revised } = await setUp()
    const r = await agentFace.put({ kind: 'place', from: { kind: 'stdin', content: Buffer.from('new') }, to: 'a.md', origin: brought }, f.ctx)
    expect(outcome(r)).toBe('accepted')
    expect(revised).toHaveLength(1)
    expect(revised[0]?.token).toBeTruthy()
    const put = seen.at(-1)
    expect(put?.kind === 'place' && put.fingerprint).toBe(sha('new'))
    expect(put?.kind === 'place' && put.previous?.token).toBe(revised[0]?.token)
    expect(f.read('a.md')).toBe('new')
  })

  it('replaces a directory registered as one thing by the content rule', async () => {
    const { f, seen } = await setUp()
    const from = outsideDir({ 'index.html': '<h1>', '.gitignore': 'build/\n', 'build/out.js': 'o' })
    const r = await agentFace.put({ kind: 'place', from: { kind: 'directory', path: from }, to: 'site', origin: brought }, f.ctx)
    expect(outcome(r)).toBe('accepted')
    expect(f.read('site/index.html')).toBe('<h1>')
    expect(existsSync(join(f.root, 'site', '.pneuma-item'))).toBe(true)
    expect(seen.at(-1)?.kind).toBe('place')
  })

  it('puts into an open directory', async () => {
    const { f } = await setUp()
    expect(outcome(await agentFace.put({ kind: 'place', from: { kind: 'stdin', content: Buffer.from('n') }, to: 'notes/new.md', origin: brought }, f.ctx))).toBe('accepted')
    expect(f.read('notes/new.md')).toBe('n')
  })

  it('puts into a directory nobody looked into', async () => {
    const { f } = await setUp()
    expect(outcome(await agentFace.put({ kind: 'place', from: { kind: 'stdin', content: Buffer.from('y') }, to: 'closed/y.txt', origin: brought }, f.ctx))).toBe('accepted')
    expect(f.read('closed/y.txt')).toBe('y')
  })

  it('refuses noise', async () => {
    const { f } = await setUp()
    expect(outcome(await agentFace.put({ kind: 'place', from: { kind: 'stdin', content: Buffer.from('z') }, to: 'node_modules/z.js', origin: brought }, f.ctx))).toBe('refused:noise')
  })
})

describe('put, registering what is already there', () => {
  it('corrects the origin of a registered file, reading none of it', async () => {
    const { f, seen } = await setUp()
    unreadable(f, 'a.md')
    const r = await agentFace.put({ kind: 'register', path: 'a.md', origin: { kind: 'brought', source: 'mail', by: null } }, f.ctx)
    expect(outcome(r)).toBe('accepted')
    const put = seen.at(-1)
    expect(put).toMatchObject({ kind: 'register', path: 'a.md', fingerprint: null, origin: { source: 'mail' } })
    expect(put?.kind === 'register' && put.now.token).toBeTruthy()
  })

  it('registers a directory already one thing again as one thing', async () => {
    const { f, seen } = await setUp()
    expect(outcome(await agentFace.put({ kind: 'register', path: 'site', origin: brought }, f.ctx))).toBe('accepted')
    expect(seen.at(-1)).toMatchObject({ kind: 'register', path: 'site', fingerprint: null, now: { kind: 'bundle' } })
  })

  it("registers an open directory's loose files of its one level as files, and does not make it one thing", async () => {
    const { f, seen } = await setUp()
    const r = await agentFace.put({ kind: 'register', path: 'notes', origin: brought }, f.ctx)
    expect(outcome(r)).toBe('accepted')
    const put = seen.at(-1)
    expect(put?.kind).toBe('register-files')
    expect(put?.kind === 'register-files' && put.files.map((x) => x.path)).toEqual(['notes/one.md', 'notes/two.md'])
    expect(put?.kind === 'register-files' && put.files.every((x) => x.now.token !== '')).toBe(true)
    expect(existsSync(join(f.root, 'notes', '.pneuma-item'))).toBe(false)
  })

  it('registers a directory nobody looked into as one thing, reading none of its content', async () => {
    const { f, seen } = await setUp()
    unreadable(f, 'closed/x.txt')
    expect(outcome(await agentFace.put({ kind: 'register', path: 'closed', origin: brought }, f.ctx))).toBe('accepted')
    expect(seen.at(-1)).toMatchObject({ kind: 'register', path: 'closed', fingerprint: null, now: { kind: 'bundle' } })
    expect(existsSync(join(f.root, 'closed', '.pneuma-item'))).toBe(true)
  })

  it('refuses noise', async () => {
    const { f } = await setUp()
    expect(outcome(await agentFace.put({ kind: 'register', path: 'node_modules/m.js', origin: brought }, f.ctx))).toBe('refused:noise')
  })
})

describe('inspect', () => {
  const inspect = (f: Fixture, target: string): Promise<InspectResult> => agentFace.inspect({ target }, f.ctx)

  it('gives a registered file as storage says it is, its content unread', async () => {
    const { f } = await setUp()
    unreadable(f, 'a.md')
    const r = await inspect(f, 'a.md')
    expect(r.file).toMatchObject({ path: 'a.md', kind: 'file', size: 1, fingerprint: null })
    expect(r.file?.token).toBeTruthy()
  })

  it('gives a directory registered as one thing with its first level', async () => {
    const { f } = await setUp()
    const r = await inspect(f, 'site')
    expect(r.file?.kind).toBe('bundle')
    expect(r.file?.level?.entries.map((e) => e.name)).toEqual(['index.html'])
  })

  it('gives an open directory its first level', async () => {
    const { f } = await setUp()
    const r = await inspect(f, 'notes')
    expect(r.file).toBeNull()
    expect(r.place?.kind).toBe('open')
    expect(r.place?.kind === 'open' && r.place.level.entries.map((e) => e.name)).toEqual(['deeper', 'one.md', 'two.md'])
  })

  it('probes a directory nobody looked into within a budget, with the project markers at its top', async () => {
    const { f } = await setUp()
    f.write('big/package.json', '{}')
    for (let i = 0; i < 600; i++) f.write(`big/src/f${i}.js`, '')
    const r = await inspect(f, 'big')
    expect(r.place?.kind).toBe('closed')
    expect(r.place?.kind === 'closed' && r.place.exceeded).toBe(true)
    expect(r.place?.kind === 'closed' && r.place.markers).toContain('package.json')
  })

  it('says noise is noise, and by which rule', async () => {
    const { f } = await setUp()
    const r = await inspect(f, 'node_modules')
    expect(r.place).toEqual({ kind: 'noise', path: 'node_modules', by: { name: 'node_modules' } })
  })
})

describe('find', () => {
  it('asks the plugins and walks nothing itself: with no plugin that finds, nothing is found', async () => {
    const { f } = await setUp()
    const r = await agentFace.find({ text: 'one', match: 'terms', filters: {}, includeArchived: false, skipOwnSession: false }, f.ctx)
    expect(r.hits).toEqual([])
  })
})

describe('archive', () => {
  const archive = (f: Fixture, path: string) => agentFace.archive({ kind: 'archive', path }, f.ctx)

  it('moves a registered file with what it expects at both ends', async () => {
    const { f } = await setUp()
    expect(await archive(f, 'a.md')).toMatchObject({ outcome: 'accepted', from: 'a.md', to: '_archive/a.md', moved: true })
    expect(f.read('_archive/a.md')).toBe('a')
  })

  it('moves a directory registered as one thing', async () => {
    const { f } = await setUp()
    expect(await archive(f, 'site')).toMatchObject({ outcome: 'accepted', to: '_archive/site', moved: true })
  })

  it('refuses an open directory and a directory nobody looked into: neither is one thing', async () => {
    const { f } = await setUp()
    expect((await archive(f, 'notes')).outcome).toBe('refused')
    expect((await archive(f, 'closed')).outcome).toBe('refused')
    expect(existsSync(join(f.root, 'notes', 'one.md'))).toBe(true)
  })

  it('refuses noise', async () => {
    const { f } = await setUp()
    expect(await archive(f, 'node_modules/m.js')).toMatchObject({ outcome: 'refused', reason: 'noise' })
  })
})
