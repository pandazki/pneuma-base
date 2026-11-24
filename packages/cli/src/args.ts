/** How a known flag takes values. Flags this table does not know take what follows them up to the next flag. */
const FLAGS: Record<string, 'boolean' | 'value' | 'list'> = {
  library: 'value',
  as: 'value',
  session: 'value',
  json: 'boolean',
  to: 'value',
  brought: 'boolean',
  made: 'boolean',
  source: 'value',
  by: 'value',
  from: 'list',
  'from-outside': 'list',
  'include-archived': 'boolean',
  since: 'value',
  bare: 'boolean',
  agent: 'value',
  area: 'value',
  'read-only': 'boolean',
  dir: 'value',
}

/** Flags every command accepts. */
export const GLOBAL_FLAGS = ['library', 'as', 'session', 'json'] as const

export type Parsed = {
  grant: string | null // from a leading `@<name>`
  positional: string[]
  flags: Map<string, string[] | true>
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Parsed {
  const parsed: Parsed = { grant: null, positional: [], flags: new Map() }
  let i = 0
  if (argv[0]?.startsWith('@')) {
    parsed.grant = argv[0].slice(1)
    i = 1
  }
  const isFlag = (token: string | undefined) => token !== undefined && token.startsWith('--') && token.length > 2
  for (; i < argv.length; i++) {
    const token = argv[i] as string
    if (!isFlag(token)) {
      parsed.positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
    const inline = eq === -1 ? null : token.slice(eq + 1)
    const kind = FLAGS[name]
    const values: string[] = []
    if (inline !== null) values.push(inline)
    else if (kind === 'value') {
      const next = argv[i + 1]
      if (next === undefined || isFlag(next)) throw new UsageError(`--${name} 后面要跟一个值`)
      values.push(next)
      i++
    } else if (kind !== 'boolean') {
      while (argv[i + 1] !== undefined && !isFlag(argv[i + 1])) values.push(argv[++i] as string)
      if (kind === 'list' && values.length === 0) throw new UsageError(`--${name} 后面至少要跟一个值`)
    }
    if (kind === 'boolean' && inline !== null) throw new UsageError(`--${name} 不带值`)
    const before = parsed.flags.get(name)
    if (before !== undefined && kind !== 'list') throw new UsageError(`--${name} 只能写一次`)
    parsed.flags.set(name, values.length === 0 ? true : [...(Array.isArray(before) ? before : []), ...values])
  }
  return parsed
}

export function flagValue(parsed: Parsed, name: string): string | null {
  const v = parsed.flags.get(name)
  return Array.isArray(v) ? (v[0] ?? null) : null
}

export function flagList(parsed: Parsed, name: string): string[] {
  const v = parsed.flags.get(name)
  return Array.isArray(v) ? v : []
}

export function hasFlag(parsed: Parsed, name: string): boolean {
  return parsed.flags.has(name)
}
