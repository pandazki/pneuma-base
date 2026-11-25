// An append-only store for a plugin's own facts, in a directory it owns: one JSON object per line,
// one new file per write, never a file changed or replaced. Concurrent writers and a sync that
// brings another machine's files lose nothing, because no two writes share a file.
import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Instant, PluginContext } from '../types.js'

/** Who wrote a record, from the context's actor. */
export type RecordActor = { kind: 'agent' | 'owner' | 'plugin'; name: string }

/** What every record carries besides its body. Ids sort by time, then by writer, then by order within the writer. */
export type Envelope = { id: string; at: Instant; actor: RecordActor; session: string }

/** A line the reader left out, and why: the file's name, the line's number from 1. */
export type Skipped = { file: string; line: number; reason: string }

export interface RecordStore<B extends object> {
  /** A record of `body` by the context's actor and session, at the context's time. Nothing is written yet. */
  stamp(ctx: PluginContext, body: B): Envelope & B
  /** Writes the records as one new file. Nothing to write writes nothing. */
  append(records: readonly (Envelope & B)[]): Promise<void>
  /** Every record, in id order, and the lines that are not records, which stay as they are. A missing directory has none. */
  read(): Promise<{ records: (Envelope & B)[]; skipped: Skipped[] }>
}

const compact = (at: Instant) => at.replace(/[^0-9]/g, '')
/** This process, among the writers of a library: ids of records written in the same millisecond still differ. */
const writer = randomBytes(3).toString('hex')
let sequence = 0

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The store in `dir`. `parse` takes a line's object, envelope included, and answers its body, or a
 * reason it is not one of this plugin's records.
 */
export function recordStore<B extends object>(dir: string, parse: (raw: Record<string, unknown>) => B | string): RecordStore<B> {
  return {
    stamp(ctx, body) {
      const actor: RecordActor = ctx.actor.kind === 'owner' ? { kind: 'owner', name: 'owner' } : { kind: ctx.actor.kind, name: ctx.actor.name }
      return { id: `f_${compact(ctx.now)}_${writer}_${(sequence++).toString(36).padStart(4, '0')}`, at: ctx.now, actor, session: ctx.session.id, ...body }
    },

    /** A temporary name first, synced, then linked to a final name, which fails rather than replace a file that has it. */
    async append(records) {
      const first = records[0]
      if (!first) return
      await mkdir(dir, { recursive: true })
      const bytes = records.map((r) => `${JSON.stringify(r)}\n`).join('')
      for (;;) {
        const name = `${compact(first.at)}-${randomBytes(4).toString('hex')}.jsonl`
        const tmp = join(dir, `.tmp-${name}`)
        const handle = await open(tmp, 'wx')
        try {
          await handle.writeFile(bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        try {
          await link(tmp, join(dir, name))
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        } finally {
          await unlink(tmp)
        }
      }
    },

    async read() {
      const records: (Envelope & B)[] = []
      const skipped: Skipped[] = []
      const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[]
        throw error
      })
      for (const file of names.sort()) {
        if (file.startsWith('.') || !file.endsWith('.jsonl')) continue
        const lines = (await readFile(join(dir, file), 'utf8')).split('\n')
        for (const [i, line] of lines.entries()) {
          if (line.trim() === '') continue
          const skip = (reason: string) => skipped.push({ file, line: i + 1, reason })
          let raw: unknown
          try {
            raw = JSON.parse(line)
          } catch {
            skip('不是一行 JSON')
            continue
          }
          const actor = isObject(raw) ? raw.actor : null
          if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.at !== 'string' || typeof raw.session !== 'string' || !isObject(actor) || typeof actor.kind !== 'string' || typeof actor.name !== 'string') {
            skip('缺 id、at、actor 或 session')
            continue
          }
          const body = parse(raw)
          if (typeof body === 'string') skip(body)
          else records.push({ ...body, id: raw.id, at: raw.at as Instant, actor: actor as RecordActor, session: raw.session })
        }
      }
      records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return { records, skipped }
    },
  }
}
