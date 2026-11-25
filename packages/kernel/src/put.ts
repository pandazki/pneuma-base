import { copyFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { writableContent } from './access.js'
import { discard, moveInto, regularFile, replaceWith, scratchName } from './files.js'
import { abs, archivedPath, canonical, originalPath, parseLibraryPath, regionOf, scratchDir } from './paths.js'
import { eachPlugin } from './pipeline.js'
import { copyBundle, enclosingBundle, fingerprintOf, kindAt, markBundle } from './things.js'
import type {
  AcceptedPut,
  Context,
  Fingerprint,
  LibraryPath,
  Note,
  Origin,
  PluginProblem,
  PutRefusal,
  PutRequest,
  PutResult,
  ThingKind,
} from './types.js'

/**
 * What the target path holds, against the incoming thing: nothing; a thing of the same kind with
 * the same or different content; a directory without the marker; or something of another kind.
 */
type TargetState = 'missing' | 'same' | 'different' | 'folder' | 'other-kind'
type PutAction = 'accept' | 'copy' | 'move' | 'revise' | 'mark' | { refuse: PutRefusal }

/**
 * ARCHITECTURE "放". The "outside the library or the grant" column is decided before the table by
 * `writableContent`, and a path inside a bundle by `enclosingBundle`. A place's incoming thing is a
 * file for a file or standard input, a bundle for a directory. For `register` the incoming thing is
 * the target itself, so a thing there is always "same", and `different` cannot happen.
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

type Accepted = { put: AcceptedPut; copied: boolean; notes: Note[]; problems: PluginProblem[] }
type Refused = { refused: PutRefusal; subject: string; problems: PluginProblem[] }

export async function put(req: PutRequest, ctx: Context): Promise<PutResult> {
  const step = req.kind === 'register' ? await register(req, ctx) : req.kind === 'place' ? await place(req, ctx) : await move(req, ctx)
  if ('refused' in step) return { outcome: 'refused', reason: step.refused, subject: step.subject, problems: step.problems }
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onPut?.(step.put, pctx))
  return {
    outcome: 'accepted',
    path: step.put.path,
    fingerprint: step.put.fingerprint,
    copied: step.copied,
    notes: [...step.notes, ...heard.values.map(({ plugin, value }) => ({ ...value, plugin }))],
    problems: [...step.problems, ...heard.problems],
  }
}

const refuse = (refused: PutRefusal, subject: string, problems: PluginProblem[] = []): Refused => ({ refused, subject, problems })

/** A path the agent face writes: in the content, in the grant, and not inside a bundle. */
async function writable(ctx: Context, input: string): Promise<{ path: LibraryPath } | Refused> {
  const target = writableContent(ctx, input)
  if (!target.ok) return refuse(target.reason, input)
  const bundle = await enclosingBundle(ctx.library.root, target.path)
  return bundle === null ? { path: target.path } : refuse('inside-bundle', bundle)
}

async function register(req: Extract<PutRequest, { kind: 'register' }>, ctx: Context): Promise<Accepted | Refused> {
  const target = await writable(ctx, req.path)
  if ('refused' in target) return target
  const origin = await parseOrigin(ctx, req.origin)
  if ('refused' in origin) return origin
  const file = abs(ctx.library.root, target.path)
  const kind = await kindAt(file)
  const state: TargetState = kind === null ? 'missing' : kind === 'folder' ? 'folder' : kind === 'other' ? 'other-kind' : 'same'
  const action = PUT_TABLE.register[state]
  if (typeof action === 'object') return refuse(action.refuse, req.path)
  if (action === 'mark') await markBundle(file)
  return { put: { kind: 'register', path: target.path, fingerprint: await fingerprintOf(file), origin }, copied: false, notes: [], problems: [] }
}

async function place(req: Extract<PutRequest, { kind: 'place' }>, ctx: Context): Promise<Accepted | Refused> {
  const { root } = ctx.library
  const target = await writable(ctx, req.to)
  if ('refused' in target) return target
  const origin = await parseOrigin(ctx, req.origin)
  if ('refused' in origin) return origin
  const from = req.from
  if (from.kind === 'file' && !(await regularFile(from.path))) return refuse('no-such-file', from.path)
  if (from.kind === 'directory') {
    const kind = await kindAt(from.path)
    if (kind !== 'folder' && kind !== 'bundle') return refuse('no-such-file', from.path)
    if (overlapsLibrary(root, from.path)) return refuse('outside-library', from.path)
  }

  // The incoming thing is fixed in a scratch copy first, so the fingerprint is of what lands.
  const scratch = scratchDir(root)
  const incoming = await scratchName(scratch)
  try {
    if (from.kind === 'file') await copyFile(from.path, incoming)
    else if (from.kind === 'directory') await copyBundle(from.path, incoming)
    else await writeFile(incoming, from.content)
    const kind: ThingKind = from.kind === 'directory' ? 'bundle' : 'file'
    const fingerprint = await fingerprintOf(incoming)
    const file = abs(root, target.path)
    const there = await stateAt(file, kind, fingerprint)
    const source = from.kind === 'stdin' ? { kind: 'stdin' as const } : { kind: from.kind, path: from.path }
    const accepted = (copied: boolean, previous: Fingerprint | null, notes: Note[] = [], problems: PluginProblem[] = []): Accepted => ({
      put: { kind: 'place', path: target.path, fingerprint, origin, source, copied, previous },
      copied,
      notes,
      problems,
    })

    const action: PutAction = PUT_TABLE.place[there.state]
    if (typeof action === 'object') return refuse(action.refuse, req.to)
    if (action === 'accept') return accepted(false, null)
    if (action === 'copy') {
      await moveInto(incoming, file)
      return accepted(true, null)
    }
    if (there.state !== 'different') throw new Error(`the put table revises only different content, not ${there.state}`)
    // Revise: ask every plugin that keeps replaced content; replace when at least one kept it.
    const asked = await eachPlugin(ctx, (plugin, pctx) => plugin.revise?.({ path: target.path, current: there.current, incoming: fingerprint }, pctx))
    const held = asked.values.flatMap(({ plugin, value }) => (value.outcome === 'held' ? [{ plugin, note: value.note }] : []))
    if (held.length === 0) return refuse('would-overwrite', req.to, asked.problems)
    await replaceWith(incoming, file, scratch)
    const notes = held.flatMap(({ plugin, note }) => (note === null ? [] : [{ plugin, text: note }]))
    return accepted(true, there.current, notes, asked.problems)
  } finally {
    await discard(incoming)
  }
}

async function move(req: Extract<PutRequest, { kind: 'move' }>, ctx: Context): Promise<Accepted | Refused> {
  const { root } = ctx.library
  const from = await writable(ctx, req.from)
  if ('refused' in from) return from
  const to = await writable(ctx, req.to)
  if ('refused' in to) return to
  const source = abs(root, from.path)
  const kind = await kindAt(source)
  if (kind !== 'file' && kind !== 'bundle') return refuse('no-such-file', req.from)
  const fingerprint = await fingerprintOf(source)
  const action: PutAction = PUT_TABLE.move[(await stateAt(abs(root, to.path), kind, fingerprint)).state]
  if (typeof action === 'object') return refuse(action.refuse, req.to)
  await moveInto(source, abs(root, to.path))
  return { put: { kind: 'move', from: from.path, path: to.path, fingerprint }, copied: false, notes: [], problems: [] }
}

type Target = { state: 'different'; current: Fingerprint } | { state: Exclude<TargetState, 'different'> }

/** What `file` holds against an incoming thing of `kind` with `fingerprint`. */
async function stateAt(file: string, kind: ThingKind, fingerprint: Fingerprint): Promise<Target> {
  const there = await kindAt(file)
  if (there === null) return { state: 'missing' }
  if (there === 'folder') return { state: 'folder' }
  if (there !== kind) return { state: 'other-kind' }
  const current = await fingerprintOf(file)
  return current === fingerprint ? { state: 'same' } : { state: 'different', current }
}

/** Whether the directory `source` lies in the library or holds it; copying either would copy the library into itself. */
function overlapsLibrary(root: string, source: string): boolean {
  const within = (inner: string, outer: string) => {
    const rel = relative(outer, inner)
    return !isAbsolute(rel) && rel.split(sep)[0] !== '..'
  }
  const dir = canonical(resolve(source))
  return within(dir, root) || within(root, dir)
}

/**
 * A made origin names things of the library that are there, in the main area or archived. A path
 * inside a bundle names the bundle, which is the thing.
 */
async function parseOrigin(ctx: Context, origin: Origin<string>): Promise<Origin | Refused> {
  if (origin.kind === 'brought') return origin
  const { root } = ctx.library
  const from: LibraryPath[] = []
  for (const input of origin.from) {
    const path = parseLibraryPath(root, input)
    if (path === null || regionOf(path) === 'kernel') return refuse('outside-library', input)
    const thing = await thingNamed(root, path)
    if (thing === null) return refuse('no-such-file', input)
    from.push(thing)
  }
  return { kind: 'made', from, outside: origin.outside }
}

/** The thing at `path`, or the bundle it lies in, looked for in the main area and then archived; named as `path` is. */
async function thingNamed(root: string, path: LibraryPath): Promise<LibraryPath | null> {
  for (const candidate of regionOf(path) === 'content' ? [path, archivedPath(path)] : [path]) {
    const bundle = await enclosingBundle(root, candidate)
    if (bundle !== null) return candidate === path ? bundle : (originalPath(bundle) ?? bundle)
    const kind = await kindAt(abs(root, candidate))
    if (kind === 'file' || kind === 'bundle') return path
  }
  return null
}
