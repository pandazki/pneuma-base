// The owner commands the search plugin adds. None can make content unrecoverable: the embedder
// record is a new file each time, and the index is a cache.
import { rm } from 'node:fs/promises'
import type { OwnerAnswer, OwnerArgs, OwnerCommand, PluginContext } from '@pneuma-base/kernel'
import { currentEmbedder, recordEmbedder } from './config.js'
import { embedderFor, embedderLabel, type EmbedderConfig } from './embed.js'
import { embedMissing, messageOf, refresh } from './search.js'
import { SearchIndex } from './store.js'
import { statusOf, statusText } from './views.js'

const done = (text: string, data?: unknown): OwnerAnswer => ({ outcome: 'done', text, ...(data === undefined ? {} : { data }) })
const refused = (reason: string, text: string): OwnerAnswer => ({ outcome: 'refused', reason, text })
const usage = (text: string) => refused('usage', text)

const SET_USAGE = 'search embedder set --kind hash，或 --kind http --url <地址> --model <模型名> [--key-env <存密钥的环境变量名>]'
const KEY_HINT = '密钥不写进库：用 --key-env 写存着密钥的环境变量的名字。'

/**
 * The flags of a call, checked at the boundary: no positional argument, no flag outside `allowed`.
 * An empty value counts as not given, as a form's empty field does.
 */
function flagsOf(command: string, args: OwnerArgs, allowed: readonly string[]): ((flag: string) => string | null) | string {
  if (args.positional.length > 0) return `${command} 不带参数：${args.positional.join(' ')}`
  const unknown = Object.keys(args.flags).find((f) => !allowed.includes(f))
  if (unknown !== undefined) return `${command} 不认识 --${unknown}。${unknown.startsWith('key') ? KEY_HINT : ''}`
  return (flag) => {
    const v = args.flags[flag]
    return Array.isArray(v) && v[0] !== undefined && v[0].trim() !== '' ? v[0].trim() : null
  }
}

/** The embedder a set call describes, or what is wrong with it. */
function embedderOf(flag: (name: string) => string | null): EmbedderConfig | string {
  const kind = flag('kind')
  const [url, model, keyEnv] = [flag('url'), flag('model'), flag('key-env')]
  // A form sends every field; for hash the http ones mean nothing.
  if (kind === 'hash') return { kind }
  if (kind !== 'http') return `要写 --kind hash 或 --kind http。${SET_USAGE}`
  if (url === null) return `--kind http 要写 --url <地址>，比如 http://127.0.0.1:11434。`
  if (!/^https?:\/\/[^\s/]+/.test(url)) return `--url 要是 http:// 或 https:// 开头的地址：${url}`
  if (model === null) return '--kind http 要写 --model <模型名>。'
  if (keyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) return `--key-env 要写环境变量的名字，不是密钥本身：${keyEnv}`
  return { kind, url, model, keyEnv }
}

async function rebuild(ctx: PluginContext): Promise<OwnerAnswer> {
  const config = await currentEmbedder(ctx)
  await rm(ctx.cacheDir, { recursive: true, force: true })
  const index = SearchIndex.open(ctx.cacheDir, ctx.now)
  let failure: string | null = null
  try {
    await refresh(index, ctx.library.root)
    if (config !== null) {
      try {
        await embedMissing(index, embedderFor(config, process.env))
      } catch (error) {
        failure = messageOf(error)
      }
    }
  } finally {
    index.close()
  }
  const s = await statusOf(ctx)
  const built = `已重建索引：${s.files} 个文件，其中文本 ${s.textFiles} 个，${s.chunks} 块。`
  if (failure !== null) return refused('embedder-failed', `${built}按意思的向量没建完（${s.vectors} / ${s.chunks} 块）：${failure}`)
  return done(`${built}${config ? `按意思：${s.vectors} / ${s.chunks} 块有向量。` : ''}`, s)
}

export const searchCommands: OwnerCommand[] = [
  {
    name: 'search embedder set',
    summary: '设按意思找用的嵌入器：hash，或 OpenAI 兼容的 http 服务',
    usage: '--kind hash | --kind http --url <地址> --model <模型名> [--key-env <存密钥的环境变量名>]',
    destructive: false,
    ownerOnly: true,
    async run(args, ctx) {
      const flag = flagsOf('search embedder set', args, ['kind', 'url', 'model', 'key-env'])
      if (typeof flag === 'string') return usage(flag)
      const config = embedderOf(flag)
      if (typeof config === 'string') return usage(config)
      await recordEmbedder(ctx, config)
      const probe = await embedderFor(config, process.env)
        .embed(['试一下能不能用'])
        .then(() => null)
        .catch((error: unknown) => messageOf(error))
      const tried = probe === null ? '试了一次，能用。下次 find 时给库里的文本补上向量。' : `不过试了一次没成：${probe}。find 照常按文字找，并报这个问题。`
      return done(`已设好嵌入器：${embedderLabel(config)}。${tried}`, { embedder: config, probe: probe ?? 'ok' })
    },
  },
  {
    name: 'search embedder clear',
    summary: '清除嵌入器，find 只按文字找',
    destructive: false,
    ownerOnly: true,
    async run(args, ctx) {
      const flag = flagsOf('search embedder clear', args, [])
      if (typeof flag === 'string') return usage(flag)
      if ((await currentEmbedder(ctx)) === null) return done('本来就没配嵌入器。')
      await recordEmbedder(ctx, null)
      return done('已清除嵌入器，find 只按文字找。缓存里的向量下次 find 时删掉。')
    },
  },
  {
    name: 'search rebuild',
    summary: '删掉查找的索引，从库里的文件重建',
    destructive: false,
    ownerOnly: false,
    async run(args, ctx) {
      const flag = flagsOf('search rebuild', args, [])
      return typeof flag === 'string' ? usage(flag) : rebuild(ctx)
    },
  },
  {
    name: 'search status',
    summary: '查找的索引有多少、待更新多少、配了什么嵌入器',
    destructive: false,
    ownerOnly: false,
    async run(args, ctx) {
      const flag = flagsOf('search status', args, [])
      if (typeof flag === 'string') return usage(flag)
      const s = await statusOf(ctx)
      return done(statusText(s), s)
    },
  },
]
