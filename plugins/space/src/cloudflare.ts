// PneumaSpace on Cloudflare: apps through its control API, as the owner's account (control.ts). The
// content id is the digest of the package (package.ts), which the control API reports for the release
// online, so content already there or already in an earlier release is never uploaded again: each app
// takes 200 uploads in its lifetime. Taking down removes, never purges; switching on again resumes the
// app. The account key comes from the plugin's secret `key`, else from the credentials file the owner
// named; it is never stored in the library.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { defineTarget, type ContentId, type Served, type SiteName, type Target, type TargetConfig } from '@pneuma-base/sdk/kit'
import { Control, ControlError, type AppSummary, type Manager } from './control.ts'
import { appName, MANAGER, ORIGIN, PLUGIN, PREFIX_PARAM } from './name.ts'
import { packageOf, refusal } from './package.ts'
import { viewOf, type Plane, type Seen } from './views.ts'

type Config = { origin: string; account: string; prefix: string; credentials: string | null; tenant: string | null }

const text = (v: unknown) => (typeof v === 'string' ? v : null)

function parseConfig(raw: TargetConfig): Config {
  const { origin, account, prefix } = raw
  const credentials = raw.credentials ?? null
  const tenant = raw.tenant ?? null
  if (typeof origin !== 'string' || typeof account !== 'string' || typeof prefix !== 'string' || (credentials !== null && typeof credentials !== 'string') || (tenant !== null && typeof tenant !== 'string')) {
    throw new Error('Cloudflare 上的 PneumaSpace 的配置要写 origin、account、prefix，可以有 credentials、tenant')
  }
  return { origin, account, prefix, credentials, tenant }
}

type Credentials = { origin: string | null; account: string | null; tenant: string | null; key: string | null }

/** A PneumaSpace credentials file (JSON with origin, account, key), or why it cannot be read, in words that quote nothing of it. */
async function credentialsAt(path: string): Promise<Credentials | string> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    return code === 'ENOENT' ? '没有这个文件' : code === 'EACCES' ? '没有权限读它' : code === 'EISDIR' ? '这是一个目录' : '读不出来'
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return '它不是 JSON'
  }
  const c = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  return { origin: text(c.origin), account: text(c.account), tenant: text(c.tenantId), key: text(c.key) }
}

const pathOf = (input: string) => resolve(input.startsWith('~/') ? `${homedir()}${input.slice(1)}` : input)
const originOf = (input: string) => {
  try {
    const url = new URL(input)
    return /^https?:$/.test(url.protocol) ? url.origin : null
  } catch {
    return null
  }
}

const SET_KEY = `pneuma-base secret set ${PLUGIN} key`
const NO_KEY = `还没有 Cloudflare 上的 PneumaSpace 的账户密钥：运行 ${SET_KEY} 设它（值从标准输入读），或者重设目标时用 --credentials 给 PneumaSpace 的凭据文件`

/** Where the library is named in the apps it makes: the manager's address. `.invalid` never resolves; it only tells libraries apart. */
const managerOf = (libraryId: string): Manager => ({ name: MANAGER, url: `https://pneuma-base.invalid/library/${libraryId}` })

/** Who holds an app, in words, when it is not this library's: made by this account, managed by pneuma-base for this library. */
function holder(app: AppSummary, user: string, mine: Manager): string | null {
  if (app.manager === null) return '它是在 PneumaSpace 上直接建的，不归 pneuma-base 管'
  if (app.manager.name !== MANAGER) return `它归 ${app.manager.name} 管理`
  if (app.manager.url !== mine.url) return `它归另一个库（${app.manager.url ?? '没有地址'}）`
  if (app.ownerId !== user) return '它属于另一个账户'
  return null
}

const planeOf = (origin: string): Plane => ({
  requests: '请求（累计）',
  framed: false,
  visible: `这个地址只有登录了 ${origin} 的账户看得到，管理界面里框不出它的预览；在新标签页打开，浏览器要先登录那个 PneumaSpace。`,
  // Each drawing signs in once, and PneumaSpace takes 40 sign-ins from a machine in ten minutes.
  refresh: 60,
})

export const cloudflareTarget = defineTarget({
  kind: 'cloudflare',
  label: '跑在 Cloudflare 上的 PneumaSpace',
  params: [
    { name: 'credentials', hint: 'PneumaSpace 的凭据文件', kind: 'value' },
    { name: 'origin', hint: '控制地址', kind: 'value', pattern: ORIGIN },
    { name: 'account', hint: '账户', kind: 'value', pattern: '[A-Za-z0-9_-]{1,40}' },
    PREFIX_PARAM,
  ],
  secrets: [{ name: 'key', description: 'Cloudflare 上的 PneumaSpace 的账户密钥；设了就不读凭据文件里的', optional: true }],

  async configure({ credentials, origin, account, prefix }, ctx) {
    const file = credentials === null ? null : pathOf(credentials)
    const read = file === null ? null : await credentialsAt(file)
    if (typeof read === 'string') return { ok: false, reason: 'credentials', text: `用不了凭据文件 ${file}：${read}。` }
    const at = originOf(origin ?? read?.origin ?? '')
    const who = account ?? read?.account ?? null
    if (at === null || who === null) {
      const missing = file === null ? '要写 --origin 和 --account，或者用 --credentials 给 PneumaSpace 的凭据文件。' : `凭据文件 ${file} 里没有可用的 origin 和 account；用 --origin、--account 写出来。`
      return { ok: false, reason: 'usage', text: missing }
    }
    const note =
      (await ctx.secrets.get('key')) !== null
        ? '账户密钥用这台机器上设的密钥 key。'
        : read?.key
          ? `账户密钥从凭据文件 ${file} 读，不存进库。`
          : `${NO_KEY}。`
    return { ok: true, config: { origin: at, account: who, prefix, credentials: file, tenant: read?.tenant ?? null }, note }
  },

  open(config, env): Target<Seen> {
    const c = parseConfig(config)
    const key = async () => {
      const set = await env.secret('key')
      if (set !== null) return set
      const read = c.credentials === null ? null : await credentialsAt(c.credentials)
      if (read !== null && typeof read !== 'string' && read.key !== null) return read.key
      throw new ControlError(typeof read === 'string' ? `用不了凭据文件 ${c.credentials}：${read}；${NO_KEY}` : NO_KEY)
    }
    const control = new Control(c.origin, c.account, key, c.tenant)
    const mine = managerOf(env.ctx.library.config.id)
    const taken = (site: string, by: string) => new ControlError(`应用名 ${site} 在 PneumaSpace 上已经有了：${by}，不是这个库的，所以不动它；换一个前缀，或在 PneumaSpace 上处理那个应用`)
    /** The app named `site`, unless someone else holds the name; null when there is none. */
    const ours = async (site: string): Promise<AppSummary | null> => {
      const app = (await control.apps()).get(site) ?? null
      const by = app && holder(app, await control.user(), mine)
      if (by) throw taken(site, by)
      return app
    }

    return {
      key: `pneuma-space-cf:${c.origin}#${c.prefix}`,
      label: `Cloudflare 上的 PneumaSpace ${c.origin}，账户 ${c.account}，应用名前缀 ${c.prefix}`,
      siteName: (path) => appName(c.prefix, path),
      identify: async (files) => (await packageOf(files)).digest as string as ContentId,

      /**
       * Refuses, before anything is sent, a site the contract would refuse. A removed app is resumed
       * first: PneumaSpace publishes only to a live app. Content already online is left as it is,
       * content of an earlier release is put back with `rollback`, and only new content is uploaded.
       */
      async publish(site, _dir, meta) {
        const pkg = await packageOf(meta.files)
        const refused = refusal(meta.files, pkg)
        if (refused !== null) throw new ControlError(refused)
        if (pkg.digest !== (meta.content as string)) throw new ControlError(`复制出来的内容和决定发布的不同：${pkg.digest} 不是 ${meta.content}`)
        let app = await ours(site)
        if (app === null) {
          try {
            app = await control.create(site, mine)
          } catch (error) {
            if (error instanceof ControlError && error.code === 'app_exists') throw taken(site, '这个名字被这个 PneumaSpace 上别的空间的应用占着')
            throw error
          }
        }
        let detail = await control.app(app.id, site)
        if (detail.status === 'removed') detail = await control.act(app, { type: 'resume' })
        if (detail.current?.digest === pkg.digest) return { url: app.url }
        const earlier = detail.releases.find((r) => r.digest === pkg.digest)
        if (earlier) await control.act(app, { type: 'rollback', release: earlier.number })
        else await control.upload(app, pkg)
        return { url: app.url }
      },

      /** Removes, never purges: the releases stay, and switching on again resumes the app. */
      async remove(site) {
        const app = await ours(site)
        if (app === null) return
        if ((await control.app(app.id, site)).status === 'registered') await control.act(app, { type: 'remove' })
      },

      /** What PneumaSpace has for each site; another holder's app is told from the list alone, its details never read. The upload allowance only when the answer is drawn. */
      async serving(sites, ask) {
        const apps = await control.apps()
        const user = await control.user()
        const told = await Promise.all(
          sites.map(async (site): Promise<[SiteName, Served<Seen>][]> => {
            const app = apps.get(site)
            if (app === undefined) return []
            const by = holder(app, user, mine)
            if (by !== null) {
              const seen: Seen = { takenBy: by, status: app.status, live: null, releases: [], spark: null, uploads: null, observedAt: app.observedAt }
              return [[site, { content: null, url: null, detail: seen }]]
            }
            const [detail, uploads] = await Promise.all([control.app(app.id, site), ask.detail ? control.uploads(app) : null])
            const current = detail.status === 'registered' ? detail.current : null
            const seen: Seen = {
              takenBy: null,
              status: detail.status,
              live: current && { release: current.number, requests: detail.requests, errors: detail.errors, lastAccessAt: detail.lastAccessAt },
              releases: detail.releases.map((r) => ({ number: r.number, publishedAt: r.createdAt, content: r.digest })),
              spark: null,
              uploads,
              observedAt: detail.observedAt,
            }
            return [[site, { content: current ? (current.digest as string as ContentId) : null, url: current ? app.url : null, detail: seen }]]
          }),
        )
        return new Map(told.flat())
      },

      view: viewOf(planeOf(c.origin), env.plugin),
      close: () => control.close(),
    }
  },
})
