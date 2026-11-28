// What connects a destination, as the page's actions and as command lines: a destination found on this
// machine in one press, a dialog per group of kinds or per kind, changing one setting of the connected
// one, and disconnecting. Every one is a call of `<name> target set` or `<name> target remove`.
import type { Action, ActionInput, Call, FlagParam, InputShown, PluginContext } from '../../types.js'
import type { Given, Kit } from './reconcile.js'
import type { Found, Target, TargetAdapter } from './target.js'

export const targetSetName = (kit: Kit) => `${kit.name} target set`
export const targetRemoveName = (kit: Kit) => `${kit.name} target remove`

/** A destination of one kind found on this machine. */
export type FoundOf = { readonly adapter: TargetAdapter; readonly found: Found }

/** What each kind finds on this machine, in the kit's order; a kind whose finding fails finds nothing. */
export async function foundAll(kit: Kit, ctx: PluginContext): Promise<FoundOf[]> {
  const all: FoundOf[] = []
  for (const adapter of kit.targets) {
    if (!adapter.found) continue
    const found = await adapter.found(ctx).catch(() => [])
    all.push(...found.map((f) => ({ adapter, found: f })))
  }
  return all
}

/** The flags a kind's dialog asks, in order: its `form`, else its required flags. */
const formFlags = (t: TargetAdapter): FlagParam[] => (t.form ? t.form.flatMap((name) => t.params.filter((p) => p.name === name)) : t.params.filter((p) => p.required))

const plain = (label: string, call: Call, inputs: ActionInput[] = []): Action => ({ label, tone: 'default', confirm: null, inputs, call })

const ownerCall = (command: string, flags: Record<string, string[] | true>, stdin?: string): Extract<Call, { face: 'owner' }> => ({
  face: 'owner',
  command,
  args: { positional: [], flags },
  ...(stdin === undefined ? {} : { stdin }),
})

const asFlags = (given: Given): Record<string, string[] | true> => Object.fromEntries(Object.entries(given).map(([name, v]) => [name, v === true ? true : typeof v === 'string' ? [v] : [...v]]))

/** Connects a destination found on this machine: its kind and the flags it was found with, nothing typed. */
export function connectFound(kit: Kit, f: FoundOf, label: string): Action {
  return plain(label, ownerCall(targetSetName(kit), asFlags({ kind: f.adapter.kind, ...f.found.values })))
}

/** The one flag every destination a kind found is connected by, which a dialog offers as a choice; null when there is not one. */
function foundFlag(found: readonly Found[]): string | null {
  const names = new Set(found.flatMap((f) => Object.keys(f.values)))
  const [name] = names
  return names.size === 1 && name !== undefined && found.every((f) => f.values[name] !== undefined) ? name : null
}

/**
 * A dialog that connects one of `kinds`: with several, first the kind, by `choose`; for a kind that
 * found destinations, a choice of them and 别的; then the fields of the kind chosen, and of 别的, each
 * shown by `when`; the secret a kind asks for last, typed hidden and sent as standard input.
 * `start`: the kind chosen when it opens.
 */
export function connectAction(kit: Kit, kinds: readonly TargetAdapter[], label: string, opts: { found?: readonly FoundOf[]; choose?: (t: TargetAdapter) => string; start?: string } = {}): Action {
  const several = kinds.length > 1
  const inputs: ActionInput[] = []
  const flags: Record<string, string[]> = {}
  const start = kinds.find((t) => t.kind === opts.start) ?? kinds[0]
  if (several) {
    inputs.push({ name: 'kind', label: '种类', placeholder: null, value: start?.kind ?? null, options: kinds.map((t) => ({ value: t.kind, label: opts.choose?.(t) ?? t.label })) })
    flags.kind = ['{kind}']
  } else if (start) flags.kind = [start.kind]
  // Each field once, shown while the kind chosen is one that asks it and no destination found is chosen.
  const fields = new Map<string, { input: ActionInput; kinds: string[]; when: InputShown[] }>()
  const field = (name: string, input: ActionInput, kind: string, when: InputShown[]) => {
    const seen = fields.get(name)
    if (seen) {
      seen.kinds.push(kind)
      seen.when.push(...when.filter((w) => !seen.when.some((s) => s.input === w.input)))
    } else fields.set(name, { input, kinds: [kind], when: [...when] })
  }
  const secret = kinds.find((t) => t.asked)?.asked
  for (const t of kinds) {
    const found = (opts.found ?? []).filter((f) => f.adapter.kind === t.kind).map((f) => f.found)
    const by = found.length > 0 ? foundFlag(found) : null
    const otherwise: InputShown[] = by === null ? [] : [{ input: by, is: [''] }]
    if (by !== null) {
      const options = [...found.map((f) => ({ value: f.values[by] as string, label: f.label })), { value: '', label: '别的' }]
      field(by, { name: by, label: t.params.find((p) => p.name === by)?.hint ?? by, placeholder: null, value: options[0]?.value ?? null, options }, t.kind, [])
    }
    for (const p of formFlags(t)) {
      const input: ActionInput = {
        name: p.name,
        label: p.hint,
        placeholder: null,
        value: null,
        options: p.options ? p.options.map((o) => ({ ...o })) : null,
        ...(p.kind === 'list' ? { multiple: true } : {}),
        ...(p.pattern === undefined ? {} : { pattern: p.pattern }),
      }
      field(p.name, input, t.kind, otherwise)
    }
    if (t.asked && t.asked.name === secret?.name) field(t.asked.name, { name: t.asked.name, label: t.asked.hint, placeholder: null, value: null, options: null, secret: true }, t.kind, otherwise)
  }
  // The secret last, after every field.
  const order = [...fields].sort(([a], [b]) => Number(a === secret?.name) - Number(b === secret?.name))
  for (const [name, { input, kinds: of, when }] of order) {
    const conditions = [...(several ? [{ input: 'kind', is: of }] : []), ...when]
    inputs.push(conditions.length > 0 ? { ...input, when: conditions } : input)
    if (name !== secret?.name) flags[name] = [`{${name}}`]
  }
  return plain(label, ownerCall(targetSetName(kit), flags, secret === undefined ? undefined : `{${secret.name}}`), inputs)
}

/** Changing one setting of the connected destination: `target set` again with the flags it was given, this one asked, filled in. */
export function settingAction(kit: Kit, kind: string, given: Given, setting: NonNullable<Target['settings']>[number], adapter: TargetAdapter): Action {
  const p = adapter.params.find((f) => f.name === setting.flag)
  const rest = Object.fromEntries(Object.entries(given).filter(([name]) => name !== setting.flag))
  const input: ActionInput = { name: setting.flag, label: setting.hint, placeholder: null, value: setting.value, options: null, ...(p?.pattern === undefined ? {} : { pattern: p.pattern }) }
  return plain(`${setting.hint}…`, ownerCall(targetSetName(kit), { ...asFlags({ kind, ...rest }), [setting.flag]: [`{${setting.flag}}`] }), [input])
}

/** Forgetting the destination, after a question that says what stays. */
export function disconnectAction(kit: Kit, label: string): Action {
  return { ...plain('断开', ownerCall(targetRemoveName(kit), {})), confirm: `断开 ${label}？线上的东西不撤下，开关都留着。` }
}

/** A word as a shell reads it back: quoted when it holds anything but plain characters. */
const shellWord = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`)

/** The command line of `target set` with these flags, as the owner would type it. */
export function setCommand(kit: Kit, given: Given): string {
  const words = Object.entries(given).flatMap(([name, v]) => (v === true ? [`--${name}`] : (typeof v === 'string' ? [v] : v).flatMap((w) => [`--${name}`, shellWord(w)])))
  return [targetSetName(kit), ...words].join(' ')
}
