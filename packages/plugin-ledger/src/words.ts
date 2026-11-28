// The one table between the records and the faces. Facts and rows keep the words they were written
// with (ARCHITECTURE.md「记什么」): an origin is brought, made or adopted, a sentence's flavor doing,
// decided or note. The faces say imported, generated, unknown and task, decision, note. Facts written
// before the commands were renamed name the old commands; they read as the new ones.
import type { FeedAct } from '@pneuma-base/kernel'
import type { LedgerOrigin } from './facts.js'
import type { SaidRow } from './model.js'

type StoredOrigin = LedgerOrigin['kind']
export type OriginWord = 'imported' | 'generated' | 'unknown'

const ORIGIN_WORD: Record<StoredOrigin, OriginWord> = { brought: 'imported', made: 'generated', adopted: 'unknown' }

/** An origin's kind as the faces say it. */
export const originWord = (kind: StoredOrigin): OriginWord => ORIGIN_WORD[kind]

/** The stored kind a face's word names; null for a word that names none. */
export const storedOrigin = (word: string): StoredOrigin | null => (Object.keys(ORIGIN_WORD) as StoredOrigin[]).find((k) => ORIGIN_WORD[k] === word) ?? null

/** An origin with its kind as the faces say it, the rest as recorded. */
export const spokenOrigin = <O extends { kind: StoredOrigin }>(origin: O): Omit<O, 'kind'> & { kind: OriginWord } => ({ ...origin, kind: originWord(origin.kind) })

type Flavor = SaidRow['flavor']
export type SaidKind = 'task' | 'decision' | 'note'

const SAID_KIND: Record<Flavor, SaidKind> = { doing: 'task', decided: 'decision', note: 'note' }

/** The `say` kind that writes a flavor, which is also how the faces name it. */
export const saidKind = (flavor: Flavor): SaidKind => SAID_KIND[flavor]

/** The flavor a `say` kind writes; null for a kind that is no sentence. */
export const flavorOf = (kind: string): Flavor | null => (Object.keys(SAID_KIND) as Flavor[]).find((f) => SAID_KIND[f] === kind) ?? null

/** The act an older fact recorded under a word the feeds no longer draw: `ledger register` recorded `brought`. */
const ACT_NOW: Readonly<Record<string, FeedAct>> = { brought: 'imported', made: 'generated', doing: 'task' }
export const actNow = (act: string): FeedAct => ACT_NOW[act] ?? (act as FeedAct)

/**
 * The fixed names a command's act was done to, as facts recorded them before the names were the
 * terms they are now (`OwnerAct.name`), and the names now.
 */
const OBJECT_NOW: Readonly<Record<string, string>> = {
  留住的旧版: '历史副本',
  没登记的散文件: '未登记的文件',
  嵌入模型: 'embedding 配置',
}
export const objectNow = (name: string): string => OBJECT_NOW[name] ?? name

/** The commands as facts recorded them before they were renamed, and their names now. */
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
}

/** Flags renamed with their command, by the command's name now. */
const FLAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'plugin disable': { '--anyway': '--force' },
  'ledger register': { '--inside': '--recursive' },
}

/** A command's name as it is now. */
export const commandNow = (name: string): string => RENAMED[name] ?? name

/** A command line as recorded, with its command and its flags as they are now. */
export function lineNow(line: string): string {
  const old = Object.keys(RENAMED).find((name) => line === name || line.startsWith(`${name} `))
  const named = old === undefined ? line : `${RENAMED[old]}${line.slice(old.length)}`
  const flags = Object.entries(FLAGS).find(([name]) => named === name || named.startsWith(`${name} `))?.[1]
  return flags === undefined ? named : named.split(' ').map((word) => flags[word] ?? word).join(' ')
}
