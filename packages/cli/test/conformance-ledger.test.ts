// The built-in ledger plugin passes every check the test kit makes for a third party's plugin.
import { it } from 'vitest'
import { passesEveryCheck } from './conformance-builtins.js'

it('the ledger passes every conformance check', () => passesEveryCheck('ledger'))
