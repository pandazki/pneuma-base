// Test-only plugins. Run by Node's type stripping, so only erasable TypeScript here.
import { fileURLToPath } from 'node:url'
import { formOf, isDescribed, isFailure, pluginName, type Action, type Block, type Event, type Instant, type LibraryPath, type OwnerCommand, type Plugin, type PluginContext } from '@pneuma-base/kernel'

/** A file of the plugin's own record place as text, through storage; null when it is not there. */
async function readOwn(ctx: PluginContext, place: string): Promise<string | null> {
  const read = await ctx.tools.storage.own.read(place)
  return isFailure(read) || read.data === null ? null : Buffer.from(read.data).toString('utf8')
}

/** Writes a file of the plugin's own record place whole, over what is there now. */
async function writeOwn(ctx: PluginContext, place: string, text: string): Promise<void> {
  const own = ctx.tools.storage.own
  for (;;) {
    const [at] = await own.glance([place])
    const expect = at !== undefined && isDescribed(at) && at.kind !== 'none' ? (at.token ?? 'empty') : 'empty'
    const written = await own.write(place, { data: text }, expect)
    if (!isFailure(written)) return
    if (written.reason !== 'refused') throw new Error(`没能写 ${place}：${written.reason}`)
  }
}

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
    await writeOwn(ctx, 'events.jsonl', '')
    return { outcome: 'done', text: 'cleared' }
  },
}

export const recorder: Plugin = {
  contract: 2,
  name: pluginName('recorder'),
  cognition: null,
  storage: [{ dir: '.', kind: 'body' }],
  statements: [],
  ownerCommands: [clear],
  observe: async (event, ctx) => {
    await writeOwn(ctx, 'events.jsonl', `${(await readOwn(ctx, 'events.jsonl')) ?? ''}${describeEvent(event)}\n`)
  },
}

const boom = (hook: string) => async (): Promise<never> => {
  throw new Error(`thrower failed in ${hook}`)
}

/** Throws in every hook. */
export const thrower: Plugin = {
  contract: 2,
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
const count = async (ctx: PluginContext) => Number((await readOwn(ctx, 'count')) ?? '0')

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

/** A command whose form has a choice that shows fields, a choice of many and a secret: it says what it was given, and its row is named by the first given of two. */
const pick: OwnerCommand = {
  name: 'pager pick',
  summary: 'Say what was picked.',
  act: { kind: 'connected', object: ['site', 'origin'], name: '挑的' },
  params: {
    flags: [
      { name: 'kind', hint: '哪种', kind: 'value', options: [{ value: 'site', label: '网站' }, { value: 'folder', label: '文件夹' }] },
      { name: 'site', hint: '网站', kind: 'value' },
      { name: 'origin', hint: '地址', kind: 'value' },
    ],
    secret: { name: 'key', hint: '账户密钥' },
  },
  destructive: false,
  ownerOnly: false,
  run: async (args) => ({ outcome: 'done', text: `选了 ${JSON.stringify(args.values)}，密钥 ${((await args.secret()) ?? '').length} 个字` }),
}

/** The newest marks: a tag that says why, a row's second cell, and a form whose fields follow a choice. */
function marks(): Block[] {
  const address = (path: string) => ({ text: `https://space.example.com/apps/${path}/`, href: `https://space.example.com/apps/${path}/`, copy: true as const, mono: true as const })
  const sites = Array.from({ length: 30 }, (_, i) => ({ value: `sites/site-${i + 1}`, label: `sites/site-${i + 1}` }))
  const form = formOf(pick, { choices: { site: sites } })
  const when = (input: string, is: string) => [{ input, is: [is] }]
  const inputs = form.inputs.map((i) => (i.name === 'site' ? { ...i, when: when('kind', 'site') } : i.name === 'origin' ? { ...i, when: when('kind', 'folder') } : i.name === 'key' ? { ...i, when: when('kind', 'site') } : i))
  return [
    {
      kind: 'list',
      items: [
        { cell: { text: 'shop' }, note: 'sites', aside: address('pb-shop-with-a-rather-long-application-name'), actions: [], toggle: { on: true, action: ping('下线') } },
        { cell: { text: 'blog', tag: { text: '读不到', tone: 'bad', tip: '连不上 space.example.com' } }, note: null, aside: address('pb-blog'), actions: [] },
      ],
    },
    { kind: 'actions', actions: [{ label: '挑一个', tone: 'default', confirm: null, inputs, call: form.call }] },
  ]
}

/** Declares one view that uses every kind of block, and one kind no page knows; one with each newer thing; and two for how often a view is asked. */
export const pager: Plugin = {
  contract: 2,
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
        await writeOwn(ctx, 'count', String(next))
        return { outcome: 'done', text: `计数是 ${next}` }
      },
    },
    { name: 'pager restore', summary: 'Pretend to put a release back.', params: { flags: [{ name: 'release', hint: '第几版', kind: 'value' }] }, destructive: false, ownerOnly: false, run: async (args) => ({ outcome: 'done', text: `已放回第 ${String(args.flags.release)} 版` }) },
    { name: 'pager prefix', summary: 'Pretend to set a prefix.', params: { positional: [{ name: 'prefix', hint: '前缀' }] }, destructive: false, ownerOnly: false, run: async (args) => ({ outcome: 'done', text: `前缀是 ${args.positional[0] ?? ''}` }) },
    pick,
  ],
  views: [
    { id: 'pager.blocks', title: '块的样例', icon: 'flask-conical', nav: true, filters: [] },
    { id: 'pager.new', title: '新的块', icon: 'layers', nav: true, filters: [] },
    { id: 'pager.still', title: '不自己更新的页', icon: 'clock', nav: false, filters: [] },
    { id: 'pager.ticking', title: '自己更新的页', icon: 'refresh-cw', nav: false, filters: [] },
    { id: 'pager.marks', title: '标记和第二格', icon: 'tag', nav: false, filters: [] },
  ],
  onItemView: async (path) => ({ title: '插件 pager 画的', blocks: [counter({ count: 0, note: `面板里的 ${path}` })] }),
  onView: async (req, ctx) => {
    if (req.view === 'pager.new') return { title: '新的块', subtitle: '链接、外部页面、带动作的时间线、带校验的输入、插件自己画的页', blocks: await newThings(ctx) }
    if (req.view === 'pager.still') return { title: '不自己更新的页', subtitle: null, blocks: [{ kind: 'text', text: '只在库变了或做了操作之后才重取。', tone: 'neutral' }] }
    if (req.view === 'pager.marks') return { title: '标记和第二格', subtitle: null, blocks: marks() }
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
        {
          kind: 'list',
          items: [
            { cell: { text: '列表的一项' }, note: '一项的说明', actions: [] },
            { cell: { text: '一个开关', icon: 'power' }, note: '开着的设置', about: '拨它就打个招呼。', toggle: { on: true, action: ping('关上') }, actions: [] },
          ],
        },
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
const answered = async (ctx: PluginContext) => (await readOwn(ctx, 'answered')) !== null
const answer = (word: string): OwnerCommand => ({
  name: `asker ${word}`,
  summary: `Answer ${word}.`,
  params: {},
  destructive: false,
  ownerOnly: true,
  run: async (_args, ctx) => {
    await writeOwn(ctx, 'answered', word)
    return { outcome: 'done', text: word === 'yes' ? '好，上线了' : '好，先不上线' }
  },
})
const yes: Action = { label: '上线', tone: 'default', confirm: null, inputs: [], call: owner('asker yes') }
const no: Action = { label: '不上线', tone: 'default', confirm: null, inputs: [], call: owner('asker no') }
const undo: Action = { label: '取回', tone: 'default', confirm: null, inputs: [], call: { face: 'agent', verb: 'archive', request: { kind: 'unarchive', path: '_archive/old.md' } } }

/** Asks the owner one thing until answered, adds a line to the home page, and has one page of the newer blocks with counted filter options. */
export const asker: Plugin = {
  contract: 2,
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
      { kind: 'chart', form: 'stacked', text: '这 3 天放进 9 样东西：带进来 5 样，做出来 4 样。', unit: '样', x: ['11月24日', '11月25日', '11月26日'], series: [{ label: '带进来的', values: [2, 0, 3] }, { label: '做出来的', values: [1, 2, 1] }] },
    ]
    return { title: '新的块', subtitle: null, blocks, filters: [{ name: 'who', options: [{ value: '', label: '全部', count: 12 }, { value: 'agent', label: 'agent 做的', count: 8 }] }] }
  },
}
