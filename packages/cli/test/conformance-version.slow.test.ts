// The built-in version plugin passes every check the test kit makes for a third party's plugin.
import { it } from 'vitest'
import { passesEveryCheck } from './conformance-builtins.js'

it('the version plugin passes every conformance check', () => passesEveryCheck('version'))
