// B1: `plugin new` writes a plugin project, or refuses before writing anything. The project's own
// build and tests run in scaffold.slow.test.ts.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PNEUMA_BASE_VERSION } from '@pneuma-base/kernel'
import { sandbox, tempDir } from './helpers.js'

describe('plugin new', () => {
  const sb = sandbox()
  const packages = tempDir('pb-packages-')
  for (const file of [`pneuma-base-${PNEUMA_BASE_VERSION}.tgz`, `pneuma-base-sdk-${PNEUMA_BASE_VERSION}.tgz`]) writeFileSync(join(packages, file), '')

  it('writes a project named after its directory, depending on the two package files by a path that holds wherever the project moves', () => {
    const project = join(tempDir('pb-new-'), 'marks')
    const r = sb.run(['plugin', 'new', project, '--packages', packages, '--json'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json()).toMatchObject({ outcome: 'done', name: 'marks', kind: 'blank' })
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
    expect(manifest.devDependencies['pneuma-base']).toBe(`file:${packages}/pneuma-base-${PNEUMA_BASE_VERSION}.tgz`)
    expect(manifest.devDependencies['@pneuma-base/sdk']).toBe(`file:${packages}/pneuma-base-sdk-${PNEUMA_BASE_VERSION}.tgz`)
    expect(Object.keys(manifest.scripts)).toEqual(['build', 'test', 'install-local'])
    const index = readFileSync(join(project, 'src/index.ts'), 'utf8')
    expect(index).toContain("pluginName('marks')")
    expect(index).not.toContain('{{name}}')
    expect(readFileSync(join(project, 'src/cognition.md'), 'utf8')).toContain('pneuma-base @{{授权的名字}} say marks notes/plan.md')
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toContain('| `src/ui/panel.html` |')
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toContain('node_modules/pneuma-base/PLUGINS.md')
  })

  it('names the plugin standard that ships with this command line, in its answer and in --json', () => {
    const standard = fileURLToPath(new URL('../../../PLUGINS.md', import.meta.url))
    const project = join(tempDir('pb-new-'), 'named')
    const r = sb.run(['plugin', 'new', project, '--packages', packages])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`插件规范：${standard}`)
    const again = sb.run(['plugin', 'new', join(tempDir('pb-new-'), 'named'), '--packages', packages, '--json'])
    expect(again.json().standard).toBe(standard)
  })

  it('writes the deploy kind with its target', () => {
    const project = join(tempDir('pb-new-'), 'site')
    const r = sb.run(['plugin', 'new', project, '--kind', 'deploy', '--name', 'my-site', '--packages', packages, '--json'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.json().files).toContain('src/target.ts')
    expect(readFileSync(join(project, 'src/index.ts'), 'utf8')).toContain("deployPlugin('my-site', localTarget")
  })

  it('with --help prints its own usage, and writes nothing', () => {
    const where = tempDir('pb-new-')
    const r = sb.run(['plugin', 'new', join(where, 'x'), '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^用法：pneuma-base plugin new <目录> \[--kind blank\|deploy\] \[--name <插件名>\] \[--packages <两个包文件所在的目录>\]\n/)
    for (const flag of ['--kind', '--name', '--packages']) expect(r.stdout).toContain(`\n  ${flag}`)
    expect(r.stdout).not.toContain('动词：')
    expect(sb.run(['plugin', 'new', '--help']).stdout).toBe(r.stdout)
    expect(readdirSync(where)).toEqual([])
  })

  it('refuses before writing anything: a directory that is not empty, package files that are not there, a name or kind that cannot be', () => {
    const full = tempDir('pb-new-')
    mkdirSync(join(full, 'x'))
    expect(sb.run(['plugin', 'new', full, '--name', 'x', '--packages', packages, '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'not-empty' })
    const empty = join(tempDir('pb-new-'), 'empty-one')
    expect(sb.run(['plugin', 'new', empty, '--packages', tempDir('pb-none-'), '--json']).json()).toMatchObject({ outcome: 'refused', reason: 'no-package-files' })
    for (const args of [['--name', 'Bad_Name'], ['--name', 'find'], ['--kind', 'website']]) {
      const r = sb.run(['plugin', 'new', empty, ...args, '--packages', packages])
      expect(r.code, args.join(' ')).toBe(1)
      expect(r.stderr).toContain('用法错误')
    }
    expect(readdirSync(join(empty, '..'))).toEqual([])
  })
})
