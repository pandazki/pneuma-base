// The real command line with the test-only plugins added to its built-in table.
import { main, processIo } from '../../dist/main.js'
import { builtinPlugins } from '../../dist/plugins.js'
import { pager, recorder, thrower } from './test-plugins.ts'

const table = new Map([...builtinPlugins, [recorder.name, recorder], [thrower.name, thrower], [pager.name, pager]])
process.exitCode = await main(process.argv.slice(2), table, processIo())
