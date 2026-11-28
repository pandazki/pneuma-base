// C5, K7, K8: the deploy plugin through the real command line, what a person sees there. Ten sites an
// agent made and declared, four of them switched on by the owner, built once for the file: the target
// holds exactly those four and follows a changed one; deploy sync converges and a second run changes
// nothing; the switch is refused in an agent session; a command target runs the owner's commands
// without a shell, and a failed publish fails no put and is listed as a problem. What each operation
// does to a site's state is the kit's table (packages/sdk/test/kit-model.test.ts, and a cell per
// operation in packages/plugin-deploy/test/kit.test.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Run, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
let outside: string
/** The dir target the four sites went online to. */
let target: string

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
const sitesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'index.json').sort() : [])
const indexOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { sites: { name: string; fingerprint: string; path: string }[] }
const factFiles = () => readdirSync(join(lib, '.pneuma-base/deploy/facts')).length
const FOUR = ['sites-s0', 'sites-s1', 'sites-s2', 'sites-s3']

/** Ten sites placed by an agent and declared deployable, a dir target, s0 to s3 switched on. Tests use their own sites past s4. */
beforeAll(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
  ok(owner(['plugin', 'enable', 'deploy']))
  for (let i = 0; i < 10; i++) {
    ok(agent(['put', site(`site-${i}`), '--to', `sites/s${i}`, '--generated']))
    expect(ok(agent(['say', 'deployable', `sites/s${i}`]))).toMatchObject({ outcome: 'heard', by: 'deploy' })
  }
  target = join(tempDir('pb-target-'), 'www')
  ok(owner(['deploy', 'target', 'set', '--kind', 'folder', '--to', target]))
  for (let i = 0; i < 4; i++) expect(ok(owner(['deploy', 'publish', `sites/s${i}`])).text).toContain(`已发布 sites/s${i}`)
})

describe('ten sites, four switched on, to a dir target', () => {
  it('the target holds exactly those four, each with the content the library has', () => {
    expect(sitesIn(target)).toEqual(FOUR)
    for (let i = 0; i < 4; i++) expect(tree(join(target, `sites-s${i}`))).toEqual(tree(join(lib, `sites/s${i}`)))
    const index = indexOf(target)
    expect(index.sites.map((s) => s.name)).toEqual(FOUR)
    for (const entry of index.sites) expect(entry.fingerprint).toBe(ok(agent(['inspect', entry.path, '--content'])).file.fingerprint)
  })

  it('a changed site goes online with its new content; the put says so', () => {
    const put = ok(agent(['put', site('site-0-new', 'brand new'), '--to', 'sites/s0', '--generated']))
    expect(put.notes.find((n: any) => n.plugin === 'deploy')?.text).toContain('重新发布')
    expect(tree(join(target, 'sites-s0'))).toEqual(tree(join(lib, 'sites/s0')))
    expect(readFileSync(join(target, 'sites-s0/index.html'), 'utf8')).toBe('<h1>brand new</h1>')
  })

  it('deploy list and inspect tell each site’s state and address', () => {
    const list = ok(owner(['deploy', 'list']))
    expect(list.text).toMatch(/sites\/s0\s+已发布\s+file:/)
    expect(list.text).toMatch(/sites\/s9\s+未发布/)
    const section = ok(agent(['inspect', 'sites/s0'])).sections.find((s: any) => s.plugin === 'deploy')
    expect(section.body).toContain('已发布')
    expect(section.body).toContain('file://')
  })

  it('reads only the facts after those its rows were folded from: none when nothing happened since', () => {
    ok(agent(['check']))
    const log = join(tempDir(), 'tools.jsonl')
    writeFileSync(log, '')
    ok(owner(['check'], { PNEUMA_BASE_TOOL_LOG: log }))
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { plugin: string; tool: string; entries?: number })
    const read = calls.filter((c) => c.plugin === 'deploy' && c.tool === 'since')
    expect(read.length).toBeGreaterThan(0)
    expect(read.reduce((n, c) => n + (c.entries ?? 0), 0)).toBe(0)
  })

  it('the switch is refused for an agent, by name, by grant, or by its session variable, and nothing goes online; an agent may still run deploy sync and deploy list', () => {
    ok(owner(['grant', 'create', 'claude', '--agent', 'claude-code']))
    const attempts = [
      agent(['deploy', 'publish', 'sites/s5']),
      sb.run(['@claude', 'deploy', 'publish', 'sites/s5', '--json'], { cwd: outside }),
      owner(['deploy', 'publish', 'sites/s5'], { CLAUDE_CODE_SESSION_ID: 'abc' }),
      owner(['deploy', 'publish', 'sites/s5'], { CODEX_THREAD_ID: 'xyz' }),
      agent(['deploy', 'target', 'set', '--kind', 'folder', '--to', join(outside, 'elsewhere')]),
    ]
    for (const r of attempts) {
      expect(r.code, r.stdout + r.stderr).toBe(2)
      expect(r.json()).toMatchObject({ outcome: 'refused', reason: 'agent-session' })
    }
    expect(sitesIn(target)).toEqual(FOUR)
    expect(ok(agent(['deploy', 'sync'])).data).toMatchObject({ changed: 0 })
    expect(ok(agent(['deploy', 'list'])).text).toMatch(/sites\/s5\s+未发布/)
  })

  // Moves the four to another target, so it comes last.
  it('deploy sync converges on a new target, and a second run changes nothing', () => {
    const next = join(tempDir('pb-target-'), 'next')
    ok(owner(['deploy', 'target', 'set', '--kind', 'folder', '--to', next]))
    expect(ok(agent(['check'])).sections.find((s: any) => s.plugin === 'deploy')?.body).toContain('待发布')

    expect(ok(owner(['deploy', 'sync'])).data).toMatchObject({ changed: 4 })
    expect(sitesIn(next)).toEqual(FOUR)
    const before = { files: factFiles(), tree: tree(next), stamp: statSync(join(next, 'index.json')).mtimeMs }

    const again = ok(owner(['deploy', 'sync']))
    expect(again.data).toMatchObject({ changed: 0 })
    expect({ files: factFiles(), tree: tree(next), stamp: statSync(join(next, 'index.json')).mtimeMs }).toEqual(before)
    expect(ok(agent(['check'])).sections.find((s: any) => s.plugin === 'deploy')).toBeUndefined()
  })
})

describe('a command target', () => {
  const node = process.execPath
  const script = (name: string, source: string) => {
    const file = join(tempDir('pb-scripts-'), name)
    writeFileSync(file, source)
    return file
  }
  const commandTarget = (publish: string, unpublish: string, extra: string[] = []) =>
    ok(owner(['deploy', 'target', 'set', '--kind', 'command', '--publish', publish, '--unpublish', unpublish, ...extra]))

  it('publishes and takes down through the owner’s commands, run without a shell: publish in the copy of the content, unpublish in an empty directory, never in the library', () => {
    const published = tempDir('pb-published-')
    // Publishing copies its working directory, and refuses unless that is the {dir} it was given.
    const pub = script(
      'publish.mjs',
      `import { cpSync, realpathSync } from 'node:fs'\nconst [dir, name, out] = process.argv.slice(2)\nif (realpathSync(dir) !== realpathSync('.')) { process.stderr.write('not run in {dir}\\n'); process.exit(4) }\ncpSync('.', out + '/' + name, { recursive: true })\n`,
    )
    const unpub = script(
      'unpublish.mjs',
      `import { readdirSync, rmSync, writeFileSync } from 'node:fs'\nconst [name, out] = process.argv.slice(2)\nwriteFileSync(out + '/' + name + '.seen', JSON.stringify(readdirSync('.')))\nrmSync(out + '/' + name, { recursive: true, force: true })\n`,
    )
    commandTarget(`'${node}' '${pub}' {dir} {name} '${published}'`, `'${node}' '${unpub}' {name} '${published}'`, ['--url', 'https://{name}.example.test'])

    expect(ok(owner(['deploy', 'publish', 'sites/s6'])).text).toContain('https://sites-s6.example.test')
    expect(readdirSync(published)).toEqual(['sites-s6'])
    expect(tree(join(published, 'sites-s6'))).toEqual(tree(join(lib, 'sites/s6')))

    ok(owner(['deploy', 'unpublish', 'sites/s6']))
    expect(readdirSync(published)).toEqual(['sites-s6.seen'])
    expect(readFileSync(join(published, 'sites-s6.seen'), 'utf8')).toBe('[]')
  })

  it('that fails: the switch answers with the reason, a put still succeeds and lists the problem, check reports it', () => {
    const fail = script('fail.mjs', `process.stderr.write('target is down\\n')\nprocess.exit(3)\n`)
    commandTarget(`'${node}' '${fail}' {dir} {name}`, `'${node}' '${fail}' {name}`)

    const on = owner(['deploy', 'publish', 'sites/s7'])
    expect(on.code).toBe(2)
    expect(on.json()).toMatchObject({ outcome: 'refused', reason: 'publish-failed' })
    expect(on.json().text).toContain('target is down')

    const put = agent(['put', site('site-7-new', 'newer'), '--to', 'sites/s7', '--generated'])
    expect(put.code, put.stderr).toBe(3)
    expect(put.json()).toMatchObject({ outcome: 'accepted', path: 'sites/s7' })
    expect(put.json().problems).toEqual([expect.objectContaining({ plugin: 'deploy', message: expect.stringContaining('target is down') })])
    expect(readFileSync(join(lib, 'sites/s7/index.html'), 'utf8')).toBe('<h1>newer</h1>')

    const check = ok(agent(['check'])).sections.find((s: any) => s.plugin === 'deploy')
    expect(check.body).toMatch(/sites\/s7.*待发布/)
  })

  it('that runs too long is stopped at its timeout', () => {
    const slow = script('slow.mjs', `setTimeout(() => {}, 20000)\n`)
    commandTarget(`'${node}' '${slow}'`, `'${node}' '${slow}'`, ['--timeout', '1'])
    const on = owner(['deploy', 'publish', 'sites/s8'])
    expect(on.code).toBe(2)
    expect(on.json()).toMatchObject({ outcome: 'refused', reason: 'publish-failed' })
    expect(on.json().text).toContain('超时')
  })
})
