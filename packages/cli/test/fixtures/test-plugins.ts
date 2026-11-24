// Test-only plugins. Run by Node's type stripping, so only erasable TypeScript here.
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginName, type Event, type OwnerCommand, type Plugin } from '@pneuma-base/kernel'

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
}
