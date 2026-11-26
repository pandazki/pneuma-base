// The plugin contract as a third party builds against it: the sdk's root export, re-exported by the kernel.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as sdk from '@pneuma-base/sdk'
import { describe, expect, it } from 'vitest'
import * as kernel from '../src/index.js'
import { fixture, outsideFile, owner, plugin, session, tempDir } from './support.js'

const brought = { kind: 'brought' as const, source: null, by: null }

describe('the sdk', () => {
  it('names the contract version, types a plugin as it is, and builds the branded values a plugin makes', () => {
    expect(sdk.CONTRACT).toBe(2)
    const plugin = { contract: sdk.CONTRACT, name: sdk.pluginName('echo'), cognition: null, storage: [], statements: [], ownerCommands: [] }
    expect(sdk.definePlugin(plugin)).toBe(plugin)
    expect(() => sdk.pluginName('Echo')).toThrow()
    expect(sdk.instant(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(() => sdk.instant('not a date')).toThrow()
  })

  it('is what the kernel exports, so imports from the kernel keep working', () => {
    expect(kernel.CONTRACT).toBe(2)
    expect(kernel.pluginName).toBe(sdk.pluginName)
    expect(kernel.definePlugin).toBe(sdk.definePlugin)
  })
})

describe('a plugin’s hooks', () => {
  it('are checked strictly: a hook that takes a narrower argument than the contract gives does not type-check', () => {
    const base = { contract: 1, name: sdk.pluginName('narrow'), cognition: null, storage: [], statements: [], ownerCommands: [] }
    const onPut = async (req: Extract<sdk.AcceptedPut, { kind: 'place' }>) => ({ text: req.source.kind })
    // @ts-expect-error onPut is given every kind of accepted put, not only a place
    const narrow: sdk.Plugin = { ...base, onPut }
    const run = async (_args: sdk.OwnerArgs, ctx: sdk.PluginContext & { extra: string }) => ({ outcome: 'done' as const, text: ctx.extra })
    // @ts-expect-error an owner command's run is given the plugin context, nothing more
    const command: sdk.OwnerCommand = { name: 'narrow x', summary: '', destructive: false, ownerOnly: false, run }
    expect([narrow, command]).toHaveLength(2)
  })
})

describe('the loader of a plugin outside the repository', () => {
  const GOOD = {
    contract: 1,
    name: 'echo',
    version: '0.1.0',
    summary: '回一句话',
    cognition: { title: '回声', text: '## 回声' },
    storage: [{ dir: 'state', kind: 'body' }],
    statements: ['echo'],
    ownerCommands: [{ name: 'echo now', summary: '', params: {}, destructive: false, ownerOnly: false, run: 'RUN' }],
    views: [{ id: 'echo.page', title: '回声', icon: 'repeat', nav: true, filters: [] }],
    onSay: 'HOOK',
  }

  /** Why `index.js` exporting `parts` over GOOD does not load; null when it loads. Functions are written as the strings RUN and HOOK. */
  async function why(parts: Record<string, unknown>, drop: string[] = []): Promise<string | null> {
    const home = tempDir('pb-k-home-')
    const value = Object.fromEntries(Object.entries({ ...GOOD, ...parts }).filter(([k]) => !drop.includes(k)))
    const source = `export default ${JSON.stringify(value).replaceAll('"RUN"', 'async () => ({ outcome: "done", text: "" })').replaceAll('"HOOK"', 'async () => null')}\n`
    mkdirSync(join(home, 'plugins', 'echo'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'echo', 'index.js'), source)
    const table = await kernel.loadPlugins(home, new Map())
    const reason = await kernel.whyNotLoaded(home, 'echo')
    expect(table.has('echo')).toBe(reason === null)
    return reason
  }

  it('loads a plugin that declares a contract this kernel supports', async () => {
    expect(await why({})).toBeNull()
  })

  it('refuses one without a contract, or with one it does not support, saying so in Chinese', async () => {
    expect(await why({}, ['contract'])).toMatch(/没有写 contract.*第 1、2 版/)
    expect(await why({ contract: 3 })).toMatch(/contract 是 3.*只认识第 1、2 版/)
  })

  it('refuses the shapes it can check without calling a hook, naming each', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: 'other' }, /目录名 echo/],
      [{ statements: 'echo' }, /statements 不是列表/],
      [{ storage: [{ dir: 'state', kind: 'forever' }] }, /storage/],
      [{ cognition: { title: '回声' } }, /cognition/],
      [{ views: [{ id: 'other.page', title: '', icon: '', nav: true, filters: [] }] }, /视图 other\.page 不以 echo\. 开头/],
      [{ ownerCommands: [{ ...GOOD.ownerCommands[0], name: 'now' }] }, /主人命令「now」不以「echo 」开头/],
      [{ ownerCommands: [{ ...GOOD.ownerCommands[0], run: 'not a function' }] }, /run/],
      [{ ownerCommands: [{ name: 'echo now', summary: '', destructive: false, ownerOnly: false, run: 'RUN' }] }, /主人命令「echo now」没有 params/],
      [{ onSay: 'not a function' }, /onSay 不是函数/],
      [{ statements: ['echo', 'echo'] }, /echo.*写了两次/],
      [{ version: 1 }, /version 不是文字/],
    ]
    for (const [parts, reason] of cases) expect(await why(parts), JSON.stringify(parts)).toMatch(reason)
  })

  it('checks a built-in plugin as it checks one of this machine: one that breaks a rule is a fault of this pneuma-base, and throws', async () => {
    const odd = plugin('odd', { ownerCommands: [{ name: 'held list', summary: '', params: {}, destructive: false, ownerOnly: false, run: async () => ({ outcome: 'done', text: '' }) }] })
    await expect(kernel.loadPlugins(tempDir('pb-k-home-'), new Map([['odd', odd]]))).rejects.toThrow(/自带插件 odd 过不了插件的核对：主人命令「held list」不以「odd 」开头/)
  })

  it('refuses a command name the kernel uses', async () => {
    const home = tempDir('pb-k-home-')
    mkdirSync(join(home, 'plugins', 'plugin'), { recursive: true })
    const command = '{ name: "plugin add", summary: "", destructive: false, ownerOnly: false, run: async () => ({ outcome: "done", text: "" }) }'
    writeFileSync(join(home, 'plugins', 'plugin', 'index.js'), `export default { contract: 1, name: 'plugin', cognition: null, storage: [], statements: [], ownerCommands: [${command}] }\n`)
    expect(await kernel.whyNotLoaded(home, 'plugin')).toMatch(/主人命令「plugin add」是内核自己的/)
  })
})

describe('a plugin’s own area', () => {
  it('takes a write whenever a hook runs, also in a library that arrived by sync before this machine had the plugin', async () => {
    const p = plugin('keeper', {
      contract: 2,
      onPut: async (_req, ctx) => {
        const written = await ctx.tools.storage.own.write('state.json', { data: '{}' }, 'empty')
        return { text: 'entry' in written ? 'written' : `refused ${written.reason}` }
      },
    })
    const f = await fixture([p])
    // A synced library carries the configuration, and nothing of the plugin's own area need come with it.
    rmSync(join(f.root, '.pneuma-base', 'keeper'), { recursive: true, force: true })
    await f.reopen()
    const r = await kernel.agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('a') }, to: 'a.md', origin: brought }, f.ctx)
    expect(r).toMatchObject({ outcome: 'accepted', notes: [{ plugin: 'keeper', text: 'written' }] })
    expect(f.read('.pneuma-base/keeper/state.json')).toBe('{}')
  })
})

describe('a hook that did its part but not an outside step', () => {
  it('answers problems beside its note from onPut, onArchive and onSay; the verb’s result stands', async () => {
    const p = plugin('outward', {
      statements: ['ship'],
      onPut: async () => ({ note: { text: '记下了' }, problems: ['没能发布，主人运行 outward sync'] }),
      onArchive: async () => ({ note: null, problems: ['没能下线'] }),
      onSay: async () => ({ outcome: 'heard', note: '记下了', problems: ['目标没有答复'] }),
    })
    const f = await fixture([p])
    const put = await kernel.agentFace.put({ kind: 'place', from: { kind: 'file', path: outsideFile('a') }, to: 'a.md', origin: brought }, f.ctx)
    expect(put).toMatchObject({ outcome: 'accepted', notes: [{ plugin: 'outward', text: '记下了' }], problems: [{ plugin: 'outward', message: '没能发布，主人运行 outward sync' }] })
    const archived = await kernel.agentFace.archive({ kind: 'archive', path: 'a.md' }, f.ctx)
    expect(archived).toMatchObject({ outcome: 'accepted', notes: [], problems: [{ plugin: 'outward', message: '没能下线' }] })
    expect(f.read('_archive/a.md')).toBe('a')
    const said = await kernel.agentFace.say({ kind: 'ship', about: null, text: null, args: {} }, f.ctx)
    expect(said).toEqual({ outcome: 'heard', by: 'outward', note: '记下了', problems: [{ plugin: 'outward', message: '目标没有答复' }] })
  })
})

describe('the tools on a plugin’s context', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  async function probe() {
    const heard: string[] = []
    let grabbed: sdk.PluginContext | undefined
    const p = plugin('probe', {
      onCheck: async (_req, ctx) => ((grabbed = ctx), []),
      onPut: async (req) => (heard.push(req.path), null),
    })
    const f = await fixture([p])
    f.write('notes/a.md', 'a')
    f.write('site/.pneuma-item', '{"format":1}\n')
    f.write('site/index.html', '<h1>')
    for (const left of ['site/.git/HEAD', 'site/node_modules/x.js', 'site/.DS_Store']) f.write(left, 'left out')
    f.write('_archive/old.md', 'old')
    await kernel.agentFace.check({ since: null, includeArchived: false }, f.ctx)
    if (!grabbed) throw new Error('onCheck was not called')
    return { f, ctx: grabbed, heard }
  }

  it('turn an agent’s input into a library path with its region and the bundle it lies in', async () => {
    const { f, ctx } = await probe()
    const t = ctx.tools
    expect(await t.resolve('site/index.html')).toEqual({ path: 'site/index.html', region: 'content', bundle: 'site' })
    expect(await t.resolve(join(f.root, 'notes', 'a.md'))).toEqual({ path: 'notes/a.md', region: 'content', bundle: null })
    expect(await t.resolve('.pneuma-base/probe/x')).toMatchObject({ region: 'kernel' })
    expect(await t.resolve('../elsewhere.md')).toBeNull()
    expect(t.regionOf('_archive/old.md' as sdk.LibraryPath)).toBe('archive')
    expect(t.archivedPath('a.md' as sdk.LibraryPath)).toBe('_archive/a.md')
    expect(t.originalPath('_archive/a.md' as sdk.LibraryPath)).toBe('a.md')
    expect(t.abs('notes/a.md' as sdk.LibraryPath)).toBe(join(f.root, 'notes', 'a.md'))
  })

  it('say what is at a path, list the things, and the files a bundle counts, leaving out the kernel’s names', async () => {
    const { ctx } = await probe()
    const t = ctx.tools
    expect(await t.thing('site' as sdk.LibraryPath)).toMatchObject({ kind: 'bundle', files: 1, size: 4 })
    expect(await t.thing('notes/a.md' as sdk.LibraryPath)).toMatchObject({ kind: 'file', files: 1, size: 1 })
    expect(await t.thing('notes' as sdk.LibraryPath)).toBeNull()
    expect(await t.things()).toEqual(['_archive/old.md', 'notes/a.md', 'site'])
    expect((await t.files('site' as sdk.LibraryPath))?.map((file) => file.path)).toEqual(['index.html'])
    expect(await t.files('notes/a.md' as sdk.LibraryPath)).toBeNull()
  })

  it('give fingerprints of things, manifests and files', async () => {
    const { f, ctx } = await probe()
    const t = ctx.tools
    expect(await t.fingerprint('notes/a.md' as sdk.LibraryPath)).toBe(sha('a'))
    expect(await t.fingerprintOfFile(join(f.root, 'notes', 'a.md'))).toBe(sha('a'))
    const manifest = await t.manifest('site' as sdk.LibraryPath)
    expect(manifest).toEqual([{ path: 'index.html', fingerprint: sha('<h1>'), size: 4 }])
    expect(await t.fingerprint('site' as sdk.LibraryPath)).toBe(sha(`index.html\0${sha('<h1>')}\n`))
    expect(t.fingerprintOfManifest(manifest ?? [])).toBe(await t.fingerprint('site' as sdk.LibraryPath))
    expect(await t.fingerprint('gone.md' as sdk.LibraryPath)).toBeNull()
    expect(await t.manifest('notes/a.md' as sdk.LibraryPath)).toBeNull()
  })

  it('copy a thing out, answering the fingerprint of the copy, and never into the library outside the plugin’s own directory', async () => {
    const { f, ctx } = await probe()
    const t = ctx.tools
    const stage = join(tempDir('pb-k-stage-'), 'site')
    expect(await t.copyOut('site' as sdk.LibraryPath, stage)).toBe(await t.fingerprint('site' as sdk.LibraryPath))
    expect(readdirSync(stage)).toEqual(['index.html'])
    const own = join(ctx.dir, 'stage')
    expect(await t.copyOut('notes/a.md' as sdk.LibraryPath, own)).toBe(sha('a'))
    expect(readFileSync(join(own, 'a.md'), 'utf8')).toBe('a')
    await expect(t.copyOut('notes/a.md' as sdk.LibraryPath, join(f.root, 'copied'))).rejects.toThrow()
    expect(existsSync(join(f.root, 'copied'))).toBe(false)
    expect(await t.copyOut('gone.md' as sdk.LibraryPath, join(tempDir('pb-k-stage-'), 'x'))).toBeNull()
  })

  it('answer what a path names without asking whether something is there', async () => {
    const { f, ctx } = await probe()
    const t = ctx.tools
    expect(await t.resolve('notes/absent.md')).toEqual({ path: 'notes/absent.md', region: 'content', bundle: null })
    expect(await t.thing('notes/absent.md' as sdk.LibraryPath)).toBeNull()
    for (const input of ['', '.', '..', '../x.md', f.root, join(f.root, '..', 'x.md')]) expect(await t.resolve(input), input).toBeNull()
  })

  it('agree with each other and with the verbs that a symbolic link in the library is no thing: none follows one', async () => {
    const { f, ctx } = await probe()
    const t = ctx.tools
    const outside = tempDir('pb-k-outside-')
    writeFileSync(join(outside, 'o.md'), 'outside')
    mkdirSync(join(outside, 'dir'))
    writeFileSync(join(outside, 'dir', 'x.md'), 'x')
    symlinkSync(join(f.root, 'notes', 'a.md'), join(f.root, 'alias.md'))
    symlinkSync(join(outside, 'o.md'), join(f.root, 'out.md'))
    symlinkSync(join(outside, 'dir'), join(f.root, 'outdir'))
    symlinkSync(join(f.root, 'notes'), join(f.root, 'notelink'))
    symlinkSync(join(f.root, 'site'), join(f.root, 'sitelink'))
    symlinkSync(join(f.root, 'notes', 'a.md'), join(f.root, 'site', 'inlink.md'))

    expect(await t.things()).toEqual(['_archive/old.md', 'notes/a.md', 'site'])
    expect((await t.files('site' as sdk.LibraryPath))?.map((file) => file.path)).toEqual(['index.html'])
    const linked = ['alias.md', 'out.md', 'outdir', 'outdir/x.md', 'notelink/a.md', 'sitelink', 'site/inlink.md'] as sdk.LibraryPath[]
    for (const path of linked) {
      expect(await t.thing(path), path).toBeNull()
      expect(await t.fingerprint(path), path).toBeNull()
      expect(await t.files(path), path).toBeNull()
      expect(await t.manifest(path), path).toBeNull()
      expect(await t.copyOut(path, join(tempDir('pb-k-stage-'), 'copy')), path).toBeNull()
    }
    for (const path of ['alias.md', 'notelink/a.md', 'outdir/x.md']) {
      expect(await t.resolve(path), path).toMatchObject({ path })
      expect(await t.resolve(join(f.root, path)), path).toMatchObject({ path })
    }

    const put = (req: sdk.PutRequest) => kernel.agentFace.put(req, ctx)
    expect(await put({ kind: 'register', path: 'alias.md', origin: brought })).toMatchObject({ outcome: 'refused', reason: 'no-such-file' })
    expect(await put({ kind: 'register', path: 'notelink/a.md', origin: brought })).toMatchObject({ outcome: 'refused', reason: 'no-such-file' })
    expect(await put({ kind: 'move', from: 'out.md', to: 'moved.md' })).toMatchObject({ outcome: 'refused', reason: 'no-such-file' })
    // Storage takes nothing below a link: a place there is outside the library.
    expect(await put({ kind: 'place', from: { kind: 'file', path: outsideFile('new') }, to: 'outdir/new.md', origin: brought })).toMatchObject({ outcome: 'refused', reason: 'outside-library' })
    expect(existsSync(join(outside, 'dir', 'new.md'))).toBe(false)
    expect(await kernel.agentFace.archive({ kind: 'archive', path: 'alias.md' }, ctx)).toMatchObject({ outcome: 'refused', reason: 'no-such-file' })
    expect(await kernel.agentFace.inspect({ target: 'out.md' }, ctx)).toMatchObject({ file: null })
  })

  it('split and rank find terms as the kernel does, and put through the agent face so every plugin hears it', async () => {
    const { ctx, heard } = await probe()
    const t = ctx.tools
    expect(t.searchTerms('部署 网站', 'terms')).toEqual(kernel.searchTerms('部署 网站', 'terms'))
    expect(t.rankHits([{ hit: 'a', haystack: 'x 部署' }, { hit: 'b', haystack: 'y' }], ['部署'], 'terms')).toEqual(['a'])
    expect(t.sentenceHits).toBe(kernel.SENTENCE_HITS)
    const r = await t.put({ kind: 'place', from: { kind: 'file', path: outsideFile('b') }, to: 'b.md', origin: brought })
    expect(r).toMatchObject({ outcome: 'accepted', path: 'b.md' })
    expect(heard).toEqual(['b.md'])
  })
})

describe('a name a plugin claims', () => {
  const command = (name: string, text: string): sdk.OwnerCommand => ({ name, summary: '', params: {}, destructive: false, ownerOnly: false, run: async () => ({ outcome: 'done', text }) })
  const first = plugin('first', {
    statements: ['deployable'],
    onSay: async () => ({ outcome: 'heard', note: 'first heard' }),
    ownerCommands: [command('first on', 'first on')],
    views: [{ id: 'first.sites', title: '网站', icon: 'globe', nav: true, filters: [] }],
  })
  // A table made without the loader can hold a plugin that shares a command or view name with another.
  const second = Object.freeze(plugin('second', {
    statements: ['deployable', 'second-only'],
    onSay: async () => ({ outcome: 'heard', note: 'second heard' }),
    ownerCommands: [command('first on', 'second on'), command('second off', 'second off')],
  }))
  const owners = (f: Awaited<ReturnType<typeof fixture>>, table: Map<string, sdk.Plugin>): kernel.OwnerCall => ({ ctx: f.ctx, table, env: {}, viaGrant: false, confirm: async () => true })

  it('cannot be taken by a plugin added later: plugin add refuses it and says which plugin holds it', async () => {
    const f = await fixture([first])
    const table = new Map<string, sdk.Plugin>([['first', first], ['second', second]])
    const r = await kernel.ownerFace.dispatch(owners(f, table), 'plugin add', { positional: ['second'], flags: {} })
    expect(r).toMatchObject({ outcome: 'refused', reason: 'name-taken' })
    if (r.outcome !== 'refused') return
    expect(r.text).toContain('「说」的种类「deployable」已归插件 first')
    expect(r.text).toContain('主人命令「first on」已归插件 first')
    expect(r.text).not.toContain('second-only')
    expect(JSON.parse(f.read('.pneuma-base/config.json')).plugins).toEqual(['first'])
  })

  it('cannot be taken at init either: init with two plugins that claim one name refuses, as plugin add would, and makes no library', async () => {
    const root = join(tempDir(), 'lib')
    const table = new Map<string, sdk.Plugin>([['first', first], ['second', second]])
    const r = await kernel.initLibrary(root, { plugins: ['first', 'second'], table, actor: owner, session, home: tempDir('pb-k-home-') })
    expect(r).toMatchObject({ outcome: 'refused', reason: 'name-taken' })
    expect(r.text).toContain('插件 second 的「说」的种类「deployable」已归插件 first')
    expect(existsSync(join(root, '.pneuma-base'))).toBe(false)
  })

  it('in a configuration that already has a clash stays with the earlier plugin; the later one’s is left out and listed', async () => {
    const f = await fixture([first])
    // Edited by hand, or synced from machines that installed one each.
    f.write('.pneuma-base/config.json', JSON.stringify({ ...JSON.parse(f.read('.pneuma-base/config.json')), plugins: ['first', 'second'] }))
    const library = await kernel.openLibrary(f.root, new Map<string, sdk.Plugin>([['first', first], ['second', second]]))
    if (library === null) throw new Error('no library')
    f.library = library
    f.ctx = kernel.makeContext(library, owner, session, f.home)
    const said = await kernel.agentFace.say({ kind: 'deployable', about: null, text: null, args: {} }, f.ctx)
    expect(said).toMatchObject({ outcome: 'heard', by: 'first' })
    const listed = said.problems.filter((p) => p.plugin === 'second').map((p) => p.message)
    expect(listed).toEqual([expect.stringContaining('「说」的种类「deployable」已归插件 first'), expect.stringContaining('主人命令「first on」已归插件 first')])
    expect(await kernel.agentFace.say({ kind: 'second-only', about: null, text: null, args: {} }, f.ctx)).toMatchObject({ outcome: 'heard', by: 'second' })
    const commands = kernel.ownerFace.commands(f.library.plugins).filter((c) => c.by !== 'kernel').map((c) => `${c.by}: ${c.name}`)
    expect(commands).toEqual(['first: first on', 'second: second off'])
    expect(kernel.viewerFace.views(f.library).problems.map((p) => p.plugin)).toEqual(['second', 'second'])
  })
})

describe('a plugin’s own lifecycle', () => {
  const calls = (f: Awaited<ReturnType<typeof fixture>>, table: Map<string, sdk.Plugin>): kernel.OwnerCall => ({ ctx: f.ctx, table, env: {}, viaGrant: false, confirm: async () => true })
  const configured = (f: Awaited<ReturnType<typeof fixture>>) => JSON.parse(f.read('.pneuma-base/config.json')).plugins

  it('hears archive purge through onPurged, with the paths as they were in the archive', async () => {
    const heard: string[][] = []
    const f = await fixture([plugin('keeper', { onPurged: async (paths) => void heard.push([...paths]) }), plugin('broken', { onPurged: async () => { throw new Error('purge broke') } })])
    const r1 = await kernel.ownerFace.dispatch(calls(f, new Map()), 'archive purge', { positional: [], flags: {} })
    expect(r1).toMatchObject({ outcome: 'done', problems: [] })
    expect(heard).toEqual([])
    f.write('_archive/a.md', 'a')
    f.write('_archive/site/.pneuma-item', '{"format":1}\n')
    f.write('_archive/site/index.html', '<h1>')
    const r2 = await kernel.ownerFace.dispatch(calls(f, new Map()), 'archive purge', { positional: [], flags: {} })
    expect(r2).toMatchObject({ outcome: 'done', problems: [{ plugin: 'broken', message: 'purge broke' }] })
    expect(heard).toEqual([['_archive/a.md', '_archive/site']])
  })

  it('hears its own plugin add once through onAdd; what it reports shows in the answer, which still succeeds', async () => {
    const f = await fixture()
    const seen: string[] = []
    const reporter = plugin('reporter', {
      onAdd: async (ctx) => {
        seen.push(ctx.library.plugins.map((p) => p.name).join(','))
        return { problems: ['目标还没设：运行 reporter target set'] }
      },
    })
    const thrower = plugin('thrower', { onAdd: async () => { throw new Error('add broke') } })
    const table = new Map<string, sdk.Plugin>([['reporter', reporter], ['thrower', thrower]])
    const add = (name: string) => kernel.ownerFace.dispatch(calls(f, table), 'plugin add', { positional: [name], flags: {} })
    expect(await add('reporter')).toMatchObject({ outcome: 'done', problems: [{ plugin: 'reporter', message: '目标还没设：运行 reporter target set' }] })
    expect(seen).toEqual(['reporter'])
    f.ctx = { ...f.ctx, library: (await kernel.openLibrary(f.root, table)) as sdk.Library }
    expect(await add('reporter')).toMatchObject({ outcome: 'done', problems: [] })
    expect(seen).toHaveLength(1)
    expect(await add('thrower')).toMatchObject({ outcome: 'done', problems: [{ plugin: 'thrower', message: 'add broke' }] })
    expect(configured(f)).toEqual(['reporter', 'thrower'])
  })

  it('may refuse plugin remove through onRemove, saying why; --anyway removes it and repeats the warning', async () => {
    const warning = '还有 3 个网站在线；先运行 holder off，网站才会下线。'
    const holder = plugin('holder', { onRemove: async () => ({ refuse: warning }) })
    const thrower = plugin('thrower', { onRemove: async () => { throw new Error('remove broke') } })
    const f = await fixture([holder, thrower])
    const table = new Map<string, sdk.Plugin>([['holder', holder], ['thrower', thrower]])
    const remove = (name: string, flags: sdk.OwnerArgs['flags'] = {}) => kernel.ownerFace.dispatch(calls(f, table), 'plugin remove', { positional: [name], flags })
    const refused = await remove('holder')
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'plugin-refused' })
    expect(refused.text).toContain(warning)
    expect(refused.text).toContain('--anyway')
    // What the page offers beside the refusal: the same command with --anyway, asking first with the plugin's sentence.
    if (refused.outcome !== 'refused') return
    expect(refused.offer).toEqual({
      label: '仍然卸下',
      tone: 'danger',
      confirm: `插件 holder 说：${warning}\n仍然卸下吗？`,
      inputs: [],
      call: { face: 'owner', command: 'plugin remove', args: { positional: ['holder'], flags: { anyway: true } } },
    })
    expect(configured(f)).toEqual(['holder', 'thrower'])
    const offered = refused.offer?.call
    if (offered?.face !== 'owner') throw new Error('no owner call offered')
    const anyway = await kernel.ownerFace.dispatch(calls(f, table), offered.command, offered.args)
    expect(anyway).toMatchObject({ outcome: 'done' })
    expect(anyway.text).toContain(warning)
    expect(configured(f)).toEqual(['thrower'])
    await f.reopen()
    expect(await remove('thrower')).toMatchObject({ outcome: 'done', problems: [{ plugin: 'thrower', message: 'remove broke' }] })
    expect(configured(f)).toEqual([])
  })
})
