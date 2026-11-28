// App names, the same on both kinds of PneumaSpace: `^[a-z][a-z0-9-]{0,39}$`, unique across a deployment.
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { FlagParam, LibraryPath } from '@pneuma-base/sdk'
import { siteName, type SiteName } from '@pneuma-base/sdk/kit'

const MAX_NAME = 40

/** The plugin's name: its commands begin with it. */
export const PLUGIN = 'deploy'
/** Who manages the apps the plugin makes; PneumaSpace answers 409 to a write that does not name it. */
export const MANAGER = 'pneuma-base'

/** `--prefix`, the same flag on both kinds, as the kit requires of a flag two kinds share. Left out, the library's folder gives it. */
export const PREFIX_PARAM = { name: 'prefix', hint: '应用名称前缀', kind: 'value', pattern: '[a-z](?:[a-z0-9-]{0,14}[a-z0-9])?' } as const satisfies FlagParam
export const ORIGIN = 'https?://[^\\s/]+'

/**
 * The prefix a library gets when none is given: its folder's name in lower case, each run of anything
 * but `a-z0-9` one `-`, from its first letter, at most 16 characters, no `-` at the end; `pb` when
 * nothing is left.
 */
export function defaultPrefix(root: string): string {
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 16).replace(/-+$/, '')
  return slug === '' ? 'pb' : slug
}

/** The settings a PneumaSpace connection can change: its prefix. */
export const prefixSetting = (prefix: string) => [{ flag: 'prefix', hint: '应用名称前缀', value: prefix }]

/** The host of an address, as the destination row names it. */
export const hostOf = (address: string) => new URL(address).host

/** `<prefix>-<the kit's site name>`, cut to PneumaSpace's 40 characters with six characters of the path's sha256 when too long. */
export function appName(prefix: string, path: LibraryPath): SiteName {
  const whole = `${prefix}-${siteName(path)}`
  if (whole.length <= MAX_NAME) return whole as SiteName
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 6)
  return `${whole.slice(0, MAX_NAME - 7).replace(/-+$/, '')}-${hash}` as SiteName
}
