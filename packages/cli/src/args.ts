// The command line, split in two steps: the flags every command takes, wherever they are written;
// then, once the words name a command, the rest by that command's own flags. How a flag takes
// values is the command's to say, so a boolean flag never takes the argument after it.

export type FlagKind = 'boolean' | 'value' | 'list'
/** `greedy`: a flag nobody declared takes what follows it up to the next flag. */
type Kind = FlagKind | 'greedy'

/** Flags every command takes, wherever they are written. */
const GLOBAL: Record<string, FlagKind> = { library: 'value', as: 'value', session: 'value', json: 'boolean' }
export const GLOBAL_FLAGS = Object.keys(GLOBAL)

/**
 * How flags take values for owner commands that declare no `params`, and for `say`, whose arguments
 * are the plugins'. A flag this table does not know takes what follows it up to the next flag.
 */
export const UNDECLARED_FLAGS: Readonly<Record<string, FlagKind>> = {
  to: 'value',
  brought: 'boolean',
  made: 'boolean',
  source: 'value',
  by: 'value',
  from: 'list',
  'from-outside': 'list',
  'include-archived': 'boolean',
  scene: 'value',
  origin: 'value',
  since: 'value',
  bare: 'boolean',
  agent: 'value',
  area: 'value',
  'read-only': 'boolean',
  anyway: 'boolean',
  dir: 'value',
  port: 'value',
  'no-open': 'boolean',
}

export type Flags = Map<string, string[] | true>

/** The command line with the global flags taken out: `rest` is everything else, in order. */
export type Line = { grant: string | null; global: Flags; rest: string[] }

export type Parsed = {
  grant: string | null // from a leading `@<name>`
  positional: string[]
  flags: Flags // the global ones and the command's own
}

export class UsageError extends Error {}

const isFlag = (token: string | undefined): token is string => token !== undefined && token.startsWith('--') && token.length > 2

/**
 * Reads the flag at `tokens[i]` into `flags` by its kind; answers the index of its last token.
 * `kindOf` answers undefined for a flag the caller leaves where it is: then nothing is read.
 */
function readFlag(tokens: readonly string[], i: number, kindOf: (name: string) => Kind | undefined, flags: Flags): number | null {
  const token = tokens[i] as string
  const eq = token.indexOf('=')
  const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
  const kind = kindOf(name)
  if (kind === undefined) return null
  const values: string[] = eq === -1 ? [] : [token.slice(eq + 1)]
  if (kind === 'boolean' && values.length > 0) throw new UsageError(`--${name} 不带值`)
  if (kind === 'value' && values.length === 0) {
    const next = tokens[i + 1]
    if (next === undefined || isFlag(next)) throw new UsageError(`--${name} 后面要跟一个值`)
    values.push(next)
    i++
  } else if ((kind === 'list' || kind === 'greedy') && values.length === 0) {
    while (tokens[i + 1] !== undefined && !isFlag(tokens[i + 1])) values.push(tokens[++i] as string)
    if (kind === 'list' && values.length === 0) throw new UsageError(`--${name} 后面至少要跟一个值`)
  }
  const before = flags.get(name)
  if (before !== undefined && kind !== 'list') throw new UsageError(`--${name} 只能写一次`)
  flags.set(name, values.length === 0 ? true : [...(Array.isArray(before) ? before : []), ...values])
  return i
}

/** Takes the leading `@<grant>` and the global flags out of the command line, wherever they are. */
export function splitLine(argv: readonly string[]): Line {
  const line: Line = { grant: null, global: new Map(), rest: [] }
  let i = 0
  if (argv[0]?.startsWith('@')) {
    line.grant = argv[0].slice(1)
    i = 1
  }
  for (; i < argv.length; i++) {
    const read = isFlag(argv[i]) ? readFlag(argv, i, (name) => GLOBAL[name], line.global) : null
    if (read === null) line.rest.push(argv[i] as string)
    else i = read
  }
  return line
}

/** The words that may name a command: the tokens before the first flag. */
export function leadingWords(line: Line): string[] {
  const end = line.rest.findIndex(isFlag)
  return end === -1 ? line.rest : line.rest.slice(0, end)
}

/**
 * The arguments after a command's `words`, read by the command's flags. `kinds` gives each flag the
 * command declares; a flag it does not declare is read as `undeclared` says: a switch the command
 * then refuses, a usage error, or, for a command that declares nothing, as the undeclared table says.
 */
export function parseCommand(line: Line, words: number, kinds: Readonly<Record<string, FlagKind>>, undeclared: 'switch' | 'error' | 'table', command: string): Parsed {
  const flags: Flags = new Map(line.global)
  const positional: string[] = []
  const tokens = line.rest.slice(words)
  const kindOf = (name: string): Kind => {
    const declared = Object.hasOwn(kinds, name) ? kinds[name] : undefined
    if (declared !== undefined) return declared
    if (undeclared === 'error') throw new UsageError(`${command} 不认识 --${name}`)
    if (undeclared === 'switch') return 'boolean'
    return UNDECLARED_FLAGS[name] ?? 'greedy'
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (!isFlag(token)) positional.push(token)
    else i = readFlag(tokens, i, kindOf, flags) as number
  }
  return { grant: line.grant, positional, flags }
}

export function flagValue(parsed: { flags: Flags }, name: string): string | null {
  const v = parsed.flags.get(name)
  return Array.isArray(v) ? (v[0] ?? null) : null
}

export function flagList(parsed: Parsed, name: string): string[] {
  const v = parsed.flags.get(name)
  return Array.isArray(v) ? v : []
}

export function hasFlag(parsed: { flags: Flags }, name: string): boolean {
  return parsed.flags.has(name)
}

/** The flags a command gave besides the global ones. */
export function ownFlags(parsed: Parsed): [string, string[] | true][] {
  return [...parsed.flags].filter(([name]) => !GLOBAL_FLAGS.includes(name))
}
