import { readFileSync } from 'node:fs'
import type { Library } from '@pneuma-base/sdk'

// The texts live in packages/kernel/cognition/, next to src/ and dist/.
const COGNITION = new URL('../cognition/', import.meta.url)
const text = (name: string): string => readFileSync(new URL(name, COGNITION), 'utf8')

const GRANT_NAME = '{{授权的名字}}'
const SAME_NAME = '{{同名时怎么办}}'
const LIBRARY_PATH = '{{库的路径}}'

/** The description is a file of the library, not of one grant, so it names the grant generically. */
export const DESCRIPTION_GRANT_NAME = '<你的授权名>'

/**
 * PNEUMA-BASE.md, assembled only from the configuration and the installed plugins' cognition
 * sections (K6): the kernel's intro, each plugin's section in configuration order, the kernel's
 * rules, and the current configuration. The same-name sentence says what an installed plugin
 * with `revise` keeps: nothing, some things, or every replaced thing.
 */
export function assembleDescription(library: Pick<Library, 'config' | 'plugins'>): string {
  const sameName = text(`3-same-name-${replacedKept(library.plugins)}.txt`).trim()
  const parts = [
    text('1-kernel-intro.md'),
    ...library.plugins.flatMap((p) => (p.cognition ? [p.cognition.text] : [])),
    text('3-kernel-rules.md').replace(SAME_NAME, sameName),
    library.config.plugins.length === 0 ? text('4-config-bare.md') : configuration(library),
  ]
  return `${parts.map((p) => p.trimEnd()).join('\n\n').replaceAll(GRANT_NAME, DESCRIPTION_GRANT_NAME)}\n`
}

/** What happens to a replaced thing's content with these plugins: no plugin holds it, some are held, or every one is. */
function replacedKept(plugins: Library['plugins']): 'bare' | 'some' | 'every' {
  const revisers = plugins.filter((p) => p.revise)
  if (revisers.length === 0) return 'bare'
  return revisers.some((p) => p.keeps === 'every') ? 'every' : 'some'
}

function configuration(library: Pick<Library, 'config' | 'plugins'>): string {
  const lines = library.config.plugins.map((name) => {
    const plugin = library.plugins.find((p) => p.name === name)
    if (!plugin) return `- \`${name}\`：这个 pneuma-base 里没有这个插件，它暂时不起作用`
    return `- \`${name}\`：${plugin.cognition?.title ?? '没有说明'}`
  })
  return ['## 这个库现在的配置', '', '装了这些插件，各自的说明在上文：', '', ...lines].join('\n')
}

/** The skill file for one grant: the library's location and the grant's name, pointing at the description. */
export function skillText(grantName: string, libraryRoot: string): string {
  return text('SKILL.md').replaceAll(GRANT_NAME, grantName).replaceAll(LIBRARY_PATH, libraryRoot)
}
