// The boundary of POST /api/call: JSON from the page parsed into the kernel's Call, or what is wrong with it.
import type { Call, Instant, Origin, OwnerArgs, PutRequest } from '@pneuma-base/kernel'

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)
const isRecordOf = <T>(v: unknown, item: (x: unknown) => x is T): v is Record<string, T> => isObject(v) && Object.values(v).every(item)

class Malformed extends Error {}
const need = (ok: boolean, what: string): void => {
  if (!ok) throw new Malformed(what)
}

function origin(raw: unknown): Origin<string> {
  need(isObject(raw), 'origin is not an object')
  const o = raw as Raw
  if (o.kind === 'brought') {
    need(isStringOrNull(o.source) && isStringOrNull(o.by), 'brought origin needs source and by, each a string or null')
    return { kind: 'brought', source: o.source as string | null, by: o.by as string | null }
  }
  need(o.kind === 'made' && isStrings(o.from) && isStrings(o.outside), 'origin is neither brought nor made')
  return { kind: 'made', from: o.from as string[], outside: o.outside as string[] }
}

/** Only a file can be placed from the page; standard input belongs to the command line. */
function putRequest(r: Raw): PutRequest {
  if (r.kind === 'register') {
    need(isString(r.path), 'register needs a path')
    return { kind: 'register', path: r.path as string, origin: origin(r.origin) }
  }
  if (r.kind === 'move') {
    need(isString(r.from) && isString(r.to), 'move needs from and to')
    return { kind: 'move', from: r.from as string, to: r.to as string }
  }
  need(r.kind === 'place' && isString(r.to), 'put is neither register, move nor place')
  const from = r.from
  need(isObject(from) && from.kind === 'file' && isString(from.path), 'place from the page takes a file path')
  return { kind: 'place', from: { kind: 'file', path: (from as Raw).path as string }, to: r.to as string, origin: origin(r.origin) }
}

function agentCall(verb: unknown, r: Raw): Call {
  switch (verb) {
    case 'put':
      return { face: 'agent', verb, request: putRequest(r) }
    case 'find':
      need(isStringOrNull(r.text) && (r.match === 'terms' || r.match === 'words') && isRecordOf(r.filters, isString), 'find needs text, match and filters')
      need(typeof r.includeArchived === 'boolean' && typeof r.skipOwnSession === 'boolean', 'find needs includeArchived and skipOwnSession')
      return { face: 'agent', verb, request: { text: r.text as string | null, match: r.match as 'terms' | 'words', filters: r.filters as Record<string, string>, includeArchived: r.includeArchived as boolean, skipOwnSession: r.skipOwnSession as boolean } }
    case 'inspect':
      need(isString(r.target), 'inspect needs a target')
      return { face: 'agent', verb, request: { target: r.target as string } }
    case 'say':
      need(isString(r.kind) && isStringOrNull(r.about) && isStringOrNull(r.text) && isRecordOf(r.args, isStrings), 'say needs kind, about, text and args')
      return { face: 'agent', verb, request: { kind: r.kind as string, about: r.about as string | null, text: r.text as string | null, args: r.args as Record<string, string[]> } }
    case 'check': {
      need((r.since === null || isString(r.since)) && typeof r.includeArchived === 'boolean', 'check needs since and includeArchived')
      const since = r.since === null || r.since === 'last' ? r.since : Number.isNaN(Date.parse(r.since as string)) ? undefined : (new Date(r.since as string).toISOString() as Instant)
      need(since !== undefined, 'check since is neither last nor a time')
      return { face: 'agent', verb, request: { since: since as Instant | 'last' | null, includeArchived: r.includeArchived as boolean } }
    }
    case 'archive':
      need((r.kind === 'archive' || r.kind === 'unarchive') && isString(r.path), 'archive needs kind and path')
      return { face: 'agent', verb, request: { kind: r.kind as 'archive' | 'unarchive', path: r.path as string } }
    default:
      throw new Malformed('not a verb of the agent face')
  }
}

function ownerArgs(raw: unknown): OwnerArgs {
  need(isObject(raw), 'owner args is not an object')
  const a = raw as Raw
  need(isStrings(a.positional) && isRecordOf(a.flags, (v): v is string[] | true => v === true || isStrings(v)), 'owner args needs positional and flags')
  return { positional: a.positional as string[], flags: a.flags as OwnerArgs['flags'] }
}

/** The call the page sent, or a sentence saying what is wrong with it. */
export function parseCall(raw: unknown): Call | string {
  try {
    need(isObject(raw), 'call is not an object')
    const c = raw as Raw
    if (c.face === 'owner') {
      need(isString(c.command), 'owner call needs a command')
      need(c.stdin === undefined || isString(c.stdin), 'owner call stdin is not a string')
      return { face: 'owner', command: c.command as string, args: ownerArgs(c.args), ...(c.stdin === undefined ? {} : { stdin: c.stdin as string }) }
    }
    need(c.face === 'agent' && isObject(c.request), 'call is neither an agent nor an owner call')
    return agentCall(c.verb, c.request as Raw)
  } catch (error) {
    if (error instanceof Malformed) return error.message
    throw error
  }
}
