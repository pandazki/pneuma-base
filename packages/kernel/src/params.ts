// A call's arguments checked against its command's declared `params`, at the owner face's one
// entry, so a plugin's `run` never sees a call that does not fit. ARCHITECTURE section 6.
import { usageOf, type FlagParam, type OwnerArgs, type OwnerParams, type OwnerValues, type PositionalParam } from '@pneuma-base/sdk'

/** A value as given: trimmed, and empty counts as not given, so a form's empty field means the same as leaving it out. */
const given = (v: string | undefined): string | null => {
  const t = v?.trim()
  return t === undefined || t === '' ? null : t
}

const matches = (pattern: string | undefined, v: string) => pattern === undefined || new RegExp(`^(?:${pattern})$`, 'u').test(v)

const named = (p: PositionalParam) => `<${p.hint}>`

/** What is wrong with the call, or null when nothing is; `values` is filled as it goes. */
function wrongWith(name: string, params: OwnerParams, args: OwnerArgs, values: Record<string, OwnerValues[string]>): string | null {
  const flags = params.flags ?? []
  const unknown = Object.keys(args.flags).find((f) => !flags.some((d) => d.name === f))
  if (unknown !== undefined) return `${name} 不认识 --${unknown}。`

  const positional = params.positional ?? []
  const rest = args.positional.slice(positional.filter((p) => !p.many).length)
  if (!positional.at(-1)?.many && rest.length > 0) return `${name} 多了参数：${rest.join(' ')}。`
  for (const [i, p] of positional.entries()) {
    const value = p.many ? rest.map(given).filter((v) => v !== null) : given(args.positional[i])
    if (p.required && (value === null || (Array.isArray(value) && value.length === 0))) return `${name} 少了 ${named(p)}。`
    const bad = (Array.isArray(value) ? value : value === null ? [] : [value]).find((v) => !matches(p.pattern, v))
    if (bad !== undefined) return `${named(p)} 写的「${bad}」不对，要整个匹配 ${p.pattern}。`
    values[p.name] = value
  }

  for (const f of flags) {
    const wrong = flagValue(f, args.flags[f.name], values)
    if (wrong !== null) return wrong
  }
  return null
}

function flagValue(f: FlagParam, raw: string[] | true | undefined, values: Record<string, OwnerValues[string]>): string | null {
  const flag = `--${f.name}`
  if (f.kind === 'boolean') {
    // A switch on the command line; a form sends it as the value yes or no.
    const one = raw === true ? 'yes' : raw === undefined ? 'no' : raw.length <= 1 ? (given(raw[0]) ?? 'no') : null
    if (one !== 'yes' && one !== 'no') return `${flag} 不带值。`
    values[f.name] = one === 'yes'
    return null
  }
  const list = raw === undefined || raw === true ? [] : raw.map(given).filter((v) => v !== null)
  if (f.kind === 'value' && list.length > 1) return `${flag} 只要一个值。`
  if (f.required && list.length === 0) return `要写 ${flag}${f.options ? ` ${f.options.map((o) => o.value).join('|')}` : ` <${f.hint}>`}。`
  for (const v of list) {
    if (f.options && !f.options.some((o) => o.value === v)) return `${flag} 只能是 ${f.options.map((o) => o.value).join('、')}：${v}`
    if (!matches(f.pattern, v)) return `${flag} 写的「${v}」不对，要整个匹配 ${f.pattern}（${f.hint}）。`
  }
  values[f.name] = f.kind === 'list' ? list : (list[0] ?? null)
  return null
}

/**
 * The values of a call to the command `name`, by argument name; or, when it does not fit `params`,
 * a sentence saying what is missing or malformed, followed by the usage line.
 */
export function checkArgs(name: string, params: OwnerParams, args: OwnerArgs): { values: OwnerValues } | { usage: string } {
  const values: Record<string, OwnerValues[string]> = {}
  const wrong = wrongWith(name, params, args, values)
  return wrong === null ? { values } : { usage: `${wrong}\n用法：${[name, usageOf(params)].filter((s) => s !== '').join(' ')}` }
}
