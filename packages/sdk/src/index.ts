// The plugin contract: the types a plugin is written against, the contract version it declares, and
// constructors for the branded values a plugin makes itself. None of the kernel's code is here: the
// kernel's helpers reach a plugin through `PluginContext.tools`.
import type { Instant, Plugin, PluginName } from './types.js'

export * from './types.js'

/** The version of the plugin contract this package describes. A plugin declares it as `contract`. */
export const CONTRACT = 1

/** Returns its argument, typed, so a plugin's hooks are checked against the contract where it is written. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}

/** A plugin's name is also the name of its directory under `.pneuma-base/` and under `$PNEUMA_BASE_HOME/plugins/`. */
export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,40}$/

export function pluginName(name: string): PluginName {
  if (!PLUGIN_NAME.test(name)) throw new Error(`not a plugin name (lowercase letters, digits, hyphens): ${name}`)
  return name as PluginName
}

/** A moment as the contract writes it, ISO 8601 in UTC. Throws on a date that is not one. */
export function instant(at: Date | number | string): Instant {
  return new Date(at).toISOString() as Instant
}
