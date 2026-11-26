// The guide an agent reads to connect itself: a generic one, and one per product of the products
// table. The command line prints it (`pneuma-base guide`) and the endpoint serves the same text
// (`/guide`, `/guide/<product>`). ARCHITECTURE.md section 6.
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
    `这是你的用户在这台机器上的 Pneuma Base 库，在 ${root}。`,
    '它是 agent 的资料库和制品库：找到的资料、做出来的东西都放进来，下次从这里找。',
    '你在库里做的每件事都记在你自己的名字下，主人看得到是哪个 agent 做的。',
    '要用它，先请主人把你接上（配对）：主人点一下允许，你就有了自己的授权名。',
  ].join('')
}

function pairing({ root, home, url }: GuideFacts, product: string): string {
  const launcher = quote(launcherPath(home))
  const cli = `${launcher} pair request ${product} "<为什么>" --library ${quote(root)}`
  const status = `${launcher} pair status <id>`
  const ask = url === null ? sh(cli) : [...sh(`curl -s -X POST ${url}/pair -H 'content-type: application/json' -d '{"product": "${product}", "why": "<一句话>"}'`), '', '能运行命令的，也可以用命令行：', '', ...sh(cli)]
  const poll = url === null ? sh(status) : [...sh(`curl -s ${url}/pair/<id>`), '', `或者 \`${status}\`。`]
  return [
    '## 接上（配对）',
    '',
    '1. 请求接入，说你是哪个产品、为什么要接上：',
    '',
    ...under([...ask, '', '答复里有 `id` 和 `code`。']),
    '2. 把 `code`（形如 `123-456`）给你的用户看：主人在 Pneuma Base 的首页上看到同一个码，核对后点「允许」。',
    '3. 每隔几秒问一次，直到 `state` 不再是 `waiting`：',
    '',
    ...under([
      ...poll,
      '',
      '- `connected`：接上了。答复里有你的授权名、之后运行的命令和先读什么。',
      '- `declined`：主人拒绝了，不要再请求。',
      '- `expired`：10 分钟没人允许，过期了；要接上，重新请求一次。',
    ]),
  ].join('\n')
}

function afterwards({ root, home }: GuideFacts, grant: string, note: string | null): string {
  const read = `先读 ${join(root, DESCRIPTION_FILE)}：库的规矩和动词都在里面。${note ?? ''}每件事开始时运行：`
  return ['## 接上之后', '', read, '', ...sh(`${quote(launcherPath(home))} @${grant} start "<一句话>"`)].join('\n')
}

function generic(facts: GuideFacts, product: string): string[] {
  const { root, home, url } = facts
  const launcher = quote(launcherPath(home))
  const where = (p: AgentProduct) => (url === null ? `\`${launcher} guide ${p.name} --library ${quote(root)}\`` : guideUrl(url, p.name))
  const products = ['## 各产品的说明', '', '有你的产品的，照它的说明做：', '', ...GUIDED.map((p) => `- ${p.title}（${p.name}）：${where(p)}`), '', '别的产品照这一页做，接上之后经 MCP 用这个库（见下面「只能接 MCP 的应用」）。'].join('\n')
  const http =
    url === null
      ? '- MCP（streamable HTTP）：Pneuma Base 应用或 `pneuma-base view` 开着时才有地址，到时再读一遍这份说明。'
      : `- MCP（streamable HTTP）：\`${mcpUrl(url, '<授权名>')}\`；加 \`?session=<名字>\` 给这次会话起个名字，一个名字是一个场景。`
  const mcp = ['## 只能接 MCP 的应用', '', '接上之后，不能运行命令、只能接 MCP 的应用这样连：', '', http, `- MCP（标准输入输出）：\`${launcher} @<授权名> mcp\``].join('\n')
  return [`# Pneuma Base：${basename(root)}`, opening(root), pairing(facts, product), products, afterwards(facts, '<授权名>', null), mcp]
}

function productGuide(facts: GuideFacts, p: AgentProduct): string[] {
  const way = waysOf(p)[0] as Way
  const how = ['## 在这里怎么接上', '', `主人允许之后，${p.title} 以「${WAY_WORD[way]}」接上：写在 ${whereOf(p, way, p.name, facts.env)}。接上之后：${p.next?.[way] ?? ''}`].join('\n')
  const likely = `你的授权名多半是 ${p.name}（以产品命名；这台机器上已经有同名的，会是 ${p.name}-2 这样的，以配对的答复为准）。`
  const known = ['## 已知的', '', ...[...(p.guide ?? []), ...(p.notice ? [p.notice(facts.root)] : [])].map((l) => `- ${l}`)].join('\n')
  return [`# Pneuma Base：${basename(facts.root)}（给 ${p.title}）`, opening(facts.root), how, pairing(facts, p.name), afterwards(facts, p.name, likely), known]
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
