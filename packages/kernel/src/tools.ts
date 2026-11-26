// The kernel's helpers on a plugin's context, `PluginContext.tools`, bound to the operation's library:
// storage in its own words, at the places a plugin's records point, through the one door.
import { type Context, type LibraryPath, type Pass, type Place, type PlaceStore, type PluginName, type PluginStorage, type PluginTools, type WriteSource } from '@pneuma-base/sdk'
import { changesSince } from './changes.js'
import { v1Tools } from './contract-v1.js'
import { archivedPath, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { storageOf, type Area, type Source, type Storage, type StorageProgress } from './storage.js'
import { rankHits, searchTerms, SENTENCE_HITS } from './terms.js'
import { enclosingBundle, markBundle, THING_FILES, THING_RULE, whatIs } from './things.js'

/** Hears storage's progress on one read or write of the place, for the operation's named whole pass. */
export type StorageHeard = (place: Place, verb: '读' | '写', progress: StorageProgress) => void

/**
 * The channel of a named whole pass as a plugin gets it: its own reports go through as they are, and
 * storage's progress on a read or write under way joins the last of them, so the pass keeps its count
 * and its line says which directory is being read and how far.
 */
export function relayedPass(pass: Pass): { pass: Pass; heard: StorageHeard } {
  let last = { done: 0, total: null as number | null, atLeast: false, text: '' }
  return {
    pass: {
      report(p) {
        last = { done: p.done, total: p.total, atLeast: p.atLeast === true, text: p.text }
        pass.report(p)
      },
      stopped: () => pass.stopped(),
    },
    heard(place, verb, p) {
      if (p.total_files === null || p.total_files < 2) return
      const step = `正在${verb} ${place}：${p.files} / ${p.total_files} 个文件`
      pass.report({ done: last.done, total: last.total, ...(last.atLeast ? { atLeast: true } : {}), text: last.text === '' ? step : `${last.text} · ${step}` })
    },
  }
}

/** One area as a plugin sees it: a directory's content always counted by the rule things follow. */
function placeStore(area: Area, own: PluginName, heard?: StorageHeard): PlaceStore {
  const source = (from: WriteSource): Source => ('place' in from ? { place: from.place, ...(from.own ? { records: own } : {}) } : from)
  const progress = (place: Place, verb: '读' | '写') => (heard === undefined ? {} : { progress: (p: StorageProgress) => heard(place, verb, p) })
  return {
    glance: (places) => area.glance(places),
    overview: (place, opts) => area.overview(place, opts),
    look: (places) => area.look(places),
    lookRows: (table, field, opts) => area.lookRows({ place: own, table, field }, opts),
    content: (place, opts = {}) => area.content(place, { rule: THING_RULE, limit: opts.limit ?? THING_FILES, ...(opts.manifest === undefined ? {} : { manifest: opts.manifest }), ...progress(place, '读') }),
    read: (place, opts) => area.read(place, opts),
    write: (place, from, expect, opts = {}) =>
      area.write(place, source(from), expect, { rule: THING_RULE, limit: opts.limit ?? THING_FILES, ...(opts.hold === undefined ? {} : { hold: opts.hold }), ...progress(place, '写') }),
    move: (from, to, expect, opts) => area.move(from, to, expect, opts),
    remove: (place, expect, opts) => area.remove(place, expect, opts),
  }
}

/** What a plugin gets of storage: the content, its own record place and its content, holds, and change learned from the kernel's cursor. */
export function pluginStorage(store: Storage, name: PluginName, heard?: StorageHeard): PluginStorage {
  return {
    ...placeStore(store, name, heard),
    probe: store.probe,
    async noise() {
      const { names, paths } = await store.noise.list()
      return { names, paths }
    },
    hold: (places, ttl) => store.hold(places, ttl),
    release: (hold) => store.release(hold),
    changed: (mark) => changesSince(store, mark),
    own: placeStore(store.own(name), name),
    records: store.records(name),
  }
}

/** The tools of the plugin `name` for the operation `ctx`; `heard` carries storage's progress to the operation's pass. */
export function pluginTools(ctx: Context, name: PluginName, heard?: StorageHeard): PluginTools {
  const root = ctx.library.root
  const store = storageOf(root)
  return {
    async resolve(input) {
      const path = parseLibraryPath(root, input)
      return path === null ? null : { path, region: regionOf(path), bundle: regionOf(path) === 'kernel' ? null : await enclosingBundle(store, path) }
    },
    regionOf,
    archivedPath,
    originalPath,
    what: async (paths) => (await whatIs(store, paths as LibraryPath[])).map(({ path, kind, entry }) => ({ path, kind, entry })),
    markBundle: (dir, opts = {}) => markBundle(store, dir, opts.hold),
    searchTerms,
    rankHits,
    sentenceHits: SENTENCE_HITS,
    async put(req) {
      // Imported when called: the agent face is built on the pipeline, which builds this context.
      const { agentFace } = await import('./agent.js')
      return agentFace.put(req, ctx)
    },
    storage: pluginStorage(store, name, heard),
    ...v1Tools(store, root, name),
  }
}
