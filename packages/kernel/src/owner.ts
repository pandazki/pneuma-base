import { basename } from 'node:path'
import { catchingUp, catchingUpLine } from './catch-up.js'
import { makeAddress, resolveAddress } from './address.js'
import { addressForm, chooseProvider, recordLibrary, type Runnable } from './providers.js'
import { said, takenBy } from './claims.js'
import { newConfig, saveConfig, writeDescription } from './library.js'
import { KERNEL_COMMANDS, type Outcome } from './owner-commands.js'
import { checkArgs } from './params.js'
import { performOwner, pluginContext } from './pipeline.js'
import { askLine } from './requests.js'
import { agentSign, ownerOnlyRefusal, OWNER_DECIDES, type Env } from './session.js'
import { bindProvider, storageOf } from './storage.js'
import { usageOf, type Actor, type Context, type Instant, type OwnerAct, type OwnerActDone, type OwnerArgs, type OwnerParams, type OwnerResult, type OwnerValues, type Plugin, type PluginName, type PluginTable, type Requested, type Session } from '@pneuma-base/sdk'

/** Who acts, in which session, on this machine, with no library at hand: the context of a command that needs none. */
export type MachineContext = Omit<Context, 'library'> & { library: null }

/** What every owner command needs besides its own arguments. This machine's home is `ctx.home`. */
export type OwnerCall = {
  ctx: Context | MachineContext
  table: PluginTable
  env: Env
  viaGrant: boolean
  confirm: (question: string) => Promise<boolean>
  /**
   * A value the person gives besides the arguments, such as a credential: typed without echo, or
   * standard input; from the page, the call's `stdin`. Absent or null: none was given.
   */
  readSecret?: (question: string) => Promise<string | null>
  /** The call runs a request the owner approved: its operation's event carries it. */
  request?: Requested
}

/** An owner call with a library. */
export type LibraryCall = OwnerCall & { ctx: Context }

/**
 * An owner command as the owner face lists it, and who provides it. `machine`: it needs no library.
 * `readOnly`: it changes nothing. `askable`: an agent may ask the owner for it with `ask`.
 */
export type OwnerCommandInfo = {
  name: string
  summary: string
  usage: string | null
  params: OwnerParams
  destructive: boolean
  ownerOnly: boolean
  readOnly: boolean
  askable: boolean
  machine: boolean
  by: PluginName | 'kernel'
}

/**
 * How a command is gated: destructive ones lose data; owner-only ones decide for the owner, and may be
 * asked for unless `askable` is false. Read-only ones change nothing; setup ones configure plugins or targets.
 */
type Gate = { destructive: boolean; ownerOnly: boolean; readOnly?: boolean; setup?: boolean; askable?: false; act?: OwnerAct }

/** A command's act as this call ran it: what it was done to, from the first given of the arguments the act names, else its fixed name. */
function actDone(act: OwnerAct, params: OwnerParams, args: OwnerArgs): OwnerActDone {
  const valueOf = (name: string): string | undefined => {
    const at = (params.positional ?? []).findIndex((p) => p.name === name)
    const flag = args.flags[name]
    // As the kernel reads a value: trimmed, and an empty one, as a form's hidden field sends, not given.
    const given = (at >= 0 ? args.positional[at] : Array.isArray(flag) ? flag[0] : undefined)?.trim()
    return given === '' ? undefined : given
  }
  const names = act.object === undefined ? [] : typeof act.object === 'string' ? [act.object] : act.object
  const given = names.map(valueOf).find((v) => v !== undefined)
  return { kind: act.kind, object: given ?? act.name ?? null }
}

/**
 * What reads the value `params.secret` asks for, at most once a call: the person's answer to its hint,
 * less one final newline; null when empty, not given, or not asked for.
 */
function secretOf(params: OwnerParams, call: OwnerCall): () => Promise<string | null> {
  const { secret } = params
  let read: Promise<string | null> | undefined
  return () => {
    read ??= secret === undefined || call.readSecret === undefined ? Promise.resolve(null) : call.readSecret(`${secret.hint}（输入时不显示）：`).then((v) => (v ?? '').replace(/\r?\n$/, '') || null)
    return read
  }
}

const isAskable = (gate: Gate) => gate.ownerOnly && !gate.destructive && gate.askable !== false

/**
 * The one place owner commands pass through. In an agent session a destructive or owner-only
 * command is refused, naming what showed the session, and an agent refused one it may ask for is
 * given the line that asks; a call that does not fit the command's `params` is refused as `usage`; a
 * destructive one then needs a confirmation the person gives in person (K7). With a library, refused
 * or not, it ends at the pipeline's single exit; with none, there is no plugin to tell.
 */
async function gated(call: OwnerCall, name: string, gate: Gate, args: OwnerArgs, params: OwnerParams, body: (values: OwnerValues) => Promise<Outcome>): Promise<OwnerResult> {
  const decide = async (): Promise<Outcome> => {
    const sign = gate.destructive || gate.ownerOnly ? agentSign(call.env, call.viaGrant, call.ctx.actor) : null
    if (sign !== null) {
      const ask = isAskable(gate) && call.ctx.actor.kind === 'agent' ? askLine(call.ctx, name, args) : null
      const text = ownerOnlyRefusal(name, gate.destructive ? '会丢数据' : OWNER_DECIDES, sign, ask)
      return { answer: { outcome: 'refused', reason: 'agent-session', text } }
    }
    const checked = checkArgs(name, params, args)
    if ('usage' in checked) return { answer: { outcome: 'refused', reason: 'usage', text: checked.usage } }
    if (gate.destructive && !(await call.confirm(`「${name}」会丢数据，不能撤回。确认要做吗？`))) {
      return { answer: { outcome: 'refused', reason: 'not-confirmed', text: '没有得到当面确认，什么都没做。' } }
    }
    return body(checked.values)
  }
  const ctx = call.ctx
  if (ctx.library === null) {
    const { answer, problems } = await decide()
    return { ...answer, problems: problems ?? [] }
  }
  const act = gate.act ? { act: actDone(gate.act, params, args) } : {}
  return performOwner(ctx, name, args, { destructive: gate.destructive, readOnly: gate.readOnly ?? false, setup: gate.setup ?? false, ...act, ...(call.request ? { request: call.request } : {}) }, decide)
}

/**
 * Makes the library at `address`, through the provider that answers its form here (the one named, or
 * the only one, the built-in first), and records on this machine which provider it uses. Only the owner
 * makes a library: `env` is the caller's environment (none from code the owner runs in-process).
 * Refused before anything is written, so a refused init has no library to send an event to.
 */
export async function initLibrary(
  address: string,
  opts: { plugins: string[]; table: PluginTable; actor: Actor; session: Session; home: string; env?: Env; provider?: string | null },
): Promise<OwnerResult> {
  const refuse = (reason: string, text: string): OwnerResult => ({ outcome: 'refused', reason, text, problems: [] })
  const sign = agentSign(opts.env ?? {}, false, opts.actor)
  if (sign !== null) return refuse('agent-session', ownerOnlyRefusal('init', OWNER_DECIDES, sign))
  const provider = chooseProvider(opts.home, addressForm(address), opts.provider ?? null)
  if ('reason' in provider) return refuse(provider.reason, provider.text)
  if (await isLibrary(address, provider)) return refuse('already-a-library', `${address} 已经是一个库了`)
  const unknown = opts.plugins.filter((name) => !opts.table.has(name))
  if (unknown.length > 0) return refuse('unknown-plugin', `没有这个插件：${unknown.join('、')}`)
  // As `plugin add` would refuse each plugin after the first that claims a name an earlier one holds.
  const chosen = [...new Set(opts.plugins)].map((name) => opts.table.get(name) as Plugin)
  const clashes = chosen.flatMap((p, i) => takenBy(p, chosen.slice(0, i)).map((t) => ({ plugin: p.name, ...t })))
  if (clashes.length > 0) {
    const what = clashes.map((c) => `插件 ${c.plugin} 的${said(c.claim)}已归插件 ${c.holder}`).join('；')
    const pairs = [...new Set(clashes.map((c) => `${c.holder} 和 ${c.plugin}`))].join('、')
    return refuse('name-taken', `没有建库：${what}。一个名字只归一个插件，${pairs} 只能选一个。`)
  }
  const root = await makeAddress(address)
  bindProvider(root, provider)
  await recordLibrary(opts.home, root, provider.name)
  // Storage's part first (ARCHITECTURE.md「库」): its cache area, and the noise declared at the root with the default names.
  await storageOf(root).init()
  const at = { actor: opts.actor, session: opts.session, home: opts.home, now: new Date().toISOString() as Instant }
  const { library, problems } = await saveConfig(root, newConfig(opts.plugins as PluginName[]), opts.table, at)
  const ctx = { ...at, library }
  const flags = { ...(opts.plugins.length === 0 ? { bare: true as const } : {}), ...(opts.provider ? { provider: [opts.provider] } : {}) }
  const args: OwnerArgs = { positional: [library.root], flags }
  return performOwner(ctx, 'init', args, { destructive: false, readOnly: false, act: { kind: 'created', object: basename(library.root) } }, async () => ({
    answer: { outcome: 'done', text: `已把 ${library.root} 建成库，存储提供者是 ${provider.name}。说明在 PNEUMA-BASE.md。`, data: { root: library.root, provider: provider.name } },
    problems,
  }))
}

/** Whether an address holds a library's declaration, readable or not, asked of the provider init would use: init never writes over one. */
async function isLibrary(address: string, provider: Runnable): Promise<boolean> {
  const root = await resolveAddress(address)
  if (root === null) return false
  bindProvider(root, provider)
  return (await storageOf(root).declaration.read()).token !== null
}

const NEEDS_LIBRARY = '要用 @<授权名> 或 --library <库的目录> 指明是哪个库。'

export const ownerFace = {
  /** The owner commands with these plugins installed: the kernel's, then each plugin's in order. A name already taken is not listed again. */
  commands(plugins: readonly Plugin[]): OwnerCommandInfo[] {
    const kernel = KERNEL_COMMANDS.map((c): OwnerCommandInfo => ({
      name: c.name,
      summary: c.summary,
      usage: usageOf(c.params) || null,
      params: c.params,
      destructive: c.destructive,
      ownerOnly: c.ownerOnly,
      readOnly: c.readOnly ?? false,
      askable: isAskable(c),
      machine: c.scope === 'machine',
      by: 'kernel',
    }))
    const own = plugins.flatMap((p) =>
      p.ownerCommands.map((c): OwnerCommandInfo => ({
        name: c.name,
        summary: c.summary,
        usage: usageOf(c.params) || null,
        params: c.params,
        destructive: c.destructive,
        ownerOnly: c.ownerOnly,
        readOnly: c.readOnly ?? false,
        askable: isAskable(c),
        machine: false,
        by: p.name,
      })),
    )
    const all = [...kernel, ...own]
    return all.filter((c, i) => all.findIndex((d) => d.name === c.name) === i)
  },

  /**
   * Runs the owner command `name`, the kernel's or an installed plugin's, through the gate. An
   * unknown name, or a command that needs a library called without one, is refused before any
   * operation begins, so it sends no event.
   */
  dispatch(call: OwnerCall, name: string, args: OwnerArgs): Promise<OwnerResult> {
    const refuse = (reason: string, text: string): Promise<OwnerResult> => Promise.resolve({ outcome: 'refused', reason, text, problems: [] })
    const kernel = KERNEL_COMMANDS.find((c) => c.name === name)
    const ctx = call.ctx
    if (kernel?.scope === 'machine') return gated(call, name, kernel, args, kernel.params, (values) => kernel.run(values, call))
    if (ctx.library === null) return kernel ? refuse('no-library', `「${name}」${NEEDS_LIBRARY}`) : refuse('unknown-command', `没有这条主人命令：${name}。插件的命令${NEEDS_LIBRARY}`)
    const bound: LibraryCall = { ...call, ctx }
    if (kernel) return gated(bound, name, kernel, args, kernel.params, (values) => kernel.run(values, bound))
    for (const plugin of ctx.library.plugins) {
      const command = plugin.ownerCommands.find((c) => c.name === name)
      if (!command) continue
      return gated(bound, name, command, args, command.params, async (values) => {
        const answer = await command.run({ ...args, values, secret: secretOf(command.params, call) }, pluginContext(ctx, plugin.name, { command: true }))
        // A configuration of the plugin's own may change what its paragraph of the description says.
        const problems = command.setup === true && answer.outcome === 'done' ? await writeDescription(ctx) : []
        // A plugin still catching up says so in one line under each of its commands' answers.
        const behind = (await catchingUp(ctx)).get(plugin.name)
        return { answer: behind === undefined ? answer : { ...answer, text: `${answer.text}\n${catchingUpLine(behind)}` }, problems }
      })
    }
    return refuse('unknown-command', `没有这条主人命令：${name}`)
  },
}
