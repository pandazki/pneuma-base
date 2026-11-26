// The kernel's `agents` page: the agents connected to this library, a two-line row each with its mark,
// how it is connected, what its grant reaches, what the plugins know of it, and 断开; the products
// found on this machine and not connected, each with 接上; and what a connected agent may do, from the
// same command table and by the same rule as the MCP face. ARCHITECTURE.md section 6.
import { formOf, type Action, type Block, type FixedValue, type PluginProblem, type ViewAnswer } from '@pneuma-base/sdk'
import { connectionFacts, WAY_WORD, whereOf } from './agent-commands.js'
import { KERNEL_COMMANDS } from './owner-commands.js'
import { ownerFace, type OwnerCommandInfo } from './owner.js'
import { eachPlugin } from './pipeline.js'
import { CONNECTABLE, lookedFor, signsOf, waysOf, type Way } from './products.js'
import type { ViewerCall } from './viewer.js'

function kernelAction(name: string, label: string, fixed: Record<string, FixedValue>, opts: { tone?: Action['tone']; confirm?: string } = {}): Action {
  const { inputs, call } = formOf(KERNEL_COMMANDS.find((c) => c.name === name) ?? { name, params: {} }, { fixed })
  return { label, tone: opts.tone ?? 'default', confirm: opts.confirm ?? null, inputs, call }
}

/** The verbs an agent's session runs, which no plugin changes (K3), and the two the command line adds. */
const VERBS_LINE = 'start、find、inspect、put、say、check、archive、unarchive、ask、show：放、找、看、说、查、归档、请你做一条下面的命令，和开始一件事、看管理界面的一页'

const commandItem = (c: OwnerCommandInfo) => ({ cell: { text: c.name, mono: true }, note: `${c.summary}${c.by === 'kernel' ? '' : `（${c.by}）`}`, actions: [] })
const askedItem = (c: OwnerCommandInfo) => (c.askable ? commandItem(c) : { ...commandItem(c), note: `${commandItem(c).note}（它请不了，要你亲自来）` })

/**
 * What an agent may do, in three groups: what its session runs itself (the verbs, and the commands
 * that neither lose data nor decide for the owner, which are the MCP face's tools); what it asks the
 * owner for (owner-only commands); and the red line (destructive commands, the owner's alone, confirmed in person).
 */
function mayDo(commands: OwnerCommandInfo[]): Block {
  const group = (title: string, note: string, items: Extract<Block, { kind: 'list' }>['items']): Block => ({ kind: 'section', title, note, count: items.length, blocks: [{ kind: 'list', items }], actions: [] })
  return {
    kind: 'section',
    title: '接上的 agent 能做什么',
    note: '每个 agent 都一样，由这个库的命令表定：命令行、MCP 服务给 agent 的就是这些。只读的授权不能放、不能归档；限在一个区域的授权只在那个区域里放和归档。',
    count: null,
    blocks: [
      group('自己能做的', '在它的会话里直接做', [{ cell: { text: '动词', mono: false }, note: VERBS_LINE, actions: [] }, ...commands.filter((c) => !c.destructive && !c.ownerOnly).map(commandItem)]),
      group('要你来做的', '替你做决定的事：它在会话里用 ask 写明为什么、请你批准，请求出现在首页的「等你决定」里', commands.filter((c) => c.ownerOnly && !c.destructive).map(askedItem)),
      group('红线', '会丢数据的事：只有你能做，要你当面确认', commands.filter((c) => c.destructive).map(commandItem)),
    ],
    actions: [],
  }
}

/**
 * What each plugin knows about a connected agent, by its grant, as `inspect @<grant>` asks: the
 * ledger says when it was last here. Each section's words, joined; a plugin that throws is a problem.
 */
async function knownAbout(ctx: ViewerCall['ctx'], grant: string): Promise<{ text: string | null; problems: PluginProblem[] }> {
  const heard = await eachPlugin(ctx, (plugin, pctx) => plugin.onInspect?.({ target: `@${grant}` }, pctx))
  const bodies = heard.values.flatMap(({ value }) => (Array.isArray(value) ? value.flatMap((s: { body?: unknown }) => (typeof s.body === 'string' && s.body !== '' ? [s.body] : [])) : []))
  return { text: bodies.length === 0 ? null : bodies.join('；'), problems: heard.problems }
}

const accessWord = (readOnly: boolean | null) => (readOnly === null ? null : readOnly ? '只读' : '读写')

export async function agentsPage(_params: Record<string, string>, { ctx, table, env }: ViewerCall): Promise<ViewAnswer & { problems: PluginProblem[] }> {
  const { root } = ctx.library
  const connections = await connectionFacts(ctx.home, env, table, root)
  const problems: PluginProblem[] = []
  const rows = []
  for (const c of connections) {
    const known = await knownAbout(ctx, c.grant)
    problems.push(...known.problems)
    const note = [WAY_WORD[c.way], c.area === null ? '整个库' : `区域 ${c.area}/`, accessWord(c.readOnly), c.grant === c.product ? null : `凭授权 ${c.grant}`, ...(c.inPlace ? [`写在 ${c.where}`] : []), ...(known.text === null ? [] : [known.text])]
    rows.push({
      cell: { text: c.title, actor: { kind: 'agent' as const, name: c.product, grant: c.grant }, ...(c.inPlace ? {} : { tag: { text: c.problems.join('；'), tone: 'warn' as const } }) },
      note: note.filter((part) => part !== null).join(' · '),
      actions: [kernelAction('agent disconnect', '断开', { grant: c.grant, 'keep-grant': false }, { tone: 'danger', confirm: `断开后，${c.title} 就不能再用这个库：接上时写进去的会被拿掉，授权 ${c.grant} 会被撤回。` })],
    })
  }
  const connected: Block = {
    kind: 'section',
    title: '接上的 agent',
    note: '断开会拿掉接上时写进那个产品的技能或 MCP 服务，再撤回授权；接上之后被你改过的，原样留着。',
    count: connections.length,
    blocks: rows.length > 0 ? [{ kind: 'list', items: rows }] : [{ kind: 'empty', title: '还没有接上任何 agent', hint: '在下面找到的产品那一行点「接上」。' }],
    actions: [],
  }

  const found = CONNECTABLE.map((p) => ({ p, signs: signsOf(p, env) }))
  const open = found.filter(({ p, signs }) => signs.length > 0 && !connections.some((c) => c.product === p.name))
  const missing = found.filter(({ signs }) => signs.length === 0)
  const offeredRows = open.map(({ p, signs }) => {
    const way = waysOf(p)[0] as Way
    return {
      cell: { text: p.title, actor: { kind: 'agent' as const, name: p.name } },
      note: `${WAY_WORD[way]}：${whereOf(p, way, p.name, env)} · ${signs.join('、')}`,
      actions: [kernelAction('agent connect', '接上', { product: p.name, name: false, via: false })],
    }
  })
  const offered: Block = {
    kind: 'section',
    title: '这台机器上找到的',
    note: '接上时发一份以产品命名的授权，再把技能装进它读技能的目录；不读技能的，把 MCP 服务登记进它的配置。',
    count: open.length,
    blocks: [
      ...(offeredRows.length > 0 ? [{ kind: 'list' as const, items: offeredRows }] : [{ kind: 'text' as const, tone: 'neutral' as const, text: '这台机器上找到的产品都接上了。' }]),
      ...(missing.length === 0 ? [] : [{ kind: 'text' as const, tone: 'neutral' as const, text: `没找到：${missing.map(({ p }) => `${p.title}（看了 ${lookedFor(p)}）`).join('；')}。` }]),
    ],
    actions: [],
  }
  return { title: 'Agent', subtitle: null, blocks: [connected, offered, mayDo(ownerFace.commands(ctx.library.plugins))], problems }
}
