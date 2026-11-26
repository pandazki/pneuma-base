// The space plugin: the deploy kit with one kind of target, PneumaSpace (target.ts). The kit does what
// every deploy plugin does: an agent declares a thing deployable, the owner's switch decides whether
// it is online, what is online follows the library's current content, and the records, commands,
// pages and cognition section that go with it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deployPlugin } from '@pneuma-base/sdk/kit'
import { spaceTarget } from './target.ts'

/** src/cognition.md, without the notes to the plugin's author: what agents should know about this target. */
const cognition = readFileSync(new URL('./cognition.md', import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->\n*/g, '')
  .trim()

export default deployPlugin('space', spaceTarget, {
  title: 'PneumaSpace',
  heading: '上线到 PneumaSpace：主人开关',
  cognition,
  icon: 'cloud-upload',
  version: '0.2.0',
  summary: '声明了可以部署的东西由主人开关上线，作为 PneumaSpace 上的应用。',
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),
})
