// Test-only plugins. Run by Node's type stripping, so only erasable TypeScript here.
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginName, type Action, type Block, type Event, type Instant, type LibraryPath, type OwnerCommand, type Plugin, type PluginContext } from '@pneuma-base/kernel'

/** One line per event it observes, in `.pneuma-base/recorder/events.jsonl`. */
export function describeEvent(event: Event): string {
  const what = event.face === 'agent' ? event.verb : event.command
  return JSON.stringify({ face: event.face, what, outcome: 'outcome' in event.result ? event.result.outcome : undefined })
}

const clear: OwnerCommand = {
  name: 'recorder clear',
  summary: 'Forget every recorded event.',
  params: {},
  destructive: true,
  ownerOnly: true,
  run: async (_args, ctx) => {
    await writeFile(join(ctx.dir, 'events.jsonl'), '')
    return { outcome: 'done', text: 'cleared' }
  },
}

export const recorder: Plugin = {
  contract: 1,
  name: pluginName('recorder'),
  cognition: null,
  storage: [{ dir: '.', kind: 'body' }],
  statements: [],
  ownerCommands: [clear],
  observe: async (event, ctx) => {
    await appendFile(join(ctx.dir, 'events.jsonl'), `${describeEvent(event)}\n`)
  },
}

const boom = (hook: string) => async (): Promise<never> => {
  throw new Error(`thrower failed in ${hook}`)
}

/** Throws in every hook. */
export const thrower: Plugin = {
  contract: 1,
  name: pluginName('thrower'),
  cognition: { title: '总是出错的测试插件', text: '## 测试插件\n\n它在每个钩子里都抛错。' },
  storage: [],
  statements: ['boom'],
  ownerCommands: [],
  onPut: boom('onPut'),
  revise: boom('revise'),
  onFind: boom('onFind'),
  onInspect: boom('onInspect'),
  onSay: boom('onSay'),
  onCheck: boom('onCheck'),
  onArchive: boom('onArchive'),
  observe: boom('observe'),
  views: [{ id: 'thrower.page', title: '总出错的页', icon: 'triangle-alert', nav: true, filters: [] }],
  onView: boom('onView'),
  onItemView: boom('onItemView'),
}

const ping = (label: string): Action => ({ label, tone: 'default', confirm: null, inputs: [], call: { face: 'owner', command: 'pager ping', args: { positional: [], flags: {} } } })
const owner = (command: string, positional: string[] = [], flags: Record<string, string[]> = {}) => ({ face: 'owner' as const, command, args: { positional, flags } })

/** How many times `pager bump` ran in this library, kept in pager's own directory. */
const count = async (ctx: PluginContext) => Number(await readFile(join(ctx.dir, 'count'), 'utf8').catch(() => '0'))

/** A long outside address, for a cell that has to be cut. */
export const LONG_URL = 'http://127.0.0.1:18080/apps/a-rather-long-application-name-for-the-demo-site/index.html'

const bump: Action = { label: '加一', tone: 'default', confirm: '把计数加一？', inputs: [], call: owner('pager bump') }
const counter = (data: unknown, entry = 'counter.html'): Block => ({ kind: 'custom', entry, height: 140, text: `计数：${JSON.stringify(data)}`, data, actions: { bump } })

/** The view with each thing the first tier added, and the second tier's own page. */
async function newThings(ctx: PluginContext): Promise<Block[]> {
  const toFile = { view: 'item', params: { path: 'pager.md' }, target: 'panel' as const }
  const site = (key: string, url: string, link: typeof toFile | null = null) => ({ key, cells: { name: { text: key }, address: { text: url, mono: true, href: url, copy: true as const } }, link, actions: [] })
  return [
    {
      kind: 'section',
      title: '站点',
      note: null,
      count: 3,
      actions: [],
      blocks: [
        { kind: 'table', columns: [{ key: 'name', label: '名字' }, { key: 'address', label: '地址' }], rows: [site('长地址', LONG_URL), site('短地址', 'https://example.com/', toFile), site('不是网址', 'javascript:alert(1)')], empty: '没有站点' },
      ],
    },
    { kind: 'embed', url: process.env.PAGER_EMBED ?? 'http://127.0.0.1:9/', title: '站点预览', height: 220 },
    {
      kind: 'timeline',
      entries: [
        { at: '2026-11-25T02:00:00.000Z' as Instant, title: { text: '第 2 版' }, lines: ['bundle 48eb8ddd'], tag: { text: '线上', tone: 'good' } },
        { at: '2026-11-25T01:00:00.000Z' as Instant, title: { text: '第 1 版' }, lines: ['bundle ec8fab9c'], tag: null, actions: [{ label: '放回这一版', tone: 'default', confirm: '把线上换回第 1 版？', inputs: [], call: owner('pager restore', [], { release: ['1'] }) }] },
      ],
    },
    {
      kind: 'actions',
      actions: [
        {
          label: '设前缀',
          tone: 'default',
          confirm: null,
          inputs: [{ name: 'prefix', label: '前缀', placeholder: '比如 shop', value: null, options: null, pattern: '[a-z][a-z0-9]{0,11}', hint: '小写字母开头，最多 12 个小写字母或数字' }],
          call: owner('pager prefix', ['{prefix}']),
        },
      ],
    },
    counter({ count: await count(ctx), note: '插件自己画的一页' }),
    counter({}, 'missing.html'),
  ]
}

/** Declares one view that uses every kind of block, and one kind no page knows; one with each newer thing; and two for how often a view is asked. */
export const pager: Plugin = {
  contract: 1,
  name: pluginName('pager'),
  cognition: null,
  storage: [{ dir: '.', kind: 'body' }],
  statements: [],
  ui: fileURLToPath(new URL('./pager-ui/', import.meta.url)),
  ownerCommands: [
    { name: 'pager ping', summary: 'Answer pong.', params: {}, destructive: false, ownerOnly: false, run: async () => ({ outcome: 'done', text: 'pong' }) },
    {
      name: 'pager bump',
      summary: 'Count one more.',
      params: {},
      destructive: false,
      ownerOnly: false,
      run: async (_args, ctx) => {
        const next = (await count(ctx)) + 1
        await writeFile(join(ctx.dir, 'count'), String(next))
        return { outcome: 'done', text: `计数是 ${next}` }
      },
    },
    { name: 'pager restore', summary: 'Pretend to put a release back.', params: { flags: [{ name: 'release', hint: '第几版', kind: 'value' }] }, destructive: false, ownerOnly: false, run: async (args) => ({ outcome: 'done', text: `已放回第 ${String(args.flags.release)} 版` }) },
    { name: 'pager prefix', summary: 'Pretend to set a prefix.', params: { positional: [{ name: 'prefix', hint: '前缀' }] }, destructive: false, ownerOnly: false, run: async (args) => ({ outcome: 'done', text: `前缀是 ${args.positional[0] ?? ''}` }) },
  ],
  views: [
    { id: 'pager.blocks', title: '块的样例', icon: 'flask-conical', nav: true, filters: [] },
    { id: 'pager.new', title: '新的块', icon: 'layers', nav: true, filters: [] },
    { id: 'pager.still', title: '不自己更新的页', icon: 'clock', nav: false, filters: [] },
    { id: 'pager.ticking', title: '自己更新的页', icon: 'refresh-cw', nav: false, filters: [] },
  ],
  onItemView: async (path) => ({ title: '插件 pager 画的', blocks: [counter({ count: 0, note: `面板里的 ${path}` })] }),
  onView: async (req, ctx) => {
    if (req.view === 'pager.new') return { title: '新的块', subtitle: '链接、外部页面、带动作的时间线、带校验的输入、插件自己画的页', blocks: await newThings(ctx) }
    if (req.view === 'pager.still') return { title: '不自己更新的页', subtitle: null, blocks: [{ kind: 'text', text: '只在库变了或做了操作之后才重取。', tone: 'neutral' }] }
    if (req.view === 'pager.ticking') return { title: '自己更新的页', subtitle: null, blocks: [{ kind: 'text', text: '每 5 秒重取一次。', tone: 'neutral' }], refresh: 5 }
    return {
      title: '块的样例',
      subtitle: '测试插件 pager 的一页',
      blocks: [
        { kind: 'text', text: '这是一段说明文字。', tone: 'info' },
        {
          kind: 'section',
          title: '一节',
          note: '节下的说明',
          count: 2,
          actions: [ping('打个招呼')],
          blocks: [
            {
              kind: 'table',
              columns: [{ key: 'name', label: '名字' }, { key: 'state', label: '状态' }, { key: 'when', label: '何时' }],
              rows: [{ key: 'r1', cells: { name: { text: '表的第一行', mono: true }, state: { text: '', tag: { text: '好', tone: 'good' } }, when: { text: '', at: '2026-11-25T11:11:00.000Z' as Instant } }, link: { view: 'item', params: { path: 'pager.md' }, target: 'panel' }, actions: [] }],
              empty: '空表',
            },
            { kind: 'fields', fields: [{ label: '字段', value: { text: '字段的值' } }] },
          ],
        },
        { kind: 'list', items: [{ cell: { text: '列表的一项' }, note: '一项的说明', actions: [] }] },
        { kind: 'timeline', entries: [{ at: '2026-11-25T01:00:00.000Z' as Instant, title: { text: '时间线的一条' }, lines: ['一条的说明'], tag: { text: '标签', tone: 'warn' } }] },
        { kind: 'preview', path: 'pager.md' as LibraryPath },
        { kind: 'actions', actions: [ping('再打个招呼')] },
        { kind: 'empty', title: '空状态的标题', hint: '空状态的提示' },
        { kind: 'sparkle' } as unknown as Block,
      ],
    }
  },
}

/** Whether the owner answered asker's question, kept in asker's own directory. */
const answered = async (ctx: PluginContext) => (await readFile(join(ctx.dir, 'answered'), 'utf8').catch(() => null)) !== null
const answer = (word: string): OwnerCommand => ({
  name: `asker ${word}`,
  summary: `Answer ${word}.`,
  params: {},
  destructive: false,
  ownerOnly: true,
  run: async (_args, ctx) => {
    await writeFile(join(ctx.dir, 'answered'), word)
    return { outcome: 'done', text: word === 'yes' ? '好，上线了' : '好，先不上线' }
  },
})
const yes: Action = { label: '上线', tone: 'default', confirm: null, inputs: [], call: owner('asker yes') }
const no: Action = { label: '不上线', tone: 'default', confirm: null, inputs: [], call: owner('asker no') }
const undo: Action = { label: '取回', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'archive', request: { kind: 'unarchive', path: '_archive/old.md' } } }

/** Asks the owner one thing until answered, adds a line to the home page, and has one page of the newer blocks with counted filter options. */
export const asker: Plugin = {
  contract: 1,
  name: pluginName('asker'),
  cognition: { title: '问主人的测试插件', text: '## 测试插件\n\n它问主人一件事。' },
  storage: [{ dir: '.', kind: 'body' }],
  statements: [],
  ownerCommands: [answer('yes'), answer('no')],
  onAsks: async (ctx) => ((await answered(ctx)) ? [] : [{ key: 'asker:site', text: 'site 可以上线了，要上线吗？', about: 'site' as LibraryPath, actions: [yes, no], suggested: 0 }]),
  views: [
    { id: 'asker.story', title: '新的块', icon: 'activity', nav: true, filters: [{ name: 'who', label: '谁做的', options: [{ value: '', label: '全部' }, { value: 'agent', label: 'agent 做的' }], default: '' }] },
    { id: 'asker.home', title: '首页的一部分', icon: 'house', nav: false, filters: [], home: true },
  ],
  onView: async (req) => {
    if (req.view === 'asker.home') return { title: '首页的一部分', subtitle: null, blocks: [{ kind: 'text', text: '问主人的测试插件也在首页上。', tone: 'neutral' }] }
    const blocks: Block[] = [
      { kind: 'stats', stats: [{ label: '放入', value: '4', note: '带进来 2 样' }, { label: '决定', value: '1', note: null }] },
      { kind: 'tree', param: 'dir', selected: req.params.dir ?? '', nodes: [{ value: '', label: '全部文件夹', count: 3, children: [{ value: 'notes', label: 'notes', count: 2, children: [{ value: 'notes/old', label: 'old', count: 1, children: [] }] }] }] },
      {
        kind: 'feed',
        groups: [
          {
            title: '今天',
            count: 2,
            link: { view: 'ledger.scene', params: { scene: 's1' }, target: 'panel' },
            rows: [
              { key: 'f1', at: '2026-11-25T11:11:00.000Z' as Instant, actor: { kind: 'agent', name: 'claude-code', grant: 'claude' }, text: '归档 notes/old.md', meta: [{ text: '整理笔记' }, { text: '凭授权 claude', muted: true }], whose: 'agent', action: undo, link: { view: 'item', params: { path: '_archive/old.md' }, target: 'panel' } },
              { key: 'f2', at: '2026-11-25T11:12:00.000Z' as Instant, actor: { kind: 'owner', name: '主人' }, text: '主人面的操作 plugin add', meta: [], whose: 'owner', settled: '已定', link: null },
            ],
          },
        ],
        empty: '没有记录。',
      },
      { kind: 'feed', groups: [], empty: '空的一串。' },
      { kind: 'asks', asks: [{ key: 'k', by: { kind: 'agent', name: 'claude-code' }, text: '要上线吗？', about: 'site' as LibraryPath, actions: [yes, no], suggested: 0 }], empty: '没有要决定的。' },
      { kind: 'asks', asks: [], empty: '没有要你决定的事。' },
    ]
    return { title: '新的块', subtitle: null, blocks, filters: [{ name: 'who', options: [{ value: '', label: '全部', count: 12 }, { value: 'agent', label: 'agent 做的', count: 8 }] }] }
  },
}
