// PLUGINS.md's blocks that install from the registry, the five minutes first, run as written in a
// directory holding the two package files pack:dist builds. npm installs globally into a temporary
// prefix, the home is temporary, and the browser `pneuma-base view` would open is a stand-in. The
// block that ends by serving the UI is stopped once its page answers with the plugin's view.
// Slow and needs the registry, so it runs with `pnpm test:slow`, not `pnpm test`.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { BROWSER_SHIMS, SLOW, STANDARD, fences, runBlock, unprinted } from './plugins-doc.js'
import { tempDir } from './helpers.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

describe('PLUGINS.md, the blocks that install from the registry', () => {
  const blocks = fences(readFileSync(STANDARD, 'utf8'))
  const packages = tempDir('pb-doc-packages-')
  const root = tempDir('pb-doc-slow-')
  const bin = join(root, 'bin')
  const env = {
    PATH: `${bin}:${join(root, 'global/bin')}:${process.env.PATH ?? ''}`,
    HOME: join(root, 'home'),
    PNEUMA_BASE_HOME: join(root, 'home/.pneuma-base'),
    npm_config_prefix: join(root, 'global'),
    npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm'),
    npm_config_update_notifier: 'false',
    ...Object.fromEntries(['LANG', 'LC_ALL', 'TMPDIR'].flatMap((n) => (process.env[n] === undefined ? [] : [[n, process.env[n] as string]]))),
  }

  beforeAll(() => {
    const packed = spawnSync(process.execPath, [join(REPO, 'scripts/pack-dist.mjs'), '--out', packages], { encoding: 'utf8' })
    expect(packed.status, packed.stderr).toBe(0)
    mkdirSync(bin, { recursive: true })
    for (const name of BROWSER_SHIMS) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "$1" >> "${join(root, 'opened')}"\n`)
      chmodSync(join(bin, name), 0o755)
    }
  }, 300_000)

  for (const block of blocks.filter((b) => b.lang === 'sh' && b.marker === SLOW)) {
    it(`runs the block at line ${block.line}`, async () => {
      const script = join(root, `block-${block.line}.sh`)
      writeFileSync(script, `${block.body}\n`)
      const r = await runBlock(script, {
        cwd: packages,
        env,
        timeout: 540_000,
        // The page the five minutes end on: the plugin's own view, with the mark the agent left.
        async served(url) {
          const page = (await (await fetch(url.replace('/?token=', '/api/view?view=marks.marks&token='))).json()) as { outcome: string; problems: unknown[]; blocks: unknown[] }
          expect(page).toMatchObject({ outcome: 'shown', problems: [] })
          expect(JSON.stringify(page.blocks)).toContain('第三节的数字还没核对')
        },
      })
      const shown = `PLUGINS.md line ${block.line}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`
      expect(r.code, shown).toBe(0)
      expect(unprinted(blocks, block, r), shown).toEqual([])
      expect(r.stdout, 'plugin new names the standard installed with the command line').toContain(`插件规范：${join(root, 'global/lib/node_modules/pneuma-base/PLUGINS.md')}`)
    }, 600_000)
  }
})
