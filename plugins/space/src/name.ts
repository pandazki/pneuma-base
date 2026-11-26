// App names, the same on both kinds of PneumaSpace: `^[a-z][a-z0-9-]{0,39}$`, unique across a deployment.
import { createHash } from 'node:crypto'
import type { FlagParam, LibraryPath } from '@pneuma-base/sdk'
import { siteName, type SiteName } from '@pneuma-base/sdk/kit'

const MAX_NAME = 40

/** The plugin's name: its commands begin with it. */
export const PLUGIN = 'space'
/** Who manages the apps the plugin makes; PneumaSpace answers 409 to a write that does not name it. */
export const MANAGER = 'pneuma-base'

/** `--prefix`, the same flag on both kinds, as the kit requires of a flag two kinds share. */
export const PREFIX_PARAM = { name: 'prefix', hint: '应用名前缀', kind: 'value', required: true, pattern: '[a-z](?:[a-z0-9-]{0,14}[a-z0-9])?' } as const satisfies FlagParam
export const ORIGIN = 'https?://[^\\s/]+'

/** `<prefix>-<the kit's site name>`, cut to PneumaSpace's 40 characters with six characters of the path's sha256 when too long. */
export function appName(prefix: string, path: LibraryPath): SiteName {
  const whole = `${prefix}-${siteName(path)}`
  if (whole.length <= MAX_NAME) return whole as SiteName
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 6)
  return `${whole.slice(0, MAX_NAME - 7).replace(/-+$/, '')}-${hash}` as SiteName
}
