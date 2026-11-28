// Connecting an agent product to a library in one command, and undoing it in one: a grant, then a
// skill in the folder the product loads skills from or an MCP server in its configuration, and a
// record on this machine of exactly what was written. Built from `grant create`, `grant revoke` and
// `skill install`. ARCHITECTURE.md「连接一个 agent」.
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { skillText } from './cognition.js'
import { addJsonEntry, appendToml, canonical, removeToml, replaceJsonEntry, tomlBlock, type ServerCommand, type ServerEntry } from './config-edit.js'
import {
  allConnections,
  dropConnection,
  keepBefore,
  missingDirs,
  readConnection,
  readText,
  saveConnection,
  sha256,
  stateOf,
  undo,
  writeBeside,
  type Connection,
  type Written,
} from './connections.js'
import { endpointOf, mcpUrl, type EndpointRecord } from './endpoint.js'
import { exists } from './machine-files.js'
import { GRANT_NAME } from './grants.js'
import { command, done, refused, type KernelCommand, type Outcome } from './kernel-command.js'
import { ensureLauncher, launcherPath, launcherProblems, ranText } from './launcher.js'
import { openLibrary } from './library.js'
import type { LibraryCall } from './owner.js'
import { makeContext, performOwner } from './pipeline.js'
import { CONNECTABLE, homeOf, lookedFor, productNamed, signsOf, tilde, waysOf, type AgentProduct, type Env, type McpConfig, type Way } from './products.js'
import { quote } from './requests.js'
import type { Grant, Library, PluginTable } from '@pneuma-base/sdk'

export const WAY_WORD: Record<Way, string> = { skill: '技能', mcp: 'MCP 服务', 'mcp-http': 'MCP 服务（HTTP）' }

/** In words, what connecting a product the products table does not know writes into other programs: nothing. */
export const NOTHING_WRITTEN = '不修改其他程序的文件'

export const titleOf = (name: string) => productNamed(name)?.title ?? name

const entryName = (grant: string) => `pneuma-base-${grant}`
/** The launcher exports the home it lives in, so the entry needs no environment of its own. */
const serverCommand = (grant: string, launcher: string): ServerCommand => ({ command: launcher, args: [`@${grant}`, 'mcp'], env: {} })
const jsonValue = (mcp: McpConfig, e: ServerEntry) => ({ ...(mcp.type === undefined ? {} : { type: mcp.type }), ...('url' in e ? { url: e.url } : { command: e.command, args: e.args }) })

const mcpOf = (p: AgentProduct, way: 'mcp' | 'mcp-http') => (way === 'mcp' ? p.mcp : p.mcpUrl) as McpConfig

/** Where a way of connecting a product writes, in words, for the grant named. */
export function whereOf(p: AgentProduct, way: Way, grant: string, env: Env): string {
  const home = homeOf(env)
  if (way === 'skill') return tilde(join(home, p.skills as string, entryName(grant), 'SKILL.md'), home)
  const mcp = mcpOf(p, way)
  return `${tilde(join(home, mcp.file), home)} 中的 ${mcp.key}`
}

/** How an agent connected under `grant` runs every verb, and how an application that only speaks MCP reaches the library. */
export function reachOf(launcher: string, grant: string, endpoint: Pick<EndpointRecord, 'url'> | null): { command: string; mcp: { url: string | null; stdio: string } } {
  const command = `${quote(launcher)} @${grant}`
  return { command, mcp: { url: endpoint === null ? null : mcpUrl(endpoint.url, grant), stdio: `${command} mcp` } }
}

/** What connecting will write, found before the grant is issued so a refusal leaves nothing behind; or that it is there already. */
type Plan = { kind: 'write'; write: (call: LibraryCall) => Promise<Written>; changes: string | null } | { kind: 'same'; written: Written } | { kind: 'refused'; outcome: Outcome }

type Planning = { product: AgentProduct; grant: string; root: string; call: LibraryCall; mine: Connection | null; skillInstall: KernelCommand }

/**
 * What connecting writes, by the way: a skill; an MCP entry that runs the launcher; one that names the
 * endpoint's address, refused when none runs for this library. A product the table does not know
 * gets nothing written: it reaches the library by itself.
 */
async function planOf(product: AgentProduct | null, way: Way, endpoint: EndpointRecord | null, planning: Omit<Planning, 'product'>): Promise<Plan> {
  if (product === null) return planning.mine?.wrote.kind === 'none' ? { kind: 'same', written: planning.mine.wrote } : { kind: 'write', changes: null, write: async () => ({ kind: 'none' }) }
  const p = { ...planning, product }
  if (way === 'skill') return planSkill(p)
  const plan = (mcp: McpConfig, entry: ServerEntry) => (mcp.format === 'toml' ? planToml(p, mcp, entry) : planJson(p, mcp, entry))
  if (way === 'mcp') return plan(mcpOf(product, way), serverCommand(p.grant, launcherPath(p.call.ctx.home)))
  if (endpoint === null) {
    const text = `${product.title} 需通过本机地址连接，当前没有为此资料库开放的地址：Pneuma Base 应用运行时提供该地址，也可先运行 pneuma-base view ${quote(p.root)}。`
    return { kind: 'refused', outcome: refused('no-endpoint', text) }
  }
  return plan(mcpOf(product, way), { url: mcpUrl(endpoint.url, p.grant) })
}

const taken = (where: string) =>
  refused('taken', `${where} 已存在同名内容，不是连接时写入的，或写入后已修改。未做改动。如需连接，请先将其移走，或用 --name 指定其他授权名称。`)

async function planSkill({ product, grant, root, call, mine, skillInstall }: Planning): Promise<Plan> {
  const home = homeOf(call.env)
  const skills = join(home, product.skills as string)
  const folder = join(skills, entryName(grant))
  const file = join(folder, 'SKILL.md')
  const content = skillText(grant, root, launcherPath(call.ctx.home))
  const own = mine?.wrote.kind === 'skill' ? mine.wrote : null
  const current = await readText(file)
  const written = (dirs: string[]): Written => ({ kind: 'skill', file, fingerprint: sha256(content), dirs })
  if (current === content) return { kind: 'same', written: written(own?.dirs ?? []) }
  const ours = current !== null && own !== null && sha256(current) === own.fingerprint
  const occupied = current !== null ? !ours : (await readdir(folder).catch(() => [])).length > 0
  if (occupied) return { kind: 'refused', outcome: taken(tilde(folder, home)) }
  const dirs = own?.dirs ?? (await missingDirs(folder, home))
  return {
    kind: 'write',
    changes: null,
    write: async (bound) => {
      const r = await skillInstall.run({ grant, agent: product.name, dir: skills }, bound)
      if (r.answer.outcome === 'refused') throw new Error(r.answer.text)
      return written(dirs)
    },
  }
}

/** Writes `next` over another program's file, if it still reads as it did when planned, keeping a copy of it first. */
function writeOver(call: LibraryCall, grant: string, file: string, text: string | null, next: string, written: Written): () => Promise<Written> {
  return async () => {
    if ((await readText(file)) !== text) throw new Error(`${tilde(file, homeOf(call.env))} 在连接期间被其他程序修改，请重新连接`)
    await keepBefore(call.ctx.home, grant, file)
    await writeBeside(file, next)
    return written
  }
}

/** A refusal for a file that cannot be edited safely, with what to paste by hand and the grant to issue first. */
function pasteInstead(where: string, why: string, snippet: string, grant: string, product: AgentProduct, root: string): Plan {
  const issue = `pneuma-base grant create ${grant} --agent ${product.name} --library ${root}`
  return { kind: 'refused', outcome: refused('unreadable-config', `${where} ${why}，未修改。\n如需连接，请先新建授权：\n  ${issue}\n再手动添加以下内容：\n${snippet}`) }
}

async function planJson({ product, grant, root, call, mine }: Planning, mcp: McpConfig, entry: ServerEntry): Promise<Plan> {
  const env = call.env
  const home = homeOf(env)
  const file = join(home, mcp.file)
  const name = entryName(grant)
  const value = jsonValue(mcp, entry)
  const fingerprint = sha256(canonical(value))
  const own = mine?.wrote.kind === 'json' ? mine.wrote : null
  const text = await readText(file)
  const added = addJsonEntry(text, mcp.key, name, value)
  const where = tilde(file, home)
  switch (added.outcome) {
    case 'unreadable':
      return pasteInstead(where, `无法解析（${added.why}）`, JSON.stringify({ [name]: value }, null, 2), grant, product, root)
    case 'present': {
      const kept = { kind: 'json' as const, file, key: mcp.key, name, created: own?.created ?? ('entry' as const), innerWas: own?.innerWas ?? null, dirs: own?.dirs ?? [] }
      if (canonical(added.value) === canonical(value)) return { kind: 'same', written: { ...kept, fingerprint } }
      if (own === null || sha256(canonical(added.value)) !== own.fingerprint) return { kind: 'refused', outcome: taken(`${where} 中 ${mcp.key} 下的 ${name}`) }
      return { kind: 'write', changes: where, write: writeOver(call, grant, file, text, replaceJsonEntry(text as string, mcp.key, name, value), { ...kept, fingerprint }) }
    }
    case 'added': {
      const written: Written = { kind: 'json', file, key: mcp.key, name, fingerprint, created: added.created, innerWas: added.innerWas, dirs: await missingDirs(dirname(file), home) }
      return { kind: 'write', changes: text === null ? null : where, write: writeOver(call, grant, file, text, added.text, written) }
    }
  }
}

async function planToml({ product, grant, root, call, mine }: Planning, mcp: McpConfig, entry: ServerEntry): Promise<Plan> {
  const home = homeOf(call.env)
  const file = join(home, mcp.file)
  const name = entryName(grant)
  const block = tomlBlock(mcp.key, name, entry)
  const own = mine?.wrote.kind === 'toml' ? mine.wrote : null
  const text = await readText(file)
  const where = tilde(file, home)
  // Ours, unchanged, written with another command or address: take it out, then append it anew.
  const base = own !== null && text !== null && !text.includes(block) ? removeToml(text, own.appended) : null
  const added = appendToml(base ?? text, mcp.key, name, block)
  switch (added.outcome) {
    case 'taken':
      return pasteInstead(where, added.why, block, grant, product, root)
    case 'present':
      return { kind: 'same', written: { kind: 'toml', file, key: mcp.key, name, appended: own?.appended ?? block, createdFile: own?.createdFile ?? false, dirs: own?.dirs ?? [] } }
    case 'added': {
      const written: Written = { kind: 'toml', file, key: mcp.key, name, appended: added.appended, createdFile: own?.createdFile ?? text === null, dirs: own?.dirs ?? (await missingDirs(dirname(file), home)) }
      return { kind: 'write', changes: text === null ? null : where, write: writeOver(call, grant, file, text, added.text, written) }
    }
  }
}

/** What was written, in words. */
function wroteText(w: Written, home: string): string {
  if (w.kind === 'none') return NOTHING_WRITTEN
  if (w.kind === 'skill') return tilde(w.file, home)
  if (w.kind === 'json') return `${tilde(w.file, home)} 中 ${w.key} 下的 ${w.name}`
  return `${tilde(w.file, home)} 中的 [${w.key}.${w.name}]`
}

/** One connection as the owner reads it: the grant's area and access come from the library, which is authoritative. */
export type ConnectionFacts = {
  grant: string
  product: string
  title: string
  library: string
  way: Way
  area: string | null
  readOnly: boolean | null
  where: string
  inPlace: boolean
  /** What is wrong, in words: what was written changed or gone, the grant revoked, the command line moved. */
  problems: string[]
}

const STATE_WORD = { changed: '已修改', gone: '已缺失', unreadable: '所在文件无法解析' } as const

/** What is wrong with what a connection runs: the launcher, or the node and entry file a record from before it names. */
async function commandProblems(c: Connection['command']): Promise<string[]> {
  if (c === null) return []
  if ('launcher' in c) return launcherProblems(c.launcher)
  return [...((await exists(c.node)) ? [] : [`node 已缺失（${c.node}）`]), ...((await exists(c.entry)) ? [] : [`命令行程序已缺失（${c.entry}）`])]
}

/** The connections recorded on this machine, those of the library at `root` when one is given, each checked against what is on disk now. */
export async function connectionFacts(home: string, env: Env, table: PluginTable, root: string | null): Promise<ConnectionFacts[]> {
  const libraries = new Map<string, Library | null>()
  const out: ConnectionFacts[] = []
  for (const c of await allConnections(home)) {
    if (root !== null && c.library !== root) continue
    if (!libraries.has(c.library)) libraries.set(c.library, await openLibrary(c.library, table))
    const library = libraries.get(c.library) ?? null
    const grant = library?.config.grants.find((g) => g.name === c.grant && g.id === c.grantId) ?? null
    const state = await stateOf(c.wrote)
    const problems = [
      ...(state === 'in-place' ? [] : [`连接时写入的内容${STATE_WORD[state]}`]),
      ...(library === null ? ['资料库不存在'] : grant === null ? ['授权已撤销'] : []),
      ...(await commandProblems(c.command)),
    ]
    out.push({ grant: c.grant, product: c.product, title: titleOf(c.product), library: c.library, way: c.way, area: grant?.area ?? null, readOnly: grant?.readOnly ?? null, where: wroteText(c.wrote, homeOf(env)), inPlace: problems.length === 0, problems })
  }
  return out
}

const accessText = (g: Pick<Grant, 'area' | 'readOnly'>) => `${g.area === null ? '整个资料库' : `区域 ${g.area}/`}，${g.readOnly ? '只读' : '读写'}`

type Base = { grantCreate: KernelCommand; grantRevoke: KernelCommand; skillInstall: KernelCommand }

/** The four commands, built on the kernel's own `grant create`, `grant revoke` and `skill install`. */
export function agentCommands({ grantCreate, grantRevoke, skillInstall }: Base): KernelCommand[] {
  const issue = grantCreate as Extract<KernelCommand, { scope: 'library' }>
  const revoke = grantRevoke as Extract<KernelCommand, { scope: 'library' }>
  const install = skillInstall as Extract<KernelCommand, { scope: 'library' }>
  return [
    command({
      name: 'agent detect',
      summary: '检测本机的 Agent 产品及各自的连接方式；仅检查文件和程序是否存在',
      params: {},
      destructive: false,
      ownerOnly: true,
      readOnly: true,
      scope: 'machine',
      async run(_values, call) {
        const root = call.ctx.library?.root ?? null
        const connections = (await allConnections(call.ctx.home)).filter((c) => root === null || c.library === root)
        const products = CONNECTABLE.map((p) => {
          const signs = signsOf(p, call.env)
          return { name: p.name, title: p.title, found: signs.length > 0, signs, ways: waysOf(p).map((way) => ({ way, where: whereOf(p, way, '<授权名称>', call.env) })), connected: connections.filter((c) => c.product === p.name).map((c) => c.grant) }
        })
        const lines = products.flatMap((p) => {
          const product = productNamed(p.name) as AgentProduct
          const head = `${p.title}（${p.name}）：${p.found ? `已检测到，${p.signs.join('、')}` : `未检测到，已检查 ${lookedFor(product)}`}`
          const ways = p.ways.map((w, i) => `  ${WAY_WORD[w.way]}${i === 0 && p.ways.length > 1 ? '（默认）' : ''}：${w.where}`)
          const next = p.connected.length > 0 ? [`  已连接：${p.connected.join('、')}`] : p.found ? [`  连接：pneuma-base agent connect ${p.name} --library ${root ?? '<资料库目录>'}`] : []
          return [head, ...ways, ...next]
        })
        return done(lines.join('\n'), { products })
      },
    }),
    command({
      name: 'agent connect',
      act: { kind: 'connected', object: 'product' },
      summary: '将 Agent 产品连接到此资料库：新建授权，再安装技能或登记 MCP 服务；产品表中没有的产品仅新建授权，由其自行通过 MCP 连接',
      params: {
        positional: [{ name: 'product', hint: '产品', required: true, pattern: GRANT_NAME.source }],
        flags: [
          { name: 'name', hint: '授权名称，默认为产品名称', kind: 'value', pattern: GRANT_NAME.source },
          { name: 'area', hint: '子文件夹', kind: 'value' },
          { name: 'read-only', hint: '只读', kind: 'boolean' },
          { name: 'via', hint: '连接方式', kind: 'value', options: (Object.keys(WAY_WORD) as Way[]).map((value) => ({ value, label: WAY_WORD[value] })) },
        ],
      },
      destructive: false,
      ownerOnly: true,
      scope: 'library',
      async run({ product: wanted, name: nameInput, area, 'read-only': readOnly, via }, call) {
        const product = CONNECTABLE.find((p) => p.name === wanted) ?? null
        const title = titleOf(wanted)
        const ways: Way[] = product === null ? ['mcp-http'] : waysOf(product)
        const way = (via ?? ways[0]) as Way
        if (!ways.includes(way)) return refused('no-such-way', `${title} 不支持此连接方式：${WAY_WORD[way]}。支持的方式：${ways.map((w) => WAY_WORD[w]).join('、')}。`)
        if (product !== null && signsOf(product, call.env).length === 0) return refused('not-found', `本机未检测到 ${title}：已检查 ${lookedFor(product)}。请安装并至少打开一次后再连接。`)
        const grant = nameInput ?? wanted
        const { library } = call.ctx
        const mine = await readConnection(call.ctx.home, grant)
        if (mine !== null && (mine.product !== wanted || mine.library !== library.root || mine.way !== way)) {
          return refused('name-taken', `授权名称 ${grant} 已用于将 ${titleOf(mine.product)}（${WAY_WORD[mine.way]}）连接到 ${mine.library}。请先运行 pneuma-base agent disconnect ${grant}，或用 --name 指定其他授权名称。`)
        }
        const endpoint = way === 'mcp-http' ? await endpointOf(call.ctx.home, library.root) : null
        const plan = await planOf(product, way, endpoint, { grant, root: library.root, call, mine, skillInstall: install })
        if (plan.kind === 'refused') return plan.outcome

        const reused = library.config.grants.some((g) => g.name === grant)
        const issued = await issue.run({ name: grant, agent: wanted, area, 'read-only': readOnly }, call)
        if (issued.answer.outcome === 'refused') return refused(issued.answer.reason, `${issued.answer.text}\n如需连接 ${title}，请用 --name 指定其他授权名称，例如 --name ${wanted}-2。`)
        const updated = issued.library ?? library
        const given = (issued.answer.data as { grant: Grant }).grant
        const bound: LibraryCall = { ...call, ctx: { ...call.ctx, library: updated } }
        const home = homeOf(call.env)
        const grantLine = `授权：${grant}（${reused ? '沿用已有授权' : '新建'}），${accessText(given)}`
        const launcher = await ensureLauncher(call.ctx.home, call.env)
        const launcherLine = launcher.changed ? [ranText(launcher)] : []
        if (plan.kind === 'same' && mine !== null && mine.grantId === given.id) {
          const head = launcher.changed ? `${title} 已连接，连接时写入的内容未变，命令已修复。` : `${title} 已连接，未做任何修改。`
          return done([head, grantLine, `已写入：${wroteText(plan.written, home)}`, ...launcherLine].join('\n'), { connection: mine }, updated)
        }

        const written = plan.kind === 'same' ? plan.written : await plan.write(bound)
        const connection: Connection = { format: 1, grant, grantId: given.id, product: wanted, library: library.root, way, at: call.ctx.now, wrote: written, command: { launcher: launcher.launcher.path } }
        await saveConnection(call.ctx.home, connection)
        const before = plan.kind === 'write' && plan.changes !== null ? [`修改前的副本：${tilde(join(call.ctx.home, 'connections', grant, 'before'), home)}/`] : []
        const reach = reachOf(launcher.launcher.path, grant, endpoint)
        const live = '（仅在 Pneuma Base 应用或 pneuma-base view 为此资料库运行时可连接）'
        const how =
          product === null
            ? [`命令：${reach.command} <命令> …`, ...(reach.mcp.url === null ? [] : [`MCP（HTTP）：${reach.mcp.url}${live}`]), `MCP（标准输入输出）：${reach.mcp.stdio}`]
            : way === 'mcp'
              ? [`运行：${reach.mcp.stdio}`]
              : way === 'mcp-http'
                ? [`连接：${reach.mcp.url ?? ''}${live}`]
                : []
        const next = product === null ? `Agent 先读取 ${join(library.root, 'PNEUMA-BASE.md')}，再通过上述命令或 MCP 操作。` : (product.next?.[way] ?? '')
        const notice = way === 'skill' && product?.notice ? [product.notice(library.root)] : []
        const lines = [
          `已将 ${title} 连接到此资料库（${WAY_WORD[way]}）。`,
          grantLine,
          written.kind === 'none' ? `${NOTHING_WRITTEN}：由其自行连接。` : `${plan.kind === 'same' ? '已存在' : '已写入'}：${wroteText(written, home)}`,
          ...how,
          ...launcherLine,
          ...before,
          `下一步：${next}`,
          ...notice,
          `断开连接：pneuma-base agent disconnect ${grant}`,
        ]
        return done(lines.join('\n'), { connection }, updated)
      },
    }),
    command({
      name: 'agent disconnect',
      act: { kind: 'disconnected', object: 'grant' },
      summary: '断开已连接的 Agent：移除连接时写入的内容，再撤销授权',
      params: { positional: [{ name: 'grant', hint: '授权名称', required: true }], flags: [{ name: 'keep-grant', hint: '保留授权', kind: 'boolean' }] },
      destructive: false,
      ownerOnly: true,
      scope: 'machine',
      async run({ grant, 'keep-grant': keep }, call) {
        const record = await readConnection(call.ctx.home, grant)
        if (record === null) return done(`本机没有名为 ${grant} 的连接，未执行任何操作。`, { removed: false })
        if (call.ctx.library !== null && call.ctx.library.root !== record.library) return refused('other-library', `连接 ${grant} 属于 ${record.library}，不属于此资料库。`)
        const title = titleOf(record.product)
        const home = homeOf(call.env)
        const act = async (bound: LibraryCall | null): Promise<Outcome> => {
          const { wrote } = record
          const where = wroteText(wrote, home)
          const state = await undo(wrote)
          const lines =
            wrote.kind === 'none'
              ? []
              : [state === 'in-place' ? `已移除：${where}` : state === 'changed' ? `${where} 在连接后已修改，未做改动；如不再需要，请手动删除。` : state === 'gone' ? `${where} 已缺失。` : `${tilde(wrote.file, home)} 无法解析，未做改动。`]
          let library = undefined
          if (keep) lines.push(`已保留授权 ${grant}。重新连接：pneuma-base agent connect ${record.product} --library ${record.library}${grant === record.product ? '' : ` --name ${grant}`}`)
          else if (bound === null) lines.push(`资料库 ${record.library} 不存在，授权随之失效。`)
          else if (!bound.ctx.library.config.grants.some((g) => g.name === grant && g.id === record.grantId)) lines.push(`授权 ${grant} 不存在。`)
          else {
            const r = await revoke.run({ name: grant }, bound)
            library = r.library
            lines.push(r.answer.outcome === 'done' ? `已撤销授权 ${grant}。` : r.answer.text)
          }
          await dropConnection(call.ctx.home, grant)
          return done(`已断开 ${title}（${grant}）的连接。\n${lines.join('\n')}`, { removed: state === 'in-place', state }, library)
        }
        if (call.ctx.library !== null) return act({ ...call, ctx: call.ctx })
        const library = keep ? null : await openLibrary(record.library, call.table)
        if (library === null) return act(null)
        // Run from the command line with no library at hand: the grant is revoked in its library, as an operation of that library.
        const ctx = makeContext(library, call.ctx.actor, call.ctx.session, call.ctx.home, call.ctx.now)
        const r = await performOwner(ctx, 'agent disconnect', { positional: [grant], flags: {} }, { destructive: false, readOnly: false, act: { kind: 'disconnected', object: grant } }, () => act({ ...call, ctx }))
        const { problems, ...answer } = r
        return { answer, problems }
      },
    }),
    command({
      name: 'agent list',
      summary: '已连接的 Agent：产品、授权、连接方式、区域、是否只读，连接时写入的内容是否完好；带 --library 时仅列出此资料库的连接',
      params: {},
      destructive: false,
      ownerOnly: true,
      readOnly: true,
      scope: 'machine',
      async run(_values, call) {
        const connections = await connectionFacts(call.ctx.home, call.env, call.table, call.ctx.library?.root ?? null)
        if (connections.length === 0) return done('暂无已连接的 Agent。运行 pneuma-base agent detect 查看本机的 Agent 产品。', { connections })
        const lines = connections.flatMap((c) => [
          `${c.grant}  ${c.title}  ${WAY_WORD[c.way]}  ${c.area === null ? '整个资料库' : c.area}  ${c.readOnly === null ? '—' : c.readOnly ? '只读' : '读写'}  ${c.inPlace ? '使用中' : c.problems.join('；')}`,
          `    ${c.where}${call.ctx.library === null ? `\n    资料库：${c.library}` : ''}`,
        ])
        return done(lines.join('\n'), { connections })
      },
    }),
  ]
}

