import { copyFile, writeFile } from 'node:fs/promises'
import { writableContent } from './access.js'
import { discard, exists, fingerprintOfFile, moveInto, regularFile, scratchName } from './files.js'
import { abs, archivedPath, parseLibraryPath, regionOf, scratchDir } from './paths.js'
import { eachPlugin, messageOf, pluginContext } from './pipeline.js'
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
  ReviseOutcome,
} from './types.js'

type TargetState = 'missing' | 'same' | 'different'
type PutAction = 'accept' | 'copy' | 'move' | 'revise' | { refuse: PutRefusal }

/**
 * ARCHITECTURE "放". The "outside the library or the grant" column is decided before the table by
 * `writableContent`. For `register` the incoming content is the target's own, so a present target
 * is always "same".
 */
export const PUT_TABLE = {
  register: { missing: { refuse: 'no-such-file' }, same: 'accept', different: 'accept' },
  place: { missing: 'copy', same: 'accept', different: 'revise' },
  move: { missing: 'move', same: { refuse: 'would-overwrite' }, different: { refuse: 'would-overwrite' } },
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

async function register(req: Extract<PutRequest, { kind: 'register' }>, ctx: Context): Promise<Accepted | Refused> {
  const target = writableContent(ctx, req.path)
  if (!target.ok) return refuse(target.reason, req.path)
  const origin = await parseOrigin(ctx, req.origin)
  if ('refused' in origin) return origin
  const file = abs(ctx.library.root, target.path)
  const current = (await regularFile(file)) ? await fingerprintOfFile(file) : null
  if (current === null) return refuse(PUT_TABLE.register.missing.refuse, req.path)
  return { put: { kind: 'register', path: target.path, fingerprint: current, origin }, copied: false, notes: [], problems: [] }
}

async function place(req: Extract<PutRequest, { kind: 'place' }>, ctx: Context): Promise<Accepted | Refused> {
  const { root } = ctx.library
  const target = writableContent(ctx, req.to)
  if (!target.ok) return refuse(target.reason, req.to)
  const origin = await parseOrigin(ctx, req.origin)
  if ('refused' in origin) return origin
  if (req.from.kind === 'file' && !(await regularFile(req.from.path))) return refuse('no-such-file', req.from.path)

  // The incoming content is fixed in a scratch copy first, so the fingerprint is of what lands.
  const incoming = await scratchName(scratchDir(root))
  try {
    if (req.from.kind === 'file') await copyFile(req.from.path, incoming)
    else await writeFile(incoming, req.from.content)
    const fingerprint = await fingerprintOfFile(incoming)
    const file = abs(root, target.path)
    const current = await currentContent(file)
    if (current === 'not-a-file') return refuse('would-overwrite', req.to)
    const state: TargetState = current === null ? 'missing' : current === fingerprint ? 'same' : 'different'
    const source = req.from.kind === 'file' ? { kind: 'file' as const, path: req.from.path } : { kind: 'stdin' as const }
    const accepted = (copied: boolean, previous: Fingerprint | null, notes: Note[] = []): Accepted => ({
      put: { kind: 'place', path: target.path, fingerprint, origin, source, copied, previous },
      copied,
      notes,
      problems: [],
    })

    const action: PutAction = PUT_TABLE.place[state]
    if (action === 'accept') return accepted(false, null)
    if (action === 'copy') {
      await moveInto(incoming, file)
      return accepted(true, null)
    }
    // revise: hand over to the first plugin that keeps replaced content; otherwise refuse.
    const reviser = ctx.library.plugins.find((p) => p.revise)
    if (!reviser?.revise || current === null) return refuse('would-overwrite', req.to)
    let outcome: ReviseOutcome
    try {
      outcome = await reviser.revise({ path: target.path, current, incoming: fingerprint }, pluginContext(ctx, reviser.name))
    } catch (error) {
      return refuse('would-overwrite', req.to, [{ plugin: reviser.name, message: messageOf(error) }])
    }
    if (outcome.outcome === 'declined') return refuse('would-overwrite', req.to)
    await moveInto(incoming, file)
    return accepted(true, current, outcome.note === null ? [] : [{ plugin: reviser.name, text: outcome.note }])
  } finally {
    await discard(incoming)
  }
}

async function move(req: Extract<PutRequest, { kind: 'move' }>, ctx: Context): Promise<Accepted | Refused> {
  const { root } = ctx.library
  const from = writableContent(ctx, req.from)
  if (!from.ok) return refuse(from.reason, req.from)
  const to = writableContent(ctx, req.to)
  if (!to.ok) return refuse(to.reason, req.to)
  const source = abs(root, from.path)
  if (!(await regularFile(source))) return refuse('no-such-file', req.from)
  const fingerprint = await fingerprintOfFile(source)
  const current = await currentContent(abs(root, to.path))
  const state: TargetState = current === null ? 'missing' : current === fingerprint ? 'same' : 'different'
  const action: PutAction = PUT_TABLE.move[state]
  if (typeof action === 'object') return refuse(action.refuse, req.to)
  await moveInto(source, abs(root, to.path))
  return { put: { kind: 'move', from: from.path, path: to.path, fingerprint }, copied: false, notes: [], problems: [] }
}

/** The fingerprint at `file`; null when nothing is there; 'not-a-file' for a folder or the like. */
async function currentContent(file: string): Promise<Fingerprint | null | 'not-a-file'> {
  if (await regularFile(file)) return fingerprintOfFile(file)
  return (await exists(file)) ? 'not-a-file' : null
}

/** A made origin names files of the library that are there, in the main area or archived. */
async function parseOrigin(ctx: Context, origin: Origin<string>): Promise<Origin | Refused> {
  if (origin.kind === 'brought') return origin
  const { root } = ctx.library
  const from: LibraryPath[] = []
  for (const input of origin.from) {
    const path = parseLibraryPath(root, input)
    if (path === null || regionOf(path) === 'kernel') return refuse('outside-library', input)
    const there = (await regularFile(abs(root, path))) ?? (regionOf(path) === 'content' ? await regularFile(abs(root, archivedPath(path))) : null)
    if (!there) return refuse('no-such-file', input)
    from.push(path)
  }
  return { kind: 'made', from, outside: origin.outside }
}

