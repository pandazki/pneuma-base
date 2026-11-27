// The home page's 「开始」: the steps of getting started, worked out from the library and this machine
// each time the page is shown, so nothing keeps a flag. The kernel knows two: whether an agent is
// connected to this library, and whether anything is in it. A part of the home page adds its own
// steps by answering a `steps` block, as the ledger does for whether an agent has worked here yet;
// they join the kernel's in one part, which is gone once every step is done. ARCHITECTURE.md section 6.
import { formOf, isFailure, type Action, type Block, type Step } from '@pneuma-base/sdk'
import { connectionFacts, WAY_WORD, whereOf } from './agent-commands.js'
import { endpointOf } from './endpoint.js'
import { KERNEL_COMMANDS } from './owner-commands.js'
import { sentenceBlock } from './pairing.js'
import { CONNECTABLE, lookedFor, signsOf, waysOf, type Way } from './products.js'
import { KERNEL_ENTRIES } from './places.js'
import { storageOf } from './storage.js'
import type { ViewerCall } from './viewer.js'

/** Where the app puts what the owner drops on it, and where the step tells the owner to put things. */
export const INBOX = 'inbox'

const shellWord = (v: string) => (/^[\w@%+=:,./~-]+$/u.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`)

/** 接上 in one click: the product fixed, nothing asked; the agents page offers the same with a form for the area and read-only. */
function connectAction(product: string): Action {
  const { inputs, call } = formOf(KERNEL_COMMANDS.find((c) => c.name === 'agent connect') ?? { name: 'agent connect', params: {} }, {
    fixed: { product, name: false, area: false, 'read-only': false, via: false },
  })
  return { label: '接上', tone: 'default', confirm: null, inputs, call }
}

/** Connect your agent: each product found on this machine, with 接上, or 已接上 and how; while an endpoint runs for this library, the sentence any agent connects itself by. */
async function connectStep({ ctx, table, env }: ViewerCall): Promise<Step> {
  const connections = await connectionFacts(ctx.home, env, table, ctx.library.root)
  const shown = CONNECTABLE.map((p) => ({ p, found: signsOf(p, env).length > 0, mine: connections.filter((c) => c.product === p.name) })).filter((x) => x.found || x.mine.length > 0)
  const items = shown.map(({ p, mine }) => {
    const way = mine[0]?.way ?? (waysOf(p)[0] as Way)
    const connected = mine.length > 0
    return {
      cell: { text: p.title, actor: { kind: 'agent' as const, name: p.name }, ...(connected ? { tag: { text: '已接上', tone: 'good' as const } } : {}) },
      note: connected ? `${WAY_WORD[way]} · 授权 ${mine.map((c) => c.grant).join('、')}` : `${WAY_WORD[way]}：${whereOf(p, way, p.name, env)}`,
      actions: connected ? [] : [connectAction(p.name)],
    }
  })
  const missing = CONNECTABLE.filter((p) => !shown.some((x) => x.p === p))
  const blocks: Block[] =
    items.length === 0
      ? [{ kind: 'text', tone: 'neutral', text: `这台机器上还没找到能接上的 agent（看了 ${missing.map((p) => `${p.title}：${lookedFor(p)}`).join('；')}）。装上一个、打开过一次之后，回到这里接上。` }]
      : [{ kind: 'list', items }]
  const endpoint = await endpointOf(ctx.home, ctx.library.root)
  if (endpoint !== null) blocks.push(sentenceBlock(endpoint.url, '首页的「等你决定」里'))
  const titles = [...new Set(connections.map((c) => c.title))]
  return { key: 'connect', title: '接上你的 agent', done: connections.length > 0, summary: connections.length > 0 ? `已接上 ${titles.join('、')}` : null, blocks }
}

/** How many entries of the root the step looks at: it only asks whether anything is there. */
const FIRST_LOOK = 50

/**
 * Put the first thing in: a drop area in the app, the command in a browser. Done once the root holds
 * anything but the kernel's own; a hidden name such as .DS_Store is not a thing put in. One look at
 * one page of the root, so the step costs the same however much the library holds.
 */
async function firstThingStep({ ctx }: ViewerCall): Promise<Step> {
  const { root } = ctx.library
  const page = await storageOf(root).overview('', { limit: FIRST_LOOK })
  const things = isFailure(page) ? [] : page.entries.filter((e) => !KERNEL_ENTRIES.has(e.place) && !e.place.startsWith('.'))
  const atLeast = !isFailure(page) && page.more !== null ? '至少 ' : ' '
  const command = `pneuma-base put <文件或文件夹> --to ${INBOX}/<名字> --brought --by owner --library ${shellWord(root)}`
  return {
    key: 'first',
    title: '放进第一样东西',
    done: things.length > 0,
    summary: things.length > 0 ? `库的根目录里有${atLeast}${things.length} 样东西` : null,
    blocks: [{ kind: 'drop', to: INBOX, command }],
  }
}

/** The kernel's own steps, in the order the owner takes them. */
export async function kernelSteps(call: ViewerCall): Promise<Step[]> {
  return [await connectStep(call), await firstThingStep(call)]
}

/**
 * The 「开始」 part from the kernel's steps and the `steps` blocks the home parts answered, which leave
 * those parts; null once every step is done. The rest of each part stays as it was.
 */
export function startPart(own: readonly Step[], parts: readonly Block[]): { start: Block | null; rest: Block[] } {
  const given = parts.flatMap((b) => (b.kind === 'steps' ? b.steps : []))
  const rest = parts.filter((b) => b.kind !== 'steps')
  const steps = [...own, ...given]
  const left = steps.filter((s) => !s.done).length
  if (left === 0) return { start: null, rest }
  const note = `做完了 ${steps.length - left} 步，还有 ${left} 步。`
  return { start: { kind: 'section', title: '开始', note, count: null, blocks: [{ kind: 'steps', steps }], actions: [] }, rest }
}
