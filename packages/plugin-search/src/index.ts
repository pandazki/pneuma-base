import { readFileSync } from 'node:fs'
import { CONTRACT, pluginName, type Plugin } from '@pneuma-base/kernel'
import { searchCommands } from './commands.js'
import { findHits } from './search.js'
import { itemSection, STATUS_VIEW, statusView } from './views.js'

/**
 * 查找: find matches the content of the library's text files, ranked by bm25, and by meaning when
 * the owner sets an embedder. The index lives in the cache directory outside the library; the only
 * record in the library is the owner's choice of embedder.
 */
export const search: Plugin = {
  contract: CONTRACT,
  name: pluginName('search'),
  cognition: { title: '查找', text: readFileSync(new URL('../cognition/search-section.md', import.meta.url), 'utf8') },
  storage: [{ dir: 'embedder', kind: 'body' }],
  statements: [],
  ownerCommands: searchCommands,
  views: [{ id: STATUS_VIEW, title: '查找', icon: 'search', nav: true, filters: [] }],

  onFind: findHits,

  async onView(req, ctx) {
    if (req.view !== STATUS_VIEW) throw new Error(`查找插件没有这个视图：${req.view}`)
    return statusView(ctx)
  },

  onItemView: itemSection,
}
