import type { PluginTable } from '@pneuma-base/kernel'
import { ledger } from '@pneuma-base/plugin-ledger'
import { sync } from '@pneuma-base/plugin-sync'

/** The plugins this command line knows, by the name a library's configuration uses. */
export const builtinPlugins: PluginTable = new Map([[ledger.name, ledger], [sync.name, sync]])
