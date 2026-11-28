// B7: the two package files a plugin project depends on, installed into an empty directory with no
// registry, run as a third party runs them.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
    expect(run('npx', ['--no', '--', 'pneuma-base', '--library', 'lib', 'put', '-', '--to', 'notes/a.md', '--generated'], '# 一页\n')).toContain('已放入 notes/a.md')
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

  it('carry the local folder’s provider and the contract suite’s program for the platform they were built on, which the official list and storage list name', () => {
    const bin = join(project, 'node_modules/pneuma-base/node_modules/@pneuma-base/kernel/bin')
    const platform = `${process.platform}-${process.arch}`
    expect(readdirSync(bin).sort()).toEqual(['platform', 'pneuma-base-contract', 'pneuma-base-core'])
    expect(readFileSync(join(bin, 'platform'), 'utf8')).toBe(`${platform}\n`)
    const sha = createHash('sha256').update(readFileSync(join(bin, 'pneuma-base-core'))).digest('hex')
    const official = JSON.parse(readFileSync(join(bin, '../official-providers.json'), 'utf8'))
    expect(official.providers).toEqual([expect.objectContaining({ name: 'local-folder', builtIn: true, sha256: { [platform]: sha } })])
    const listed = JSON.parse(run('npx', ['--no', '--', 'pneuma-base', 'storage', 'list', '--json'])).data.providers
    expect(listed).toEqual([expect.objectContaining({ name: 'local-folder', executable: join(bin, 'pneuma-base-core'), sha256: sha, version: official.providers[0].version })])
  })

  it('say plainly, on a machine of another platform, which one the build is for', () => {
    const file = join(project, 'node_modules/pneuma-base/node_modules/@pneuma-base/kernel/bin/platform')
    const built = readFileSync(file, 'utf8')
    const here = `${process.platform}-${process.arch}`
    const other = here === 'darwin-arm64' ? 'linux-x64' : 'darwin-arm64'
    writeFileSync(file, `${other}\n`)
    try {
      const r = spawnSync('npx', ['--no', '--', 'pneuma-base', 'storage', 'list'], { cwd: project, env, encoding: 'utf8' })
      expect(r.status).toBe(1)
      expect(r.stderr).toBe(`这个 pneuma-base 是给 ${other === 'darwin-arm64' ? 'Apple 芯片的 Mac (darwin-arm64)' : other} 构建的，这台机器是 ${here}。\n`)
    } finally {
      writeFileSync(file, built)
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
