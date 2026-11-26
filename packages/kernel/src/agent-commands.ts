// Connecting an agent product to a library in one command, and undoing it in one: a grant, then a
// skill in the folder the product loads skills from or an MCP server in its configuration, and a
// record on this machine of exactly what was written. Built from `grant issue`, `grant revoke` and
// `skill install`. ARCHITECTURE.md section 6.
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { skillText } from './cognition.js'
import { addJsonEntry, appendToml, canonical, removeToml, replaceJsonEntry, tomlBlock, type ServerCommand } from './config-edit.js'
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
import { exists } from './files.js'
import { GRANT_NAME } from './grants.js'
import { command, done, refused, type KernelCommand, type Outcome } from './kernel-command.js'
import { ensureLauncher, launcherPath, launcherProblems, ranText } from './launcher.js'
import { openLibrary } from './library.js'
import type { LibraryCall } from './owner.js'
import { makeContext, performOwner } from './pipeline.js'
import { CONNECTABLE, homeOf, lookedFor, productNamed, signsOf, tilde, waysOf, type AgentProduct, type Env, type McpConfig, type Way } from './products.js'
import type { Grant, Library, PluginTable } from '@pneuma-base/sdk'

export const WAY_WORD: Record<Way, string> = { skill: '技能', mcp: 'MCP 服务' }

const titleOf = (name: string) => productNamed(name)?.title ?? name

const entryName = (grant: string) => `pneuma-base-${grant}`
/** The launcher exports the home it lives in, so the entry needs no environment of its own. */
const serverCommand = (grant: string, launcher: string): ServerCommand => ({ command: launcher, args: [`@${grant}`, 'mcp'], env: {} })
const jsonValue = (mcp: McpConfig, s: ServerCommand) => ({ ...(mcp.stdio ? { type: 'stdio' } : {}), command: s.command, args: s.args })

/** Where a way of connecting a product writes, in words, for the grant named. */
export function whereOf(p: AgentProduct, way: Way, grant: string, env: Env): string {
  const home = homeOf(env)
  if (way === 'skill') return tilde(join(home, p.skills as string, entryName(grant), 'SKILL.md'), home)
  const mcp = p.mcp as McpConfig
  return `${tilde(join(home, mcp.file), home)} 的 ${mcp.key}`
}

/** What connecting will write, found before the grant is issued so a refusal leaves nothing behind; or that it is there already. */
type Plan = { kind: 'write'; write: (call: LibraryCall) => Promise<Written>; changes: string | null } | { kind: 'same'; written: Written } | { kind: 'refused'; outcome: Outcome }

type Planning = { product: AgentProduct; grant: string; root: string; call: LibraryCall; mine: Connection | null; skillInstall: KernelCommand }

const taken = (where: string) =>
  refused('taken', `${where} 已经有一份同名的，不是接上时写的，或写了之后被改过。没有动它。要接上，先把它挪开，或用 --name 另起一个授权名。`)

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
    if ((await readText(file)) !== text) throw new Error(`${tilde(file, homeOf(call.env))} 在接上的时候被别的程序改了，再接一次`)
    await keepBefore(call.ctx.home, grant, file)
    await writeBeside(file, next)
    return written
  }
}

/** A refusal for a file that cannot be edited safely, with what to paste by hand and the grant to issue first. */
function pasteInstead(where: string, why: string, snippet: string, grant: string, product: AgentProduct, root: string): Plan {
  const issue = `pneuma-base grant issue ${grant} --agent ${product.name} --library ${root}`
  return { kind: 'refused', outcome: refused('unreadable-config', `${where} ${why}，没有改它。\n要接上，先发授权：\n  ${issue}\n再把下面这段自己加进去：\n${snippet}`) }
}

async function planJson({ product, grant, root, call, mine }: Planning): Promise<Plan> {
  const env = call.env
  const home = homeOf(env)
  const mcp = product.mcp as McpConfig
  const file = join(home, mcp.file)
  const name = entryName(grant)
  const value = jsonValue(mcp, serverCommand(grant, launcherPath(call.ctx.home)))
  const fingerprint = sha256(canonical(value))
  const own = mine?.wrote.kind === 'json' ? mine.wrote : null
  const text = await readText(file)
  const added = addJsonEntry(text, mcp.key, name, value)
  const where = tilde(file, home)
  switch (added.outcome) {
    case 'unreadable':
      return pasteInstead(where, `读不懂（${added.why}）`, JSON.stringify({ [name]: value }, null, 2), grant, product, root)
    case 'present': {
      const kept = { kind: 'json' as const, file, key: mcp.key, name, created: own?.created ?? ('entry' as const), innerWas: own?.innerWas ?? null, dirs: own?.dirs ?? [] }
      if (canonical(added.value) === canonical(value)) return { kind: 'same', written: { ...kept, fingerprint } }
      if (own === null || sha256(canonical(added.value)) !== own.fingerprint) return { kind: 'refused', outcome: taken(`${where} 的 ${mcp.key} 里的 ${name}`) }
      return { kind: 'write', changes: where, write: writeOver(call, grant, file, text, replaceJsonEntry(text as string, mcp.key, name, value), { ...kept, fingerprint }) }
    }
    case 'added': {
      const written: Written = { kind: 'json', file, key: mcp.key, name, fingerprint, created: added.created, innerWas: added.innerWas, dirs: await missingDirs(dirname(file), home) }
      return { kind: 'write', changes: text === null ? null : where, write: writeOver(call, grant, file, text, added.text, written) }
    }
  }
}

async function planToml({ product, grant, root, call, mine }: Planning): Promise<Plan> {
  const home = homeOf(call.env)
  const mcp = product.mcp as McpConfig
  const file = join(home, mcp.file)
  const name = entryName(grant)
  const block = tomlBlock(mcp.key, name, serverCommand(grant, launcherPath(call.ctx.home)))
  const own = mine?.wrote.kind === 'toml' ? mine.wrote : null
  const text = await readText(file)
  const where = tilde(file, home)
  // Ours, unchanged, written with another command (before the launcher): take it out, then append it anew.
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
  if (w.kind === 'skill') return tilde(w.file, home)
  if (w.kind === 'json') return `${tilde(w.file, home)} 的 ${w.key} 里的 ${w.name}`
  return `${tilde(w.file, home)} 里的 [${w.key}.${w.name}]`
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

const STATE_WORD = { changed: '被改过', gone: '不在了', unreadable: '所在的文件读不懂了' } as const

/** What is wrong with what a connection runs: the launcher, or the node and entry file a record from before it names. */
async function commandProblems(c: Connection['command']): Promise<string[]> {
  if (c === null) return []
  if ('launcher' in c) return launcherProblems(c.launcher)
  return [...((await exists(c.node)) ? [] : [`node 不在了（${c.node}）`]), ...((await exists(c.entry)) ? [] : [`命令行不在了（${c.entry}）`])]
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
      ...(state === 'in-place' ? [] : [`接上时写的${STATE_WORD[state]}`]),
      ...(library === null ? ['库不在了'] : grant === null ? ['授权已撤回'] : []),
      ...(await commandProblems(c.command)),
    ]
    out.push({ grant: c.grant, product: c.product, title: titleOf(c.product), library: c.library, way: c.way, area: grant?.area ?? null, readOnly: grant?.readOnly ?? null, where: wroteText(c.wrote, homeOf(env)), inPlace: problems.length === 0, problems })
  }
  return out
}

const accessText = (g: Pick<Grant, 'area' | 'readOnly'>) => `${g.area === null ? '整个库' : `区域 ${g.area}/`}，${g.readOnly ? '只读' : '读写'}`

type Base = { grantIssue: KernelCommand; grantRevoke: KernelCommand; skillInstall: KernelCommand }

/** The four commands, built on the kernel's own `grant issue`, `grant revoke` and `skill install`. */
export function agentCommands({ grantIssue, grantRevoke, skillInstall }: Base): KernelCommand[] {
  const issue = grantIssue as Extract<KernelCommand, { scope: 'library' }>
  const revoke = grantRevoke as Extract<KernelCommand, { scope: 'library' }>
  const install = skillInstall as Extract<KernelCommand, { scope: 'library' }>
  return [
    command({
      name: 'agent detect',
      summary: '这台机器上有哪些 agent 产品，各能怎么接上；只看文件和程序在不在',
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
          return { name: p.name, title: p.title, found: signs.length > 0, signs, ways: waysOf(p).map((way) => ({ way, where: whereOf(p, way, '<授权名>', call.env) })), connected: connections.filter((c) => c.product === p.name).map((c) => c.grant) }
        })
        const lines = products.flatMap((p) => {
          const product = productNamed(p.name) as AgentProduct
          const head = `${p.title}（${p.name}）：${p.found ? `找到了，${p.signs.join('、')}` : `没找到，看了 ${lookedFor(product)}`}`
          const ways = p.ways.map((w, i) => `  ${WAY_WORD[w.way]}${i === 0 && p.ways.length > 1 ? '（缺省）' : ''}：${w.where}`)
          const next = p.connected.length > 0 ? [`  已接上：${p.connected.join('、')}`] : p.found ? [`  接上：pneuma-base agent connect ${p.name} --library ${root ?? '<库的目录>'}`] : []
          return [head, ...ways, ...next]
        })
        return done(lines.join('\n'), { products })
      },
    }),
    command({
      name: 'agent connect',
      summary: '把一个 agent 产品接到这个库：发授权，再装技能或登记 MCP 服务',
      params: {
        positional: [{ name: 'product', hint: '产品', required: true }],
        flags: [
          { name: 'name', hint: '授权名，缺省是产品名', kind: 'value', pattern: GRANT_NAME.source },
          { name: 'area', hint: '子文件夹', kind: 'value' },
          { name: 'read-only', hint: '只读', kind: 'boolean' },
          { name: 'via', hint: '怎么接', kind: 'value', options: [{ value: 'skill', label: WAY_WORD.skill }, { value: 'mcp', label: WAY_WORD.mcp }] },
        ],
      },
      destructive: false,
      ownerOnly: true,
      scope: 'library',
      async run({ product: wanted, name: nameInput, area, 'read-only': readOnly, via }, call) {
        const product = CONNECTABLE.find((p) => p.name === wanted)
        if (product === undefined) return refused('unknown-product', `不认识这个 agent 产品：${wanted}。能接上的：${CONNECTABLE.map((p) => p.name).join('、')}。`)
        const ways = waysOf(product)
        const way = (via ?? ways[0]) as Way
        if (!ways.includes(way)) return refused('no-such-way', `${product.title} 不能这样接上：${WAY_WORD[way]}。它能用的：${ways.map((w) => WAY_WORD[w]).join('、')}。`)
        if (signsOf(product, call.env).length === 0) return refused('not-found', `这台机器上没找到 ${product.title}：看了 ${lookedFor(product)}。装上它、打开过一次之后再接。`)
        const grant = nameInput ?? product.name
        const { library } = call.ctx
        const mine = await readConnection(call.ctx.home, grant)
        if (mine !== null && (mine.product !== product.name || mine.library !== library.root || mine.way !== way)) {
          return refused('name-taken', `授权名 ${grant} 已经用来把 ${titleOf(mine.product)}（${WAY_WORD[mine.way]}）接到 ${mine.library}。先 pneuma-base agent disconnect ${grant}，或用 --name 另起一个授权名。`)
        }
        const planning: Planning = { product, grant, root: library.root, call, mine, skillInstall: install }
        const plan = way === 'skill' ? await planSkill(planning) : product.mcp?.format === 'toml' ? await planToml(planning) : await planJson(planning)
        if (plan.kind === 'refused') return plan.outcome

        const reused = library.config.grants.some((g) => g.name === grant)
        const issued = await issue.run({ name: grant, agent: product.name, area, 'read-only': readOnly }, call)
        if (issued.answer.outcome === 'refused') return refused(issued.answer.reason, `${issued.answer.text}\n要接上 ${product.title}，用 --name 另起一个授权名，比如 --name ${product.name}-2。`)
        const updated = issued.library ?? library
        const given = (issued.answer.data as { grant: Grant }).grant
        const bound: LibraryCall = { ...call, ctx: { ...call.ctx, library: updated } }
        const home = homeOf(call.env)
        const grantLine = `授权：${grant}（${reused ? '已有的，接着用' : '新发的'}），${accessText(given)}`
        const launcher = await ensureLauncher(call.ctx.home, call.env)
        const launcherLine = launcher.changed ? [ranText(launcher)] : []
        if (plan.kind === 'same' && mine !== null && mine.grantId === given.id) {
          const head = launcher.changed ? `${product.title} 已经接上了，接上时写的没有改，命令修好了。` : `${product.title} 已经接上了，什么都没改。`
          return done([head, grantLine, `写着：${wroteText(plan.written, home)}`, ...launcherLine].join('\n'), { connection: mine }, updated)
        }

        const written = plan.kind === 'same' ? plan.written : await plan.write(bound)
        const connection: Connection = { format: 1, grant, grantId: given.id, product: product.name, library: library.root, way, at: call.ctx.now, wrote: written, command: { launcher: launcher.launcher.path } }
        await saveConnection(call.ctx.home, connection)
        const before = plan.kind === 'write' && plan.changes !== null ? [`改之前的那份留在：${tilde(join(call.ctx.home, 'connections', grant, 'before'), home)}/`] : []
        const command = way === 'mcp' ? [`它运行：${launcher.launcher.path} @${grant} mcp`] : []
        const notice = way === 'skill' && product.notice ? [product.notice(library.root)] : []
        const lines = [
          `已把 ${product.title} 接到这个库（${WAY_WORD[way]}）。`,
          grantLine,
          `${plan.kind === 'same' ? '写着' : '写了'}：${wroteText(written, home)}`,
          ...command,
          ...launcherLine,
          ...before,
          `接着：${product.next?.[way] ?? ''}`,
          ...notice,
          `要撤回：pneuma-base agent disconnect ${grant}`,
        ]
        return done(lines.join('\n'), { connection }, updated)
      },
    }),
    command({
      name: 'agent disconnect',
      summary: '断开一个接上的 agent：拿掉接上时写的，再撤回授权',
      params: { positional: [{ name: 'grant', hint: '授权名', required: true }], flags: [{ name: 'keep-grant', hint: '授权留着', kind: 'boolean' }] },
      destructive: false,
      ownerOnly: true,
      scope: 'machine',
      async run({ grant, 'keep-grant': keep }, call) {
        const record = await readConnection(call.ctx.home, grant)
        if (record === null) return done(`本机没有叫 ${grant} 的连接，什么都没做。`, { removed: false })
        if (call.ctx.library !== null && call.ctx.library.root !== record.library) return refused('other-library', `连接 ${grant} 是 ${record.library} 的，不是这个库的。`)
        const title = titleOf(record.product)
        const home = homeOf(call.env)
        const act = async (bound: LibraryCall | null): Promise<Outcome> => {
          const where = wroteText(record.wrote, home)
          const state = await undo(record.wrote)
          const lines = [
            state === 'in-place' ? `拿掉了：${where}` : state === 'changed' ? `${where} 在接上之后被改过，没有动它；不要了就自己删掉。` : state === 'gone' ? `${where} 已经不在了。` : `${tilde(record.wrote.file, home)} 现在读不懂了，没有动它。`,
          ]
          let library = undefined
          if (keep) lines.push(`授权 ${grant} 留着。再接上：pneuma-base agent connect ${record.product} --library ${record.library}${grant === record.product ? '' : ` --name ${grant}`}`)
          else if (bound === null) lines.push(`库 ${record.library} 不在了，授权跟着它。`)
          else if (!bound.ctx.library.config.grants.some((g) => g.name === grant && g.id === record.grantId)) lines.push(`授权 ${grant} 已经不在了。`)
          else {
            const r = await revoke.run({ name: grant }, bound)
            library = r.library
            lines.push(r.answer.outcome === 'done' ? `撤回了授权 ${grant}。` : r.answer.text)
          }
          await dropConnection(call.ctx.home, grant)
          return done(`已断开 ${title}（${grant}）。\n${lines.join('\n')}`, { removed: state === 'in-place', state }, library)
        }
        if (call.ctx.library !== null) return act({ ...call, ctx: call.ctx })
        const library = keep ? null : await openLibrary(record.library, call.table)
        if (library === null) return act(null)
        // Run from the command line with no library at hand: the grant is revoked in its library, as an operation of that library.
        const ctx = makeContext(library, call.ctx.actor, call.ctx.session, call.ctx.home, call.ctx.now)
        const r = await performOwner(ctx, 'agent disconnect', { positional: [grant], flags: {} }, { destructive: false, readOnly: false }, () => act({ ...call, ctx }))
        const { problems, ...answer } = r
        return { answer, problems }
      },
    }),
    command({
      name: 'agent list',
      summary: '接上的 agent：产品、授权、怎么接的、区域、只读与否，接上时写的还在不在；带 --library 时只列这个库的',
      params: {},
      destructive: false,
      ownerOnly: true,
      readOnly: true,
      scope: 'machine',
      async run(_values, call) {
        const connections = await connectionFacts(call.ctx.home, call.env, call.table, call.ctx.library?.root ?? null)
        if (connections.length === 0) return done('还没有接上任何 agent。pneuma-base agent detect 看这台机器上有哪些。', { connections })
        const lines = connections.flatMap((c) => [
          `${c.grant}  ${c.title}  ${WAY_WORD[c.way]}  ${c.area === null ? '整个库' : c.area}  ${c.readOnly === null ? '—' : c.readOnly ? '只读' : '读写'}  ${c.inPlace ? '在用' : c.problems.join('；')}`,
          `    ${c.where}${call.ctx.library === null ? `\n    库：${c.library}` : ''}`,
        ])
        return done(lines.join('\n'), { connections })
      },
    }),
  ]
}

