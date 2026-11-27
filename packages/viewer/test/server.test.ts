// C8 and the server's contract: only this machine and the token holder reach /api; the file
// endpoint gives the content and the archive and nothing else; views and calls over HTTP; a
// directory that is not a library can be made one. Runs the built server, as the command line does.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initLibrary, type Plugin, type PluginTable } from '@pneuma-base/kernel'
import { FRAME_CLASSES } from '@pneuma-base/sdk/frame'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../dist/server/index.js'

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), prefix)))

const running: RunningServer[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()))
})

type Lib = { root: string; home: string; write(path: string, content: string): void }

async function library(plugins: Plugin[] = []): Promise<Lib> {
  const root = join(tempDir('pb-v-'), 'lib')
  const table = new Map(plugins.map((p) => [p.name as string, p]))
  const home = tempDir('pb-v-home-')
  await initLibrary(root, { plugins: plugins.map((p) => p.name), table, actor: { kind: 'owner' }, session: { id: 's', source: 'flag', cwd: '/', machine: 'm', transcript: null }, home })
  return {
    root,
    home,
    write(path, content) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    },
  }
}

async function serve(dir: string, opts: { table?: PluginTable; env?: Record<string, string>; home?: string } = {}): Promise<RunningServer> {
  const server = await startServer({ dir, builtins: opts.table ?? new Map(), home: opts.home ?? tempDir('pb-v-home-'), env: opts.env ?? {}, port: 0 })
  running.push(server)
  return server
}

type Answer = { status: number; type: string; headers: Record<string, string | string[] | undefined>; text: string; json(): any }

/** A raw HTTP request, so the test can send any Host header. */
function http(server: RunningServer, path: string, opts: { token?: string | null; host?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const token = opts.token === undefined ? server.token : opts.token
  const sep = path.includes('?') ? '&' : '?'
  const full = token === null ? path : `${path}${sep}token=${token}`
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const req = request(
      { host: '127.0.0.1', port: server.port, path: full, method: body === undefined ? 'GET' : 'POST', headers: { host: opts.host ?? `127.0.0.1:${server.port}`, ...(body ? { 'content-type': 'application/json' } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), headers: res.headers, text, json: () => JSON.parse(text) })
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('who reaches the server (C8)', () => {
  it('refuses /api without the token or with a wrong one; takes it as a query parameter or a header', async () => {
    const lib = await library()
    const server = await serve(lib.root)
    expect((await http(server, '/api/state', { token: null })).status).toBe(401)
    expect((await http(server, '/api/state', { token: 'x'.repeat(server.token.length) })).status).toBe(401)
    expect((await http(server, '/api/file?path=a.md', { token: null })).status).toBe(401)
    expect((await http(server, '/api/state')).status).toBe(200)
    const viaHeader = await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { 'x-pneuma-token': server.token } })
    expect(viaHeader.status).toBe(200)
  })

  it('serves the page itself without the token', async () => {
    const lib = await library()
    const server = await serve(lib.root)
    const page = await http(server, '/', { token: null })
    expect(page.status).toBe(200)
    expect(page.type).toContain('text/html')
    expect(page.text).toContain('<div id="root">')
    expect((await http(server, '/../../package.json', { token: null })).status).toBe(404)
  })
})

describe('the file endpoint (C8)', () => {
  it('gives files of the content and the archive as they are', async () => {
    const lib = await library()
    lib.write('notes/a.md', '# 你好')
    lib.write('_archive/old.txt', 'old')
    const server = await serve(lib.root)
    const a = await http(server, `/api/file?path=${encodeURIComponent('notes/a.md')}`)
    expect(a).toMatchObject({ status: 200, text: '# 你好' })
    expect(a.type).toBe('text/plain; charset=utf-8')
    expect((await http(server, '/api/file?path=_archive/old.txt')).text).toBe('old')
  })

  it('gives a file inside a bundle, in the content or archived, but not the bundle itself or its marker’s escape', async () => {
    const lib = await library()
    lib.write('site/.pneuma-item', '{"format":1}\n')
    lib.write('site/index.html', '<h1>hi</h1>')
    lib.write('_archive/old-site/.pneuma-item', '{"format":1}\n')
    lib.write('_archive/old-site/a.txt', 'archived inner')
    const server = await serve(lib.root)
    const inner = await http(server, `/api/file?path=${encodeURIComponent('site/index.html')}`)
    expect(inner).toMatchObject({ status: 200, text: '<h1>hi</h1>' })
    expect(inner.type).toBe('text/plain; charset=utf-8')
    expect((await http(server, `/api/file?path=${encodeURIComponent('_archive/old-site/a.txt')}`)).text).toBe('archived inner')
    expect((await http(server, '/api/file?path=site')).status).toBe(404)
    expect((await http(server, `/api/file?path=${encodeURIComponent('site/../../x')}`)).status).toBe(404)
  })

  it('refuses paths outside the library, the kernel’s files, folders and links that lead out', async () => {
    const lib = await library()
    lib.write('a.md', 'a')
    const outside = join(tempDir('pb-v-out-'), 'secret.txt')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(lib.root, 'leak.txt'))
    symlinkSync(join(lib.root, '.pneuma-base', 'config.json'), join(lib.root, 'config-link.json'))
    const server = await serve(lib.root)
    for (const path of ['../a.md', '../../etc/passwd', outside, '.pneuma-base/config.json', 'PNEUMA-BASE.md', 'notes/../../x', 'leak.txt', 'config-link.json', '', '.']) {
      const r = await http(server, `/api/file?path=${encodeURIComponent(path)}`)
      expect(r.status, path).toBe(404)
      expect(r.text).not.toContain('secret')
    }
    lib.write('dir/inner.md', 'x')
    expect((await http(server, '/api/file?path=dir')).status).toBe(404)
  })

  it('never lets the browser run a library file: HTML comes back as text, sandboxed', async () => {
    const lib = await library()
    lib.write('page.html', '<script>alert(1)</script>')
    lib.write('pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    lib.write('blob.bin', '\u0000\u0001\u0002')
    const server = await serve(lib.root)
    const html = await http(server, '/api/file?path=page.html')
    expect(html.type).toBe('text/plain; charset=utf-8')
    expect(html.headers['content-security-policy']).toContain('sandbox')
    expect(html.headers['x-content-type-options']).toBe('nosniff')
    expect((await http(server, '/api/file?path=pic.svg')).headers['content-security-policy']).toContain('sandbox')
    expect((await http(server, '/api/file?path=blob.bin')).type).toBe('application/octet-stream')
  })
})

describe('the file endpoint reads through storage', () => {
  it('gives one range of a file when asked, and says it takes ranges', async () => {
    const lib = await library()
    lib.write('notes/long.txt', 'abcdefghij')
    const server = await serve(lib.root)
    const whole = await http(server, '/api/file?path=notes/long.txt')
    expect(whole.headers['accept-ranges']).toBe('bytes')
    const part = await http(server, '/api/file?path=notes/long.txt', { headers: { range: 'bytes=2-5' } })
    expect(part).toMatchObject({ status: 206, text: 'cdef' })
    expect(part.headers['content-range']).toBe('bytes 2-5/10')
    expect((await http(server, '/api/file?path=notes/long.txt', { headers: { range: 'bytes=-3' } })).text).toBe('hij')
    expect((await http(server, '/api/file?path=notes/long.txt', { headers: { range: 'bytes=20-' } })).status).toBe(416)
  })

  it('does not fetch a placeholder’s content unless asked', async () => {
    // A storage program that answers as a sync service's placeholder would for files named *.placeholder.
    const dir = tempDir('pb-v-core-')
    const proxy = join(dir, 'core')
    writeFileSync(
      proxy,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const real = spawn(process.env.REAL_CORE, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] })
const asked = new Map()
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line)
  if (r.op === 'read' && String(r.place).endsWith('.placeholder') && r.fetch !== true) return process.stdout.write(JSON.stringify({ id: r.id, outcome: 'failed', reason: 'elsewhere', size: 4096 }) + '\\n')
  if (r.op === 'read') require('node:fs').appendFileSync(process.env.READS, r.place + (r.fetch ? ' fetch' : '') + '\\n')
  real.stdin.write(line + '\\n')
}).on('close', () => real.stdin.end())
real.stdout.pipe(process.stdout)
real.on('exit', (code) => process.exit(code ?? 0))
`,
    )
    chmodSync(proxy, 0o755)
    const reads = join(dir, 'reads.txt')
    writeFileSync(reads, '')
    const before = { core: process.env.PNEUMA_BASE_CORE, real: process.env.REAL_CORE, reads: process.env.READS }
    process.env.REAL_CORE = fileURLToPath(new URL('../../../core/target/release/pneuma-base-core', import.meta.url))
    process.env.READS = reads
    process.env.PNEUMA_BASE_CORE = proxy
    try {
      const lib = await library()
      lib.write('cloud/report.placeholder', 'the bytes of the report')
      const server = await serve(lib.root)
      const unasked = await http(server, `/api/file?path=${encodeURIComponent('cloud/report.placeholder')}`)
      expect(unasked.status).toBe(409)
      expect(unasked.json()).toEqual({ error: 'elsewhere', size: 4096 })
      expect(readFileSync(reads, 'utf8')).toBe('')
      const asked = await http(server, `/api/file?path=${encodeURIComponent('cloud/report.placeholder')}&fetch=1`)
      expect(asked).toMatchObject({ status: 200, text: 'the bytes of the report' })
      expect(readFileSync(reads, 'utf8')).toContain('cloud/report.placeholder fetch')
    } finally {
      for (const [k, v] of [['PNEUMA_BASE_CORE', before.core], ['REAL_CORE', before.real], ['READS', before.reads]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('a library with no plugin over HTTP (C1)', () => {
  it('gives the root as people read it: the home directory as ~', async () => {
    const home = tempDir('pb-v-user-')
    const root = join(home, 'work', 'lib')
    await initLibrary(root, { plugins: [], table: new Map(), actor: { kind: 'owner' }, session: { id: 's', source: 'flag', cwd: '/', machine: 'm', transcript: null }, home: tempDir('pb-v-home-') })
    const server = await serve(root)
    const before = process.env.HOME
    process.env.HOME = home
    try {
      expect((await http(server, '/api/state')).json().library).toMatchObject({ root, shown: '~/work/lib' })
    } finally {
      process.env.HOME = before
    }
  })

  it('archives and takes back through calls, leaving the files where expected', async () => {
    const lib = await library()
    lib.write('notes/a.md', 'a')
    const server = await serve(lib.root)
    const archive = (kind: string, path: string) => http(server, '/api/call', { body: { call: { face: 'agent', verb: 'archive', request: { kind, path } }, confirmed: false } })
    const done = (await archive('archive', 'notes/a.md')).json()
    expect(done).toMatchObject({ tone: 'good', result: { outcome: 'accepted' } })
    expect(existsSync(join(lib.root, 'notes/a.md'))).toBe(false)
    expect(readFileSync(join(lib.root, '_archive/notes/a.md'), 'utf8')).toBe('a')
    expect((await archive('unarchive', '_archive/notes/a.md')).json()).toMatchObject({ tone: 'good', result: { outcome: 'accepted' } })
    expect(readFileSync(join(lib.root, 'notes/a.md'), 'utf8')).toBe('a')
    expect(existsSync(join(lib.root, '_archive/notes/a.md'))).toBe(false)
  })

  it('a destructive call runs only with the page’s confirmation, and never when the server runs in an agent session', async () => {
    const lib = await library()
    lib.write('_archive/old.md', 'o')
    const purge = (server: RunningServer, confirmed: boolean) => http(server, '/api/call', { body: { call: { face: 'owner', command: 'archive purge', args: { positional: [], flags: {} } }, confirmed } })
    const inSession = await serve(lib.root, { env: { CLAUDE_CODE_SESSION_ID: 'x' } })
    expect((await purge(inSession, true)).json()).toMatchObject({ tone: 'bad', result: { outcome: 'refused', reason: 'agent-session' } })
    const server = await serve(lib.root)
    expect((await purge(server, false)).json()).toMatchObject({ tone: 'bad', result: { outcome: 'refused', reason: 'not-confirmed' } })
    expect(existsSync(join(lib.root, '_archive/old.md'))).toBe(true)
    expect((await purge(server, true)).json()).toMatchObject({ tone: 'good', result: { outcome: 'done' } })
    expect(existsSync(join(lib.root, '_archive'))).toBe(false)
  })

  it('answers a malformed call with 400 and changes nothing', async () => {
    const lib = await library()
    lib.write('a.md', 'a')
    const server = await serve(lib.root)
    for (const call of [null, { face: 'agent', verb: 'delete', request: {} }, { face: 'agent', verb: 'archive', request: { kind: 'shred', path: 'a.md' } }, { face: 'owner', command: 1 }]) {
      expect((await http(server, '/api/call', { body: { call, confirmed: true } })).status).toBe(400)
    }
    expect(readFileSync(join(lib.root, 'a.md'), 'utf8')).toBe('a')
  })

  it('holds no state: a server started afresh shows the same views', async () => {
    const lib = await library()
    lib.write('a.md', 'a')
    const first = await serve(lib.root)
    const before = (await http(first, '/api/view?view=files')).text
    await first.close()
    const second = await serve(lib.root)
    expect((await http(second, '/api/view?view=files')).text).toBe(before)
  })

  it('gives a revision stamp that changes when a file changes', async () => {
    const lib = await library()
    const server = await serve(lib.root)
    const rev = async () => (await http(server, '/api/rev')).json().rev as string
    const a = await rev()
    expect(await rev()).toBe(a)
    lib.write('new.md', 'n')
    expect(await rev()).not.toBe(a)
    // tmp/run-7: the stamp looks at the open directories only, never into one no record points into.
    lib.write('closed/x.md', 'x')
    const b = await rev()
    expect(b).not.toBe(a)
    lib.write('closed/y.md', 'y')
    expect(await rev()).toBe(b)
  })
})

describe('a directory that is not a library (C7)', () => {
  it('says so, and init makes it a library with the chosen plugins', async () => {
    const dir = tempDir('pb-v-plain-')
    writeFileSync(join(dir, 'kept.md'), 'kept')
    const pager: Plugin = { contract: 2, name: 'pager' as Plugin['name'], cognition: { title: '测试插件', text: '## 测试' }, storage: [], statements: [], ownerCommands: [] }
    const server = await serve(dir, { table: new Map([['pager', pager]]) })
    expect((await http(server, '/api/state')).json()).toMatchObject({ library: null, views: [], available: [{ name: 'pager', title: '测试插件' }] })
    expect((await http(server, '/api/view?view=files')).status).toBe(409)
    expect((await http(server, '/api/init', { body: { plugins: ['nope'] } })).json()).toMatchObject({ tone: 'bad', result: { reason: 'unknown-plugin' } })
    expect((await http(server, '/api/init', { body: { plugins: ['pager'] } })).json()).toMatchObject({ tone: 'good', result: { outcome: 'done' } })
    const config = JSON.parse(readFileSync(join(dir, '.pneuma-base/config.json'), 'utf8'))
    expect(config.plugins).toEqual(['pager'])
    expect(readFileSync(join(dir, 'kept.md'), 'utf8')).toBe('kept')
    expect((await http(server, '/api/state')).json().library.root).toBe(dir)
    expect((await http(server, '/api/init', { body: { plugins: [] } })).json()).toMatchObject({ result: { reason: 'already-a-library' } })
  })
})

describe('the view slot over HTTP (C2)', () => {
  const name = (n: string) => n as Plugin['name']
  const page: Plugin = {
    contract: 2,
    name: name('page'),
    cognition: null,
    storage: [],
    statements: [],
    ownerCommands: [],
    views: [{ id: 'page.one', title: '一页', icon: 'list', nav: true, filters: [] }],
    onView: async () => ({ title: '一页', subtitle: null, blocks: [{ kind: 'text', text: 'hello from page', tone: 'neutral' }] }),
  }
  // A plugin that throws in its view, and a malformed block, are the kernel's viewer.test.ts (K8, D7).
  it('a plugin’s view joins the navigation before the kernel’s and is shown; uninstalled, it is gone', async () => {
    const lib = await library([page])
    const table = new Map([['page', page]])
    const server = await serve(lib.root, { table, home: lib.home })
    const navOf = async () => (await http(server, '/api/state')).json().views.filter((v: any) => v.nav).map((v: any) => v.id)
    expect(await navOf()).toEqual(['page.one', 'home', 'files', 'archive', 'agents', 'config'])
    expect((await http(server, '/api/view?view=page.one')).json()).toMatchObject({ outcome: 'shown', blocks: [{ text: 'hello from page' }], problems: [] })
    const removed = await http(server, '/api/call', { body: { call: { face: 'owner', command: 'plugin remove', args: { positional: ['page'], flags: {} } }, confirmed: false } })
    expect(removed.json()).toMatchObject({ tone: 'good' })
    expect(await navOf()).toEqual(['home', 'files', 'archive', 'agents', 'config'])
    expect((await http(server, '/api/view?view=page.one')).json()).toMatchObject({ outcome: 'no-such-view' })
  })

})

describe('a plugin’s own pages and the kit they load (custom blocks)', () => {
  const name = (n: string) => n as Plugin['name']
  /** A ui directory with a page, a script in a folder, and beside it a file that must stay out of reach. */
  function uiDir(): string {
    const dir = tempDir('pb-v-ui-')
    mkdirSync(join(dir, 'ui', 'js'), { recursive: true })
    writeFileSync(join(dir, 'ui', 'page.html'), '<!doctype html><p>drawn page</p>')
    writeFileSync(join(dir, 'ui', 'js', 'app.js'), 'console.log(1)')
    writeFileSync(join(dir, 'secret.txt'), 'outside the ui directory')
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'ui', 'out.txt'))
    return join(dir, 'ui')
  }
  const drawn = (ui: string): Plugin => ({ contract: 2, name: name('drawn'), cognition: null, storage: [], statements: [], ownerCommands: [], ui })

  it('serves an installed plugin’s ui files without the token, as pages that cannot reach the viewer’s origin', async () => {
    const plugin = drawn(uiDir())
    const lib = await library([plugin])
    const server = await serve(lib.root, { table: new Map([['drawn', plugin]]) })
    const page = await http(server, '/plugin-ui/drawn/page.html', { token: null })
    expect(page.status).toBe(200)
    expect(page.type).toContain('text/html')
    expect(page.text).toContain('drawn page')
    expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts')
    expect(page.headers['content-security-policy']).not.toContain('allow-same-origin')
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    const script = await http(server, '/plugin-ui/drawn/js/app.js', { token: null })
    expect(script.status).toBe(200)
    expect(script.type).toContain('text/javascript')
    expect((await http(server, '/plugin-ui/drawn/page.html', { token: null, host: 'evil.example' })).status).toBe(403)
  })

  it('serves nothing for a plugin the library has not installed, or one without ui, and nothing outside the ui directory', async () => {
    const plugin = drawn(uiDir())
    const bare: Plugin = { contract: 2, name: name('bare'), cognition: null, storage: [], statements: [], ownerCommands: [] }
    const lib = await library([bare])
    const server = await serve(lib.root, { table: new Map([['drawn', plugin], ['bare', bare]]) })
    expect((await http(server, '/plugin-ui/drawn/page.html', { token: null })).status).toBe(404)
    expect((await http(server, '/plugin-ui/bare/page.html', { token: null })).status).toBe(404)

    const installed = await library([plugin])
    const s2 = await serve(installed.root, { table: new Map([['drawn', plugin]]) })
    for (const path of ['/plugin-ui/drawn/..%2Fsecret.txt', '/plugin-ui/drawn/%2e%2e/secret.txt', '/plugin-ui/drawn/js/..%2F..%2Fsecret.txt', '/plugin-ui/drawn/out.txt', '/plugin-ui/drawn/js', '/plugin-ui/drawn/', '/plugin-ui/drawn/missing.html']) {
      const r = await http(s2, path, { token: null })
      expect(r.status, path).toBe(404)
      expect(r.text, path).not.toContain('outside the ui directory')
    }
  })

  it('serves the frame kit at a fixed address any frame can load, with every call and class the sdk’s frame types promise', async () => {
    const lib = await library()
    const server = await serve(lib.root)
    for (const [path, type] of [['/plugin-kit/frame.js', 'text/javascript'], ['/plugin-kit/frame.css', 'text/css']] as const) {
      const r = await http(server, path, { token: null })
      expect(r.status, path).toBe(200)
      expect(r.type, path).toContain(type)
      expect(r.headers['access-control-allow-origin'], path).toBe('*')
    }
    const script = (await http(server, '/plugin-kit/frame.js', { token: null })).text
    for (const call of ['onData', 'run', 'open']) expect(script, call).toMatch(new RegExp(`\\b${call}\\(`))
    const sheet = (await http(server, '/plugin-kit/frame.css', { token: null })).text
    const missing = FRAME_CLASSES.filter((c) => !new RegExp(`(^|[\\s,}>])\\.${c}\\s*[{,:.>[]`, 'm').test(sheet))
    expect(missing).toEqual([])
  })

})
