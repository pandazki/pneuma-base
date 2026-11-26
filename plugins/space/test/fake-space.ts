// A PneumaSpace in memory, as the test kit's stand-in for an outside service serves it: the admin API
// calls the plugin makes, with the answers' shapes as the acceptance stack gives them. Apps are served
// in path mode at `/<name>/` on the stand-in's own address.
import { createHash } from 'node:crypto'

type App = { owner: string; status: 'registered' | 'removed'; current: number | null; releases: { number: number; publishedAt: number; bundle: string }[] }

export function fakeSpace(): (request: Request) => Promise<Response> {
  const apps = new Map<string, App>()
  const bundles = new Set<string>()
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  return async (request) => {
    const url = new URL(request.url)
    const [, api, kind, name, action] = url.pathname.split('/')
    if (api !== 'api') return json({ error: 'not found' }, 404)
    const app = name === undefined ? undefined : apps.get(name)
    const route = `${request.method} ${kind}${name === undefined ? '' : '/:name'}${action === undefined ? '' : `/${action}`}`
    switch (route) {
      case 'GET health':
        return json({ ok: true, ingressPort: Number(url.port) })
      case 'GET apps':
        return json([...apps].map(([n, a]) => ({ name: n, address: `/${n}/`, release: a.status === 'registered' ? a.current : null, status: a.status, requests: 0, errors: 0, lastAccessAt: null })))
      case 'GET apps/:name':
        return app === undefined ? json({ error: 'no such app' }, 404) : json({ app: { status: app.status, owner: app.owner, current: app.current, manager: { name: 'pneuma-base', url: null } }, releases: app.releases })
      case 'POST bundles': {
        const bundle = createHash('sha256').update(Buffer.from(await request.arrayBuffer())).digest('hex')
        bundles.add(bundle)
        return json({ bundle })
      }
      case 'PUT apps/:name/release': {
        const { bundle, owner } = (await request.json()) as { bundle: string; owner: string }
        if (!bundles.has(bundle)) return json({ error: 'no such bundle' }, 400)
        const a = app ?? { owner, status: 'registered', current: null, releases: [] }
        const same = a.releases.find((r) => r.number === a.current && r.bundle === bundle)
        const number = same?.number ?? a.releases.length + 1
        if (!same) a.releases.unshift({ number, publishedAt: Date.now(), bundle })
        apps.set(name as string, { ...a, status: 'registered', current: number })
        return json({ number })
      }
      case 'POST apps/:name/remove':
        if (app !== undefined) app.status = 'removed'
        return json({})
      case 'GET usage':
        return json({ buckets: [] })
      default:
        return json({ error: `the stand-in does not answer ${request.method} ${url.pathname}` }, 501)
    }
  }
}
