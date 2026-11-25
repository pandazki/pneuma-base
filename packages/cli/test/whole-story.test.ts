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
    expect(ok(sb.run(['init', lib], { cwd: root })).stdout).toContain('已把')
    for (const name of PLUGINS) expect(ok(owner(lib, ['plugin', 'add', name])).stdout).toBe(`已装上插件 ${name}，说明已重新生成。\n`)
    ok(owner(lib, ['deploy', 'target', 'set', '--kind', 'dir', '--to', www]))
    ok(owner(lib, ['sync', 'target', 'set', '--kind', 'dir', '--to', syncTarget]))
    expect(ok(owner(lib, ['search', 'embedder', 'set', '--kind', 'hash'])).stdout).toContain('能用')
    const description = readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')
    for (const name of ['ledger', ...PLUGINS]) expect(description).toContain(`- \`${name}\`：`)
  })

  it('an agent starts, puts ten sites in as made things, and declares each deployable and versioned', () => {
    expect(lines(ok(claude(['start', '做十个小网站'])))).toContain('已记下（ledger）：在做：做十个小网站')
    for (const [name, text] of Object.entries(SITES)) {
      const put = ok(claude(['put', site(join(claudeDir, name), text), '--to', `sites/${name}`, '--made']))
      // Five plugins, one put: the answer stays a head line and one line per plugin that had something to say.
      expect(lines(put)[0]).toBe(`已放入 sites/${name}`)
      expect(lines(put).length).toBeLessThanOrEqual(4)
      expect(ok(claude(['say', 'deployable', `sites/${name}`])).stdout).toContain('它现在不在线；上不上线由主人决定')
      expect(ok(claude(['say', 'versioned', `sites/${name}`])).stdout).toContain('当前内容记为第 1 版')
    }
    expect(claude(['deploy', 'on', 'sites/coffee']).code).toBe(2)
    expect(served()).toEqual([])
  })

  it('the owner turns four on and archives three of the others; the deploy target holds exactly the four', () => {
    for (const name of ONLINE) expect(ok(owner(lib, ['deploy', 'on', `sites/${name}`])).stdout).toMatch(new RegExp(`^已打开 sites/${name}：在线`))
    for (const name of ARCHIVED) expect(lines(ok(owner(lib, ['archive', `sites/${name}`])))[0]).toBe(`已归档：sites/${name} → _archive/sites/${name}`)
    expect(served()).toEqual(ONLINE.map((name) => `sites-${name}`).sort())
    for (const name of ONLINE) expect(readFileSync(join(www, `sites-${name}`, 'index.html'), 'utf8')).toContain(SITES[name])
  })

  it('another agent, in another directory, starts with a sentence about an online site and is told about it', () => {
    const start = ok(codex(['start', '把手冲咖啡那个网站的配色改一下']))
    const related = start.stdout.slice(start.stdout.indexOf('【库里可能相关的】'))
    expect(related).toContain('sites/coffee')
    expect(related).toContain('手冲咖啡')
  })

  it('it puts a new directory over that site; the target follows, two versions are listed, version 1 exports the old bytes', () => {
    const before = readFileSync(join(lib, 'sites/coffee/index.html'))
    const put = ok(codex(['put', site(join(codexDir, 'coffee'), '手冲咖啡：豆子、水温和研磨度，换了深色配色'), '--to', 'sites/coffee', '--made']))
    expect(lines(put)).toEqual([
      '已放入 sites/coffee',
      expect.stringMatching(/^ {2}ledger：已记下换了新内容，旧内容进了留存，主人取得回 · 条目 i_/),
      '  version：记为 sites/coffee 的第 2 版',
      expect.stringMatching(/^ {2}deploy：sites\/coffee 在线，已重新发布/),
    ])
    expect(readFileSync(join(www, 'sites-coffee/index.html'), 'utf8')).toContain('换了深色配色')
    expect(ok(codex(['version', 'list', 'sites/coffee'])).stdout).toMatch(/共 2 版。当前内容是第 2 版。\n第 2 版 · .* · codex · .*\n第 1 版 · .* · claude-code · /)
    ok(codex(['version', 'export', 'sites/coffee', '--version', '1', '--to', './coffee-v1']))
    expect(readFileSync(join(codexDir, 'coffee-v1/index.html'))).toEqual(before)
  })

  it('the library syncs; a second library with the same plugins syncs from the same target and shows the same provenance', () => {
    expect(ok(owner(lib, ['sync', 'now'])).stdout).toMatch(/推上去 \d+ · 拉下来 0 ·.* 冲突 0/)
    ok(sb.run(['init', lib2], { cwd: root }))
    for (const name of PLUGINS) ok(owner(lib2, ['plugin', 'add', name]))
    ok(owner(lib2, ['sync', 'target', 'set', '--kind', 'dir', '--to', syncTarget]))
    expect(ok(owner(lib2, ['sync', 'now'])).stdout).toMatch(/拉下来 \d+ ·.* 冲突 0/)
    const provenance = (library: string) => {
      const sections = ok(sb.run(['--library', library, '--as', 'codex', 'inspect', 'sites/coffee', '--json'], { cwd: root })).json().sections
      return sections.find((s: { plugin: string }) => s.plugin === 'ledger').body as string
    }
    expect(provenance(lib2)).toBe(provenance(lib))
    expect(provenance(lib2)).toMatch(/^做出来的 · claude-code · .* · 场景 claude-1\n当时在做：做十个小网站/)
    expect(readFileSync(join(lib2, 'sites/coffee/index.html'), 'utf8')).toContain('换了深色配色')
  })

  it('there, a sentence that is not the file name finds the 手冲咖啡 site first, under the scene it was made in', () => {
    const found = lines(ok(sb.run(['--library', lib2, '--as', 'codex', 'find', '在家怎么冲一杯好喝的咖啡'], { cwd: root })))
    expect(found[0]).toMatch(/^场景 claude-1 · claude-code · .* · 在做：做十个小网站$/)
    expect(found[1]).toMatch(/^ {2}sites\/coffee {2}做出来的 {2}/)
  })

  it('check, as an agent at the end, is quiet about what is in order and mentions nothing stale', () => {
    const r = ok(sb.run(['--library', lib, '--as', 'claude-code', '--session', 'claude-2', 'check', '--json'], { cwd: claudeDir }))
    expect(r.json().sections.map((s: { title: string }) => s.title)).toEqual(['自上次以来'])
    const text = ok(sb.run(['--library', lib, '--as', 'claude-code', '--session', 'claude-2', 'check'], { cwd: claudeDir })).stdout
    expect(text).toContain('sites/coffee 换了新内容')
    expect(text).not.toMatch(/可能过期|来源不在|没人登记过|被直接改过|不一致|冲突副本|在工具之外/)
    // A scene's heading says where it ran; the lines under it name things, never a directory outside the library.
    expect(text.split('\n').filter((line) => line.startsWith('  ')).join('\n')).not.toContain(root)
  })
})
