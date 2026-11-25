// A plugin that loads, then breaks each behavioural rule the loader cannot see: the conformance
// check must name every one of them.
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const seen = (ctx) => join(ctx.cacheDir, 'seen.txt')

export default {
  contract: 1,
  name: 'rule-breaker',
  cognition: {
    title: '破规矩',
    text: '这个插件什么都不守。找东西可以加 --include-archived。\n\n```sh\npneuma-base @{{授权的名字}} find 一个词\npneuma-base @{{库}} say nonsense\n```\n',
  },
  storage: [{ dir: '.', kind: 'body' }],
  statements: ['nonsense'],
  ownerCommands: [],
  views: [{ id: 'rule-breaker.page', title: '破规矩', icon: 'bomb', nav: true, filters: [] }],
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),

  // Writes into the content, rewrites its own file, and keeps the only record of what it saw in its cache.
  async onPut(req, ctx) {
    await writeFile(join(ctx.library.root, 'stray.txt'), '写在了插件自己的目录外面\n')
    await writeFile(join(ctx.dir, 'last.json'), JSON.stringify({ path: req.path }))
    await mkdir(ctx.cacheDir, { recursive: true })
    await appendFile(seen(ctx), `${req.path}\n`)
    return null
  },

  // Throws on an empty library; answers from its cache alone.
  async onFind(_req, ctx) {
    const text = await readFile(seen(ctx), 'utf8')
    return text.trim().split('\n').map((path) => ({ path, title: '缓存里记着的', group: null, detail: null }))
  },

  // Writes when it is only looked at, and answers a malformed block and a page its ui directory lacks.
  async onView(_req, ctx) {
    await writeFile(join(ctx.dir, `viewed-${Date.now()}.txt`), '')
    return {
      title: '破规矩',
      subtitle: null,
      blocks: [{ kind: 'table', rows: [] }, { kind: 'custom', entry: 'missing.html', height: 80, data: null, actions: {} }],
    }
  },

  // Takes content with it when it goes.
  async onRemove(ctx) {
    await rm(join(ctx.library.root, 'conformance', 'moved.md'), { force: true })
  },
}
