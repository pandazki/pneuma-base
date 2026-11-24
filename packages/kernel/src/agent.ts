import { posix } from 'node:path'
import { archive } from './archive.js'
import { fingerprintOfFile, listFiles, regularFile } from './files.js'
import { ARCHIVE_DIR, DESCRIPTION_FILE, KERNEL_DIR, abs, archivedPath, originalPath, parseLibraryPath, regionOf } from './paths.js'
import { eachPlugin, messageOf, performVerb, pluginContext, type Collected } from './pipeline.js'
import { put } from './put.js'
import type {
  AgentFace,
  CheckRequest,
  CheckResult,
  Context,
  FileFacts,
  FindRequest,
  FindResult,
  Hit,
  InspectRequest,
  InspectResult,
  LibraryPath,
  PluginSection,
  SayRequest,
  SayResult,
  Section,
} from './types.js'

export const NO_HEARER = '这个库没配能记下这句话的插件'

/** The six verbs. Each ends at the pipeline's single exit, which sends its event (K5). */
export const agentFace: AgentFace = {
  put: (req, ctx) => performVerb('put', req, ctx, () => put(req, ctx)),
  find: (req, ctx) => performVerb('find', req, ctx, () => find(req, ctx)),
  inspect: (req, ctx) => performVerb('inspect', req, ctx, () => inspect(req, ctx)),
  say: (req, ctx) => performVerb('say', req, ctx, () => say(req, ctx)),
  check: (req, ctx) => performVerb('check', req, ctx, () => check(req, ctx)),
  archive: (req, ctx) => performVerb('archive', req, ctx, () => archive(req, ctx)),
}

/** Splits find text into terms: on white space and common punctuation, compared case-insensitively. */
export function termsOf(text: string | null): string[] {
  if (text === null) return []
  return text
    .toLowerCase()
    .split(/[\s,.;:!?，。、；：！？"'“”‘’「」『』()（）]+/u)
    .filter((t) => t !== '')
}

async function find(req: FindRequest, ctx: Context): Promise<FindResult> {
  const skip = new Set([KERNEL_DIR, DESCRIPTION_FILE, ...(req.includeArchived ? [] : [ARCHIVE_DIR])])
  const terms = termsOf(req.text)
  const hits: Hit[] = []
  for (const file of await listFiles(ctx.library.root, skip)) {
    const path = file as LibraryPath
    const archived = regionOf(path) === 'archive'
    const name = (archived ? originalPath(path) ?? path : path).toLowerCase()
    if (terms.length > 0 && !terms.some((t) => name.includes(t))) continue
    hits.push({ path, title: posix.basename(path), by: 'kernel', detail: archived ? '已归档' : null })
  }
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onFind?.(req, pctx))
  return { hits: [...hits, ...heard.values.flatMap(({ plugin, value }) => value.map((h) => ({ ...h, by: plugin })))], problems: heard.problems }
}

async function inspect(req: InspectRequest, ctx: Context): Promise<InspectResult> {
  const file = await fileFacts(ctx.library.root, req.target)
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onInspect?.(req, pctx))
  return { file, sections: stamp(heard), problems: heard.problems }
}

/** The file a target names: the main file, else its archived copy. `_archive/…` names the archived copy. */
async function fileFacts(root: string, target: string): Promise<FileFacts | null> {
  const path = parseLibraryPath(root, target)
  if (path === null || regionOf(path) === 'kernel') return null
  const candidates = regionOf(path) === 'archive' ? [path] : [path, archivedPath(path)]
  for (const candidate of candidates) {
    const facts = await regularFile(abs(root, candidate))
    if (facts) {
      return { path: candidate, ...facts, fingerprint: await fingerprintOfFile(abs(root, candidate)), archived: regionOf(candidate) === 'archive' }
    }
  }
  return null
}

async function say(req: SayRequest, ctx: Context): Promise<SayResult> {
  const hearer = ctx.library.plugins.find((p) => p.onSay && p.statements.includes(req.kind))
  if (!hearer?.onSay) return { outcome: 'not-heard', reason: 'no-plugin-for-kind', note: NO_HEARER, problems: [] }
  try {
    const answer = await hearer.onSay(req, pluginContext(ctx, hearer.name))
    if (answer.outcome === 'heard') return { outcome: 'heard', by: hearer.name, note: answer.note, problems: [] }
    return { ...answer, problems: [] }
  } catch (error) {
    return {
      outcome: 'not-heard',
      reason: 'plugin-failed',
      note: `插件 ${hearer.name} 没能记下这句话`,
      problems: [{ plugin: hearer.name, message: messageOf(error) }],
    }
  }
}

async function check(req: CheckRequest, ctx: Context): Promise<CheckResult> {
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onCheck?.(req, pctx))
  return { sections: stamp(heard), problems: heard.problems }
}

function stamp(heard: Collected<PluginSection[]>): Section[] {
  return heard.values.flatMap(({ plugin, value }) => value.map((s) => ({ ...s, plugin })))
}
