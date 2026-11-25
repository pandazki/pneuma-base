import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  initLibrary,
  makeContext,
  openLibrary,
  type Actor,
  type Context,
  type Library,
  type Plugin,
  type PluginName,
  type Session,
} from '../src/index.js'

export function tempDir(prefix = 'pb-k-'): string {
  return realpathSync(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), prefix)))
}

export const session: Session = { id: 'test-session', source: 'flag', cwd: '/', machine: 'test', transcript: null }
export const owner: Actor = { kind: 'owner' }

export function plugin(name: string, parts: Partial<Plugin> = {}): Plugin {
  return { contract: 1, name: name as PluginName, cognition: null, storage: [], statements: [], ownerCommands: [], ...parts }
}

async function mustOpen(root: string, table: Map<string, Plugin>): Promise<Library> {
  const library = await openLibrary(root, table)
  if (!library) throw new Error(`no library at ${root}`)
  return library
}

export type Fixture = {
  root: string
  home: string
  library: Library
  ctx: Context
  write(path: string, content: string): void
  read(path: string): string
  reopen(actor?: Actor): Promise<void>
}

/** A fresh library with the given plugins installed, opened as the owner. */
export async function fixture(plugins: Plugin[] = []): Promise<Fixture> {
  const root = join(tempDir(), 'lib')
  const home = tempDir('pb-k-home-')
  const table = new Map(plugins.map((p) => [p.name as string, p]))
  const init = await initLibrary(root, { plugins: plugins.map((p) => p.name), table, actor: owner, session, home })
  if (init.outcome !== 'done') throw new Error(`init refused: ${init.reason}`)
  const f: Fixture = {
    root,
    home,
    library: await mustOpen(root, table),
    ctx: undefined as unknown as Context,
    write(path, content) {
      const abs = join(root, path)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    },
    read: (path) => readFileSync(join(root, path), 'utf8'),
    async reopen(actor = owner) {
      f.library = await mustOpen(root, table)
      f.ctx = makeContext(f.library, actor, session, home)
    },
  }
  f.ctx = makeContext(f.library, owner, session, home)
  return f
}

export function outsideFile(content: string): string {
  const path = join(tempDir('pb-k-out-'), 'file.txt')
  writeFileSync(path, content)
  return path
}
