#!/usr/bin/env node
import { main, processIo } from './main.js'
import { builtinPlugins } from './plugins.js'

process.exitCode = await main(process.argv.slice(2), builtinPlugins, processIo())
