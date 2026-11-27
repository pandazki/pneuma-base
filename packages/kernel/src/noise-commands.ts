// The owner's side of noise: the names and paths declared at the library's root that storage never
// reports or enters (ARCHITECTURE.md「噪音」). Answering 「不用管」 to a directory
// nobody looked into adds it here.
import { command, done, refused, type KernelCommand } from './kernel-command.js'
import { parseLibraryPath, regionOf } from './paths.js'
import { storageOf } from './storage.js'
import { formOf, type Action, type Block, type FixedValue, type LibraryPath, type ListItem } from '@pneuma-base/sdk'

const PATH = { name: 'path', hint: '库内路径：这个目录或文件，和它里面的一切' } as const
const NAME = { name: 'name', hint: '名字：任何一层叫这个名字的都算，比如 node_modules', kind: 'value' } as const

const listed = (n: { names: string[]; paths: string[] }) => `名字：${n.names.join('、') || '无'}；路径：${n.paths.join('、') || '无'}`

/** The path or name the owner wrote; a refusal when neither, or the path is not in the content. */
function parsed(root: string, path: string | null, name: string | null): { paths?: LibraryPath[]; names?: string[] } | string {
  if ((path === null) === (name === null)) return '写一个库内路径，或用 --name 写一个名字，只写一个。'
  if (name !== null) return name.includes('/') || name.trim() === '' || name === '.' || name === '..' ? `名字是一层的名字，不带 /：${name}` : { names: [name] }
  const place = parseLibraryPath(root, path as string)
  return place === null || regionOf(place) !== 'content' ? `这不是库的内容里的路径：${path}` : { paths: [place] }
}

export const NOISE_COMMANDS: readonly KernelCommand[] = [
  command({
    name: 'noise list',
    summary: '库根上声明的噪音：库不报告、不进入的名字和路径',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    scope: 'library',
    async run(_values, call) {
      const n = await storageOf(call.ctx.library.root).noise.list()
      return done(`噪音（${n.declared ? '库根上声明的' : '还没改过，是默认的'}）。${listed(n)}`, n)
    },
  }),
  command({
    name: 'noise add',
    act: { kind: 'hidden', object: 'path' },
    summary: '加一条噪音：一个库内路径，或用 --name 加一个名字；之后库不再报告、不再进入它',
    params: { positional: [PATH], flags: [NAME] },
    destructive: false,
    ownerOnly: true,
    scope: 'library',
    async run({ path, name }, call) {
      const what = parsed(call.ctx.library.root, path, name)
      if (typeof what === 'string') return refused('usage', what)
      const n = await storageOf(call.ctx.library.root).noise.add(what)
      return done(`已记为噪音：${path ?? name}。库不再报告、不再进入它；要撤回：noise remove ${path ?? `--name ${name}`}。现在的${listed(n)}`, n)
    },
  }),
  command({
    name: 'noise remove',
    act: { kind: 'shown', object: 'path' },
    summary: '去掉一条噪音：一个库内路径，或用 --name 去掉一个名字',
    params: { positional: [PATH], flags: [NAME] },
    destructive: false,
    ownerOnly: true,
    scope: 'library',
    async run({ path, name }, call) {
      const what = parsed(call.ctx.library.root, path, name)
      if (typeof what === 'string') return refused('usage', what)
      const n = await storageOf(call.ctx.library.root).noise.remove(what)
      return done(`已不再当作噪音：${path ?? name}。现在的${listed(n)}`, n)
    },
  }),
]

/** A button of the noise command `name`, with these of its values fixed. */
const formFor = (name: string, label: string, fixed: Record<string, FixedValue>, tone: Action['tone'] = 'default'): Action => {
  const c = NOISE_COMMANDS.find((x) => x.name === name) as KernelCommand
  return { label, tone, confirm: null, ...formOf(c, { fixed }) }
}

/** The configuration page's part for noise, folded: each declared name and path a row with 去掉 in its 「···」, and 加一条 in its head. */
export async function noiseSection(root: string): Promise<Block> {
  const n = await storageOf(root).noise.list()
  const item = (value: string, fixed: Record<string, FixedValue>, note: string | null): ListItem => ({
    cell: { text: value },
    note,
    actions: [{ ...formFor('noise remove', '去掉', fixed, 'danger'), icon: 'trash-2' }],
  })
  const items = [...n.names.map((v) => item(v, { name: v, path: false }, null)), ...n.paths.map((v) => item(v, { path: v, name: false }, '库内路径'))]
  return {
    kind: 'section',
    title: '噪音',
    note: null,
    about: `库不报告、不进入的名字和路径：名字在任何一层都算，库内路径只算那一处。${n.declared ? '记在库根上，跟着库走。' : '现在是默认的那份。'}`,
    count: items.length,
    collapse: 'closed',
    blocks: items.length > 0 ? [{ kind: 'list', items }] : [{ kind: 'text', tone: 'neutral', text: '没有噪音：库里的一切都会被报告。' }],
    actions: [{ label: '加一条', tone: 'default', confirm: null, ...formOf(NOISE_COMMANDS.find((x) => x.name === 'noise add') as KernelCommand), as: 'icon', icon: 'plus' }],
  }
}
