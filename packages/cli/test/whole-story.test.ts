// C10, through the command line: one library with every plugin installed, the whole story told in
// order. An agent makes ten small sites; the owner puts four online and archives three; another
// agent, elsewhere, changes one that is online; the library syncs to a second library, where a
// sentence finds a site. Each step asserts what a person sees: the text, the exit code, the files.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run } from './helpers.js'

const PLUGINS = ['version', 'deploy', 'sync', 'search']

/** Ten small sites, each an index.html with its own visible text. */
const SITES: Record<string, string> = {
  coffee: '手冲咖啡：豆子、水温和研磨度',
  hiking: '登山路线：从山脚到山顶的三条路',
  books: '旧书交换：每月第一个周六',
  pets: '宠物医院：疫苗和体检',
  cycling: '城市骑行：周末的骑行路线',
  recipes: '家常菜谱：红烧肉和番茄炒蛋',
  photo: '摄影入门：光圈与快门',
  plants: '盆栽养护：浇水和光照',
  music: '古典音乐：巴赫入门',
  camping: '露营装备：帐篷和睡袋',
}
const ONLINE = ['coffee', 'hiking', 'books', 'pets']
const ARCHIVED = ['plants', 'music', 'camping']

const sb = sandbox()
const root = tempDir('pb-story-')
const lib = join(root, 'lib')
const lib2 = join(root, 'lib2')
const www = join(root, 'www')
const syncTarget = join(root, 'sync-target')
const claudeDir = join(root, 'claude-work')
const codexDir = join(root, 'codex-work')
for (const dir of [syncTarget, claudeDir, codexDir]) mkdirSync(dir, { recursive: true })

const ok = (r: Run): Run => {
  expect(r.code, `${r.stdout}${r.stderr}`).toBe(0)
  return r
}
const owner = (library: string, args: string[]) => sb.run(['--library', library, ...args], { cwd: root })
const claude = (args: string[]) => sb.run(['--library', lib, '--as', 'claude-code', '--session', 'claude-1', ...args], { cwd: claudeDir })
const codex = (args: string[]) => sb.run(['--library', lib, '--as', 'codex', '--session', 'codex-1', ...args], { cwd: codexDir })
const lines = (r: Run) => r.stdout.trimEnd().split('\n')

function site(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), `<!doctype html><title>${text}</title><h1>${text}</h1>\n`)
  return dir
}

/** The sites a dir deploy target serves: its entries besides index.json and dot-named scratch. */
const served = () => (existsSync(www) ? readdirSync(www).filter((n) => !n.startsWith('.') && n !== 'index.json').sort() : [])

describe('the whole story, with every plugin installed', () => {
  it('the owner makes a library, adds the plugins, and sets a deploy target, a sync target and an embedder', () => {
    ok(sb.run(['init', lib], { cwd: root }))
    for (const name of PLUGINS) ok(owner(lib, ['plugin', 'enable', name]))
    ok(owner(lib, ['deploy', 'target', 'set', '--kind', 'dir', '--to', www]))
    ok(owner(lib, ['sync', 'target', 'set', '--kind', 'dir', '--to', syncTarget]))
    ok(owner(lib, ['search', 'embedding', 'set', '--kind', 'hash']))
    const description = readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')
    for (const name of ['ledger', ...PLUGINS]) expect(description).toContain(`- \`${name}\`：`)
  })

  it('an agent starts, puts ten sites in as made things, and declares each deployable and versioned', () => {
    ok(claude(['start', '做十个小网站']))
    for (const [name, text] of Object.entries(SITES)) {
      const put = ok(claude(['put', site(join(claudeDir, name), text), '--to', `sites/${name}`, '--generated']))
      // Five plugins, one put: the answer stays a head line and one line per plugin that had something to say.
      expect(lines(put)[0]).toMatch(new RegExp(` sites/${name}$`))
      expect(lines(put).length).toBeLessThanOrEqual(4)
      expect(ok(claude(['say', 'deployable', `sites/${name}`])).stdout).toContain('它现在不在线；上不上线由主人决定')
      ok(claude(['say', 'versioned', `sites/${name}`]))
    }
    expect(claude(['deploy', 'on', 'sites/coffee']).code).toBe(2)
    expect(served()).toEqual([])
  })

  it('the owner turns four on and archives three of the others; the deploy target holds exactly the four', () => {
    for (const name of ONLINE) expect(ok(owner(lib, ['deploy', 'on', `sites/${name}`])).stdout).toMatch(new RegExp(`^已上线 sites/${name} → `))
    for (const name of ARCHIVED) expect(lines(ok(owner(lib, ['archive', `sites/${name}`])))[0]).toBe(`已归档：sites/${name} → _archive/sites/${name}`)
    expect(served()).toEqual(ONLINE.map((name) => `sites-${name}`).sort())
    for (const name of ONLINE) expect(readFileSync(join(www, `sites-${name}`, 'index.html'), 'utf8')).toContain(SITES[name])
  })

  it('another agent, in another directory, starts with a sentence about an online site and is told about it', () => {
    const start = ok(codex(['start', '把手冲咖啡那个网站的配色改一下']))
    const related = start.stdout.slice(start.stdout.indexOf('【可能相关的条目】'))
    expect(related).toContain('sites/coffee')
    expect(related).toContain('手冲咖啡')
  })

  it('it puts a new directory over that site; the target follows, two versions are listed, version 1 exports the old bytes', () => {
    const before = readFileSync(join(lib, 'sites/coffee/index.html'))
    const put = ok(codex(['put', site(join(codexDir, 'coffee'), '手冲咖啡：豆子、水温和研磨度，换了深色配色'), '--to', 'sites/coffee', '--generated']))
    expect(lines(put)).toEqual([
      expect.stringMatching(/ sites\/coffee$/),
      expect.stringMatching(/^ {2}ledger：.* · 条目 i_/),
      expect.stringMatching(/^ {2}version：.*sites\/coffee.*2/),
      expect.stringMatching(/^ {2}deploy：sites\/coffee 在线，已重新发布/),
    ])
    expect(readFileSync(join(www, 'sites-coffee/index.html'), 'utf8')).toContain('换了深色配色')
    expect(ok(codex(['version', 'list', 'sites/coffee', '--json'])).json().data.versions.map((v: { n: number; by: string }) => [v.n, v.by])).toEqual([[1, 'claude-code'], [2, 'codex']])
    ok(codex(['version', 'export', 'sites/coffee', '--version', '1', '--to', './coffee-v1']))
    expect(readFileSync(join(codexDir, 'coffee-v1/index.html'))).toEqual(before)
  })

  it('the library syncs; a second library with the same plugins syncs from the same target and shows the same provenance', () => {
    expect(ok(owner(lib, ['sync', 'now', '--json'])).json().data.counts).toMatchObject({ pushed: expect.any(Number), pulled: 0, conflicts: 0 })
    ok(sb.run(['init', lib2], { cwd: root }))
    for (const name of PLUGINS) ok(owner(lib2, ['plugin', 'enable', name]))
    ok(owner(lib2, ['sync', 'target', 'set', '--kind', 'dir', '--to', syncTarget]))
    const pulled = ok(owner(lib2, ['sync', 'now', '--json'])).json().data.counts
    expect(pulled.pulled).toBeGreaterThan(0)
    expect(pulled.conflicts).toBe(0)
    const provenance = (library: string) => {
      const sections = ok(sb.run(['--library', library, '--as', 'codex', 'inspect', 'sites/coffee', '--json'], { cwd: root })).json().sections
      // How deep this machine's last look went is this library's own, not the provenance.
      return (sections.find((s: { plugin: string }) => s.plugin === 'ledger').body as string).replace(/\n上次检查：.*/, '')
    }
    expect(provenance(lib2)).toBe(provenance(lib))
    expect(provenance(lib2)).toMatch(/^生成 · claude-code · .* · 场景 claude-1\n任务：做十个小网站/)
    expect(readFileSync(join(lib2, 'sites/coffee/index.html'), 'utf8')).toContain('换了深色配色')
  })

  it('there, a sentence that is not the file name finds the 手冲咖啡 site first, under the scene it was made in', () => {
    const found = lines(ok(sb.run(['--library', lib2, '--as', 'codex', 'find', '在家怎么冲一杯好喝的咖啡'], { cwd: root })))
    expect(found[0]).toMatch(/^场景 claude-1 · claude-code · .* · 任务：做十个小网站$/)
    expect(found[1]).toMatch(/^ {2}sites\/coffee {2}目录，生成 {2}/)
  })

  it('check, as an agent at the end, is quiet about what is in order and mentions nothing stale', () => {
    const r = ok(sb.run(['--library', lib, '--as', 'claude-code', '--session', 'claude-2', 'check', '--json'], { cwd: claudeDir }))
    expect(r.json().sections.map((s: { title: string }) => s.title)).toEqual(['最近动态'])
    // That check was a look; the text asks from the same moment the look did.
    const since = r.json().sections[0].data.since as string
    const text = ok(sb.run(['--library', lib, '--as', 'claude-code', '--session', 'claude-2', 'check', '--since', since], { cwd: claudeDir })).stdout
    expect(text).toContain('sites/coffee 内容已更新')
    expect(text).not.toMatch(/可能已过期|来源缺失|未登记|外部修改|不一致|冲突副本/)
    // A scene's heading says where it ran; the lines under it name things, never a directory outside the library.
    // (What only the owner can settle comes after, each answer as the owner's command for this library.)
    const told = text.split('## 需所有者处理')[0] ?? ''
    expect(told.split('\n').filter((line) => line.startsWith('  ')).join('\n')).not.toContain(root)
    expect(text).toContain(`pneuma-base deploy on sites/cycling --library ${lib}  # 上线（推荐）`)
  })
})
