// The owner's choice of embedder: a record in the plugin's directory in the library. Each change is
// a new file with a unique name, written once; the latest by name is the one in force.
import { randomBytes } from 'node:crypto'
import { link, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Instant, PluginContext } from '@pneuma-base/kernel'
import type { EmbedderConfig } from './embed.js'

const DIR = 'embedder'

/** `embedder` null: the owner cleared it. */
type EmbedderRecord = { format: 1; at: Instant; embedder: EmbedderConfig | null }

/** Parses a record read from disk; anything else is not one. */
function parseRecord(text: string): EmbedderRecord | null {
  try {
    const raw = JSON.parse(text) as Partial<EmbedderRecord>
    const e = raw.embedder as Record<string, unknown> | null | undefined
    if (raw.format !== 1 || e === undefined) return null
    if (e === null || e.kind === 'hash') return raw as EmbedderRecord
    const valid = e.kind === 'http' && typeof e.url === 'string' && typeof e.model === 'string' && (e.keyEnv === null || typeof e.keyEnv === 'string')
    return valid ? (raw as EmbedderRecord) : null
  } catch {
    return null
  }
}

/** The embedder in force: the latest valid record's, or none. */
export async function currentEmbedder(ctx: PluginContext): Promise<EmbedderConfig | null> {
  const folder = join(ctx.dir, DIR)
  const names = (await readdir(folder).catch(() => [] as string[])).filter((n) => !n.startsWith('.') && n.endsWith('.json')).sort()
  for (const name of names.reverse()) {
    const record = parseRecord(await readFile(join(folder, name), 'utf8').catch(() => ''))
    if (record) return record.embedder
  }
  return null
}

/** Writes a new record under a unique name: a temporary name first, then linked, never replacing a file. */
export async function recordEmbedder(ctx: PluginContext, embedder: EmbedderConfig | null): Promise<void> {
  const folder = join(ctx.dir, DIR)
  await mkdir(folder, { recursive: true })
  const record: EmbedderRecord = { format: 1, at: ctx.now, embedder }
  for (;;) {
    const name = `${ctx.now.replace(/[^0-9]/g, '')}-${randomBytes(4).toString('hex')}.json`
    const tmp = join(folder, `.tmp-${name}`)
    await writeFile(tmp, `${JSON.stringify(record)}\n`, { flag: 'wx' })
    try {
      await link(tmp, join(folder, name))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await unlink(tmp)
    }
  }
}
