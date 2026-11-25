// The plugin contract as a third party builds against it: the sdk's root export, re-exported by the kernel.
import * as sdk from '@pneuma-base/sdk'
import { describe, expect, it } from 'vitest'
import * as kernel from '../src/index.js'

describe('the sdk', () => {
  it('names the contract version, types a plugin as it is, and builds the branded values a plugin makes', () => {
    expect(sdk.CONTRACT).toBe(1)
    const plugin = { contract: sdk.CONTRACT, name: sdk.pluginName('echo'), cognition: null, storage: [], statements: [], ownerCommands: [] }
    expect(sdk.definePlugin(plugin)).toBe(plugin)
    expect(() => sdk.pluginName('Echo')).toThrow()
    expect(sdk.instant(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(() => sdk.instant('not a date')).toThrow()
  })

  it('is what the kernel exports, so imports from the kernel keep working', () => {
    expect(kernel.CONTRACT).toBe(1)
    expect(kernel.pluginName).toBe(sdk.pluginName)
    expect(kernel.definePlugin).toBe(sdk.definePlugin)
  })
})
