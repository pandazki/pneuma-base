// The kernel's helpers on a plugin's context, `PluginContext.tools`, bound to the operation's library:
// storage in its own words, at the places a plugin's records point, through the one door.
import { type Context, type LibraryPath, type PlaceStore, type PluginName, type PluginStorage, type PluginTools, type WriteSource } from '@pneuma-base/sdk'
import { changesSince } from './changes.js'
import { archivedPath, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { PLACE as REQUESTS } from './requests.js'
import { storageOf, type Area, type Source, type Storage } from './storage.js'
import { loggedStorage } from './tool-log.js'
import { rankHits, searchTerms, SENTENCE_HITS } from './terms.js'
import { enclosingBundle, markBundle, THING_FILES, THING_RULE, whatIs } from './things.js'

/** One area as a plugin sees it: a directory's content always counted by the rule things follow. */
function placeStore(area: Area, own: PluginName): PlaceStore {
  const source = (from: WriteSource): Source => ('place' in from ? { place: from.place, ...(from.own ? { records: own } : {}) } : from)
  return {
    glance: (places) => area.glance(places),
    overview: (place, opts) => area.overview(place, opts),
    look: (places) => area.look(places),
    lookRows: (table, field, opts) => area.lookRows({ place: own, table, field }, opts),
    content: (place, opts = {}) => area.content(place, { rule: THING_RULE, limit: opts.limit ?? THING_FILES, ...(opts.manifest === undefined ? {} : { manifest: opts.manifest }) }),
    read: (place, opts) => area.read(place, opts),
    write: (place, from, expect, opts = {}) => area.write(place, source(from), expect, { rule: THING_RULE, limit: opts.limit ?? THING_FILES, ...(opts.hold === undefined ? {} : { hold: opts.hold }) }),
    move: (from, to, expect, opts) => area.move(from, to, expect, opts),
    remove: (place, expect, opts) => area.remove(place, expect, opts),
  }
}

/**
 * What a plugin gets of storage: the content, its own record place and its content, holds, change
 * learned from the kernel's cursor, and the library's other record places by name.
 */
export function pluginStorage(store: Storage, name: PluginName, places: readonly string[]): PluginStorage {
  return {
    ...placeStore(store, name),
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
    recordPlaces: async () => [REQUESTS, ...places],
    recordPlace(place) {
      const { append, since } = store.records(place)
      return { own: placeStore(store.own(place), name), facts: { append, since } }
    },
  }
}

/** The tools of the plugin `name` for the operation `ctx`. */
export function pluginTools(ctx: Context, name: PluginName): PluginTools {
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
    storage: loggedStorage(pluginStorage(store, name, ctx.library.config.plugins), name),
  }
}
