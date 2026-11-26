// B7: the two package files a plugin project depends on, installed into an empty directory with no
// registry, run as a third party runs them.
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PNEUMA_BASE_VERSION } from '@pneuma-base/kernel'
import { tempDir } from './helpers.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

describe('the package files', () => {
  const out = tempDir('pb-packages-')
  const project = tempDir('pb-project-')
  const home = tempDir('pb-home-')
  const env = { PATH: process.env.PATH ?? '', HOME: home, PNEUMA_BASE_HOME: join(home, '.pneuma-base'), npm_config_cache: join(home, '.npm'), npm_config_update_notifier: 'false' }
  const run = (command: string, args: string[], input = '') => {
    const r = spawnSync(command, args, { cwd: project, env, input, encoding: 'utf8', timeout: 120_000 })
    expect(r.status, `${command} ${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0)
    return r.stdout
  }

  it('are built by pack:dist with the repository’s version, and install with no registry', () => {
    const packed = spawnSync(process.execPath, [join(REPO, 'scripts/pack-dist.mjs'), '--out', out], { encoding: 'utf8' })
    expect(packed.status, packed.stderr).toBe(0)
    expect(readdirSync(out).sort()).toEqual([`pneuma-base-${PNEUMA_BASE_VERSION}.tgz`, `pneuma-base-sdk-${PNEUMA_BASE_VERSION}.tgz`])
    writeFileSync(join(project, 'package.json'), '{ "name": "a-plugin", "private": true, "type": "module" }\n')
    run('npm', ['install', '--offline', '--no-audit', '--no-fund', ...readdirSync(out).map((f) => join(out, f))])
    const manifest = JSON.parse(readFileSync(join(project, 'node_modules/pneuma-base/package.json'), 'utf8'))
    expect(manifest.engines).toEqual(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).engines)
  })

  it('carry the plugin standard in the command line’s package, and plugin new names it', () => {
    const standard = join(project, 'node_modules/pneuma-base/PLUGINS.md')
    expect(readFileSync(standard, 'utf8')).toBe(readFileSync(join(REPO, 'PLUGINS.md'), 'utf8'))
    const made = JSON.parse(run('npx', ['--no', '--', 'pneuma-base', 'plugin', 'new', 'demo', '--packages', out, '--json']))
    expect(made.standard).toBe(standard)
  })

  it('give npx pneuma-base, which makes a library, puts into it and serves its UI', async () => {
    expect(run('npx', ['--no', '--', 'pneuma-base', 'init', 'lib'])).toContain('建成库')
    expect(run('npx', ['--no', '--', 'pneuma-base', '--library', 'lib', 'put', '-', '--to', 'notes/a.md', '--made'], '# 一页\n')).toContain('已放入 notes/a.md')
    const viewer = spawn('npx', ['--no', '--', 'pneuma-base', 'view', 'lib', '--no-open', '--port', '0'], { cwd: project, env })
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
      const page = await fetch(url)
      expect(await page.text()).toContain('<div id="root">')
      const files: any = await (await fetch(url.replace('/?token=', '/api/view?view=files&token='))).json()
      expect(JSON.stringify(files.blocks)).toContain('notes')
    } finally {
      viewer.kill('SIGINT')
    }
  })

  it('give the sdk with declarations of its own, whose test kit finds the installed command line', () => {
    const sdk = join(project, 'node_modules/@pneuma-base/sdk')
    const declarations = readdirSync(sdk, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.d.ts'))
    expect(declarations).toEqual(expect.arrayContaining(['dist/index.d.ts', 'dist/kit/index.d.ts', 'dist/testkit/index.d.ts']))
    for (const file of declarations) expect(readFileSync(join(sdk, file), 'utf8'), file).not.toMatch(/from '@pneuma-base\//)
    const found = run(process.execPath, ['--input-type=module', '-e', "import { findCli } from '@pneuma-base/sdk/testkit'; console.log(findCli())"])
    expect(found.trim()).toBe(join(project, 'node_modules/pneuma-base/dist/bin.js'))
  })
})
