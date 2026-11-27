// The pieces the kernel's own pages share: moments and sizes in words, links to a thing's panel and to
// a folder's page, the buttons of the kernel's commands, and the answers to a directory nobody looked into.
import type { KernelCommandName } from './claims.js'
import { KERNEL_COMMANDS } from './owner-commands.js'
import { formOf, type Action, type ActionInput, type Cell, type Description, type FixedValue, type Instant, type LibraryPath, type Link } from '@pneuma-base/sdk'

export const when = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`
}

export const itemLink = (path: string): Link => ({ view: 'item', params: { path }, target: 'panel' })
export const folderLink = (dir: string): Link => ({ view: 'files', params: dir === '' ? {} : { dir }, target: 'main' })

export const nameOf = (place: string) => place.slice(place.lastIndexOf('/') + 1)
export const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i
export const blank: Cell = { text: '' }
export const modified = (at: string | undefined): Cell => (at ? { text: when(at), muted: true, at: at as Instant } : { text: '' })

export const field = (name: string, label: string, opts: { placeholder?: string; value?: string } = {}): ActionInput => ({ name, label, placeholder: opts.placeholder ?? null, value: opts.value ?? null, options: null })

type FormOptions = { fixed?: Record<string, FixedValue>; values?: Record<string, string> }

/** The form of the kernel's command `name`, made from its `params`, so it asks for what the command line takes. */
export const kernelForm = (name: KernelCommandName, opts: FormOptions = {}) => formOf(KERNEL_COMMANDS.find((c) => c.name === name) ?? { name, params: {} }, opts)

export function kernelAction(name: KernelCommandName, label: string, opts: FormOptions & { tone?: Action['tone']; confirm?: string } = {}): Action {
  const { inputs, call } = kernelForm(name, opts)
  return { label, tone: opts.tone ?? 'default', confirm: opts.confirm ?? null, inputs, call }
}

/** Registering a directory nobody looked into as one thing the owner brought: put of what is already there. */
export const asOneThing = (path: LibraryPath): Action => ({
  label: '登记成一样东西',
  tone: 'default',
  confirm: null,
  inputs: [],
  call: { face: 'agent', verb: 'put', request: { kind: 'register', path, origin: { kind: 'brought', source: null, by: 'owner' }, note: null } },
})

/** Leaving a directory alone: it joins the library's noise, so nothing mentions it again. */
export const leaveAlone = (path: LibraryPath): Action => kernelAction('noise add', '不用管', { fixed: { path, name: false } })

const PROVIDERS: Record<string, string> = { icloud: 'iCloud', dropbox: 'Dropbox', googledrive: 'Google Drive', onedrive: 'OneDrive', box: 'Box' }
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The placeholder facet of a place whose content a sync service keeps elsewhere, else null. */
export const placeholderOf = (entry: Pick<Description, 'facets'>): Record<string, unknown> | null => {
  const facet = entry.facets?.placeholder
  return isObject(facet) ? facet : null
}

/** Where a placeholder's content is and how big it is there, from its facet. */
export const elsewhereText = (facet: Record<string, unknown>): string =>
  elsewhereWords(typeof facet.provider === 'string' ? facet.provider : null, typeof facet.size_elsewhere === 'number' ? facet.size_elsewhere : null)

/** Where content that is not on this machine is, by the sync service's name, and how big it is there. */
export function elsewhereWords(provider: string | null, size: number | null): string {
  const where = provider === null ? null : (PROVIDERS[provider] ?? provider)
  return [where === null ? '内容不在这台机器上' : `内容在 ${where} 上`, size === null ? null : sizeText(size)].filter((s) => s !== null).join('，')
}
