// A page of the management UI as the command line prints it: the same typed blocks in words, so an
// agent reading it knows what the person sees, and every button written as the command line that
// does the same thing. ARCHITECTURE.md section 6.
import { usageOf, type Action, type Block, type Call, type Cell, type FlagParam, type Link, type OwnerCommandInfo, type PositionalParam, type ViewList, type ViewResult } from '@pneuma-base/kernel'

type Shown = Extract<ViewResult, { outcome: 'shown' }>
type OwnerCall = Extract<Call, { face: 'owner' }>
type AgentCall = Extract<Call, { face: 'agent' }>

/** A moment as the rest of the command line prints it, in UTC to the minute; a text that is no moment stays as it is. */
export function minute(at: string): string {
  const t = Date.parse(at)
  if (Number.isNaN(t)) return at
  const iso = new Date(t).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`
}

// Characters a terminal draws two columns wide: CJK, kana, hangul and the full-width forms.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u
const width = (s: string) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)
const pad = (s: string, to: number) => s + ' '.repeat(Math.max(0, to - width(s)))

/** Columns aligned by what a terminal draws; the last one is not padded. */
function aligned(rows: string[][], indent: string): string[] {
  const widths = rows.reduce<number[]>((w, row) => row.map((c, i) => Math.max(w[i] ?? 0, width(c))), [])
  return rows.map((row) => `${indent}${row.map((c, i) => (i === row.length - 1 ? c : pad(c, widths[i] as number))).join('  ')}`.trimEnd())
}

// ---- the command an action or a link is ----

const SAFE = /^[\p{L}\p{N}_@%+=:,./~-]+$/u
/** A literal value as a shell takes it. */
const quote = (v: string) => (SAFE.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`)

const PLACEHOLDER = /\{([^{}]+)\}/g
const exactly = (v: string) => /^\{([^{}]+)\}$/.exec(v)?.[1] ?? null

/** A value of a call: a literal quoted; an input the person fills in, as `<its label>`. */
function valueOf(v: string, action: Action): string {
  if (!/\{[^{}]+\}/.test(v)) return quote(v)
  return v.replace(PLACEHOLDER, (_, name: string) => `<${action.inputs.find((i) => i.name === name)?.label ?? name}>`)
}

/** An optional flag whose value is an input: shown as the usage line shows a flag that may be left out. */
function optionalFlag(name: string, v: string, action: Action): string[] {
  return exactly(v) === null ? [`--${name}`, valueOf(v, action)] : [`[--${name} ${valueOf(v, action)}]`]
}

/** A flag that takes a list: none, the values written, or an input of a value per line, which may be left empty. */
function listFlag(name: string, values: readonly string[], action: Action): string[] {
  if (values.length === 0) return []
  const input = values.length === 1 ? exactly(values[0] as string) : null
  if (input === null) return [`--${name}`, ...values.map((v) => valueOf(v, action))]
  const many = action.inputs.find((i) => i.name === input)?.multiple === true ? '…' : ''
  return [`[--${name} ${valueOf(values[0] as string, action)}${many}]`]
}

function ownerWords(call: OwnerCall, info: OwnerCommandInfo | undefined, action: Action): string[] {
  const positional = info?.params.positional ?? []
  const flags = info?.params.flags ?? []
  const words = [call.command]
  call.args.positional.forEach((v, i) => {
    const p: PositionalParam | undefined = positional[Math.min(i, positional.length - 1)]
    words.push(exactly(v) !== null && p !== undefined ? usageOf({ positional: [p] }) : valueOf(v, action))
  })
  for (const [name, raw] of Object.entries(call.args.flags)) {
    const f: FlagParam | undefined = flags.find((x) => x.name === name)
    if (raw === true) words.push(`--${name}`)
    else if (raw.length === 1 && exactly(raw[0] as string) !== null && f !== undefined) words.push(usageOf({ flags: [f] }))
    else if (f?.kind === 'boolean') words.push(...(raw[0] === 'yes' ? [`--${name}`] : []))
    else words.push(`--${name}`, ...raw.map((v) => valueOf(v, action)))
  }
  return call.stdin === undefined ? words : [...words, `（标准输入：${valueOf(call.stdin, action)}）`]
}

function agentWords({ verb, request }: AgentCall, action: Action): string[] {
  const v = (s: string) => valueOf(s, action)
  switch (verb) {
    case 'put': {
      if (request.kind === 'move') return ['put', v(request.from), '--to', v(request.to)]
      const what = request.kind === 'register' ? [v(request.path)] : request.from.kind === 'stdin' ? ['-', '--to', v(request.to)] : [v(request.from.path), '--to', v(request.to)]
      const o = request.origin
      const origin =
        o.kind === 'brought'
          ? ['--brought', ...(o.source === null ? [] : optionalFlag('source', o.source, action)), ...(o.by === null ? [] : optionalFlag('by', o.by, action))]
          : ['--made', ...listFlag('from', o.from, action), ...listFlag('from-outside', o.outside, action)]
      const note = request.note === undefined || request.note === null ? [] : optionalFlag('note', request.note, action)
      return ['put', ...what, ...origin, ...note]
    }
    case 'find':
      return ['find', ...(request.text === null ? [] : [v(request.text)]), ...(request.includeArchived ? ['--include-archived'] : []), ...Object.entries(request.filters).flatMap(([k, x]) => [`--${k}`, v(x)])]
    case 'inspect':
      return ['inspect', v(request.target)]
    case 'say':
      return [
        'say',
        v(request.kind),
        ...(request.about === null ? [] : [v(request.about)]),
        ...(request.text === null ? [] : [v(request.text)]),
        ...Object.entries(request.args).flatMap(([k, xs]) => (xs.length === 0 ? [`--${k}`] : listFlag(k, xs, action))),
      ]
    case 'check':
      return ['check', ...(request.since === null ? [] : ['--since', v(request.since)]), ...(request.includeArchived ? ['--include-archived'] : [])]
    case 'archive':
      return [request.kind, v(request.path)]
  }
}

/** The command line, without `pneuma-base`, that does what the action's button does. */
export function commandOf(action: Action, commands: readonly OwnerCommandInfo[]): string {
  const { call } = action
  return (call.face === 'owner' ? ownerWords(call, commands.find((c) => c.name === call.command), action) : agentWords(call, action)).join(' ')
}

/** Whether an agent's session is refused the action: a destructive or owner-only command. */
function ownersOnly(action: Action, commands: readonly OwnerCommandInfo[]): boolean {
  const { call } = action
  if (call.face === 'agent') return false
  const info = commands.find((c) => c.name === call.command)
  return info === undefined || info.destructive || info.ownerOnly
}

/** One action as a line: the command, then the button's label, whether only the owner may, and what it asks first. */
function actionLine(action: Action, commands: readonly OwnerCommandInfo[], indent: string): string {
  const gate = ownersOnly(action, commands) ? '（只给主人）' : ''
  const asks = action.confirm === null ? '' : `；先问：${action.confirm}`
  return `${indent}$ ${commandOf(action, commands)}  # ${action.label}${gate}${asks}`
}

/** The command that opens what a link opens. */
function linkCommand(link: Link): string {
  return ['show', link.view, ...Object.entries(link.params).flatMap(([k, v]) => [`--${k}`, quote(v)])].join(' ')
}

const sameLink = (a: Link | null | undefined, b: Link | null | undefined) => a != null && b != null && linkCommand(a) === linkCommand(b)

/** A cell in words: a moment in UTC, else its text; its tag, its outside address, and where it leads unless the row leads there. */
function cellText(cell: Cell, rowLink: Link | null = null): string {
  const parts = [cell.at === undefined ? cell.text : minute(cell.at)]
  if (cell.tag) parts.push(`[${cell.tag.text}]`)
  if (cell.href !== undefined && cell.href !== cell.text) parts.push(cell.href)
  if (cell.link && !sameLink(cell.link, rowLink)) parts.push(`→ ${linkCommand(cell.link)}`)
  return parts.filter((p) => p !== '').join(' ')
}

// ---- blocks ----

const TONE_WORD: Partial<Record<string, string>> = { warn: '警告：', bad: '错误：' }

function blockLines(block: Block, commands: readonly OwnerCommandInfo[], depth: number, indent: string): string[] {
  const actions = (list: readonly Action[], at = indent) => list.map((a) => actionLine(a, commands, at))
  const more = `${indent}  `
  switch (block.kind) {
    case 'section': {
      const heading = `${'#'.repeat(depth)} ${block.title}${block.count === null ? '' : `（${block.count}）`}`
      return ['', heading, ...(block.note === null ? [] : [block.note]), ...actions(block.actions), ...block.blocks.flatMap((b) => blockLines(b, commands, depth + 1, indent)), '']
    }
    case 'table': {
      if (block.rows.length === 0) return [`${indent}${block.empty}`]
      const linked = block.rows.some((r) => r.link !== null)
      const header = [...block.columns.map((c) => c.label), ...(linked ? ['打开'] : [])]
      const cells = block.rows.map((r) => [...block.columns.map((c) => (r.cells[c.key] ? cellText(r.cells[c.key] as Cell, r.link) : '')), ...(linked ? [r.link === null ? '' : `→ ${linkCommand(r.link)}`] : [])])
      const lines = aligned([header, ...cells], indent)
      return [lines[0] as string, ...block.rows.flatMap((r, i) => [lines[i + 1] as string, ...actions(r.actions, more)])]
    }
    case 'fields':
      return block.fields.map((f) => `${indent}${f.label}：${cellText(f.value)}`)
    case 'list':
      return block.items.flatMap((item) => [`${indent}- ${cellText(item.cell)}`, ...(item.note === null ? [] : [`${more}${item.note}`]), ...actions(item.actions, more)])
    case 'timeline':
      return block.entries.flatMap((e) => [
        `${indent}- ${[minute(e.at), cellText(e.title), ...(e.tag === null ? [] : [`[${e.tag.text}]`])].filter((p) => p !== '').join('  ')}`,
        ...e.lines.map((l) => `${more}${l}`),
        ...actions(e.actions ?? [], more),
      ])
    case 'text':
      return block.text.split('\n').map((l, i) => `${indent}${i === 0 ? (TONE_WORD[block.tone] ?? '') : ''}${l}`)
    case 'preview':
      return [`${indent}预览：${block.path}`]
    case 'actions':
      return actions(block.actions)
    case 'empty':
      return [`${indent}${block.title}`, ...(block.hint === null ? [] : [`${indent}${block.hint}`])]
    case 'embed':
      return [`${indent}嵌入的页面「${block.title}」：${block.url}`]
    case 'custom':
      return [...block.text.split('\n').map((l) => `${indent}${l}`), ...actions(Object.values(block.actions))]
  }
}

const problemLines = (r: { problems: readonly { plugin: string; message: string }[] }) => r.problems.map((p) => `  插件 ${p.plugin} 出错：${p.message}`)

/** A shown page in words: its title, then each block as the page shows it, then what went wrong. */
export function pageText(r: Shown, commands: readonly OwnerCommandInfo[]): string[] {
  const head = [`# ${r.title}`, ...(r.subtitle === null ? [] : [r.subtitle])]
  const body = [...head, ...r.blocks.flatMap((b) => blockLines(b, commands, 2, ''))]
  // A section opens and closes with a blank line, so where it ends shows; one blank line is enough.
  const lines = body.filter((l, i) => l !== '' || (body[i - 1] !== '' && i < body.length - 1))
  return [...lines, ...problemLines(r)]
}

/** The views of a library: each one's id, title and who gives it, its filters as flags, and whether it is the owner's or only reached by a link. */
export function viewListText(list: ViewList): string[] {
  const rows = list.views.map((v) => [
    v.id,
    v.title,
    v.by,
    [...v.filters.map((f) => `[--${f.name} ${f.options.flatMap((o) => (o.value === '' ? [] : [o.value])).join('|')}]`), ...(v.ownerOnly === true ? ['只给主人'] : []), ...(v.nav ? [] : ['从别的页的链接打开'])].join(' '),
  ])
  return ['这个库的页，pneuma-base show <编号> 打开一页：', ...aligned(rows, '  '), ...problemLines(list)]
}
