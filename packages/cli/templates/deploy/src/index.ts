// The {{name}} plugin: the deploy kit with one kind of target. The kit does what every deploy plugin
// does: an agent declares a thing deployable, the owner's switch decides whether it is online, what
// is online follows the library's current content, and the records, commands, pages and cognition
// section that go with it. The target in target.ts is the only part about where sites go.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deployPlugin } from '@pneuma-base/sdk/kit'
import { localTarget } from './target.ts'

/** src/cognition.md, without the notes to the plugin's author: what agents should know about this target. */
const cognition = readFileSync(new URL('./cognition.md', import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->\n*/g, '')
  .trim()

export default deployPlugin('{{name}}', localTarget, {
  title: '发布',
  heading: '上线：所有者开关',
  cognition,
  icon: 'globe',
  version: '0.1.0',
  summary: '已声明可部署的条目由所有者开关上线，发布到本地目录。',
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),
})
