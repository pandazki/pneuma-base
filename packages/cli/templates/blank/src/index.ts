// The {{name}} plugin. An agent leaves a mark on a thing in the library, one sentence, with
// `say {{name}}`; the owner lists the marks with `{{name}} list`; the plugin's page shows them as
// typed blocks and as a panel it draws itself (ui/panel.html). Replace the marks with what your
// plugin does: the shape stays the same.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT, defineCommand, definePlugin, pluginName, type Action, type Block, type PluginContext, type SayAnswer } from '@pneuma-base/sdk'
import { recordStore, type Envelope } from '@pneuma-base/sdk/kit'

const NAME = pluginName('{{name}}')
const PAGE = `${NAME}.marks`

/** What a mark says: the library path it is about, and the sentence. */
export type Mark = { path: string; text: string }

/** A stored line as a mark, or why it is not one. Records are read through this, at the boundary. */
export function parseMark(raw: Record<string, unknown>): Mark | string {
  return typeof raw.path === 'string' && typeof raw.text === 'string' ? { path: raw.path, text: raw.text } : '不是一条标记'
}

/** The marks, under the plugin's own directory: one new file per write, no file ever changed. */
const marks = (ctx: PluginContext) => recordStore(join(ctx.dir, 'marks'), parseMark)

/** src/cognition.md, without the notes to the plugin's author. */
const cognition = readFileSync(new URL('./cognition.md', import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->\n*/g, '')
  .trim()

const refused = (note: string): SayAnswer => ({ outcome: 'not-heard', reason: 'refused', note })

const list = defineCommand({
  name: `${NAME} list`,
  summary: '列出 agent 留下的标记，可以只看一样东西的',
  params: { flags: [{ name: 'path', hint: '库内路径', kind: 'value' }] },
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  async run({ path }, ctx) {
    const shown = (await marks(ctx).read()).records.filter((m) => path === null || m.path === path)
    const text = shown.length === 0 ? '还没有标记。' : shown.map((m) => `${m.path}：${m.text}（${m.actor.name}）`).join('\n')
    return { outcome: 'done', text, data: { marks: shown.map((m) => ({ path: m.path, text: m.text, by: m.actor.name, at: m.at })) } }
  },
})

/** The button the panel can press: it runs `{{name}} list`, as any action does, through the owner face. */
const LIST: Action = { label: '列出全部', tone: 'default', confirm: null, inputs: [], call: { face: 'owner', command: list.name, args: { positional: [], flags: {} } } }

function page(all: readonly (Envelope & Mark)[]): Block[] {
  const latest = all.at(-1)
  return [
    {
      kind: 'custom',
      entry: 'panel.html',
      height: 72,
      // What the panel shows, in words: the command line prints it, and screen readers read it.
      text: `${all.length} 条标记，${latest === undefined ? '还没有' : `最近一条：${latest.text}（${latest.path}）`}`,
      data: { count: all.length, latest: latest === undefined ? null : { text: latest.text, path: latest.path } },
      actions: { list: LIST },
    },
    {
      kind: 'table',
      columns: [
        { key: 'path', label: '东西' },
        { key: 'text', label: '标记' },
        { key: 'by', label: '谁', optional: true },
        { key: 'at', label: '时间', optional: true },
      ],
      rows: all.map((m) => ({
        key: m.id,
        cells: { path: { text: m.path, mono: true, icon: 'file' }, text: { text: m.text }, by: { text: m.actor.name, muted: true }, at: { text: m.at, at: m.at } },
        link: { view: 'item', params: { path: m.path }, target: 'panel' },
        actions: [],
      })),
      empty: `还没有标记。agent 用 say ${NAME} <库内路径> "<一句话>" 留下一条。`,
    },
  ]
}

export default definePlugin({
  contract: CONTRACT,
  name: NAME,
  version: '0.1.0',
  summary: 'agent 给库里的东西留一句标记，主人在一页里看全部。',
  cognition: { title: '标记', text: cognition },
  storage: [{ dir: 'marks', kind: 'body' }],
  statements: [NAME],
  ownerCommands: [list],
  views: [{ id: PAGE, title: '标记', icon: 'bookmark', nav: true, filters: [] }],
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),

  /** `say {{name}} <库内路径> "<一句话>"`: the thing must be in the library. */
  async onSay(req, ctx) {
    if (req.about === null || req.text === null) return refused(`要写是哪样东西和一句话：say ${NAME} <库内路径> "<一句话>"`)
    const at = await ctx.tools.resolve(req.about)
    if (at === null || at.region !== 'content' || !(await ctx.tools.thing(at.path))) return refused(`库里没有这样东西：${req.about}`)
    const store = marks(ctx)
    await store.append([store.stamp(ctx, { path: at.path, text: req.text })])
    return { outcome: 'heard', note: `已给 ${at.path} 留下标记。` }
  },

  /** Views read and never write: the page is drawn from the records as they are. */
  async onView(req, ctx) {
    if (req.view !== PAGE) return { title: '标记', subtitle: null, blocks: [{ kind: 'empty', title: '没有这一页', hint: req.view }] }
    const all = (await marks(ctx).read()).records
    return { title: '标记', subtitle: `${all.length} 条`, blocks: page(all) }
  },
})
