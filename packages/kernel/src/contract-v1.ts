// Contract version 1, kept for the plugins written against it until they move (tmp/run-7 plan, step 4);
// remove this file with them. Everything here is written on storage's operations through the door:
// it reads the library no other way. What version 1 promised and version 2 dropped (a fingerprint on
// every put, the files of a bundle, every thing of the library) is computed here, at the cost version 1
// always had, and only for a plugin that declares contract 1.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path'
import { isDescribed, isFailure, type AcceptedPut, type BundleFile, type Fingerprint, type Instant, type LibraryPath, type ManifestEntry, type Place, type Plugin, type PluginTools, type Thing } from '@pneuma-base/sdk'
import { DESCRIPTION_FILE, KERNEL_DIR, parseLibraryPath } from './paths.js'
import type { Storage } from './storage.js'
import { BUNDLE_MARKER, fingerprintOf, fingerprintOfManifest, whatIsOne } from './things.js'

const isV1 = (plugin: Plugin) => plugin.contract === 1

/**
 * The puts a plugin's `onPut` takes for one accepted put: the put itself for contract 2; for contract 1,
 * one `register` per file of a `register-files`, each with a fingerprint, the content read for it when
 * the put read none, and `previous` a fingerprint.
 */
export async function putsFor(plugin: Plugin, put: AcceptedPut, store: Storage): Promise<AcceptedPut[]> {
  if (!isV1(plugin)) return [put]
  const one = async (p: Exclude<AcceptedPut, { kind: 'register-files' }>) => {
    const fingerprint = p.fingerprint ?? (await fingerprintOf(store, p.path))?.fingerprint ?? null
    return { ...p, fingerprint, ...(p.kind === 'place' ? { previous: p.previous?.fingerprint ?? null } : {}) } as unknown as AcceptedPut
  }
  if (put.kind !== 'register-files') return [await one(put)]
  const { files, origin, note, observed } = put
  return Promise.all(files.map((f) => one({ kind: 'register', path: f.path, now: f.now, fingerprint: null, origin, note, ...(observed ? { observed } : {}) })))
}

/**
 * The fingerprint of the content a place replaces, as contract 1 promised it to `revise` and to `onPut`
 * (`previous`): read now, before the write, only when a contract-1 plugin is installed that hears either.
 */
export async function replacedFor(plugins: readonly Plugin[], known: Fingerprint | null, store: Storage, path: LibraryPath): Promise<Fingerprint | null> {
  if (known !== null || !plugins.some((p) => isV1(p) && (p.revise || p.onPut))) return known
  return (await fingerprintOf(store, path))?.fingerprint ?? null
}

const nameOf = (place: Place) => place.slice(place.lastIndexOf('/') + 1)

/** Every file under `dir`, one level of one directory at a time through storage, as `[path relative to dir, size, modified]`; bundles not entered when `stopAtBundles`. */
async function walk(store: Storage, dir: Place, visit: (entry: { place: Place; kind: 'file' | 'bundle'; size: number; modified: string }) => void, stopAtBundles: boolean): Promise<void> {
  const queue: Place[] = [dir]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let after: string | undefined
    for (;;) {
      const page = await store.overview(next, { limit: 1000, ...(after === undefined ? {} : { after }) })
      if (isFailure(page)) break
      const dirs = page.entries.filter((e) => e.kind === 'dir')
      const marked = stopAtBundles && dirs.length > 0 ? await store.glance(dirs.map((d) => `${d.place}/${BUNDLE_MARKER}`)) : []
      for (const e of page.entries) {
        if (next === '' && (e.place === KERNEL_DIR || e.place === DESCRIPTION_FILE)) continue
        if (e.kind === 'file') {
          if (nameOf(e.place) !== BUNDLE_MARKER || !stopAtBundles) visit({ place: e.place, kind: 'file', size: e.size ?? 0, modified: e.modified ?? '' })
        } else if (e.kind === 'dir') {
          const at = dirs.indexOf(e)
          const m = marked[at]
          if (stopAtBundles && m !== undefined && isDescribed(m) && m.kind === 'file') visit({ place: e.place, kind: 'bundle', size: 0, modified: e.modified ?? '' })
          else queue.push(e.place)
        }
      }
      if (page.more === null) break
      after = page.more.after
    }
  }
}

const byBytes = (a: { path: string }, b: { path: string }) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))

/** A bundle's files as contract 1 counted them: every file under it but the marker and noise. */
async function bundleFiles(store: Storage, path: LibraryPath): Promise<BundleFile[]> {
  const out: BundleFile[] = []
  await walk(store, path, (e) => {
    if (e.kind === 'file' && nameOf(e.place) !== BUNDLE_MARKER) out.push({ path: e.place.slice(path.length + 1), size: e.size, modifiedAt: e.modified as Instant })
  }, false)
  return out.sort(byBytes)
}

async function hashLocal(path: string): Promise<Fingerprint> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex') as Fingerprint
}

/** The version 1 tools, on storage: what a contract-1 plugin's context still carries. */
export function v1Tools(store: Storage, root: string, own: string): Pick<PluginTools, 'abs' | 'thing' | 'things' | 'files' | 'copyOut' | 'fingerprint' | 'manifest' | 'fingerprintOfManifest' | 'fingerprintOfFile' | 'putting'> {
  const ownDir = join(root, KERNEL_DIR, own)
  /** Where an absolute path lies: in the content, in this plugin's own record place, or outside the library. */
  const placeOf = (absolute: string): { area: 'content' | 'own'; place: Place } | null => {
    const rel = relative(ownDir, absolute)
    if (!isAbsolute(rel) && rel.split(sep)[0] !== '..' && rel !== '') return { area: 'own', place: rel.split(sep).join('/') }
    const path = parseLibraryPath(root, absolute)
    if (path === null) return null
    if (path.split('/')[0] === KERNEL_DIR) throw new Error(`插件只读自己名下的记录：${absolute}`)
    return { area: 'content', place: path }
  }
  const files = async (path: LibraryPath) => ((await whatIsOne(store, path)).kind === 'bundle' ? bundleFiles(store, path) : null)
  return {
    abs: (path) => join(root, ...path.split('/')),
    async thing(path): Promise<Thing | null> {
      const at = await whatIsOne(store, path)
      if (at.kind === 'file') return { kind: 'file', size: at.entry?.size ?? 0, files: 1, modifiedAt: (at.entry?.modified ?? '') as Instant }
      if (at.kind !== 'bundle') return null
      const inner = await bundleFiles(store, path)
      const latest = inner.reduce((m, f) => (f.modifiedAt > m ? f.modifiedAt : m), '')
      return { kind: 'bundle', size: inner.reduce((n, f) => n + f.size, 0), files: inner.length, modifiedAt: (latest || at.entry?.modified || '') as Instant }
    },
    async things() {
      const out: LibraryPath[] = []
      await walk(store, '', (e) => out.push(e.place as LibraryPath), true)
      return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    },
    files,
    async copyOut(path, to) {
      if (!isAbsolute(to)) throw new Error(`copyOut 要写到一个绝对路径：${to}`)
      const where = (() => {
        try {
          return placeOf(to)
        } catch {
          return { area: 'content' as const, place: '' }
        }
      })()
      if (where?.area === 'content') throw new Error(`copyOut 不往库里写，除了插件自己名下的目录：${to}`)
      const at = await whatIsOne(store, path)
      if (at.kind !== 'file' && at.kind !== 'bundle') return null
      if (where?.area === 'own') {
        const target = at.kind === 'bundle' ? where.place : `${where.place}/${posix.basename(path)}`
        const written = await store.own(own).write(target, { place: path }, 'empty', at.kind === 'bundle' ? { rule: { noise: [BUNDLE_MARKER] }, limit: 10_000_000 } : {})
        if (isFailure(written)) throw new Error(`没能复制 ${path}（${written.reason}）`)
        return written.fingerprint
      }
      if (at.kind === 'file') {
        await mkdir(to, { recursive: true })
        const copy = join(to, posix.basename(path))
        const read = await store.read(path, { to: copy })
        if (isFailure(read)) throw new Error(`没能复制 ${path}（${read.reason}）`)
        return hashLocal(copy)
      }
      const entries: ManifestEntry[] = []
      await mkdir(to, { recursive: true })
      for (const f of await bundleFiles(store, path)) {
        const copy = join(to, ...f.path.split('/'))
        await mkdir(dirname(copy), { recursive: true })
        const read = await store.read(`${path}/${f.path}`, { to: copy })
        if (isFailure(read)) throw new Error(`没能复制 ${path}/${f.path}（${read.reason}）`)
        entries.push({ path: f.path, fingerprint: await hashLocal(copy), size: f.size })
      }
      return fingerprintOfManifest(entries)
    },
    fingerprint: async (path) => (await fingerprintOf(store, path))?.fingerprint ?? null,
    async manifest(path) {
      const inner = await files(path)
      if (inner === null) return null
      const out: ManifestEntry[] = []
      for (const f of inner) {
        const answer = await store.content(`${path}/${f.path}`)
        if (!isFailure(answer)) out.push({ path: f.path, fingerprint: answer.fingerprint, size: f.size })
      }
      return out
    },
    fingerprintOfManifest,
    async fingerprintOfFile(absolute) {
      const where = placeOf(absolute)
      if (where === null) return hashLocal(absolute)
      const answer = where.area === 'own' ? await store.own(own).content(where.place) : await store.content(where.place)
      if (isFailure(answer)) throw new Error(`没能读 ${absolute}（${answer.reason}）`)
      return answer.fingerprint
    },
    putting: async () => [],
  }
}

const made = new Set<string>()

/**
 * Contract 1 promised that a plugin's own directory is there whenever a hook runs: made here, once a
 * process, for each installed plugin of contract 1, through storage (a write of an empty file, then its
 * removal, leave the directory and nothing in it).
 */
export async function makeV1Dirs(store: Storage, root: string, plugins: readonly Plugin[]): Promise<void> {
  for (const plugin of plugins) {
    const key = `${root}\0${plugin.name}`
    if (!isV1(plugin) || made.has(key)) continue
    made.add(key)
    const own = store.own(plugin.name)
    const place = '.contract-1'
    const written = await own.write(place, { data: '' }, 'empty')
    const [there] = isFailure(written) ? await own.glance([place]) : [written.entry]
    if (there !== undefined && isDescribed(there) && there.token !== undefined) await own.remove(place, there.token)
  }
}
