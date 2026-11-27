// What plugins ask of storage, written down for the conformance check `bounded` when PNEUMA_BASE_TOOL_LOG
// names a file: one JSON line per call that lists, reads, probes or looks, with the place asked and how
// many entries came back. The file is the test harness's, outside every library; unset, nothing is written.
import { appendFileSync } from 'node:fs'
import { isFailure, type PlaceStore, type PluginStorage, type RecordPlace } from '@pneuma-base/sdk'

/** One call: the plugin, the area (`content`, `own`, or the record place it named), the tool, the place, how many entries it answered, and whether a look went deep. */
export type ToolCall = { plugin: string; area: string; tool: string; place?: string; entries?: number; reason?: string; deep?: true }

const write = (file: string, call: ToolCall) => appendFileSync(file, `${JSON.stringify(call)}\n`)

const answered = (answer: unknown, entries: (a: never) => number): Pick<ToolCall, 'entries' | 'reason'> =>
  isFailure(answer) ? { reason: answer.reason } : { entries: entries(answer as never) }

function placeStore(file: string, plugin: string, area: string, store: PlaceStore): PlaceStore {
  const log = (call: Omit<ToolCall, 'plugin' | 'area'>) => write(file, { plugin, area, ...call })
  return {
    ...store,
    async overview(place, opts) {
      const a = await store.overview(place, opts)
      log({ tool: 'overview', place, ...answered(a, (o: { entries: unknown[] }) => o.entries.length) })
      return a
    },
    async look(places, opts) {
      const a = await store.look(places, opts)
      log({ tool: 'look', entries: places.length, ...(opts?.deep ? { deep: true as const } : {}) })
      return a
    },
    async lookRows(table, field, opts) {
      const a = await store.lookRows(table, field, opts)
      log({ tool: 'lookRows', place: table, entries: a.compared, ...(opts?.deep ? { deep: true as const } : {}) })
      return a
    },
    async content(place, opts) {
      const a = await store.content(place, opts)
      log({ tool: 'content', place, ...answered(a, (c: { manifest?: { entries: unknown[] } }) => c.manifest?.entries.length ?? 1) })
      return a
    },
    async read(place, opts) {
      const a = await store.read(place, opts)
      log({ tool: 'read', place, ...answered(a, () => 1) })
      return a
    },
  }
}

function records(file: string, plugin: string, area: string, place: RecordPlace): RecordPlace {
  const log = (call: Omit<ToolCall, 'plugin' | 'area'>) => write(file, { plugin, area, ...call })
  return {
    ...place,
    async since(cursor, limit) {
      const a = await place.since(cursor, limit)
      log({ tool: 'since', entries: a?.facts.length ?? 0 })
      return a
    },
    async under(table, prefix, opts) {
      const a = await place.under(table, prefix, opts)
      log({ tool: 'under', place: table, entries: a.rows.length })
      return a
    },
    async where(table, field, value, opts) {
      const a = await place.where(table, field, value, opts)
      log({ tool: 'where', place: table, entries: a.rows.length })
      return a
    },
  } as RecordPlace
}

/** The plugin's storage tools, each listing written down when PNEUMA_BASE_TOOL_LOG names a file; as they are otherwise. */
export function loggedStorage(storage: PluginStorage, plugin: string, env: NodeJS.ProcessEnv = process.env): PluginStorage {
  const file = env.PNEUMA_BASE_TOOL_LOG
  if (!file) return storage
  return {
    ...storage,
    ...placeStore(file, plugin, 'content', storage),
    async probe(place, budget) {
      const a = await storage.probe(place, budget)
      write(file, { plugin, area: 'content', tool: 'probe', place, ...answered(a, (p: { files: number; dirs: number }) => p.files + p.dirs) })
      return a
    },
    own: placeStore(file, plugin, 'own', storage.own),
    records: records(file, plugin, 'own', storage.records),
    recordPlace(name) {
      const other = storage.recordPlace(name)
      return { own: placeStore(file, plugin, name, other.own), facts: other.facts }
    },
  }
}
