// The ledger's body: immutable facts, one JSON object per line, one file per write.
// ledger-design.md sections 1 and 2.
import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Actor, Context, Fingerprint, Instant, LibraryPath, Transcript } from '@pneuma-base/kernel'

export type ItemId = string & { readonly __brand: 'ItemId' }
export type SceneId = string & { readonly __brand: 'SceneId' }

export type Basis = { items: { item: ItemId; fingerprint: Fingerprint }[]; outside: string[] }

export type LedgerOrigin =
  | { kind: 'brought'; source: string | null; by: string | null }
  | { kind: 'made'; basis: Basis }
  | { kind: 'adopted' } // nobody knew where it came from when it was entered

type SaidFlavor = 'doing' | 'decided' | 'note'

/** One thing of an `items.enter`: what an `item.enter` says of it, but for the origin they share. */
export type Entered = { item: ItemId; path: LibraryPath; fingerprint: Fingerprint; size: number; bundle?: true }

export type FactBody =
  | { kind: 'said'; flavor: SaidFlavor; text: string; about: ItemId | null }
  | { kind: 'item.enter'; item: ItemId; path: LibraryPath; fingerprint: Fingerprint; size: number; origin: LedgerOrigin; bundle?: true; note?: string } // bundle: a marked directory; note: what this put changed
  | { kind: 'items.enter'; items: Entered[]; origin: LedgerOrigin } // many things entered in one act, all with one origin: the owner registering what nobody had
  | { kind: 'item.revise'; item: ItemId; base: Fingerprint | null; fingerprint: Fingerprint; size: number; basis?: Basis; held: string | null; claimed: boolean; by?: 'owner'; note?: string } // by: the owner made the edit the actor recorded
  | { kind: 'item.move'; item: ItemId; from: LibraryPath; to: LibraryPath; archive: 'in' | 'out' | null }
  | { kind: 'item.basis'; item: ItemId; fingerprint: Fingerprint; basis: Basis }
  | { kind: 'item.remove'; item: ItemId }
  | { kind: 'owner.op'; command: string; summary: string; destructive: boolean; readOnly?: true; setup?: true; request?: { id: string; by: FactActor }; refused?: string; declined?: { id: string; by: FactActor | null } } // request: the owner approved it at an agent's request; refused: the command's reason when it then refused; declined: the request a `request decline` turned down, and who had asked
  | { kind: 'request'; act: 'asked' | 'withdrawn'; request: string; line: string; why?: string } // an agent asked the owner to run a command, or took the request back
  | { kind: 'checked' } // the actor looked at what changed: its check, or the owner's 都看过了 on the home page
  | { kind: 'unowned.left'; paths: LibraryPath[] } // the owner left these things unregistered, not to be asked about them again

export type FactActor = { kind: 'agent' | 'owner' | 'plugin'; name: string; grant: string | null }

/** The request a fact asked, took back or answered: approved, or turned down by a decline, which before it named the request said so only in its summary. */
export function requestOf(f: Fact): string | null {
  if (f.kind === 'request') return f.request
  if (f.kind !== 'owner.op') return null
  if (f.request) return f.request.id
  if (f.command !== 'request decline') return null
  return f.declined?.id ?? /的请求 (r-[0-9a-f]+)/.exec(f.summary)?.[1] ?? null
}
export type How = 'tool' | 'reported' | 'observed' // the tool did it; the actor said so; seen mechanically

export type Envelope = {
  id: string
  at: Instant
  scene: SceneId
  actor: FactActor
  where: { cwd: string; machine: string; sessionSource: 'flag' | 'env' | 'minted'; transcript: Transcript | null }
  how: How
}

export type Fact = Envelope & FactBody

const FACTS_DIR = 'facts'

/** The ledger plugin acting on its own, for what it observes. */
export const LEDGER_ACTOR: FactActor = { kind: 'plugin', name: 'ledger', grant: null }

export function factActor(actor: Actor): FactActor {
  if (actor.kind === 'agent') return { kind: 'agent', name: actor.name, grant: actor.grant }
  if (actor.kind === 'plugin') return { kind: 'plugin', name: actor.name, grant: null }
  return { kind: 'owner', name: 'owner', grant: null }
}

const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, '')

export const ADHOC_SCENE = 'adhoc-'

/** The session id made safe; for a session minted for this one call, the actor's ad hoc scene of the day. */
export function sceneOf(ctx: Context): SceneId {
  if (ctx.session.source !== 'minted') return (safe(ctx.session.id) || 'session') as SceneId
  return `${ADHOC_SCENE}${safe(factActor(ctx.actor).name)}-${ctx.now.slice(0, 10)}` as SceneId
}

const compact = (at: Instant) => at.replace(/[^0-9]/g, '')
const writer = randomBytes(3).toString('hex')
let sequence = 0

export function newItemId(): ItemId {
  return `i_${randomBytes(5).toString('hex')}` as ItemId
}

/** One fact in the context's scene. Ids sort by time, then by order within this process. */
export function fact(ctx: Context, how: How, body: FactBody, actor: FactActor = factActor(ctx.actor)): Fact {
  const { cwd, machine, source, transcript } = ctx.session
  const id = `f_${compact(ctx.now)}_${writer}_${(sequence++).toString(36).padStart(4, '0')}`
  return { id, at: ctx.now, scene: sceneOf(ctx), actor, where: { cwd, machine, sessionSource: source, transcript }, how, ...body }
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

/** The facts of each file read in this process, by its path: a fact file is written once and never changed. */
const parsedFiles = new Map<string, Fact[]>()

/** Every fact on disk, skipping temporary files and lines that are not facts. Duplicates by id kept once. */
export async function readFacts(dir: string): Promise<Fact[]> {
  const root = join(dir, FACTS_DIR)
  const scenes = await readdir(root).catch(() => [] as string[])
  const listed = await Promise.all(
    scenes.map(async (scene) => {
      const folder = join(root, scene)
      const names = await readdir(folder).catch(() => [] as string[])
      return names.filter((name) => !name.startsWith('.') && name.endsWith('.jsonl')).map((name) => `${folder}${sep}${name}`)
    }),
  )
  const files = listed.flat()
  await Promise.all(
    files
      .filter((file) => !parsedFiles.has(file))
      .map(async (file) => {
        parsedFiles.set(file, (await readFile(file, 'utf8')).split('\n').flatMap((line) => parseFact(line) ?? []))
      }),
  )
  const byId = new Map<string, Fact>()
  for (const file of files) for (const parsed of parsedFiles.get(file) ?? []) if (!byId.has(parsed.id)) byId.set(parsed.id, parsed)
  return [...byId.values()]
}

function parseFact(line: string): Fact | null {
  if (line.trim() === '') return null
  try {
    const raw = JSON.parse(line) as Partial<Fact>
    return typeof raw.id === 'string' && typeof raw.at === 'string' && typeof raw.kind === 'string' && typeof raw.scene === 'string' ? (raw as Fact) : null
  } catch {
    return null
  }
}
