// The owner's choice of embedder: a record in the plugin's own place in the library, reached through
// storage. Each change is a new file with a unique name, written once; the greatest name whose record
// is valid is the one in force. Files an earlier version wrote there load as they are.
import { randomBytes } from 'node:crypto'
import { isFailure, type Instant, type PluginContext } from '@pneuma-base/kernel'
import type { EmbedderConfig } from './embed.js'

const DIR = 'embedder'
const PAGE = 1000
/** A record is a line of JSON; a file longer than this is none. */
const RECORD_LIMIT = 64 * 1024

/** `embedder` null: the owner cleared it. */
type EmbedderRecord = { format: 1; at: Instant; embedder: EmbedderConfig | null }

/** Parses a record read from storage; anything else is not one. */
function parseRecord(text: string): EmbedderRecord | null {
  try {
    const raw = JSON.parse(text) as Partial<EmbedderRecord>
    const e = raw.embedder as Record<string, unknown> | null | undefined
    if (raw.format !== 1 || e === undefined) return null
    if (e === null || e.kind === 'hash') return raw as EmbedderRecord
    // keyEnv: a record written before the key moved to a secret; still valid, read only to say so.
    const valid = e.kind === 'http' && typeof e.url === 'string' && typeof e.model === 'string' && (e.keyEnv === undefined || e.keyEnv === null || typeof e.keyEnv === 'string')
    return valid ? (raw as EmbedderRecord) : null
  } catch {
    return null
  }
}

/** The names of the records, a page of the directory at a time. */
async function recordNames(ctx: PluginContext): Promise<string[]> {
  const own = ctx.tools.storage.own
  const names: string[] = []
  for (let after: string | undefined; ; ) {
    const page = await own.overview(DIR, { limit: PAGE, ...(after === undefined ? {} : { after }) })
    if (isFailure(page)) return names
    for (const e of page.entries) {
      const name = e.place.slice(e.place.lastIndexOf('/') + 1)
      if (e.kind === 'file' && !name.startsWith('.') && name.endsWith('.json')) names.push(name)
    }
    if (page.more === null) return names
    after = page.more.after
  }
}

/** The embedder in force: the latest valid record's, or none. */
export async function currentEmbedder(ctx: PluginContext): Promise<EmbedderConfig | null> {
  const own = ctx.tools.storage.own
  for (const name of (await recordNames(ctx)).sort().reverse()) {
    const read = await own.read(`${DIR}/${name}`, { length: RECORD_LIMIT })
    const record = isFailure(read) || read.data === null ? null : parseRecord(Buffer.from(read.data).toString('utf8'))
    if (record) return record.embedder
  }
  return null
}

/** Writes a new record under a unique name, expecting nothing there, so no record is ever replaced. */
export async function recordEmbedder(ctx: PluginContext, embedder: EmbedderConfig | null): Promise<void> {
  const record: EmbedderRecord = { format: 1, at: ctx.now, embedder }
  for (;;) {
    const name = `${ctx.now.replace(/[^0-9]/g, '')}-${randomBytes(4).toString('hex')}.json`
    const written = await ctx.tools.storage.own.write(`${DIR}/${name}`, { data: `${JSON.stringify(record)}\n` }, 'empty')
    if (!isFailure(written)) return
    if (written.reason !== 'refused') throw new Error(`嵌入器的记录没写成：${written.reason}`)
  }
}
