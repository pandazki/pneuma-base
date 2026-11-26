// PneumaSpace on a machine (its Docker plane): apps through its admin HTTP API. The content id is the
// sha256 of the bundle tar PneumaSpace is given, and `serving` answers from what PneumaSpace really has,
// so `space sync` repairs a publish that died halfway or an app removed from PneumaSpace's console.
import { defineTarget, type ContentId, type Served, type SiteName, type Target, type TargetConfig } from '@pneuma-base/sdk/kit'
import { appName, ORIGIN, PREFIX_PARAM } from './name.ts'
import { bundleOf, ownerOf, Space, SpaceError, type AppDetail, type AppSummary } from './space.ts'
import { viewOf, type Plane, type Seen } from './views.ts'

type Config = { admin: string; prefix: string; public: string | null }

function parseConfig(raw: TargetConfig): Config {
  const { admin, prefix } = raw
  const origin = raw.public ?? null
  if (typeof admin !== 'string' || typeof prefix !== 'string' || (origin !== null && typeof origin !== 'string')) throw new Error('一台机器上的 PneumaSpace 的配置要写 admin、prefix，可以有 public')
  return { admin, prefix, public: origin }
}

const PLANE: Plane = { requests: '24 小时请求', framed: true, visible: null }

/** What the views get of an app on a machine. `spark` only for a drawn answer. */
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

export const machineTarget = defineTarget({
  kind: 'machine',
  label: '跑在一台机器上的 PneumaSpace',
  params: [
    { name: 'admin', hint: '管理地址', kind: 'value', required: true, pattern: `${ORIGIN}(?:/\\S*)?` },
    PREFIX_PARAM,
    { name: 'public', hint: '站点的公开地址', kind: 'value', pattern: ORIGIN },
  ],
  secrets: [{ name: 'token', description: '一台机器上的 PneumaSpace 不在本地模式时的访问令牌，作为 Bearer 发出', optional: true }],
  // The board is the plugin's page for both kinds; a page is declared once, here, and each kind draws it.
  views: [{ name: 'board', title: '看板', icon: 'layout-grid' }],

  async configure({ admin, prefix, public: origin }) {
    return { ok: true, config: { admin: admin.replace(/\/+$/, ''), prefix, public: origin?.replace(/\/+$/, '') ?? null } }
  },

  open(config, env): Target<Seen> {
    const c = parseConfig(config)
    const space = new Space(c.admin, () => env.secret('token'))
    const owner = ownerOf(env.ctx.library.config.id)
    const urlOf = async (address: string) => (/^https?:\/\//.test(address) ? address : (c.public ?? (await space.ingress())) + address)
    const taken = (site: string, by: string) => new SpaceError(`应用名 ${site} 在 PneumaSpace 上属于 ${by}，不是这个库，所以不动它；换一个前缀，或在 PneumaSpace 上处理那个应用`)

    return {
      key: `pneuma-space:${c.admin}#${c.prefix}`,
      label: `一台机器上的 PneumaSpace ${c.admin}，应用名前缀 ${c.prefix}`,
      siteName: (path) => appName(c.prefix, path),
      identify: async (files) => (await bundleOf(files)).bundle as string as ContentId,

      async publish(site, _dir, meta) {
        const { tar, bundle } = await bundleOf(meta.files)
        if (bundle !== (meta.content as string)) throw new SpaceError(`复制出来的内容和决定发布的不同：${bundle} 不是 ${meta.content}`)
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
