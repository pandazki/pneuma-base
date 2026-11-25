// B1, B5, B6: a third party's whole loop, from nothing to a plugin in a library. The command line
// comes from its package file, installed with no registry, so nothing reaches into this repository.
// For each kind, its `plugin new` writes a project; it installs its dependencies (the two package files, and the
// bundler, the type checker and Node's types from the registry), builds, passes its own tests, and
// installs into a temporary home, where a library adds it, calls its command and opens its view.
// Slow and needs the registry, so it runs with `pnpm test:slow`, not `pnpm test`.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './helpers.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

const COMMON = ['.gitignore', 'README.md', 'package.json', 'scripts/build.mjs', 'src/cognition.md', 'src/index.ts', 'src/ui/panel.html', 'test/conformance.test.ts', 'test/plugin.test.ts', 'tsconfig.json']
const FILES = { blank: COMMON, deploy: [...COMMON, 'src/target.ts'].sort() }

describe('a plugin project from plugin new', () => {
  const packages = tempDir('pb-packages-')
  const tools = tempDir('pb-tools-')
  const cli = join(tools, 'node_modules/pneuma-base/dist/bin.js')
  const home = tempDir('pb-home-')
  // No agent session variable reaches these calls: installing a plugin is the owner's.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PNEUMA_BASE_HOME: join(home, '.pneuma-base'),
    npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm'),
    npm_config_update_notifier: 'false',
  }
  const run = (cwd: string, command: string, args: string[], input = '') => {
    const r = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', timeout: 240_000 })
    expect(r.status, `${command} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
    return r.stdout
  }

  beforeAll(() => {
    run(REPO, process.execPath, [join(REPO, 'scripts/pack-dist.mjs'), '--out', packages])
    writeFileSync(join(tools, 'package.json'), '{ "private": true }\n')
    run(tools, 'npm', ['install', '--offline', '--no-audit', '--no-fund', join(packages, readdirSync(packages).find((f) => !f.includes('-sdk-')) as string)])
  })

  for (const kind of ['blank', 'deploy'] as const) {
    it(`${kind}: builds, passes its own tests untouched, installs, and works in a library`, async () => {
      const name = `demo-${kind}`
      const project = join(tempDir('pb-scaffold-'), name)
      const made = JSON.parse(run(home, process.execPath, [cli, 'plugin', 'new', project, '--kind', kind, '--packages', packages, '--json']))
      expect(made).toMatchObject({ outcome: 'done', name, kind, files: FILES[kind] })

      run(project, 'npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'])
      run(project, 'npm', ['run', 'build'])
      expect(['dist/index.js', 'dist/cognition.md', 'dist/ui/panel.html'].filter((f) => !existsSync(join(project, f)))).toEqual([])
      // Node's test runner prints `ℹ fail 0` or, where it reports in TAP, `# fail 0`.
      expect(run(project, 'npm', ['test'])).toMatch(/^(ℹ|#) fail 0$/m)
      run(project, 'npm', ['run', 'install-local'])
      expect(existsSync(join(home, '.pneuma-base/plugins', name, 'index.js'))).toBe(true)

      // The command line the project installed, on a library of the home the plugin went into.
      const bin = join(project, 'node_modules/pneuma-base/dist/bin.js')
      const lib = join(tempDir('pb-lib-'), 'lib')
      const pb = (args: string[], input = '') => JSON.parse(run(home, process.execPath, [bin, ...args, '--json'], input))
      const agent = (args: string[], input = '') => pb(['--library', lib, '--as', 'claude-code', ...args], input)
      expect(pb(['init', lib]).outcome).toBe('done')
      expect(pb(['plugin', 'add', name, '--library', lib]).outcome).toBe('done')
      let view: string
      if (kind === 'blank') {
        expect(agent(['put', '-', '--to', 'notes/plan.md', '--made'], '# 计划\n').outcome).toBe('accepted')
        expect(agent(['say', name, 'notes/plan.md', '第三节的数字还没核对']).outcome).toBe('heard')
        expect(pb([name, 'list', '--library', lib]).data.marks.map((m: any) => m.text)).toEqual(['第三节的数字还没核对'])
        view = `${name}.marks`
      } else {
        const site = join(home, 'shop')
        mkdirSync(site, { recursive: true })
        writeFileSync(join(site, 'index.html'), '<h1>小店</h1>\n')
        expect(agent(['put', site, '--to', 'sites/shop', '--made']).outcome).toBe('accepted')
        expect(agent(['say', 'deployable', 'sites/shop']).outcome).toBe('heard')
        const published = join(home, 'published')
        expect(pb([name, 'target', 'set', '--to', published, '--library', lib]).outcome).toBe('done')
        expect(pb([name, 'on', 'sites/shop', '--library', lib]).outcome).toBe('done')
        expect(readFileSync(join(published, 'sites-shop/index.html'), 'utf8')).toBe('<h1>小店</h1>\n')
        view = `${name}.sites`
      }

      const viewer = spawn(process.execPath, [bin, 'view', lib, '--no-open'], { cwd: home, env })
      try {
        const url = await new Promise<string>((resolve, reject) => {
          let printed = ''
          viewer.stdout.on('data', (chunk: Buffer) => {
            printed += chunk.toString('utf8')
            const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/.exec(printed)
            if (match) resolve(match[0])
          })
          viewer.once('exit', (code) => reject(new Error(`view exited with ${code}: ${printed}`)))
        })
        const page: any = await (await fetch(url.replace('/?token=', `/api/view?view=${view}&token=`))).json()
        expect(page).toMatchObject({ outcome: 'shown', problems: [] })
        const panel = page.blocks.find((b: any) => b.kind === 'custom')
        expect(panel).toMatchObject({ plugin: name, entry: 'panel.html' })
        expect((await fetch(new URL(`/plugin-ui/${name}/panel.html`, url))).status).toBe(200)
      } finally {
        viewer.kill('SIGINT')
      }
    })
  }
})
