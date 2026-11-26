// The ledger's body: immutable facts, appended through storage, one write per hook. ledger-design.md
// sections 1 and 2; where storage puts them is storage's (core/README.md).
import { randomBytes } from 'node:crypto'
import type { Actor, Context, Fingerprint, Instant, LibraryPath, PluginContext, Transcript } from '@pneuma-base/kernel'

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

/** Appends the facts through storage as one write; they are never rewritten. */
export async function writeFacts(ctx: PluginContext, facts: readonly Fact[]): Promise<void> {
  if (facts.length > 0) await ctx.tools.storage.records.append(facts)
}

/** How many facts one read of storage brings. */
export const FACT_PAGE = 5000

/**
 * The facts after `cursor`, read through storage page by page, each fact checked for the envelope it
 * must have; null when the cursor no longer fits the facts there.
 */
export async function factsSince(ctx: PluginContext, cursor: string | null): Promise<{ facts: Fact[]; cursor: string } | null> {
  const facts: Fact[] = []
  let at = cursor
  for (;;) {
    const page = await ctx.tools.storage.records.since(at, FACT_PAGE)
    if (page === null) return null
    for (const { fact } of page.facts) if (isFact(fact)) facts.push(fact)
    at = page.cursor
    if (!page.more) return { facts, cursor: page.cursor }
  }
}

/** The facts this process has read, by the ledger directory they belong to, and where the reading stopped. */
const read = new Map<string, { cursor: string; byId: Map<string, Fact> }>()

/** Every fact, duplicates by id kept once; within one process only what is new is read again. */
export async function readFacts(ctx: PluginContext): Promise<Fact[]> {
  const known = read.get(ctx.dir)
  const more = await factsSince(ctx, known?.cursor ?? null)
  if (more === null) {
    read.delete(ctx.dir)
    return readFacts(ctx)
  }
  const byId = known?.byId ?? new Map<string, Fact>()
  for (const f of more.facts) if (!byId.has(f.id)) byId.set(f.id, f)
  read.set(ctx.dir, { cursor: more.cursor, byId })
  return [...byId.values()]
}

function isFact(raw: unknown): raw is Fact {
  const f = raw as Partial<Fact> | null
  return typeof f === 'object' && f !== null && typeof f.id === 'string' && typeof f.at === 'string' && typeof f.kind === 'string' && typeof f.scene === 'string'
}
