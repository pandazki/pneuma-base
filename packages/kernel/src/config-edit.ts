// Another program's configuration, edited as text: one entry goes in, every other byte stays where it
// was, and taking the entry out gives back the text as it was. No parser rewrites the file, so numbers,
// key order, comments and formatting the owner chose survive. ARCHITECTURE.md「接上一个 agent」.

// ---- JSON ----

type Member = { key: string; keyStart: number; valueStart: number; valueEnd: number }
type Obj = { open: number; close: number; members: Member[] }

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

function skipSpace(t: string, i: number): number {
  while (isSpace(t[i])) i++
  return i
}

function stringEnd(t: string, i: number): number {
  i++
  while (t[i] !== '"') i += t[i] === '\\' ? 2 : 1
  return i + 1
}

/** Where the JSON value starting at `i` ends. The text is known to parse. */
function valueEnd(t: string, i: number): number {
  const c = t[i]
  if (c === '"') return stringEnd(t, i)
  if (c === '{' || c === '[') {
    let depth = 0
    for (;;) {
      const d = t[i]
      if (d === '"') {
        i = stringEnd(t, i)
        continue
      }
      if (d === '{' || d === '[') depth++
      else if ((d === '}' || d === ']') && --depth === 0) return i + 1
      i++
    }
  }
  while (i < t.length && !isSpace(t[i]) && t[i] !== ',' && t[i] !== '}' && t[i] !== ']') i++
  return i
}

/** The object whose `{` is at `open`: where it closes, and each member's key and where its key and value are. */
function objectAt(t: string, open: number): Obj {
  const members: Member[] = []
  let i = skipSpace(t, open + 1)
  if (t[i] === '}') return { open, close: i, members }
  for (;;) {
    const keyStart = i
    const keyEnd = stringEnd(t, i)
    const valueStart = skipSpace(t, skipSpace(t, keyEnd) + 1)
    const end = valueEnd(t, valueStart)
    members.push({ key: JSON.parse(t.slice(keyStart, keyEnd)) as string, keyStart, valueStart, valueEnd: end })
    i = skipSpace(t, end)
    if (t[i] !== ',') return { open, close: i, members }
    i = skipSpace(t, i + 1)
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type Located = { top: Obj; servers: { member: Member; obj: Obj } | null; entry: Member | null }

/** The top object, the servers member under `key` and the entry `name` in it; or why the text cannot be edited. */
function locate(text: string, key: string, name: string): Located | { why: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { why: `不是 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isPlainObject(parsed)) return { why: '最外层不是一个对象' }
  const top = objectAt(text, skipSpace(text, 0))
  const holders = top.members.filter((m) => m.key === key)
  if (holders.length > 1) return { why: `有不止一个 ${key}` }
  const member = holders[0]
  if (member === undefined) return { top, servers: null, entry: null }
  if (!isPlainObject(parsed[key])) return { why: `${key} 不是一个对象` }
  const obj = objectAt(text, member.valueStart)
  const entries = obj.members.filter((m) => m.key === name)
  if (entries.length > 1) return { why: `${key} 里有不止一个 ${name}` }
  return { top, servers: { member, obj }, entry: entries[0] ?? null }
}

/** The whitespace that starts the line `pos` is on. */
function lineIndent(t: string, pos: number): string {
  const start = t.lastIndexOf('\n', pos - 1) + 1
  let end = start
  while (t[end] === ' ' || t[end] === '\t') end++
  return t.slice(start, end)
}

/** The indent of an object's members when they sit on lines of their own; null when the object is written on one line. */
function memberIndent(t: string, o: Obj): string | null {
  const first = o.members[0]
  if (first === undefined) return null
  return t.slice(o.open, first.keyStart).includes('\n') ? lineIndent(t, first.keyStart) : null
}

type Style = { unit: string; eol: string }

function styleOf(t: string, top: Obj): Style {
  const unit = memberIndent(t, top)
  return { unit: unit === null || unit === '' ? '  ' : unit, eol: t.includes('\r\n') ? '\r\n' : '\n' }
}

const valueText = (value: unknown, indent: string | null, s: Style) => (indent === null ? JSON.stringify(value) : (JSON.stringify(value, null, s.unit) ?? 'null').split('\n').join(`${s.eol}${indent}`))
const memberText = (name: string, value: unknown, indent: string | null, s: Style) => `${JSON.stringify(name)}: ${valueText(value, indent, s)}`

/**
 * Text with a member added at the end of object `o`: on a line of its own at the indent of the others,
 * or after a comma on the same line when the object is written on one line. An empty object gets the
 * member on a line of its own, and what was between its braces is handed back to restore it.
 */
function withMember(t: string, o: Obj, member: (indent: string | null) => string, s: Style): { text: string; innerWas: string | null } {
  const last = o.members.at(-1)
  if (last === undefined) {
    const outer = lineIndent(t, o.open)
    const inner = `${outer}${s.unit}`
    return { text: `${t.slice(0, o.open + 1)}${s.eol}${inner}${member(inner)}${s.eol}${outer}${t.slice(o.close)}`, innerWas: t.slice(o.open + 1, o.close) }
  }
  const indent = memberIndent(t, o)
  const added = indent === null ? `, ${member(null)}` : `,${s.eol}${indent}${member(indent)}`
  return { text: `${t.slice(0, last.valueEnd)}${added}${t.slice(last.valueEnd)}`, innerWas: null }
}

/** Text without member `m` of object `o`; the object's only member leaves behind what was between its braces before. */
function withoutMember(t: string, o: Obj, m: Member, innerWas: string | null): string {
  const i = o.members.indexOf(m)
  if (o.members.length === 1) return `${t.slice(0, o.open + 1)}${innerWas ?? ''}${t.slice(o.close)}`
  if (i > 0) return `${t.slice(0, (o.members[i - 1] as Member).valueEnd)}${t.slice(m.valueEnd)}`
  return `${t.slice(0, m.keyStart)}${t.slice((o.members[1] as Member).keyStart)}`
}

/**
 * What adding an entry made: `file` when there was no file, `key` when the servers key was not there,
 * `entry` when only the entry is new. `innerWas`: what was between the braces of the object the
 * entry or key went into, when that object was empty.
 */
export type JsonAdded = { created: 'file' | 'key' | 'entry'; innerWas: string | null }

export type JsonAdd = ({ outcome: 'added'; text: string } & JsonAdded) | { outcome: 'present'; value: unknown } | { outcome: 'unreadable'; why: string }

/** The text with entry `name` added under `key`, every other byte as it was. `text` null: there is no file. */
export function addJsonEntry(text: string | null, key: string, name: string, value: unknown): JsonAdd {
  if (text === null) {
    const added = addJsonEntry('{}\n', key, name, value)
    return added.outcome === 'added' ? { ...added, created: 'file' } : added
  }
  const found = locate(text, key, name)
  if ('why' in found) return { outcome: 'unreadable', why: found.why }
  if (found.entry !== null) return { outcome: 'present', value: JSON.parse(text.slice(found.entry.valueStart, found.entry.valueEnd)) as unknown }
  const s = styleOf(text, found.top)
  if (found.servers !== null) return { outcome: 'added', created: 'entry', ...withMember(text, found.servers.obj, (indent) => memberText(name, value, indent, s), s) }
  const servers = (indent: string | null) => {
    const inner = indent === null ? null : `${indent}${s.unit}`
    const body = inner === null ? `{${memberText(name, value, null, s)}}` : `{${s.eol}${inner}${memberText(name, value, inner, s)}${s.eol}${indent}}`
    return `${JSON.stringify(key)}: ${body}`
  }
  return { outcome: 'added', created: 'key', ...withMember(text, found.top, servers, s) }
}

export type JsonFound = { outcome: 'found'; value: unknown } | { outcome: 'absent' } | { outcome: 'unreadable'; why: string }

/** The value of entry `name` under `key`. */
export function jsonEntry(text: string, key: string, name: string): JsonFound {
  const found = locate(text, key, name)
  if ('why' in found) return { outcome: 'unreadable', why: found.why }
  return found.entry === null ? { outcome: 'absent' } : { outcome: 'found', value: JSON.parse(text.slice(found.entry.valueStart, found.entry.valueEnd)) as unknown }
}

/** The text with the value of entry `name` replaced, written at the entry's indent. The entry is there. */
export function replaceJsonEntry(text: string, key: string, name: string, value: unknown): string {
  const found = locate(text, key, name)
  if ('why' in found || found.entry === null || found.servers === null) throw new Error(`no entry ${name} under ${key} to replace`)
  const s = styleOf(text, found.top)
  const indent = memberIndent(text, found.servers.obj)
  return `${text.slice(0, found.entry.valueStart)}${valueText(value, indent, s)}${text.slice(found.entry.valueEnd)}`
}

/**
 * The text without entry `name`. Where the entry went in, nothing else changed since, the text is
 * what it was before, byte for byte. A servers key the entry came with goes when the entry was the
 * last one in it. The entry is there.
 */
export function removeJsonEntry(text: string, key: string, name: string, added: JsonAdded): string {
  const found = locate(text, key, name)
  if ('why' in found || found.entry === null || found.servers === null) throw new Error(`no entry ${name} under ${key} to remove`)
  const { servers, entry } = found
  const ownKey = added.created !== 'entry'
  if (ownKey && servers.obj.members.length === 1) return withoutMember(text, found.top, servers.member, added.created === 'file' ? '' : added.innerWas)
  return withoutMember(text, servers.obj, entry, ownKey ? null : added.innerWas)
}

/** A JSON value with object keys sorted, so two values equal in meaning are written the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

// ---- TOML ----

/** The command an MCP server entry runs. */
export type ServerCommand = { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }

/** What an MCP server entry names: a command to run, or the address of a server already running. */
export type ServerEntry = ServerCommand | { url: string }

/** A TOML basic string: JSON's escapes for a string are TOML's. */
const tomlString = (s: string) => JSON.stringify(s)

/** The tables for one MCP server, written as Codex writes them itself: the command, then its environment; or the one line of its address. */
export function tomlBlock(table: string, name: string, c: ServerEntry): string {
  if ('url' in c) return `[${table}.${name}]\nurl = ${tomlString(c.url)}\n`
  const env = Object.entries(c.env).map(([k, v]) => `${k} = ${tomlString(v)}\n`).join('')
  return `[${table}.${name}]\ncommand = ${tomlString(c.command)}\nargs = [${c.args.map(tomlString).join(', ')}]\n${env === '' ? '' : `\n[${table}.${name}.env]\n${env}`}`
}

const nameIn = (name: string) => new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}($|[^A-Za-z0-9_-])`, 'm')

export type TomlAdd = { outcome: 'added'; text: string; appended: string } | { outcome: 'present' } | { outcome: 'taken'; why: string }

/**
 * The text with `block` appended, after a blank line. Without a TOML parser, a file that already names
 * the server, or defines the servers' table inline (a table cannot be added to then), is left alone.
 */
export function appendToml(text: string | null, table: string, name: string, block: string): TomlAdd {
  const t = text ?? ''
  if (t.includes(block)) return { outcome: 'present' }
  if (nameIn(name).test(t)) return { outcome: 'taken', why: `已经写着 ${name}` }
  if (new RegExp(`^\\s*${table}\\s*=`, 'm').test(t)) return { outcome: 'taken', why: `${table} 写成了一行里的表，不能再往里加` }
  const appended = `${t === '' ? '' : t.endsWith('\n') ? '\n' : '\n\n'}${block}`
  return { outcome: 'added', text: `${t}${appended}`, appended }
}

/** The text without what was appended, matched exactly; null when it is not there exactly once. */
export function removeToml(text: string, appended: string): string | null {
  if (text.endsWith(appended)) return text.slice(0, text.length - appended.length)
  const at = text.indexOf(appended)
  if (at < 0 || text.indexOf(appended, at + 1) >= 0) return null
  return `${text.slice(0, at)}${text.slice(at + appended.length)}`
}

export function tomlState(text: string, name: string, appended: string): 'in-place' | 'changed' | 'gone' {
  if (text.includes(appended)) return 'in-place'
  return nameIn(name).test(text) ? 'changed' : 'gone'
}
