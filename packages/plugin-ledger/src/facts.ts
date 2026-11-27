// The ledger's body: immutable facts, appended through storage, one write per hook. ARCHITECTURE.md
// 「记什么」; where storage puts them is storage's (core/README.md). A thing is known by its
// state token, which storage gave when the fact was written; its fingerprint is there only when its
// content passed through the kernel or somebody read it. Facts written before tokens existed have none.
import { randomBytes } from 'node:crypto'
import type { Actor, Context, FeedAct, Fingerprint, Instant, LibraryPath, PluginContext, Transcript } from '@pneuma-base/kernel'

export type ItemId = string & { readonly __brand: 'ItemId' }
export type SceneId = string & { readonly __brand: 'SceneId' }

/** One source of a made thing, as it was when the thing was made from it: its state token and, when known, its fingerprint. */
export type BasisRow = { item: ItemId; fingerprint: Fingerprint | null; token?: string }
export type Basis = { items: BasisRow[]; outside: string[] }

export type LedgerOrigin =
  | { kind: 'brought'; source: string | null; by: string | null }
  | { kind: 'made'; basis: Basis }
  | { kind: 'adopted' } // nobody knew where it came from when it was entered

type SaidFlavor = 'doing' | 'decided' | 'note'

/** What storage said of a thing when a fact recorded it: its state token and its moment. Absent in facts written before tokens. */
export type Seen = { token?: string; modified?: string }

/** One thing of an `items.enter`: what an `item.enter` says of it, but for the origin they share. */
export type Entered = Seen & { item: ItemId; path: LibraryPath; fingerprint: Fingerprint | null; size: number; bundle?: true }

export type FactBody =
  | { kind: 'said'; flavor: SaidFlavor; text: string; about: ItemId | null }
  | (Seen & { kind: 'item.enter'; item: ItemId; path: LibraryPath; fingerprint: Fingerprint | null; size: number; origin: LedgerOrigin; bundle?: true; note?: string }) // bundle: a marked directory; note: what this put changed
  | { kind: 'items.enter'; items: Entered[]; origin: LedgerOrigin } // many things entered in one act, all with one origin: the owner registering what nobody had
  | (Seen & { kind: 'item.revise'; item: ItemId; base: Fingerprint | null; fingerprint: Fingerprint | null; size: number; basis?: Basis; held: string | null; claimed: boolean; by?: 'owner'; note?: string }) // by: the owner made the edit the actor recorded
  | (Seen & { kind: 'item.move'; item: ItemId; from: LibraryPath; to: LibraryPath; archive: 'in' | 'out' | null })
  | { kind: 'item.basis'; item: ItemId; fingerprint: Fingerprint | null; basis: Basis }
  | { kind: 'item.remove'; item: ItemId }
  | { kind: 'owner.op'; command: string; summary: string; destructive: boolean; readOnly?: true; setup?: true; request?: { id: string; by: FactActor }; refused?: string; declined?: { id: string; by: FactActor | null }; line?: string; act?: FeedAct; object?: string } // request: the owner approved it at an agent's request; refused: the command's reason when it then refused; declined: the request a `request decline` turned down, and who had asked; line: the command as given, its name and arguments; act and object: what it did and to what, as the command declares (readOnly: one an older ledger wrote; looking is no longer recorded)
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

export const actorKey = (a: FactActor) => `${a.kind}:${a.name}:${a.grant ?? ''}`

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

/** How many facts one read of storage brings, and so how many one fold of the rows takes at most. */
export const FACT_PAGE = 2000

/** Facts in the order the rows take them: by time, then by id. */
const byTime = (a: Fact, b: Fact) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
export const inOrder = (input: readonly Fact[]): Fact[] => [...input].sort(byTime)

/** What an owner command records besides the row of the command itself, which tells it: no news of its own. */
export const toldByItsCommand = (f: Fact) => f.kind === 'items.enter' || f.kind === 'unowned.left'

/** Owner commands that change neither the content nor the capabilities: recorded as facts, but no news to an agent. */
export const QUIET_OWNER_COMMANDS: ReadonlySet<string> = new Set(['init', 'grant issue', 'grant revoke', 'skill install'])

/** Whether a feed tells a fact: every one but the looks, which are no news, and what the row of an owner command tells. */
export const isTold = (f: Fact) => f.kind !== 'checked' && !toldByItsCommand(f)

/** Whether a fact is an act, a row of the activity page and counted there: a told fact, but not a scene saying what it is doing, which is its context, nor an older record of looking. */
export const isAct = (f: Fact) => isTold(f) && !(f.kind === 'said' && f.flavor === 'doing') && !(f.kind === 'owner.op' && f.readOnly === true)

/** Whether a fact can be news to anyone: setup commands are judged against each reader when asked; an export takes data out and changes nothing anyone works on. */
export const mayBeNews = (f: Fact) => isTold(f) && !(f.kind === 'owner.op' && (QUIET_OWNER_COMMANDS.has(f.command) || f.readOnly || f.act === 'exported'))

export function isFact(raw: unknown): raw is Fact {
  const f = raw as Partial<Fact> | null
  return typeof f === 'object' && f !== null && typeof f.id === 'string' && typeof f.at === 'string' && typeof f.kind === 'string' && typeof f.scene === 'string'
}

/** A key that sorts the latest moment first: the digits of the moment turned around. */
export const turned = (at: string) => at.replace(/[^0-9]/g, '').replace(/[0-9]/g, (d) => String(9 - Number(d)))

/** A key that sorts the latest fact first: its moment turned around, then its id. */
export const newsKey = (f: Pick<Fact, 'at' | 'id'>): string => `${turned(f.at)}|${f.id}`
