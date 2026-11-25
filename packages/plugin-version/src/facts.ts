// The version plugin's records: immutable facts, one JSON object per line, one new file per write,
// under facts/<scene>/. Each plugin keeps its own copy of this pattern; plugins share no code.
import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Actor, Context, Fingerprint, Instant, LibraryPath, ManifestEntry, ThingKind } from '@pneuma-base/kernel'

export type ThingId = string & { readonly __brand: 'ThingId' }
export type FactId = string & { readonly __brand: 'FactId' }

/** One version's content: each file's path in the thing and its sha256. A single file has one row, whose path is ''. */
export type Manifest = { kind: ThingKind; rows: ManifestEntry[] }

/** How a version came to be recorded: when it was declared, after a put, or seen changed outside the tool. */
export type Via = 'declare' | 'put' | 'outside'

export type FactBody =
  | { kind: 'declare'; thing: ThingId; path: LibraryPath }
  | { kind: 'version'; thing: ThingId; path: LibraryPath; fingerprint: Fingerprint; manifest: Manifest; via: Via }
  | { kind: 'note'; thing: ThingId; version: FactId; text: string }
  | { kind: 'move'; thing: ThingId; from: LibraryPath; to: LibraryPath }
  | { kind: 'gone'; thing: ThingId } // the owner deleted it from the library (archive purge); its versions stay
  | { kind: 'prune'; thing: ThingId; versions: FactId[] } // the owner dropped these versions' content

export type Who = { kind: Actor['kind']; name: string }
export type Fact = { id: FactId; at: Instant; scene: string; by: Who } & FactBody

const KINDS: ReadonlySet<string> = new Set(['declare', 'version', 'note', 'move', 'gone', 'prune'] satisfies FactBody['kind'][])
const FACTS_DIR = 'facts'

const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, '')
const compact = (at: Instant) => at.replace(/[^0-9]/g, '')
const writer = randomBytes(3).toString('hex')
let sequence = 0

export function who(actor: Actor): Who {
  return actor.kind === 'owner' ? { kind: 'owner', name: 'owner' } : { kind: actor.kind, name: actor.name }
}

/** The session id made safe; for a session minted for this one call, the actor's ad hoc scene of the day. */
function sceneOf(ctx: Context): string {
  if (ctx.session.source !== 'minted') return safe(ctx.session.id) || 'session'
  return `adhoc-${safe(who(ctx.actor).name)}-${ctx.now.slice(0, 10)}`
}

export function newThingId(): ThingId {
  return `t_${randomBytes(5).toString('hex')}` as ThingId
}

/** One fact of this call. Ids sort by time, then by order within this process. */
export function fact(ctx: Context, body: FactBody): Fact {
  const id = `f_${compact(ctx.now)}_${writer}_${(sequence++).toString(36).padStart(4, '0')}` as FactId
  return { id, at: ctx.now, scene: sceneOf(ctx), by: who(ctx.actor), ...body }
}

/**
 * Writes the facts as one new file in their scene's folder: a temporary name first, then linked to
 * its final name, which fails rather than replace a file that is there. Nothing is ever rewritten.
 */
export async function writeFacts(dir: string, facts: Fact[]): Promise<void> {
  const first = facts[0]
  if (!first) return
  const folder = join(dir, FACTS_DIR, first.scene)
  await mkdir(folder, { recursive: true })
  const bytes = facts.map((f) => `${JSON.stringify(f)}\n`).join('')
  for (;;) {
    const name = `${compact(first.at)}-${randomBytes(4).toString('hex')}.jsonl`
    const tmp = join(folder, `.tmp-${name}`)
    const handle = await open(tmp, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(tmp, join(folder, name))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await unlink(tmp)
    }
  }
}

/** Every fact on disk, skipping temporary files and lines that are not facts. A fact seen twice is kept once. */
export async function readFacts(dir: string): Promise<Fact[]> {
  const root = join(dir, FACTS_DIR)
  const byId = new Map<string, Fact>()
  for (const scene of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, scene)).catch(() => [] as string[])) {
      if (name.startsWith('.') || !name.endsWith('.jsonl')) continue
      for (const line of (await readFile(join(root, scene, name), 'utf8')).split('\n')) {
        const parsed = parseFact(line)
        if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, parsed)
      }
    }
  }
  return [...byId.values()]
}

function parseFact(line: string): Fact | null {
  if (line.trim() === '') return null
  try {
    const raw = JSON.parse(line) as Partial<Record<keyof Fact, unknown>>
    const strings = [raw.id, raw.at, raw.scene, raw.kind, raw.thing].every((v) => typeof v === 'string')
    return strings && KINDS.has(raw.kind as string) ? (raw as Fact) : null
  } catch {
    return null
  }
}
