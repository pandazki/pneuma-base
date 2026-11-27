// A plugin that loads, then breaks each behavioural rule the loader cannot see: the conformance
// check must name every one of them.
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const seen = (ctx) => join(ctx.cacheDir, 'seen.txt')
/** Its own directory in the library, written with node:fs as no plugin may. */
const own = async (ctx) => {
  const dir = join(ctx.library.root, '.pneuma-base', 'rule-breaker')
  await mkdir(dir, { recursive: true })
  return dir
}

export default {
  contract: 2,
  name: 'rule-breaker',
  cognition: {
    title: '破规矩',
    text: '这个插件什么都不守。找东西可以加 --include-archived。\n\n```sh\npneuma-base @{{授权的名字}} find 一个词\npneuma-base @{{库}} say nonsense\n```\n',
  },
  storage: [{ dir: '.', kind: 'body' }],
  statements: ['nonsense'],
  // Drops its own records, which the owner may always do, and writes into the content besides, which no command may.
  ownerCommands: [
    {
      name: 'rule-breaker drop',
      summary: '丢掉记下的东西',
      params: {},
      destructive: true,
      ownerOnly: false,
      async run(_args, ctx) {
        await rm(join(await own(ctx), 'last.json'), { force: true })
        await writeFile(join(ctx.library.root, 'dropped.txt'), '主人命令写进了内容\n')
        return { outcome: 'done', text: '丢掉了。' }
      },
    },
  ],
  views: [{ id: 'rule-breaker.page', title: '破规矩', icon: 'bomb', nav: true, filters: [] }],
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),

  // Writes into the content, rewrites its own file, and keeps the only record of what it saw in its cache.
  async onPut(req, ctx) {
    await writeFile(join(ctx.library.root, 'stray.txt'), '写在了插件自己的目录外面\n')
    await writeFile(join(await own(ctx), 'last.json'), JSON.stringify({ path: req.path }))
    await mkdir(ctx.cacheDir, { recursive: true })
    await appendFile(seen(ctx), `${req.path}\n`)
    return null
  },

  // Throws on an empty library; answers from its cache alone.
  async onFind(_req, ctx) {
    const text = await readFile(seen(ctx), 'utf8')
    return text.trim().split('\n').map((path) => ({ path, title: '缓存里记着的', group: null, detail: null }))
  },

  // Writes when it is only looked at, and answers a malformed block, a page its ui directory lacks, a
  // page that never loads the frame script nor asks for its data, one that does both, a page that
  // does not say in words what it draws, and a button that calls a command nobody has.
  async onView(_req, ctx) {
    await writeFile(join(await own(ctx), `viewed-${Date.now()}.txt`), '')
    const custom = (entry) => ({ kind: 'custom', entry, height: 80, text: `${entry} 画的东西`, data: null, actions: {} })
    const nowhere = { label: '去哪', tone: 'default', confirm: null, inputs: [], call: { face: 'owner', command: 'rule-breaker nowhere', args: { positional: [], flags: {} } } }
    return {
      title: '破规矩',
      subtitle: null,
      blocks: [
        { kind: 'table', rows: [] },
        custom('missing.html'),
        custom('silent.html'),
        custom('framed.html'),
        { kind: 'custom', entry: 'framed.html', height: 80, data: null, actions: {} },
        { kind: 'actions', actions: [nowhere] },
      ],
    }
  },

  // Takes content with it when it goes.
  async onRemove(ctx) {
    await rm(join(ctx.library.root, 'conformance', 'moved.md'), { force: true })
  },
}
