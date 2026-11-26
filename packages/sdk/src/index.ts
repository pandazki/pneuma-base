// The plugin contract: the types a plugin is written against, the contract version it declares, and
// constructors for the branded values a plugin makes itself. None of the kernel's code is here: the
// kernel's helpers reach a plugin through `PluginContext.tools`.
import type { Instant, Plugin, PluginName } from './types.js'

export * from './types.js'
export * from './storage.js'
export { ICON_NAMES, type IconName } from './icons.js'
export { defineCommand, formOf, usageOf, type FixedValue } from './params.js'

/**
 * The version of the plugin contract this package describes. A plugin declares it as `contract`.
 * Version 2 hands a plugin storage's words (`tools.storage`); the kernel still runs a plugin written
 * against version 1, whose tools are kept as a layer over version 2's until those plugins move.
 */
export const CONTRACT = 2

/**
 * The version of Pneuma Base this package belongs to. The command line, this package and the built-in
 * plugins carry it; `pnpm pack:dist` stamps it on both package files. A plugin of your own has its own version.
 */
export const PNEUMA_BASE_VERSION = '0.9.0'

/** Returns its argument, typed, so a plugin's hooks are checked against the contract where it is written. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}

/** A plugin's name is also the name of its directory under `.pneuma-base/` and under `$PNEUMA_BASE_HOME/plugins/`. */
export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,40}$/

/** The kernel's own owner commands. No plugin command takes one of these names. */
export const KERNEL_COMMAND_NAMES = [
  'grant issue',
  'grant revoke',
  'plugin add',
  'plugin remove',
  'skill install',
  'archive purge',
  'plugin install',
  'plugin uninstall',
  'plugin list',
  'secret set',
  'secret list',
  'secret remove',
  'agent detect',
  'agent connect',
  'agent disconnect',
  'agent list',
  'launcher install',
  'request list',
  'request approve',
  'request decline',
  'noise list',
  'noise add',
  'noise remove',
  'storage list',
  'storage install',
  'storage remove',
  'storage update',
] as const

/**
 * Names no plugin takes. A plugin's commands start with its name, so it is none of the command line's
 * own words or the first words of the kernel's commands; and its directory sits beside the kernel's
 * record places: the kernel's (`kernel`, `requests`) and storage's own areas (`tmp`, `trash`, `holds`, `cache`).
 */
export const RESERVED_PLUGIN_NAMES: readonly string[] = [
  'tmp',
  'requests',
  'kernel',
  'trash',
  'holds',
  'ask',
  'request',
  'start',
  'show',
  'find',
  'inspect',
  'put',
  'say',
  'check',
  'archive',
  'unarchive',
  'init',
  'view',
  'help',
  'grant',
  'plugin',
  'skill',
  'secret',
  'agent',
  'launcher',
  'noise',
  'storage',
  'cache',
]

/** The name of a secret a plugin declares; it is also a file name under `$PNEUMA_BASE_HOME/secrets/<plugin>/`. */
export const SECRET_NAME = /^[a-z][a-z0-9-]{0,40}$/

export function pluginName(name: string): PluginName {
  if (!PLUGIN_NAME.test(name)) throw new Error(`not a plugin name (lowercase letters, digits, hyphens): ${name}`)
  return name as PluginName
}

/** A moment as the contract writes it, ISO 8601 in UTC. Throws on a date that is not one. */
export function instant(at: Date | number | string): Instant {
  return new Date(at).toISOString() as Instant
}
