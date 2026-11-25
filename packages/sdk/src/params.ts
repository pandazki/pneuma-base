// An owner command's declared arguments, turned into what people read and fill in: the usage line
// and a form. The kernel checks a call by the same declaration, so the command line, help and the
// form in the UI cannot disagree.
import type { ActionInput, Call, FlagParam, OwnerAnswer, OwnerCommand, OwnerParams, ParamValues, PluginContext, PositionalParam } from './types.js'

/**
 * An owner command with `params`, whose `run` gets the values typed by them: each by name, a
 * required one a string, an optional one possibly null, a list or `many` a list, a boolean true or false.
 */
export function defineCommand<const P extends OwnerParams>(
  command: Omit<OwnerCommand, 'params' | 'usage' | 'run'> & { readonly params: P; readonly run: (values: ParamValues<P>, ctx: PluginContext) => Promise<OwnerAnswer> },
): OwnerCommand {
  const { run, ...rest } = command
  // The kernel calls `run` only with values it checked against `params`.
  return { ...rest, run: (args, ctx) => run(args.values as ParamValues<P>, ctx) }
}

const slot = (a: PositionalParam) => {
  const one = `<${a.hint}>${a.many ? '…' : ''}`
  return a.required ? one : `[${one}]`
}

const flagSlot = (f: FlagParam) => {
  if (f.kind === 'boolean') return `[--${f.name}]`
  const value = f.options ? f.options.map((o) => o.value).join('|') : `<${f.hint}>${f.kind === 'list' ? '…' : ''}`
  return f.required ? `--${f.name} ${value}` : `[--${f.name} ${value}]`
}

/** How the arguments are written after the command's name, e.g. `<授权名> --agent <给谁> [--read-only]`. */
export function usageOf(params: OwnerParams): string {
  return [...(params.positional ?? []).map(slot), ...(params.flags ?? []).map(flagSlot)].join(' ')
}

/** A value fixed by the caller, so the form does not ask for it. */
export type FixedValue = string | readonly string[] | boolean

/**
 * The inputs and call of a form for an owner command with `params`. Each argument not in `fixed` is
 * one input, labelled with its hint, with its pattern and options; a list or `many` one takes a value
 * per line, a boolean is a choice of 否 or 是. `values` fills inputs before the person sees them.
 */
export function formOf(
  command: { readonly name: string; readonly params?: OwnerParams },
  opts: { fixed?: Readonly<Record<string, FixedValue>>; values?: Readonly<Record<string, string>> } = {},
): { inputs: ActionInput[]; call: Extract<Call, { face: 'owner' }> } {
  const params = command.params
  if (params === undefined) throw new Error(`formOf: ${command.name} declares no params`)
  const fixed = opts.fixed ?? {}
  const inputs: ActionInput[] = []
  const ask = (p: PositionalParam | FlagParam, many: boolean, options: ActionInput['options']): string => {
    inputs.push({
      name: p.name,
      label: p.hint,
      placeholder: null,
      value: opts.values?.[p.name] ?? null,
      options,
      ...(many ? { multiple: true } : {}),
      ...(p.pattern === undefined ? {} : { pattern: p.pattern }),
    })
    return `{${p.name}}`
  }
  const text = (v: FixedValue): string[] => (typeof v === 'boolean' ? [] : typeof v === 'string' ? [v] : [...v])
  const positional = (params.positional ?? []).flatMap((a) => {
    const v = fixed[a.name]
    return v === undefined ? [ask(a, a.many === true, null)] : text(v)
  })
  const flags: Record<string, string[] | true> = {}
  for (const f of params.flags ?? []) {
    const v = fixed[f.name]
    if (v === undefined) {
      const options = f.kind === 'boolean' ? [{ value: 'no', label: '否' }, { value: 'yes', label: '是' }] : f.options ? f.options.map((o) => ({ ...o })) : null
      flags[f.name] = [ask(f, f.kind === 'list', options)]
    } else if (v === true) flags[f.name] = true
    else if (v !== false) flags[f.name] = text(v)
  }
  return { inputs, call: { face: 'owner', command: command.name, args: { positional, flags } } }
}
