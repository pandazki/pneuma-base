// PneumaSpace on Cloudflare: apps through its control API, as the owner's account (control.ts). The
// content id is the digest of the package (package.ts), which the control API reports for the release
// online, so content already there or already in an earlier release is never uploaded again: each app
// takes 200 uploads in its lifetime. Taking down removes, never purges; switching on again resumes the
// app. The account key is read, at each run, from the one place the connection names: the owner.json
// PneumaSpace's command line wrote on this machine for its host, the credentials file the owner named,
// or the key typed when connecting, kept as the plugin's secret `key`. It is never stored in the library.
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineTarget, type ContentId, type Found, type Served, type SiteName, type Target, type TargetConfig } from '@pneuma-base/sdk/kit'
import { CLOUDFLARE_COGNITION } from './cognition.js'
import { Control, ControlError, type AppSummary, type Manager } from './control.js'
import { appName, defaultPrefix, hostOf, MANAGER, ORIGIN, PREFIX_PARAM, prefixSetting } from './name.js'
import { packageOf, refusal } from './package.js'
import { viewOf, type Plane, type Seen } from './views.js'

type Config = { host: string | null; origin: string; account: string; prefix: string; credentials: string | null; tenant: string | null }

const text = (v: unknown) => (typeof v === 'string' ? v : null)
const optional = (v: unknown) => v === undefined || v === null || typeof v === 'string'

function parseConfig(raw: TargetConfig): Config {
  const { origin, account, prefix } = raw
  if (typeof origin !== 'string' || typeof account !== 'string' || typeof prefix !== 'string' || !optional(raw.host) || !optional(raw.credentials) || !optional(raw.tenant)) {
    throw new Error('Cloudflare 上的 PneumaSpace 的配置要写 origin、account、prefix，可以有 host、credentials、tenant')
  }
  return { host: text(raw.host), origin, account, prefix, credentials: text(raw.credentials), tenant: text(raw.tenant) }
}

type Credentials = { origin: string | null; account: string | null; tenant: string | null; key: string | null }

const HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?'
/** Where PneumaSpace's command line keeps, for each host it installed from this machine, the owner's account. */
const hostsDir = () => join(homedir(), '.pneuma-space', 'hosts')
const ownerFile = (host: string) => join(hostsDir(), host, 'owner.json')

/**
 * The PneumaSpace installations made from this machine: one level of the hosts folder, each folder
 * holding owner.json, by name. Only that file is looked at, and only that it is there.
 */
async function installed(): Promise<Found[]> {
  const entries = await readdir(hostsDir(), { withFileTypes: true }).catch(() => [])
  const hosts = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && new RegExp(`^${HOST}$`).test(e.name)).map((e) => e.name)
  const there = await Promise.all(hosts.map((host) => stat(ownerFile(host)).then((s) => s.isFile(), () => false)))
  return hosts.filter((_, i) => there[i]).sort().map((host) => ({ label: host, values: { host } }))
}

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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
  label: 'Cloudflare 上的 PneumaSpace',
  icon: 'cloud',
  group: { name: 'PneumaSpace', choice: 'Cloudflare 上的' },
  form: ['origin', 'account'],
  params: [
    { name: 'host', hint: '这台机器上装的 PneumaSpace', kind: 'value', pattern: HOST },
    { name: 'credentials', hint: 'PneumaSpace 的凭据文件', kind: 'value' },
    { name: 'origin', hint: '地址', kind: 'value', pattern: ORIGIN },
    { name: 'account', hint: '账户', kind: 'value', pattern: '[A-Za-z0-9_-]{1,40}' },
    PREFIX_PARAM,
  ],
  secrets: [{ name: 'key', description: 'Cloudflare 上的 PneumaSpace 的账户密钥，连上时填的', optional: true }],
  asked: { name: 'key', hint: '账户密钥' },
  cognition: CLOUDFLARE_COGNITION,
  found: installed,

  /**
   * What it will connect to, from the one place given: the host installed from this machine, a
   * credentials file, or the address and account with the key typed (or the one kept from before).
   * It signs in once with the key it will use and signs out; nothing is stored when that fails.
   */
  async configure({ host, credentials, origin, account, prefix }, ctx, typed) {
    if (host !== null && credentials !== null) return { ok: false, reason: 'usage', text: '--host 和 --credentials 只写一个。' }
    const file = host !== null ? ownerFile(host) : credentials === null ? null : pathOf(credentials)
    const read = file === null ? null : await credentialsAt(file)
    if (typeof read === 'string') return { ok: false, reason: 'credentials', text: host !== null ? `这台机器上的 PneumaSpace ${host} 用不了：${read}。` : `用不了凭据文件 ${file}：${read}。` }
    const at = originOf((host === null ? origin : null) ?? read?.origin ?? '')
    const who = (host === null ? account : null) ?? read?.account ?? null
    if (at === null || who === null) {
      const missing = host !== null ? `这台机器上的 PneumaSpace ${host} 的 owner.json 里没有可用的 origin 和 account。` : file === null ? '要写 --host，或 --origin 和 --account，或 --credentials。' : `凭据文件 ${file} 里没有可用的 origin 和 account；用 --origin、--account 写出来。`
      return { ok: false, reason: 'usage', text: missing }
    }
    const key = read !== null ? read.key : ((await typed()) ?? (await ctx.secrets.get('key')))
    if (key === null) return { ok: false, reason: 'no-key', text: read !== null ? `${host !== null ? `这台机器上的 PneumaSpace ${host} 的 owner.json` : `凭据文件 ${file}`} 里没有密钥。` : '没有账户密钥。' }
    const tenant = read?.tenant ?? null
    const control = new Control(at, who, async () => key, tenant)
    try {
      await control.user()
    } catch (error) {
      return { ok: false, reason: 'unreachable', text: `${messageOf(error)}。` }
    } finally {
      await control.close().catch(() => undefined)
    }
    const where = host !== null ? { host } : { credentials: file }
    return { ok: true, config: { ...where, origin: at, account: who, prefix: prefix ?? defaultPrefix(ctx.library.root), tenant } }
  },

  open(config, env): Target<Seen> {
    const c = parseConfig(config)
    /** The key, read again at each sign-in from the place the connection names. */
    const key = async () => {
      const file = c.host !== null ? ownerFile(c.host) : c.credentials
      if (file === null) {
        const kept = await env.secret('key')
        if (kept !== null) return kept
        throw new ControlError(`这台机器上没有 ${c.origin} 的账户密钥`)
      }
      const read = await credentialsAt(file)
      if (typeof read !== 'string' && read.key !== null) return read.key
      throw new ControlError(`${c.host !== null ? `这台机器上的 PneumaSpace ${c.host}` : `凭据文件 ${file}`} 用不了：${typeof read === 'string' ? read : '里面没有密钥'}`)
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
      key: `pneuma-space-cf:${c.origin}`,
      label: c.host ?? hostOf(c.origin),
      settings: prefixSetting(c.prefix),
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
