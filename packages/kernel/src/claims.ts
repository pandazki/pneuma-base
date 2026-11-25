// The names a plugin claims, which no one else may hold: its `say` kinds, owner command names and view ids.
import type { KERNEL_COMMAND_NAMES, Plugin, PluginName, PluginProblem } from '@pneuma-base/sdk'

export type KernelCommandName = (typeof KERNEL_COMMAND_NAMES)[number]

type Claim = { kind: 'statement' | 'command' | 'view'; name: string }

const key = (c: Claim) => `${c.kind}\0${c.name}`

/** A claim as the owner reads it. */
export function said(c: Claim): string {
  return `${c.kind === 'statement' ? '「说」的种类' : c.kind === 'command' ? '主人命令' : '视图'}「${c.name}」`
}

/** The names `plugin` claims. A view whose id lacks its `<name>.` prefix claims nothing: the viewer leaves it out. */
function claimsOf(plugin: Plugin): Claim[] {
  return [
    ...plugin.statements.map((name): Claim => ({ kind: 'statement', name })),
    ...plugin.ownerCommands.map((c): Claim => ({ kind: 'command', name: c.name })),
    ...(plugin.views ?? []).filter((v) => v.id.startsWith(`${plugin.name}.`)).map((v): Claim => ({ kind: 'view', name: v.id })),
  ]
}

/** Each name of `plugin` that one of `holders` already claims, with the plugin that holds it. */
export function takenBy(plugin: Plugin, holders: readonly Plugin[]): { claim: Claim; holder: PluginName }[] {
  const held = new Map(holders.flatMap((h) => claimsOf(h).map((c) => [key(c), h.name] as const)))
  return claimsOf(plugin).flatMap((claim) => {
    const holder = held.get(key(claim))
    return holder === undefined ? [] : [{ claim, holder }]
  })
}

/**
 * The installed plugins in configuration order, each without the names an earlier one claims, as a
 * configuration edited by hand or synced can have them. Each name left out is a problem of the later
 * plugin, listed in every answer as a broken plugin is (K8).
 */
export function settle(plugins: readonly Plugin[]): { plugins: Plugin[]; clashes: PluginProblem[] } {
  const kept: Plugin[] = []
  const clashes: PluginProblem[] = []
  for (const plugin of plugins) {
    const taken = takenBy(plugin, kept)
    if (taken.length === 0) {
      kept.push(plugin)
      continue
    }
    const gone = new Set(taken.map((t) => key(t.claim)))
    const free = (claim: Claim) => !gone.has(key(claim))
    // Built on the plugin itself, so hooks on a prototype stay reachable, and defined, not assigned, so a frozen plugin works too.
    const trimmed = Object.create(plugin, {
      statements: { value: plugin.statements.filter((name) => free({ kind: 'statement', name })), enumerable: true },
      ownerCommands: { value: plugin.ownerCommands.filter((c) => free({ kind: 'command', name: c.name })), enumerable: true },
      views: { value: plugin.views?.filter((v) => free({ kind: 'view', name: v.id })), enumerable: true },
    }) as Plugin
    kept.push(trimmed)
    for (const { claim, holder } of taken) {
      clashes.push({ plugin: plugin.name, message: `${said(claim)}已归插件 ${holder}，这里的同名一项没有接上。一个名字只归一个插件，卸下其中一个就好。` })
    }
  }
  return { plugins: kept, clashes }
}
