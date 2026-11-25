// The kernel's helpers on a plugin's context, `PluginContext.tools`, bound to the operation's library.
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix } from 'node:path'
import type { Context, LibraryPath, PluginTools } from '@pneuma-base/sdk'
import { fingerprintOfFile } from './files.js'
import { abs, archivedPath, isWithin, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { rankHits, searchTerms, SENTENCE_HITS } from './terms.js'
import { bundleFiles, bundleManifest, copyCounted, enclosingBundle, fingerprintOf, fingerprintOfManifest, kindAt, libraryFiles, thingAt } from './things.js'

/** The tools of the plugin whose own directory is `dir`, for the operation `ctx`. */
export function pluginTools(ctx: Context, dir: string): PluginTools {
  const root = ctx.library.root
  const at = (path: LibraryPath) => abs(root, path)
  const isBundle = async (path: LibraryPath) => (await kindAt(at(path))) === 'bundle'
  const own = parseLibraryPath(root, dir) as LibraryPath
  return {
    async resolve(input) {
      const path = parseLibraryPath(root, input)
      return path === null ? null : { path, region: regionOf(path), bundle: await enclosingBundle(root, path) }
    },
    regionOf,
    archivedPath,
    originalPath,
    abs: at,
    thing: (path) => thingAt(at(path)),
    things: () => libraryFiles(root),
    files: async (path) => ((await isBundle(path)) ? bundleFiles(at(path)) : null),
    async copyOut(path, to) {
      if (!isAbsolute(to)) throw new Error(`copyOut 要写到一个绝对路径：${to}`)
      const inLibrary = parseLibraryPath(root, to)
      if (inLibrary !== null && !isWithin(inLibrary, own)) throw new Error(`copyOut 不往库里写，除了插件自己名下的目录：${to}`)
      const kind = await kindAt(at(path))
      if (kind !== 'file' && kind !== 'bundle') return null
      await mkdir(dirname(to), { recursive: true })
      if (kind === 'bundle') {
        await copyCounted(at(path), to)
        return fingerprintOfManifest(await bundleManifest(to))
      }
      await mkdir(to)
      const copy = join(to, posix.basename(path))
      await copyFile(at(path), copy)
      return fingerprintOfFile(copy)
    },
    async fingerprint(path) {
      const kind = await kindAt(at(path))
      return kind === 'file' || kind === 'bundle' ? fingerprintOf(at(path)) : null
    },
    manifest: async (path) => ((await isBundle(path)) ? bundleManifest(at(path)) : null),
    fingerprintOfManifest,
    fingerprintOfFile,
    searchTerms,
    rankHits,
    sentenceHits: SENTENCE_HITS,
    async put(req) {
      // Imported when called: the agent face is built on the pipeline, which builds this context.
      const { agentFace } = await import('./agent.js')
      return agentFace.put(req, ctx)
    },
  }
}
