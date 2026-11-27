// The shape of the kernel's own owner commands, and the answers they give. ARCHITECTURE.md「命令表」.
import type { KernelCommandName } from './claims.js'
import type { LibraryCall, OwnerCall } from './owner.js'
import type { Library, OwnerAnswer, OwnerParams, OwnerValues, ParamValues, PluginProblem } from '@pneuma-base/sdk'

export type Outcome = { answer: OwnerAnswer; library?: Library; problems?: PluginProblem[] }

type KernelBase = {
  readonly name: KernelCommandName
  readonly summary: string
  readonly params: OwnerParams
  readonly destructive: boolean
  readonly ownerOnly: boolean
  readonly readOnly?: boolean
  readonly setup?: boolean
  readonly askable?: false
}

/**
 * Like a plugin's OwnerCommand with `params`, but it runs with the whole owner call and may hand back
 * the reopened library. A `library` command needs one; a `machine` one changes only this machine, not
 * a library's files, and runs with a library or without.
 */
export type KernelCommand = KernelBase &
  ({ readonly scope: 'library'; run(values: OwnerValues, call: LibraryCall): Promise<Outcome> } | { readonly scope: 'machine'; run(values: OwnerValues, call: OwnerCall): Promise<Outcome> })

/** A kernel command with `run` typed by its `params`; the owner face calls it only with values it checked against them. */
export function command<const P extends OwnerParams>(
  c: Omit<KernelBase, 'params'> & { readonly params: P } & (
      | { readonly scope: 'library'; run(values: ParamValues<P>, call: LibraryCall): Promise<Outcome> }
      | { readonly scope: 'machine'; run(values: ParamValues<P>, call: OwnerCall): Promise<Outcome> }
    ),
): KernelCommand {
  return c as unknown as KernelCommand
}

export const refused = (reason: string, text: string): Outcome => ({ answer: { outcome: 'refused', reason, text } })

export const done = (text: string, data?: unknown, library?: Library, problems: PluginProblem[] = []): Outcome => ({
  answer: { outcome: 'done', text, ...(data === undefined ? {} : { data }) },
  ...(library ? { library } : {}),
  problems,
})
