import { copyFile } from 'node:fs/promises'
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
})
await copyFile('src/cognition.md', 'dist/cognition.md')
