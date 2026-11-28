// The `ignore` commands, the owner's side of storage's noise: the names and paths declared at the
// library's root that storage never reports or enters (ARCHITECTURE.md「噪音」). Answering 「忽略」 to a
// directory nobody looked into adds it here.
import { command, done, refused, type KernelCommand } from './kernel-command.js'
import { parseLibraryPath, regionOf } from './paths.js'
import { storageOf } from './storage.js'
import { formOf, type Action, type Block, type FixedValue, type LibraryPath, type ListItem } from '@pneuma-base/sdk'

const PATH = { name: 'path', hint: '库内路径：该目录或文件及其中的全部内容' } as const
const NAME = { name: 'name', hint: '名称：匹配任意层级中的同名文件或目录，例如 node_modules', kind: 'value' } as const

const listed = (n: { names: string[]; paths: string[] }) => `名称：${n.names.join('、') || '无'}；路径：${n.paths.join('、') || '无'}`

/** The path or name the owner wrote; a refusal when neither, or the path is not in the content. */
function parsed(root: string, path: string | null, name: string | null): { paths?: LibraryPath[]; names?: string[] } | string {
  if ((path === null) === (name === null)) return '指定一个库内路径，或用 --name 指定一个名称，二者只能选其一。'
  if (name !== null) return name.includes('/') || name.trim() === '' || name === '.' || name === '..' ? `名称为单层名称，不含 /：${name}` : { names: [name] }
  const place = parseLibraryPath(root, path as string)
  return place === null || regionOf(place) !== 'content' ? `该路径不在资料库内容中：${path}` : { paths: [place] }
}

export const IGNORE_COMMANDS: readonly KernelCommand[] = [
  command({
    name: 'ignore list',
    summary: '资料库根目录中声明的忽略规则：资料库不报告、不进入的名称和路径',
    params: {},
    destructive: false,
    ownerOnly: false,
    readOnly: true,
    scope: 'library',
    async run(_values, call) {
      const n = await storageOf(call.ctx.library.root).noise.list()
      return done(`忽略规则（${n.declared ? '资料库根目录中声明' : '默认，未修改'}）。${listed(n)}`, n)
    },
  }),
  command({
    name: 'ignore add',
    act: { kind: 'hidden', object: 'path' },
    summary: '添加忽略规则：一个库内路径，或用 --name 指定一个名称；此后资料库不再报告、不再进入该位置',
    params: { positional: [PATH], flags: [NAME] },
    destructive: false,
    ownerOnly: true,
    scope: 'library',
    async run({ path, name }, call) {
      const what = parsed(call.ctx.library.root, path, name)
      if (typeof what === 'string') return refused('usage', what)
      const n = await storageOf(call.ctx.library.root).noise.add(what)
      return done(`已忽略：${path ?? name}。资料库不再报告、不再进入该位置；撤销：ignore remove ${path ?? `--name ${name}`}。当前${listed(n)}`, n)
    },
  }),
  command({
    name: 'ignore remove',
    act: { kind: 'shown', object: 'path' },
    summary: '移除忽略规则：一个库内路径，或用 --name 指定一个名称',
    params: { positional: [PATH], flags: [NAME] },
    destructive: false,
    ownerOnly: true,
    scope: 'library',
    async run({ path, name }, call) {
      const what = parsed(call.ctx.library.root, path, name)
      if (typeof what === 'string') return refused('usage', what)
      const n = await storageOf(call.ctx.library.root).noise.remove(what)
      return done(`已取消忽略：${path ?? name}。当前${listed(n)}`, n)
    },
  }),
]

/** A button of the ignore command `name`, with these of its values fixed. */
const formFor = (name: string, label: string, fixed: Record<string, FixedValue>, tone: Action['tone'] = 'default'): Action => {
  const c = IGNORE_COMMANDS.find((x) => x.name === name) as KernelCommand
  return { label, tone, confirm: null, ...formOf(c, { fixed }) }
}

/** The settings page's part for the ignore rules, folded: each declared name and path a row with 移除 in its 「···」, and 添加 in its head. */
export async function ignoreSection(root: string): Promise<Block> {
  const n = await storageOf(root).noise.list()
  const item = (value: string, fixed: Record<string, FixedValue>, note: string | null): ListItem => ({
    cell: { text: value },
    note,
    actions: [{ ...formFor('ignore remove', '移除', fixed, 'danger'), icon: 'trash-2' }],
  })
  const items = [...n.names.map((v) => item(v, { name: v, path: false }, null)), ...n.paths.map((v) => item(v, { path: v, name: false }, '路径'))]
  return {
    kind: 'section',
    title: '忽略规则',
    note: null,
    about: `资料库不报告、不进入的名称和路径：名称匹配任意层级，路径仅匹配该位置。${n.declared ? '记录在资料库根目录中，随资料库移动。' : '当前为默认规则。'}`,
    count: items.length,
    collapse: 'closed',
    blocks: items.length > 0 ? [{ kind: 'list', items }] : [{ kind: 'text', tone: 'neutral', text: '暂无忽略规则：资料库中的全部内容均会报告。' }],
    actions: [{ label: '添加', tone: 'default', confirm: null, ...formOf(IGNORE_COMMANDS.find((x) => x.name === 'ignore add') as KernelCommand), as: 'icon', icon: 'plus' }],
  }
}
