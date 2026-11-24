import { readFileSync } from 'node:fs'
import { pluginName, type Plugin } from '@pneuma-base/kernel'

/**
 * 记账与对账. For now only its cognition section, so description assembly and plugin add and
 * remove can be exercised; the hooks come with the ledger itself.
 */
export const ledger: Plugin = {
  name: pluginName('ledger'),
  cognition: { title: '记账与对账', text: readFileSync(new URL('../cognition/2-ledger-section.md', import.meta.url), 'utf8') },
  storage: [],
  statements: [],
  ownerCommands: [],
}
