import { readFileSync } from 'node:fs'
import { pluginName, type Plugin } from '@pneuma-base/kernel'
import { syncCommands } from './commands.js'
import { SCRATCH } from './facts.js'
import { recordDeletions } from './sync.js'
import { checkSections, itemSection, STATUS_VIEW, statusView } from './views.js'

/** 同步: a library and a target in two-way sync, without merging contents and without losing any. design.md 五. */
export const sync: Plugin = {
  name: pluginName('sync'),
  cognition: { title: '同步', text: readFileSync(new URL('../cognition/2-sync-section.md', import.meta.url), 'utf8') },
  storage: [
    { dir: 'facts', kind: 'body' },
    { dir: SCRATCH, kind: 'cache' },
  ],
  statements: [],
  ownerCommands: syncCommands,
  views: [STATUS_VIEW],

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
