// The guide an agent reads to connect itself: a generic one, and one per product of the products
// table. The command line prints it (`pneuma-base guide`) and the endpoint serves the same text
// (`/guide`, `/guide/<product>`). ARCHITECTURE.md「本机的 endpoint」.
import { basename, join } from 'node:path'
import { WAY_WORD, whereOf } from './agent-commands.js'
import { guideUrl, mcpUrl } from './endpoint.js'
import { launcherPath } from './launcher.js'
import { DESCRIPTION_FILE } from './paths.js'
import { CONNECTABLE, waysOf, type AgentProduct, type Env, type Way } from './products.js'
import { quote } from './requests.js'

/**
 * What the guide is written from. `url`: the origin of the endpoint serving this library
 * (`http://127.0.0.1:<port>`), null when none runs; the guide then gives the command-line forms only.
 */
export type GuideFacts = { root: string; home: string; env: Env; url: string | null }

/** The products with a guide of their own. */
const GUIDED: readonly AgentProduct[] = CONNECTABLE.filter((p) => p.guide !== undefined)

const sh = (line: string) => ['```sh', line, '```']
/** Lines under a list item, indented to its text. */
const under = (lines: readonly string[]) => lines.map((l) => (l === '' ? '' : `   ${l}`))

function opening(root: string): string {
  return [
    `此处是本机用户的 Pneuma Base 资料库，位于 ${root}。`,
    'Pneuma Base 是 Agent 的资料库和制品库：检索到的资料和生成的成果添加到此处，之后从此处检索。',
    'Agent 在资料库中的每项操作都记录在其授权名称下，所有者可查看每项操作的执行者。',
    '使用前需先连接（配对）：所有者允许后，Agent 获得自己的授权名称。',
  ].join('')
}

function pairing({ root, home, url }: GuideFacts, product: string): string {
  const launcher = quote(launcherPath(home))
  const cli = `${launcher} pair request ${product} "<原因>" --library ${quote(root)}`
  const status = `${launcher} pair status <id>`
  const ask = url === null ? sh(cli) : [...sh(`curl -s -X POST ${url}/pair -H 'content-type: application/json' -d '{"product": "${product}", "why": "<原因>"}'`), '', '可运行命令的 Agent 也可使用命令行：', '', ...sh(cli)]
  const poll = url === null ? sh(status) : [...sh(`curl -s ${url}/pair/<id>`), '', `或运行 \`${status}\`。`]
  return [
    '## 连接（配对）',
    '',
    '1. 请求接入，写明产品名称和接入原因：',
    '',
    ...under([...ask, '', '答复中包含 `id` 和 `code`。']),
    '2. 向用户展示 `code`（形如 `123-456`）：所有者在 Pneuma Base 首页看到同一配对码，核对后点击「允许」。',
    '3. 每隔几秒查询一次，直到 `state` 不再是 `waiting`：',
    '',
    ...under([
      ...poll,
      '',
      '- `connected`：已连接。答复中包含授权名称、之后运行的命令和需先读取的文件。',
      '- `declined`：所有者已拒绝，不要再次请求。',
      '- `expired`：10 分钟内未获允许，已过期；如需连接，请重新请求。',
    ]),
  ].join('\n')
}

function afterwards({ root, home }: GuideFacts, grant: string, note: string | null): string {
  const read = `先读取 ${join(root, DESCRIPTION_FILE)}：其中包含资料库的规则和基本命令。${note ?? ''}每项任务开始时运行：`
  return ['## 连接之后', '', read, '', ...sh(`${quote(launcherPath(home))} @${grant} start "<任务描述>"`)].join('\n')
}

function generic(facts: GuideFacts, product: string): string[] {
  const { root, home, url } = facts
  const launcher = quote(launcherPath(home))
  const where = (p: AgentProduct) => (url === null ? `\`${launcher} guide ${p.name} --library ${quote(root)}\`` : guideUrl(url, p.name))
  const products = ['## 各产品的说明', '', '已列出的产品按其说明操作：', '', ...GUIDED.map((p) => `- ${p.title}（${p.name}）：${where(p)}`), '', '其他产品按本页操作，连接后通过 MCP 使用此资料库（见下文「仅支持 MCP 的应用」）。'].join('\n')
  const http =
    url === null
      ? '- MCP（streamable HTTP）：仅在 Pneuma Base 应用或 `pneuma-base view` 运行时提供地址，届时重新读取本说明。'
      : `- MCP（streamable HTTP）：\`${mcpUrl(url, '<授权名称>')}\`；加 \`?session=<名称>\` 为本次会话命名，一个名称对应一个场景。`
  const mcp = ['## 仅支持 MCP 的应用', '', '连接后，无法运行命令、仅支持 MCP 的应用按以下方式连接：', '', http, `- MCP（标准输入输出）：\`${launcher} @<授权名称> mcp\``].join('\n')
  return [`# Pneuma Base：${basename(root)}`, opening(root), pairing(facts, product), products, afterwards(facts, '<授权名称>', null), mcp]
}

function productGuide(facts: GuideFacts, p: AgentProduct): string[] {
  const way = waysOf(p)[0] as Way
  const how = ['## 连接方式', '', `所有者允许后，${p.title} 以「${WAY_WORD[way]}」连接：写入 ${whereOf(p, way, p.name, facts.env)}。`].join('\n')
  const likely = `授权名称通常为 ${p.name}（以产品命名；本机已有同名授权时为 ${p.name}-2 等，以配对的答复为准）。`
  const known = ['## 注意事项', '', ...[...(p.guide ?? []), ...(p.notice ? [p.notice(facts.root)] : [])].map((l) => `- ${l}`)].join('\n')
  return [`# Pneuma Base：${basename(facts.root)}（适用于 ${p.title}）`, opening(facts.root), how, pairing(facts, p.name), afterwards(facts, p.name, likely), known]
}

/**
 * The guide for `product`: its own when the products table has a guide for it, else the generic
 * one (with the name filled in where the generic one says `<产品>`). `product` null: the generic one.
 * The caller has checked `product` against GRANT_NAME.
 */
export function guideText(facts: GuideFacts, product: string | null): string {
  const own = GUIDED.find((p) => p.name === product)
  return `${(own === undefined ? generic(facts, product ?? '<产品>') : productGuide(facts, own)).join('\n\n')}\n`
}
