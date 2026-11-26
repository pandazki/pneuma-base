// C5, C8, K7, K8: the deploy plugin through the real command line. Agents declare things
// deployable; the owner's switch decides what is online; the target follows the current content
// through puts, moves and archives; deploy sync converges and a second run changes nothing; the
// switch is refused in an agent session; a failed publish fails no put and is listed as a problem.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'


let sb: Sandbox
let lib: string
let outside: string

beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
})

const owner = (args: string[], env: Record<string, string> = {}) => sb.run(['--library', lib, ...args, '--json'], { cwd: outside, env })
const agent = (args: string[]) => sb.run(['--library', lib, '--as', 'claude-code', ...args, '--json'], { cwd: outside })
const ok = (r: Run) => {
  expect(r.code, r.stdout + r.stderr).toBe(0)
  return r.json()
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

/** An outside directory holding a small site. */
function site(name: string, title = name): string {
  const dir = join(outside, name)
  write(dir, { 'index.html': `<h1>${title}</h1>`, 'css/site.css': `h1{color:${title.length % 2 ? 'red' : 'blue'}}` })
  return dir
}

/** Every file under `dir` with its content, the marker and dot-named scratch left out. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(path)
      else out[path] = readFileSync(join(dir, path), 'utf8')
    }
  }
  walk('')
  return out
}

/** The sites a dir target holds: its entries besides index.json and dot-named scratch. The directory is made at the first publish. */
const sitesIn = (target: string) => (existsSync(target) ? readdirSync(target).filter((n) => !n.startsWith('.') && n !== 'index.json').sort() : [])
const indexOf = (target: string) => JSON.parse(readFileSync(join(target, 'index.json'), 'utf8')) as { sites: { name: string; fingerprint: string; path: string }[] }
const factFiles = () => readdirSync(join(lib, '.pneuma-base/deploy/facts')).length

/** Ten sites placed by an agent and declared deployable; the owner installs the plugin first. */
function tenSites(): string[] {
  ok(owner(['plugin', 'add', 'deploy']))
  const paths = Array.from({ length: 10 }, (_, i) => `sites/s${i}`)
  for (const [i, path] of paths.entries()) {
    ok(agent(['put', site(`site-${i}`), '--to', path, '--made']))
    expect(ok(agent(['say', 'deployable', path]))).toMatchObject({ outcome: 'heard', by: 'deploy' })
  }
  return paths
}

function dirTarget(): string {
  const target = join(tempDir('pb-target-'), 'www')
  ok(owner(['deploy', 'target', 'set', '--kind', 'dir', '--to', target]))
  return target
}

describe('declaring', () => {
  it('without the plugin, say deployable is heard by no plugin; with it, the description has its section until it is removed', () => {
    ok(agent(['put', site('a'), '--to', 'sites/a', '--made']))
    expect(agent(['say', 'deployable', 'sites/a']).json()).toMatchObject({ outcome: 'not-heard', reason: 'no-plugin-for-kind' })
    expect(readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')).not.toContain('## 上线：主人开关')

    ok(owner(['plugin', 'add', 'deploy']))
    expect(readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')).toContain('## 上线：主人开关')
    expect(ok(agent(['say', 'deployable', 'sites/a']))).toMatchObject({ outcome: 'heard', by: 'deploy' })

    ok(owner(['plugin', 'remove', 'deploy']))
    expect(readFileSync(join(lib, 'PNEUMA-BASE.md'), 'utf8')).not.toContain('## 上线：主人开关')
    expect(agent(['say', 'deployable', 'sites/a']).json()).toMatchObject({ outcome: 'not-heard', reason: 'no-plugin-for-kind' })
  })

  it('does not put anything online, and refuses a path the library does not have', () => {
    ok(owner(['plugin', 'add', 'deploy']))
    const target = dirTarget()
    ok(agent(['put', site('a'), '--to', 'sites/a', '--made']))
    expect(ok(agent(['say', 'deployable', 'sites/a'])).note).toContain('不在线')
    expect(sitesIn(target)).toEqual([])
    const missing = agent(['say', 'deployable', 'sites/nope'])
    expect(missing.code).toBe(2)
    expect(missing.json()).toMatchObject({ outcome: 'not-heard', reason: 'refused' })
  })
})

describe('ten sites, four switched on, to a dir target', () => {
  let paths: string[]
  let target: string

  beforeEach(() => {
    paths = tenSites()
    target = dirTarget()
    for (const path of paths.slice(0, 4)) expect(ok(owner(['deploy', 'on', path])).text).toContain('在线')
  })

  it('the target holds exactly those four, each with the content the library has', () => {
    expect(sitesIn(target)).toEqual(['sites-s0', 'sites-s1', 'sites-s2', 'sites-s3'])
    for (const [i, path] of paths.slice(0, 4).entries()) expect(tree(join(target, `sites-s${i}`))).toEqual(tree(join(lib, path)))
    const index = indexOf(target)
    expect(index.sites.map((s) => s.name)).toEqual(['sites-s0', 'sites-s1', 'sites-s2', 'sites-s3'])
    for (const entry of index.sites) expect(entry.fingerprint).toBe(ok(agent(['inspect', entry.path, '--content'])).file.fingerprint)
  })

  it('a changed site goes online with its new content; the put says so', () => {
    const put = ok(agent(['put', site('site-0-new', 'brand new'), '--to', 'sites/s0', '--made']))
    expect(put.notes.find((n: any) => n.plugin === 'deploy')?.text).toContain('重新发布')
    expect(tree(join(target, 'sites-s0'))).toEqual(tree(join(lib, 'sites/s0')))
    expect(readFileSync(join(target, 'sites-s0/index.html'), 'utf8')).toBe('<h1>brand new</h1>')
  })

  it('a site switched off leaves the target', () => {
    ok(owner(['deploy', 'off', 'sites/s1']))
    expect(sitesIn(target)).toEqual(['sites-s0', 'sites-s2', 'sites-s3'])
    expect(indexOf(target).sites.map((s) => s.name)).toEqual(['sites-s0', 'sites-s2', 'sites-s3'])
  })

  it('an archived site leaves the target, and comes back when it is taken back with its switch still on', () => {
    ok(agent(['archive', 'sites/s2']))
    expect(sitesIn(target)).toEqual(['sites-s0', 'sites-s1', 'sites-s3'])
    expect(ok(agent(['inspect', 'sites/s2'])).sections.find((s: any) => s.plugin === 'deploy')?.body).toContain('已归档')
    ok(agent(['unarchive', 'sites/s2']))
    expect(sitesIn(target)).toEqual(['sites-s0', 'sites-s1', 'sites-s2', 'sites-s3'])
  })

  it('a moved site keeps its switch and goes online under its new name; the old name is taken down', () => {
    ok(agent(['put', 'sites/s3', '--to', 'shop/main']))
    expect(sitesIn(target)).toEqual(['shop-main', 'sites-s0', 'sites-s1', 'sites-s2'])
    expect(tree(join(target, 'shop-main'))).toEqual(tree(join(lib, 'shop/main')))
  })

  it('deploy sync converges on a new target, and a second run changes nothing', () => {
    const next = join(tempDir('pb-target-'), 'next')
    ok(owner(['deploy', 'target', 'set', '--kind', 'dir', '--to', next]))
    expect(ok(agent(['check'])).sections.find((s: any) => s.plugin === 'deploy')?.body).toContain('待发布')

    expect(ok(owner(['deploy', 'sync'])).data).toMatchObject({ changed: 4 })
    expect(sitesIn(next)).toEqual(['sites-s0', 'sites-s1', 'sites-s2', 'sites-s3'])
    const before = { files: factFiles(), tree: tree(next), stamp: statSync(join(next, 'index.json')).mtimeMs }

    const again = ok(owner(['deploy', 'sync']))
    expect(again.data).toMatchObject({ changed: 0 })
    expect({ files: factFiles(), tree: tree(next), stamp: statSync(join(next, 'index.json')).mtimeMs }).toEqual(before)
    expect(ok(agent(['check'])).sections.find((s: any) => s.plugin === 'deploy')).toBeUndefined()
  })

  it('deploy list and inspect tell each site’s state and address', () => {
    const list = ok(owner(['deploy', 'list']))
    expect(list.text).toMatch(/sites\/s0\s+在线\s+file:/)
    expect(list.text).toMatch(/sites\/s9\s+离线/)
    const section = ok(agent(['inspect', 'sites/s0'])).sections.find((s: any) => s.plugin === 'deploy')
    expect(section.body).toContain('在线')
    expect(section.body).toContain('file://')
  })
})

describe('the switch is the owner’s', () => {
  let target: string

  beforeEach(() => {
    tenSites()
    target = dirTarget()
  })

  it('is refused for an agent, by name, by grant, or by its session variable, and nothing goes online', () => {
    ok(owner(['grant', 'issue', 'claude', '--agent', 'claude-code']))
    const attempts = [
      agent(['deploy', 'on', 'sites/s5']),
      sb.run(['@claude', 'deploy', 'on', 'sites/s5', '--json'], { cwd: outside }),
      owner(['deploy', 'on', 'sites/s5'], { CLAUDE_CODE_SESSION_ID: 'abc' }),
      owner(['deploy', 'on', 'sites/s5'], { CODEX_THREAD_ID: 'xyz' }),
      agent(['deploy', 'target', 'set', '--kind', 'dir', '--to', join(outside, 'elsewhere')]),
    ]
    for (const r of attempts) {
      expect(r.code, r.stdout + r.stderr).toBe(2)
      expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    }
    expect(sitesIn(target)).toEqual([])
    expect(ok(owner(['deploy', 'list'])).text).toMatch(/sites\/s5\s+离线/)
  })

  it('an agent may still run deploy sync and deploy list, which only follow the owner’s switches', () => {
    ok(owner(['deploy', 'on', 'sites/s1']))
    expect(ok(agent(['deploy', 'sync'])).data).toMatchObject({ changed: 0 })
    expect(ok(agent(['deploy', 'list'])).text).toContain('sites/s1')
  })
})

describe('a command target', () => {
  let published: string
  const node = process.execPath
  const script = (name: string, source: string) => {
    const file = join(tempDir('pb-scripts-'), name)
    writeFileSync(file, source)
    return file
  }

  beforeEach(() => {
    tenSites()
    published = tempDir('pb-published-')
  })

  function commandTarget(publish: string, unpublish: string, extra: string[] = []) {
    ok(owner(['deploy', 'target', 'set', '--kind', 'command', '--publish', publish, '--unpublish', unpublish, ...extra]))
  }

  it('publishes and takes down through the owner’s commands, run without a shell', () => {
    const pub = script('publish.mjs', `import { cpSync } from 'node:fs'\nconst [dir, name, out] = process.argv.slice(2)\ncpSync(dir, out + '/' + name, { recursive: true })\n`)
    const unpub = script('unpublish.mjs', `import { rmSync } from 'node:fs'\nconst [name, out] = process.argv.slice(2)\nrmSync(out + '/' + name, { recursive: true, force: true })\n`)
    commandTarget(`'${node}' '${pub}' {dir} {name} '${published}'`, `'${node}' '${unpub}' {name} '${published}'`, ['--url', 'https://{name}.example.test'])

    expect(ok(owner(['deploy', 'on', 'sites/s0'])).text).toContain('https://sites-s0.example.test')
    expect(readdirSync(published)).toEqual(['sites-s0'])
    expect(tree(join(published, 'sites-s0'))).toEqual(tree(join(lib, 'sites/s0')))

    ok(owner(['deploy', 'off', 'sites/s0']))
    expect(readdirSync(published)).toEqual([])
  })

  it('that fails: the switch answers with the reason, a put still succeeds and lists the problem, check reports it', () => {
    const fail = script('fail.mjs', `process.stderr.write('target is down\\n')\nprocess.exit(3)\n`)
    commandTarget(`'${node}' '${fail}' {dir} {name}`, `'${node}' '${fail}' {name}`)

    const on = owner(['deploy', 'on', 'sites/s1'])
    expect(on.code).toBe(2)
    expect(on.json()).toMatchObject({ outcome: 'refused', reason: 'publish-failed' })
    expect(on.json().text).toContain('target is down')

    const put = agent(['put', site('site-1-new', 'newer'), '--to', 'sites/s1', '--made'])
    expect(put.code, put.stderr).toBe(3)
    expect(put.json()).toMatchObject({ outcome: 'accepted', path: 'sites/s1' })
    expect(put.json().problems).toEqual([expect.objectContaining({ plugin: 'deploy', message: expect.stringContaining('target is down') })])
    expect(readFileSync(join(lib, 'sites/s1/index.html'), 'utf8')).toBe('<h1>newer</h1>')

    const check = ok(agent(['check'])).sections.find((s: any) => s.plugin === 'deploy')
    expect(check.body).toMatch(/sites\/s1.*待发布/)
  })

  it('that an agent’s put cannot reach, as from a sandbox: the text says the put worked and going online waits for the owner', () => {
    const fail = script('fail.mjs', `process.stderr.write('EACCES: permission denied\\n')\nprocess.exit(1)\n`)
    commandTarget(`'${node}' '${fail}' {dir} {name}`, `'${node}' '${fail}' {name}`)
    owner(['deploy', 'on', 'sites/s1'])
    const put = sb.run(['--library', lib, '--as', 'codex', 'put', site('site-1-sandbox', 'from the sandbox'), '--to', 'sites/s1', '--made'], { cwd: outside })
    expect(put.code).toBe(3)
    const [head, ...rest] = put.stdout.trim().split('\n')
    expect(head).toBe('已放入 sites/s1')
    const problem = rest.find((l) => l.includes('deploy')) as string
    expect(problem).toContain('放入本身已经成功')
    expect(problem).toContain('这不是你的放入出了问题，你不用重做')
    expect(problem).toContain('等主人在自己的终端里运行 deploy sync')
    expect(problem).toContain('EACCES')
  })

  it('that runs too long is stopped at its timeout', () => {
    const slow = script('slow.mjs', `setTimeout(() => {}, 20000)\n`)
    commandTarget(`'${node}' '${slow}'`, `'${node}' '${slow}'`, ['--timeout', '1'])
    const on = owner(['deploy', 'on', 'sites/s2'])
    expect(on.code).toBe(2)
    expect(on.json()).toMatchObject({ outcome: 'refused', reason: 'publish-failed' })
    expect(on.json().text).toContain('超时')
  })
})
