// Plugins written as a third party writes them: plain ES modules in a directory, no import of the
// kernel. Tests write them where they need them, in a plugin directory to install or straight into
// $PNEUMA_BASE_HOME/plugins/.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Writes each file of `files`, by its path relative to `dir`. */
export function writePlugin(dir: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

/** `argv show` hands back the arguments and values it was given, so a test sees how the command line read them. */
export const ARGV = {
  'index.js': `export default {
  contract: 1,
  name: 'argv',
  version: '1.0.0',
  summary: '把收到的参数原样交回',
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [
    {
      name: 'argv show',
      summary: '交回收到的参数',
      destructive: false,
      ownerOnly: false,
      readOnly: true,
      params: {
        positional: [
          { name: 'path', hint: '路径', required: true, pattern: '[a-z/]+' },
          { name: 'more', hint: '更多', many: true },
        ],
        flags: [
          { name: 'force', hint: '强行', kind: 'boolean' },
          { name: 'tags', hint: '标签', kind: 'list' },
          { name: 'mode', hint: '方式', kind: 'value', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] },
        ],
      },
      async run(args) {
        return { outcome: 'done', text: JSON.stringify(args.values), data: { positional: args.positional, flags: args.flags, values: args.values } }
      },
    },
  ],
}
`,
}

/** Declares the secret `token`; `vault show` says what `ctx.secrets.get('token')` gave it. */
export const VAULT = {
  'index.js': `export default {
  contract: 1,
  name: 'vault',
  version: '1.0.0',
  cognition: null,
  storage: [],
  statements: [],
  secrets: [{ name: 'token', description: '外面服务的令牌' }],
  ownerCommands: [
    {
      name: 'vault show',
      summary: '说出它读到的令牌',
      destructive: false,
      ownerOnly: false,
      readOnly: true,
      params: {},
      async run(_args, ctx) {
        const token = await ctx.secrets.get('token')
        return { outcome: 'done', text: token === null ? '没有令牌' : '有令牌', data: { token } }
      },
    },
  ],
}
`,
}

/** A plugin of several files: its view shows what a sibling module says, and its own page is in `ui/`. */
export function pager(words: string, version: string): Record<string, string> {
  return {
    'index.js': `import { WORDS, VERSION } from './lib/words.js'
export default {
  contract: 1,
  name: 'pager',
  version: VERSION,
  summary: '一页字',
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
  views: [{ id: 'pager.page', title: '一页字', icon: 'file', nav: true, filters: [] }],
  ui: new URL('./ui/', import.meta.url).pathname,
  async onView() {
    return { title: '一页字', subtitle: null, blocks: [{ kind: 'text', tone: 'neutral', text: WORDS }] }
  },
}
`,
    'lib/words.js': `export const WORDS = ${JSON.stringify(words)}\nexport const VERSION = ${JSON.stringify(version)}\n`,
    'ui/page.html': `<!doctype html><p>${words}</p>\n`,
  }
}
