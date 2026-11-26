// Builds the plugin directory pneuma-base installs: dist/index.js with every dependency bundled in,
// and beside it cognition.md and ui/, which index.js reads relative to itself.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('dist', { recursive: true, force: true })
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
})
cpSync('src/cognition.md', 'dist/cognition.md')
if (existsSync('src/ui')) cpSync('src/ui', 'dist/ui', { recursive: true })
