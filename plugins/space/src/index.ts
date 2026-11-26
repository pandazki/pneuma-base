// The space plugin: the deploy kit with two kinds of target, PneumaSpace on a machine (machine.ts) and
// PneumaSpace on Cloudflare (cloudflare.ts); the owner picks one with `space target set --kind`. The
// kit does what every deploy plugin does: an agent declares a thing deployable, the owner's switch
// decides whether it is online, what is online follows the library's current content, and the
// records, commands, pages and cognition section that go with it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deployPlugin } from '@pneuma-base/sdk/kit'
import { cloudflareTarget } from './cloudflare.ts'
import { machineTarget } from './machine.ts'
import { PLUGIN } from './name.ts'

/** src/cognition.md, without the notes to the plugin's author: what agents should know about this target. */
const cognition = readFileSync(new URL('./cognition.md', import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->\n*/g, '')
  .trim()

export default deployPlugin(PLUGIN, [machineTarget, cloudflareTarget], {
  title: 'PneumaSpace',
  heading: '上线到 PneumaSpace：主人开关',
  cognition,
  icon: 'cloud-upload',
  version: '0.3.0',
  summary: '声明了可以部署的东西由主人开关上线，作为 PneumaSpace 上的应用：一台机器上的，或 Cloudflare 上的。',
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),
})
