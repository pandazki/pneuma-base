import { readFileSync } from 'node:fs'
import { CONTRACT, PNEUMA_BASE_VERSION, pluginName, type Plugin } from '@pneuma-base/kernel'
import { syncCommands } from './commands.js'
import { envelope, writeFacts } from './facts.js'
import { foldAll, THINGS } from './rows.js'
import { carried } from './scope.js'
import { recordDeletions } from './sync.js'
import { checkSections, itemSection, STATUS_VIEW, statusView } from './views.js'

/** 同步: a library and a target in two-way sync, without merging contents and without losing any. design.md 五. */
export const sync: Plugin = {
  contract: CONTRACT,
  name: pluginName('sync'),
  version: PNEUMA_BASE_VERSION,
  title: '同步',
  summary: '和设好的目标双向同步',
  about: '和主人设的目标双向同步，只整份地复制，不合并内容，也不丢内容。',
  cognition: { title: '同步', text: readFileSync(new URL('../cognition/2-sync-section.md', import.meta.url), 'utf8') },
  storage: [{ dir: 'facts', kind: 'body' }],
  statements: [],
  ownerCommands: syncCommands,
  views: [STATUS_VIEW],

  // What it carries is what it heard registered: each put, archive and purge is one fact.
  async onPut(req, ctx) {
    if (req.kind === 'move') await writeFacts(ctx, [{ ...envelope(ctx), kind: 'moved', from: req.from, to: req.path }])
    else {
      const paths = (req.kind === 'register-files' ? req.files.map((f) => f.path) : [req.path]).filter(carried)
      if (paths.length > 0) await writeFacts(ctx, [{ ...envelope(ctx), kind: 'things', paths }])
    }
    return null
  },

  async onArchive(req, ctx) {
    if (req.moved) await writeFacts(ctx, [{ ...envelope(ctx), kind: 'moved', from: req.from, to: req.to }])
    return null
  },

  async onPurged(paths, ctx) {
    await writeFacts(ctx, [{ ...envelope(ctx), kind: 'gone', paths: [...paths] }])
  },

  /** A page of what was registered before it was added: the things it did not know are one fact, carried by the next sync. */
  async catchUp(things, ctx) {
    await foldAll(ctx)
    const known = new Set((await ctx.tools.storage.records.get(THINGS, things.map((t) => t.place))).rows.map((r) => r.key))
    const paths = things.map((t) => t.place).filter((p) => carried(p) && !known.has(p))
    if (paths.length > 0) await writeFacts(ctx, [{ ...envelope(ctx), kind: 'things', paths }])
  },

  onCheck: (_req, ctx) => checkSections(ctx),

  async onView(req, ctx) {
    if (req.view !== STATUS_VIEW.id) throw new Error(`sync has no view ${req.view}`)
    return statusView(ctx)
  },

  onItemView: (path, ctx) => itemSection(path, ctx),

  async observe(event, ctx) {
    if (event.face === 'owner' && event.destructive && event.result.outcome === 'done') await recordDeletions(ctx, event.command)
  },
}
