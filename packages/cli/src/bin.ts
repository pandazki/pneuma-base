#!/usr/bin/env node
import { meetsNodeFloor, NODE_FLOOR } from './node-floor.js'

if (!meetsNodeFloor(process.versions.node)) {
  process.stderr.write(`pneuma-base 要 Node ${NODE_FLOOR} 以上，现在是 ${process.versions.node}。\n`)
  process.exit(1)
}

// Loaded after the check, so an older Node gets the sentence above and not an error from deep in a module.
const { platformMismatch } = await import('@pneuma-base/kernel')
const mismatch = platformMismatch()
if (mismatch !== null) {
  process.stderr.write(`${mismatch}\n`)
  process.exit(1)
}
const { main, processIo } = await import('./main.js')
const { builtinPlugins } = await import('./plugins.js')

process.exitCode = await main(process.argv.slice(2), builtinPlugins, processIo())
