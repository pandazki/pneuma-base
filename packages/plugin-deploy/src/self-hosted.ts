// PneumaSpace self-hosted on a machine (its Docker plane): apps through its admin HTTP API. Its kind was
// `machine`; its key is unchanged, so the records of one connected before count. The content id is the
// sha256 of the bundle tar PneumaSpace is given, and `serving` answers from what PneumaSpace really has,
// so `deploy sync` repairs a publish that died halfway or an app removed from PneumaSpace's console.
import { defineTarget, type ContentId, type Served, type SiteName, type Target, type TargetConfig } from '@pneuma-base/sdk/kit'
import { SELF_HOSTED_COGNITION } from './cognition.js'
import { NO_INDEX } from './package.js'
import { appName, defaultPrefix, hostOf, ORIGIN, PREFIX_PARAM, prefixSetting } from './name.js'
import { bundleOf, ownerOf, Space, SpaceError, type AppDetail, type AppSummary } from './space.js'
import { viewOf, type Plane, type Seen } from './views.js'

type Config = { admin: string; prefix: string; public: string | null }

function parseConfig(raw: TargetConfig): Config {
  const { admin, prefix } = raw
  const origin = raw.public ?? null
  if (typeof admin !== 'string' || typeof prefix !== 'string' || (origin !== null && typeof origin !== 'string')) throw new Error('自托管 PneumaSpace 的配置须包含 admin、prefix，可包含 public')
  return { admin, prefix, public: origin }
}

const PLANE: Plane = { requests: '24 小时请求', framed: true, visible: null }

/** What the views get of a self-hosted app. `spark` only for a drawn answer. */
function seen(summary: AppSummary, detail: AppDetail | null, mine: boolean, spark: number[] | null): Seen {
  const registered = mine && detail?.status === 'registered'
  return {
    takenBy: detail !== null && !mine ? `属于 ${detail.owner}` : null,
    status: detail?.status ?? summary.status,
    live: registered && summary.release !== null ? { release: summary.release, requests: summary.requests, errors: summary.errors, lastAccessAt: summary.lastAccessAt } : null,
    releases: (detail?.releases ?? []).map((r) => ({ number: r.number, publishedAt: r.publishedAt, content: r.bundle })),
    spark,
    uploads: null,
    observedAt: null,
  }
}

export const selfHostedTarget = defineTarget({
  kind: 'self-hosted',
  formerly: ['machine'],
  label: '自托管',
  icon: 'server',
  group: { name: 'PneumaSpace', choice: '自托管' },
  form: ['admin'],
  cognition: SELF_HOSTED_COGNITION,
  params: [
    { name: 'admin', hint: '地址', kind: 'value', required: true, pattern: `${ORIGIN}(?:/\\S*)?` },
    PREFIX_PARAM,
    { name: 'public', hint: '站点公开地址', kind: 'value', pattern: ORIGIN },
  ],
  secrets: [{ name: 'token', title: '访问 token', description: '自托管 PneumaSpace 不在本地模式时的访问 token，作为 Bearer token 发送', optional: true }],
  // The board is the plugin's page for both kinds; a page is declared once, here, and each kind draws it.
  views: [{ name: 'board', title: '看板', icon: 'layout-grid' }],

  /** Asks the admin address once whether it is PneumaSpace; nothing is stored when it does not answer as one. */
  async configure({ admin, prefix, public: origin }, ctx) {
    const at = admin.replace(/\/+$/, '')
    try {
      await new Space(at, () => ctx.secrets.get('token')).health()
    } catch (error) {
      return { ok: false, reason: 'unreachable', text: `${error instanceof Error ? error.message : String(error)}。` }
    }
    return { ok: true, config: { admin: at, prefix: prefix ?? defaultPrefix(ctx.library.root), public: origin?.replace(/\/+$/, '') ?? null } }
  },

  open(config, env): Target<Seen> {
    const c = parseConfig(config)
    const space = new Space(c.admin, () => env.secret('token'))
    const owner = ownerOf(env.ctx.library.config.id)
    const urlOf = async (address: string) => (/^https?:\/\//.test(address) ? address : (c.public ?? (await space.ingress())) + address)
    const taken = (site: string, by: string) => new SpaceError(`应用名称 ${site} 在 PneumaSpace 上属于 ${by}，不属于此资料库，未做改动；请更换应用名称前缀，或在 PneumaSpace 上处理该应用`)

    return {
      key: `pneuma-space:${c.admin}`,
      label: hostOf(c.admin),
      settings: prefixSetting(c.prefix),
      siteName: (path) => appName(c.prefix, path),
      identify: async (files) => (await bundleOf(files)).bundle as string as ContentId,

      async publish(site, _dir, meta) {
        if (!meta.files.some((f) => f.path === 'index.html')) throw new SpaceError(NO_INDEX)
        const { tar, bundle } = await bundleOf(meta.files)
        if (bundle !== (meta.content as string)) throw new SpaceError(`复制的内容与待发布的内容不一致：${bundle} 不是 ${meta.content}`)
        const detail = await space.app(site)
        if (detail !== null && detail.owner !== owner) throw taken(site, detail.owner)
        await space.publish(site, tar, bundle, owner)
        const summary = (await space.apps()).get(site)
        return { url: summary ? await urlOf(summary.address) : null }
      },

      /** Removes, never purges: the releases stay, and publishing again restores the app. */
      async remove(site) {
        const detail = await space.app(site)
        if (detail === null) return
        if (detail.owner !== owner) throw taken(site, detail.owner)
        if (detail.status === 'registered') await space.remove(site)
      },

      /** What PneumaSpace has for each site; the request series, which only the board draws, only when the answer is drawn. */
      async serving(sites, ask) {
        const summaries = await space.apps()
        const told = await Promise.all(
          sites.map(async (site): Promise<[SiteName, Served<Seen>][]> => {
            const summary = summaries.get(site) ?? null
            if (summary === null) return []
            const detail = await space.app(site)
            const mine = detail?.owner === owner
            const live = detail !== null && mine && detail.status === 'registered' ? detail.releases.find((r) => r.number === detail.current) : undefined
            const spark = live && ask.detail ? await space.requestsByHour(site, 24) : null
            const content = live ? (live.bundle as string as ContentId) : null
            return [[site, { content, url: live ? await urlOf(summary.address) : null, detail: seen(summary, detail, mine, spark) }]]
          }),
        )
        return new Map(told.flat())
      },

      view: viewOf(PLANE, env.plugin),
    }
  },
})
