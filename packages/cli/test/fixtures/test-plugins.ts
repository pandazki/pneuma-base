// Test-only plugins. Run by Node's type stripping, so only erasable TypeScript here.
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginName, type Action, type Block, type Event, type Instant, type LibraryPath, type OwnerCommand, type Plugin } from '@pneuma-base/kernel'

/** One line per event it observes, in `.pneuma-base/recorder/events.jsonl`. */
export function describeEvent(event: Event): string {
  const what = event.face === 'agent' ? event.verb : event.command
  return JSON.stringify({ face: event.face, what, outcome: 'outcome' in event.result ? event.result.outcome : undefined })
}

const clear: OwnerCommand = {
  name: 'recorder clear',
  summary: 'Forget every recorded event.',
  destructive: true,
  run: async (_args, ctx) => {
    await writeFile(join(ctx.dir, 'events.jsonl'), '')
    return { outcome: 'done', text: 'cleared' }
  },
}

export const recorder: Plugin = {
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
  views: [{ id: 'thrower.page', title: '总出错的页', icon: 'bomb', nav: true, filters: [] }],
  onView: boom('onView'),
  onItemView: boom('onItemView'),
}

const ping = (label: string): Action => ({ label, tone: 'default', confirm: null, inputs: [], call: { face: 'owner', command: 'pager ping', args: { positional: [], flags: {} } } })

/** Declares one view that uses every kind of block, and one kind no page knows. */
export const pager: Plugin = {
  name: pluginName('pager'),
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [{ name: 'pager ping', summary: 'Answer pong.', destructive: false, run: async () => ({ outcome: 'done', text: 'pong' }) }],
  views: [{ id: 'pager.blocks', title: '块的样例', icon: 'flask-conical', nav: true, filters: [] }],
  onView: async () => ({
    title: '块的样例',
    subtitle: '测试插件 pager 的唯一一页',
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
            columns: [{ key: 'name', label: '名字' }, { key: 'state', label: '状态' }],
            rows: [{ key: 'r1', cells: { name: { text: '表的第一行', mono: true }, state: { text: '', tag: { text: '好', tone: 'good' } } }, link: { view: 'item', params: { path: 'pager.md' }, target: 'panel' }, actions: [] }],
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
  }),
}
