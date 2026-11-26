// put: placing content in the library, registering what is already there, moving a thing. ARCHITECTURE
// "放". Every change goes through storage with its expectation, under a hold from the write until every
// plugin's records are in; a register reads no content: a glance for a file, the marker for a directory.
import { createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { writableContent } from './access.js'
import { openDirectories } from './places.js'
import { hashOutside, outsideDir, outsideFile } from './outside.js'
import { archivedPath, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { eachPlugin, notesOf } from './pipeline.js'
import { storageOf, type Source, type Storage } from './storage.js'
import { enclosingBundle, LEVEL, markBundle, nowOf, THING_FILES, THING_RULE, whatIs, whatIsOne, type At } from './things.js'
import {
  isFailure,
  type AcceptedPut,
  type Context,
  type Fingerprint,
  type LibraryPath,
  type Note,
  type Origin,
  type PlaceOverExisting,
  type PluginNoteAnswer,
  type PluginProblem,
  type PutRefusal,
  type PutRequest,
  type PutResult,
  type StorageFailure,
  type ThingKind,
  type ThingNow,
} from '@pneuma-base/sdk'

/**
 * What the target path holds, against the incoming thing: nothing; a thing of the same kind with the
 * same or different content; a directory without the marker; or something of another kind.
 */
type TargetState = 'missing' | 'same' | 'different' | 'folder' | 'other-kind'
type PutAction = 'accept' | 'copy' | 'move' | 'revise' | 'mark' | { refuse: PutRefusal }

/**
 * ARCHITECTURE "放". The "outside the library or the grant" column is decided before the table by
 * `writableContent`, a path inside a bundle by `enclosingBundle`, a noise path by storage. A place's
 * incoming thing is a file for a file or standard input, a bundle for a directory. For `register` the
 * incoming thing is the target itself, so a thing there is always "same", and `different` cannot happen.
 */
export const PUT_TABLE = {
  register: { missing: { refuse: 'no-such-file' }, same: 'accept', different: 'accept', folder: 'mark', 'other-kind': { refuse: 'no-such-file' } },
  place: { missing: 'copy', same: 'accept', different: 'revise', folder: { refuse: 'would-overwrite' }, 'other-kind': { refuse: 'would-overwrite' } },
  move: {
    missing: 'move',
    same: { refuse: 'would-overwrite' },
    different: { refuse: 'would-overwrite' },
    folder: { refuse: 'would-overwrite' },
    'other-kind': { refuse: 'would-overwrite' },
  },
} as const satisfies Record<PutRequest['kind'], Record<TargetState, PutAction>>

/** A hold lasts this long: a killed put's place stays held at most so long, and a longer write outlives its hold harmlessly. */
const HOLD_FILE_MS = 120_000
const HOLD_DIR_MS = 600_000

/** An accepted put: what the plugins hear, one put or, for an open directory's files, one per page. */
type Accepted = { put: AcceptedPut; more?: AcceptedPut[]; copied: boolean; notes: Note[]; problems: PluginProblem[] }
type Refused = { refused: PutRefusal; subject: string; notes: Note[]; problems: PluginProblem[] }

const refuse = (refused: PutRefusal, subject: string, problems: PluginProblem[] = [], notes: Note[] = []): Refused => ({ refused, subject, notes, problems })

/** A storage refusal or failure as put's: noise is noise, a hold or a changed expectation is busy, a directory over the limit is too many. */
function refusalOf(failure: StorageFailure, subject: string): Refused {
  if (failure.reason === 'noise') return refuse('noise', subject)
  if (failure.reason === 'held' || failure.reason === 'refused' || failure.reason === 'busy') return refuse('busy', subject)
  if (failure.reason === 'too_many') return refuse('too-many', `${subject}（至少 ${failure.at_least ?? THING_FILES} 个文件）`)
  if (failure.reason === 'no_such_place' || failure.reason === 'not_a_file' || failure.reason === 'not_a_dir') return refuse('no-such-file', subject)
  if (failure.reason === 'outside') return refuse('outside-library', subject)
  throw new Error(`存储没能做这次放入（${failure.reason}${failure.detail ? `：${failure.detail}` : ''}）：${subject}`)
}

/**
 * A put. The places it changes are held from before the write until every plugin's `onPut` is done, so
 * whoever looks meanwhile sees them held, not as things nobody registered or things gone.
 */
export async function put(req: PutRequest, ctx: Context): Promise<PutResult> {
  const store = storageOf(ctx.library.root)
  const holds: string[] = []
  try {
    const step = req.kind === 'register' ? await register(req, ctx, store, holds) : req.kind === 'place' ? await place(req, ctx, store, holds) : await move(req, ctx, store, holds)
    if ('refused' in step) return { outcome: 'refused', reason: step.refused, subject: step.subject, notes: step.notes, problems: step.problems }
    const told = [step.put, ...(step.more ?? [])]
    const heard = notesOf(
      await eachPlugin(ctx, async (plugin, pctx) => {
        if (!plugin.onPut) return null
        const answers: PluginNoteAnswer[] = []
        for (const one of told) {
          const answer = await plugin.onPut(one, pctx)
          if (answer !== null) answers.push(answer)
        }
        return answers.length <= 1 ? (answers[0] ?? null) : joined(answers)
      }),
    )
    return {
      outcome: 'accepted',
      path: step.put.path,
      fingerprint: step.put.kind === 'register-files' ? null : step.put.fingerprint,
      copied: step.copied,
      notes: [...step.notes, ...heard.notes],
      problems: [...step.problems, ...heard.problems],
    }
  } finally {
    for (const hold of holds) await store.release(hold).catch(() => undefined)
  }
}

/** Several answers of one plugin to one put as one: their notes' texts joined, every problem kept. */
function joined(answers: readonly PluginNoteAnswer[]): PluginNoteAnswer {
  const parts = answers.map((a) => ('problems' in a ? a : { note: a, problems: [] }))
  const notes = parts.flatMap((p) => (p.note === null ? [] : [p.note]))
  const note = notes.length === 0 ? null : { text: notes.map((n) => n.text).join('\n'), data: notes.map((n) => n.data ?? null) }
  return { note, problems: parts.flatMap((p) => p.problems) }
}

/** Holds these places for this put; a place another write holds refuses it as busy. */
async function holdFor(store: Storage, holds: string[], places: readonly LibraryPath[], ttl: number): Promise<string | Refused> {
  const held = await store.hold(places, ttl)
  if (isFailure(held)) return refusalOf(held, places.join('、'))
  holds.push(held.hold)
  return held.hold
}

/** A path the agent face writes: in the content, in the grant, and not inside a bundle. */
async function writable(ctx: Context, store: Storage, input: string): Promise<{ path: LibraryPath } | Refused> {
  const target = writableContent(ctx, input)
  if (!target.ok) return refuse(target.reason, input)
  const bundle = await enclosingBundle(store, target.path)
  return bundle === null ? { path: target.path } : refuse('inside-bundle', bundle)
}

const stateOfAt = (at: At): Exclude<TargetState, 'same' | 'different'> | ThingKind =>
  at.kind === 'none' ? 'missing' : at.kind === 'folder' ? 'folder' : at.kind === 'other' ? 'other-kind' : at.kind

async function register(req: Extract<PutRequest, { kind: 'register' }>, ctx: Context, store: Storage, holds: string[]): Promise<Accepted | Refused> {
  // What the owner's side saw is the owner's to record: an agent says where a thing came from.
  if (req.observed && ctx.actor.kind !== 'owner') return refuse('agent-session', req.path)
  const target = await writable(ctx, store, req.path)
  if ('refused' in target) return target
  const origin = await parseOrigin(ctx, store, req.origin)
  if ('refused' in origin) return origin
  const at = await whatIsOne(store, target.path)
  if (at.failed === 'noise') return refuse('noise', req.path)
  const s = stateOfAt(at)
  const action = PUT_TABLE.register[s === 'file' || s === 'bundle' ? 'same' : s]
  if (typeof action === 'object') return refuse(action.refuse, req.path)
  if (action === 'mark' && (await openDirectories(ctx)).includes(target.path)) return registerFiles(req, store, holds, target.path, origin)
  const hold = await holdFor(store, holds, [target.path], at.kind === 'file' ? HOLD_FILE_MS : HOLD_DIR_MS)
  if (typeof hold !== 'string') return hold
  if (action === 'mark') {
    const marked = await markBundle(store, target.path, hold)
    if (isFailure(marked)) return refusalOf(marked, req.path)
  }
  const now = action === 'mark' ? await whatIsOne(store, target.path) : at
  if (now.entry === null) return refuse('busy', req.path)
  const put: AcceptedPut = { kind: 'register', path: target.path, fingerprint: null, now: nowOf(now.entry, now.kind), origin, note: given(req.note ?? null), ...(req.observed ? { observed: true } : {}) }
  return { put, copied: false, notes: [], problems: [] }
}

/**
 * A register of an open directory: the loose files of its one level, LEVEL at a time from its overview,
 * each held and told as storage described it. Its folders, and what lies deeper, are not touched.
 */
async function registerFiles(req: Extract<PutRequest, { kind: 'register' }>, store: Storage, holds: string[], dir: LibraryPath, origin: Origin): Promise<Accepted | Refused> {
  const puts: AcceptedPut[] = []
  let after: string | undefined
  for (;;) {
    const page = await store.overview(dir, { limit: LEVEL, ...(after === undefined ? {} : { after }) })
    if (isFailure(page)) return refusalOf(page, req.path)
    const files = page.entries.filter((e) => e.kind === 'file' && e.token !== undefined)
    if (files.length > 0) {
      const hold = await holdFor(store, holds, files.map((f) => f.place as LibraryPath), HOLD_FILE_MS)
      if (typeof hold !== 'string') return hold
      puts.push({ kind: 'register-files', path: dir, files: files.map((f) => ({ path: f.place as LibraryPath, now: nowOf(f, 'file') })), origin, note: given(req.note ?? null), ...(req.observed ? { observed: true } : {}) })
    }
    if (page.more === null) break
    after = page.more.after
  }
  const [first, ...more] = puts
  if (first === undefined) return refuse('no-such-file', `${req.path}（这一层没有文件）`)
  return { put: first, more, copied: false, notes: [], problems: [] }
}

/** Where a place's content comes from, as storage takes it, with its fingerprint when it is a file read here or a place in the store. */
type Incoming = { source: Source; kind: ThingKind; size: number | null; fingerprint: () => Promise<Fingerprint | null> }

/**
 * The incoming content. A file or directory outside the library is read by storage as it copies; a
 * file inside the library is copied from its place; standard input is bytes. Null when there is no such file.
 */
async function incomingOf(ctx: Context, store: Storage, from: Extract<PutRequest, { kind: 'place' }>['from']): Promise<Incoming | Refused> {
  const { root } = ctx.library
  if (from.kind === 'stdin') {
    const fingerprint = createHash('sha256').update(from.content).digest('hex') as Fingerprint
    return { source: { data: from.content }, kind: 'file', size: from.content.byteLength, fingerprint: async () => fingerprint }
  }
  const inside = parseLibraryPath(root, from.path)
  if (from.kind === 'file') {
    if (inside !== null && isAbsolute(from.path)) {
      if (regionOf(inside) === 'kernel') return refuse('outside-library', from.path)
      const at = await whatIsOne(store, inside)
      if (at.kind !== 'file' || at.entry === null) return refuse('no-such-file', from.path)
      return { source: { place: inside }, kind: 'file', size: at.entry.size ?? null, fingerprint: async () => (await contentOf(store, inside))?.fingerprint ?? null }
    }
    const file = await outsideFile(from.path)
    if (file === null) return refuse('no-such-file', from.path)
    let print: Promise<Fingerprint> | null = null
    return { source: { path: file.path }, kind: 'file', size: file.size, fingerprint: () => (print ??= hashOutside(file.path)) }
  }
  const dir = await outsideDir(from.path)
  if (dir === null) return refuse('no-such-file', from.path)
  if (overlapsLibrary(root, dir)) return refuse('outside-library', from.path)
  return { source: { path: dir }, kind: 'bundle', size: null, fingerprint: async () => null }
}

async function contentOf(store: Storage, place: LibraryPath) {
  const answer = await store.content(place)
  return isFailure(answer) ? null : answer
}

async function place(req: Extract<PutRequest, { kind: 'place' }>, ctx: Context, store: Storage, holds: string[]): Promise<Accepted | Refused> {
  const target = await writable(ctx, store, req.to)
  if ('refused' in target) return target
  const origin = await parseOrigin(ctx, store, req.origin)
  if ('refused' in origin) return origin
  const incoming = await incomingOf(ctx, store, req.from)
  if ('refused' in incoming) return incoming
  const at = await whatIsOne(store, target.path)
  if (at.failed === 'noise') return refuse('noise', req.to)
  const source = req.from.kind === 'stdin' ? { kind: 'stdin' as const } : { kind: req.from.kind, path: req.from.path }
  const note = given(req.note ?? null)

  // Same content is decided by reading only when it could be: a file of the same size. A directory onto a bundle is taken as different.
  const s = stateOfAt(at)
  let current: Fingerprint | null = null
  let state: TargetState
  if (s !== incoming.kind) state = s === 'file' || s === 'bundle' ? 'other-kind' : s
  else if (s === 'bundle' || at.entry?.size !== incoming.size) state = 'different'
  else {
    current = (await contentOf(store, target.path))?.fingerprint ?? null
    state = current !== null && current === (await incoming.fingerprint()) ? 'same' : 'different'
  }

  const action: PutAction = PUT_TABLE.place[state]
  if (typeof action === 'object') return refuse(action.refuse, req.to)
  const accepted = (fingerprint: Fingerprint, now: ThingNow, copied: boolean, previous: { token: string; fingerprint: Fingerprint | null } | null, notes: Note[] = [], problems: PluginProblem[] = []): Accepted => ({
    put: { kind: 'place', path: target.path, fingerprint, now, origin, note, source, copied, previous },
    copied,
    notes,
    problems,
  })
  if (action === 'accept') {
    const fingerprint = (await incoming.fingerprint()) as Fingerprint
    return accepted(fingerprint, nowOf(at.entry as NonNullable<At['entry']>, at.kind), false, null)
  }
  if (action !== 'copy' && action !== 'revise') throw new Error(`the put table places only by copying or revising, not ${action}`)

  const hold = await holdFor(store, holds, [target.path], incoming.kind === 'file' ? HOLD_FILE_MS : HOLD_DIR_MS)
  if (typeof hold !== 'string') return hold
  let notes: Note[] = []
  let problems: PluginProblem[] = []
  let previous: { token: string; fingerprint: Fingerprint | null } | null = null
  if (action === 'revise') {
    // Ask every plugin that keeps replaced content; replace when at least one kept it.
    const token = at.entry?.token ?? ''
    const over: PlaceOverExisting = { path: target.path, token, current, incoming: await incoming.fingerprint() }
    const asked = await eachPlugin(ctx, (plugin, pctx) => plugin.revise?.(over, pctx))
    const held = asked.values.flatMap(({ plugin, value }) => (value.outcome === 'held' ? [{ plugin, note: value.note }] : []))
    const declined = asked.values.flatMap(({ plugin, value }) => (value.outcome === 'declined' ? [{ plugin, text: value.reason }] : []))
    if (held.length === 0) return refuse('would-overwrite', req.to, asked.problems, declined)
    notes = held.flatMap(({ plugin, note }) => (note === null ? [] : [{ plugin, text: note }]))
    problems = asked.problems
    previous = { token, fingerprint: current }
  }
  const expect = action === 'copy' ? 'empty' : (at.entry?.token ?? 'empty')
  const written = await store.write(target.path, incoming.source, expect, { hold, ...(incoming.kind === 'bundle' ? { rule: THING_RULE, limit: THING_FILES } : {}) })
  if (isFailure(written)) {
    if (written.side === 'from') return refusalOf({ ...written, reason: written.reason === 'noise' ? 'no_such_place' : written.reason }, req.from.kind === 'stdin' ? '-' : req.from.path)
    return refusalOf(written, req.to)
  }
  let entry = written.entry
  if (incoming.kind === 'bundle') {
    const marked = await markBundle(store, target.path, hold)
    if (isFailure(marked)) return refusalOf(marked, req.to)
    entry = (await whatIsOne(store, target.path)).entry ?? entry
  }
  return accepted(written.fingerprint, nowOf(entry, incoming.kind, { bytes: written.bytes, ...(written.files === undefined ? {} : { files: written.files }) }), true, previous, notes, problems)
}

async function move(req: Extract<PutRequest, { kind: 'move' }>, ctx: Context, store: Storage, holds: string[]): Promise<Accepted | Refused> {
  const from = await writable(ctx, store, req.from)
  if ('refused' in from) return from
  const to = await writable(ctx, store, req.to)
  if ('refused' in to) return to
  const [source, there] = await whatIs(store, [from.path, to.path]) as [At, At]
  if (source.failed === 'noise') return refuse('noise', req.from)
  if (source.kind !== 'file' && source.kind !== 'bundle') return refuse('no-such-file', req.from)
  if (there.failed === 'noise') return refuse('noise', req.to)
  const action: PutAction = PUT_TABLE.move[there.kind === 'none' ? 'missing' : there.kind === 'folder' ? 'folder' : there.kind === 'other' ? 'other-kind' : there.kind === source.kind ? 'different' : 'other-kind']
  if (typeof action === 'object') return refuse(action.refuse, req.to)
  const hold = await holdFor(store, holds, [from.path, to.path], source.kind === 'file' ? HOLD_FILE_MS : HOLD_DIR_MS)
  if (typeof hold !== 'string') return hold
  const moved = await store.move(from.path, to.path, { from: source.entry?.token ?? '', to: 'empty' }, { hold })
  if (isFailure(moved)) return refusalOf(moved, req.to)
  return { put: { kind: 'move', from: from.path, path: to.path, fingerprint: null, now: nowOf(moved.entry, source.kind) }, copied: false, notes: [], problems: [] }
}

/** Whether the directory `source` lies in the library or holds it; copying either would copy the library into itself. */
function overlapsLibrary(root: string, dir: string): boolean {
  const within = (inner: string, outer: string) => {
    const rel = relative(outer, inner)
    return !isAbsolute(rel) && rel.split(sep)[0] !== '..'
  }
  return within(dir, root) || within(root, dir)
}

/** A form's field left empty means not given, as for owner commands. */
const given = (text: string | null) => (text === null || text.trim() === '' ? null : text.trim())

/**
 * A made origin names things of the library that are there, in the main area or archived. A path
 * inside a bundle names the bundle, which is the thing. Empty fields count as not given.
 */
async function parseOrigin(ctx: Context, store: Storage, origin: Origin<string>): Promise<Origin | Refused> {
  if (origin.kind === 'brought') return { kind: 'brought', source: given(origin.source), by: given(origin.by) }
  const { root } = ctx.library
  const from: LibraryPath[] = []
  for (const input of origin.from.flatMap((f) => given(f) ?? [])) {
    const path = parseLibraryPath(root, input)
    if (path === null || regionOf(path) === 'kernel') return refuse('outside-library', input)
    const thing = await thingNamed(store, path)
    if (thing === null) return refuse('no-such-file', input)
    from.push(thing)
  }
  return { kind: 'made', from, outside: origin.outside.flatMap((o) => given(o) ?? []) }
}

/** The thing at `path`, or the bundle it lies in, looked for in the main area and then archived; named as `path` is. */
async function thingNamed(store: Storage, path: LibraryPath): Promise<LibraryPath | null> {
  for (const candidate of regionOf(path) === 'content' ? [path, archivedPath(path)] : [path]) {
    const bundle = await enclosingBundle(store, candidate)
    if (bundle !== null) return candidate === path ? bundle : (originalPath(bundle) ?? bundle)
    const at = await whatIsOne(store, candidate)
    if (at.kind === 'file' || at.kind === 'bundle') return path
  }
  return null
}
