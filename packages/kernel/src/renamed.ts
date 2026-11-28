// Commands as records and requests wrote them before they were renamed, and their names now. A fact
// keeps the line it was written with; a pending request runs under the name the command has now.
import type { OwnerArgs } from '@pneuma-base/sdk'

const RENAMED: Readonly<Record<string, string>> = {
  'grant issue': 'grant create',
  'plugin add': 'plugin enable',
  'plugin remove': 'plugin disable',
  'plugin catch-up': 'plugin backfill',
  'noise list': 'ignore list',
  'noise add': 'ignore add',
  'noise remove': 'ignore remove',
  'search embedder set': 'search embedding set',
  'search embedder clear': 'search embedding clear',
  'ledger held list': 'ledger copies list',
  'ledger held restore': 'ledger copies restore',
  'ledger held drop': 'ledger copies drop',
  'ledger leave': 'ledger dismiss',
  'deploy on': 'deploy publish',
  'deploy off': 'deploy unpublish',
}

/** Flags renamed with their command, by the command's name now, without the leading `--`. */
const FLAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'plugin disable': { anyway: 'force' },
  'ledger register': { inside: 'recursive' },
}

/** Flag values renamed, by the command's name now and the flag's name now. */
const VALUES: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  'deploy target set': { kind: { dir: 'folder', machine: 'self-hosted' } },
}

/** A command's name as it is now. */
export const commandNow = (name: string): string => RENAMED[name] ?? name

/** A request's arguments as the command takes them now, for a command named as it is now. */
export function argsNow(command: string, args: OwnerArgs): OwnerArgs {
  const flags = FLAGS[command] ?? {}
  const values = VALUES[command] ?? {}
  const entries = Object.entries(args.flags).map(([name, value]): [string, string[] | true] => {
    const now = flags[name] ?? name
    return [now, value === true || values[now] === undefined ? value : value.map((v) => values[now]?.[v] ?? v)]
  })
  return { positional: args.positional, flags: Object.fromEntries(entries) }
}

/** A command line as recorded, with its command, its flags and their values as they are now. */
export function lineNow(line: string): string {
  const old = Object.keys(RENAMED).find((name) => line === name || line.startsWith(`${name} `))
  const named = old === undefined ? line : `${RENAMED[old]}${line.slice(old.length)}`
  const command = [...Object.keys(FLAGS), ...Object.keys(VALUES)].find((name) => named === name || named.startsWith(`${name} `))
  if (command === undefined) return named
  const flags = FLAGS[command] ?? {}
  const values = VALUES[command] ?? {}
  const words = named.split(' ')
  return words
    .map((word, i) => {
      if (word.startsWith('--')) return `--${flags[word.slice(2)] ?? word.slice(2)}`
      const flag = words[i - 1]?.startsWith('--') ? (flags[words[i - 1]!.slice(2)] ?? words[i - 1]!.slice(2)) : undefined
      return flag === undefined ? word : (values[flag]?.[word] ?? word)
    })
    .join(' ')
}
