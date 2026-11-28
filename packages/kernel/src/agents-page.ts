// The kernel's `agents` page: the agents that may use this library, a two-line row each with its mark:
// the connected ones with how they are connected, what their grant reaches, what the plugins know of
// them, and 断开连接; a grant no product was connected with, with its skills and 撤销; 新建授权 in the head.
// Then agents connecting themselves, by the sentence and by pairing; the products found on this machine
// and not connected, each with 连接; and what a connected agent may do, from the same command table and
// by the same rule as the MCP face. ARCHITECTURE.md「Agent 页（`agents`）」.
import { formOf, type Action, type Block, type FixedValue, type ListItem, type Plugin, type PluginProblem, type Tag, type ViewAnswer } from '@pneuma-base/sdk'
import { connectionFacts, NOTHING_WRITTEN, titleOf, WAY_WORD, whereOf } from './agent-commands.js'
import { pluginTitle } from './claims.js'
import { endpointOf } from './endpoint.js'
import { KERNEL_COMMANDS } from './owner-commands.js'
import { ownerFace, type OwnerCommandInfo } from './owner.js'
import { pairingActions, pairingsOf, pairingState, sentenceBlock, type PairingState } from './pairing.js'
import { eachPlugin } from './pipeline.js'
import { codexHint, CONNECTABLE, lookedFor, signsOf, waysOf, type Way } from './products.js'
import { when } from './requests.js'
import type { ViewerCall } from './viewer.js'

function kernelAction(name: string, label: string, fixed: Record<string, FixedValue>, opts: { tone?: Action['tone']; confirm?: string; values?: Record<string, string> } = {}): Action {
  const { inputs, call } = formOf(KERNEL_COMMANDS.find((c) => c.name === name) ?? { name, params: {} }, { fixed, ...(opts.values ? { values: opts.values } : {}) })
  return { label, tone: opts.tone ?? 'default', confirm: opts.confirm ?? null, inputs, call }
}

/** A skill for Claude or Codex pointing at the description, written for one grant into the directory that product reads. */
const skillAction = (grant: string, agent: 'claude' | 'codex'): Action => ({
  ...kernelAction('skill install', agent === 'claude' ? '为 Claude 生成技能' : '为 Codex 生成技能', { grant, agent }, { values: { dir: agent === 'claude' ? '~/.claude/skills' : '~/.agents/skills' } }),
  as: 'menu',
  icon: 'sparkles',
})

/** The verbs an agent's session runs, which no plugin changes (K3), and the two the command line adds. */
const VERBS_LINE = 'start、find、inspect、put、say、check、archive、unarchive、ask、show：添加、搜索、查看、记录、检查、归档与取消归档、提交请求，以及开始任务和查看管理界面页面'


/**
 * What an agent may do, in three groups: what its session runs itself (the verbs, and the commands
 * that neither lose data nor decide for the owner, which are the MCP face's tools); what it asks the
 * owner for (owner-only commands); and the red line (destructive commands, the owner's alone, confirmed in person).
 */
function mayDo(commands: OwnerCommandInfo[], plugins: readonly Plugin[]): Block {
  const by = (name: string) => {
    const plugin = plugins.find((p) => p.name === name)
    return plugin === undefined ? name : pluginTitle(plugin)
  }
  const commandItem = (c: OwnerCommandInfo) => ({ cell: { text: c.name, mono: true }, note: `${c.summary}${c.by === 'kernel' ? '' : `（${by(c.by)}）`}`, actions: [] })
  const askedItem = (c: OwnerCommandInfo) => (c.askable ? commandItem(c) : { ...commandItem(c), note: `${commandItem(c).note}（不可请求，需所有者亲自执行）` })
  const group = (title: string, about: string, items: Extract<Block, { kind: 'list' }>['items']): Block => ({ kind: 'section', title, note: null, about, count: items.length, blocks: [{ kind: 'list', items }], actions: [] })
  return {
    kind: 'section',
    title: 'Agent 权限',
    note: null,
    about: '所有 Agent 相同，由此资料库的命令表决定，即命令行和 MCP 服务向 Agent 提供的命令。只读授权不能添加或归档；限定区域的授权仅能在该区域内添加和归档。',
    count: null,
    collapse: 'closed',
    blocks: [
      group('可直接执行', '在 Agent 会话中直接执行', [{ cell: { text: '基本命令', mono: false }, note: VERBS_LINE, actions: [] }, ...commands.filter((c) => !c.destructive && !c.ownerOnly).map(commandItem)]),
      group('需所有者批准', '所有者的决定：Agent 写明原因提交请求，请求显示在首页的「待处理」中', commands.filter((c) => c.ownerOnly && !c.destructive).map(askedItem)),
      group('限制', '将丢失数据的操作：仅所有者可执行，且需当面确认', commands.filter((c) => c.destructive).map(commandItem)),
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

/** How many pairings the page lists, the latest. */
const PAIRINGS_SHOWN = 20

// Only a request still waiting is marked; how a settled one ended is a word in its line.
const PAIRING_WORD: Record<Exclude<PairingState, 'waiting'>, string> = { connected: '已连接', declined: '已拒绝', expired: '已过期' }
const WAITING: Tag = { text: '待处理', tone: 'warn' }

/**
 * Agents connecting themselves: the sentence to say to any agent while an endpoint runs for this
 * library, and the latest pairings, latest first, the waiting ones with 允许 and 拒绝. Null when
 * there is neither.
 */
async function pairingSection({ ctx }: ViewerCall): Promise<Block | null> {
  const { home, library, now } = ctx
  const endpoint = await endpointOf(home, library.root)
  const pairings = (await pairingsOf(home, library.root)).slice(-PAIRINGS_SHOWN).reverse()
  if (endpoint === null && pairings.length === 0) return null
  const items = pairings.map((p) => {
    const state = pairingState(p, now)
    const d = p.decision
    const settled = d?.outcome === 'connected' ? [`授权 ${d.grant}`] : d?.outcome === 'declined' && d.reason !== null ? [`原因：${d.reason}`] : []
    return {
      cell: { text: titleOf(p.product), actor: { kind: 'agent' as const, name: p.product }, ...(state === 'waiting' ? { tag: WAITING } : {}) },
      note: [...(state === 'waiting' ? [] : [PAIRING_WORD[state]]), `配对码 ${p.code}`, when(p.at), p.why, ...settled].join(' · '),
      actions: state === 'waiting' ? pairingActions(p.id) : [],
    }
  })
  return {
    kind: 'section',
    title: '配对',
    note: null,
    about: '记录每次接入请求：待处理、已连接、已拒绝和已过期。',
    count: pairings.length,
    blocks: [...(endpoint === null ? [] : [sentenceBlock(endpoint.url, '本页或首页')]), ...(items.length === 0 ? [] : [{ kind: 'list' as const, items }])],
    actions: [],
  }
}

export async function agentsPage(_params: Record<string, string>, call: ViewerCall): Promise<ViewAnswer & { problems: PluginProblem[] }> {
  const { ctx, table, env } = call
  const { root, config } = ctx.library
  const connections = await connectionFacts(ctx.home, env, table, root)
  const problems: PluginProblem[] = []
  const known = async (grant: string) => {
    const k = await knownAbout(ctx, grant)
    problems.push(...k.problems)
    return k.text
  }
  // The whole library, read and write, is the usual reach and goes unsaid; a narrower one is said, read-only as a mark.
  const area = (a: string | null) => (a === null ? null : `区域 ${a}/`)
  const line = (parts: (string | null)[]) => parts.filter((part) => part !== null).join(' · ')
  const rows: ListItem[] = []
  for (const c of connections) {
    const note = line([WAY_WORD[c.way], area(c.area), c.grant === c.product ? null : `授权 ${c.grant}`, ...(c.inPlace && c.where !== NOTHING_WRITTEN ? [`写入 ${c.where}`] : []), await known(c.grant)])
    const tag: Tag | null = !c.inPlace ? { text: c.problems.join('；'), tone: 'warn' } : c.readOnly === true ? { text: '只读', tone: 'neutral' } : null
    rows.push({
      cell: { text: c.title, actor: { kind: 'agent', name: c.product, grant: c.grant }, ...(tag ? { tag } : {}) },
      note,
      actions: [{ ...kernelAction('agent disconnect', '断开连接', { grant: c.grant, 'keep-grant': false }, { tone: 'danger', confirm: `断开 ${c.title} 的连接？连接时写入的内容将被移除，授权 ${c.grant} 将被撤销，${c.title} 将无法再使用此资料库。` }), icon: 'unplug' }],
    })
  }
  // A grant issued by hand, or left by a connection undone with --keep-grant: the agent it was given to.
  for (const g of config.grants.filter((g) => !connections.some((c) => c.grant === g.name))) {
    const note = line([g.name === g.agent ? null : `授权 ${g.name}`, area(g.area), await known(g.name)])
    rows.push({
      cell: { text: titleOf(g.agent), actor: { kind: 'agent', name: g.agent, grant: g.name }, ...(g.readOnly ? { tag: { text: '只读', tone: 'neutral' as const } } : {}) },
      note: note === '' ? null : note,
      actions: [skillAction(g.name, 'claude'), skillAction(g.name, 'codex'), { ...kernelAction('grant revoke', '撤销', { name: g.name }, { tone: 'danger', confirm: `撤销授权 ${g.name}？持有该授权的 Agent 将无法再使用此资料库。` }), icon: 'trash-2' }],
    })
  }
  const connected: Block = {
    kind: 'section',
    title: '已连接的 Agent',
    note: null,
    about: `未新建任何授权时，任何 Agent 都可使用整个资料库。断开连接会移除连接时写入该产品的技能或 MCP 服务，再撤销授权；连接后被修改过的内容保留不变。${codexHint(root)}`,
    count: rows.length,
    blocks: rows.length > 0 ? [{ kind: 'list', items: rows }] : [{ kind: 'text', tone: 'neutral', text: '暂无已连接的 Agent' }],
    actions: [{ ...kernelAction('grant create', '新建授权', {}), as: 'icon', icon: 'plus' }],
  }

  const found = CONNECTABLE.map((p) => ({ p, signs: signsOf(p, env) }))
  const open = found.filter(({ p, signs }) => signs.length > 0 && !connections.some((c) => c.product === p.name))
  const missing = found.filter(({ signs }) => signs.length === 0)
  const offeredRows = open.map(({ p }) => {
    const way = waysOf(p)[0] as Way
    return {
      cell: { text: p.title, actor: { kind: 'agent' as const, name: p.name } },
      note: `${WAY_WORD[way]}：${whereOf(p, way, p.name, env)}`,
      actions: [{ ...kernelAction('agent connect', '连接', { product: p.name, name: false, via: false }), as: 'icon' as const, icon: 'plug' as const }],
    }
  })
  const offered: Block = {
    kind: 'section',
    title: '可连接',
    note: null,
    about: [
      '连接时新建以产品命名的授权，再将技能安装到该产品的技能目录；不支持技能的产品，将 MCP 服务登记到其配置中。',
      ...open.map(({ p, signs }) => `${p.title}：${signs.join('、')}。`),
      ...(missing.length === 0 ? [] : [`未检测到：${missing.map(({ p }) => `${p.title}（已检查 ${lookedFor(p)}）`).join('；')}。`]),
    ].join(''),
    count: open.length,
    blocks:
      offeredRows.length > 0
        ? [{ kind: 'list' as const, items: offeredRows }]
        : [{ kind: 'text' as const, tone: 'neutral' as const, text: connections.length > 0 ? '本机检测到的产品均已连接' : '本机未检测到可连接的 Agent。安装并至少打开一次后，可在此连接。' }],
    actions: [],
  }
  const pairing = await pairingSection(call)
  return { title: 'Agent', subtitle: null, blocks: [connected, ...(pairing === null ? [] : [pairing]), offered, mayDo(ownerFace.commands(ctx.library.plugins), ctx.library.plugins)], problems }
}
