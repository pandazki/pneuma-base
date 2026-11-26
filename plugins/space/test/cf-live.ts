// The owner's PneumaSpace on Cloudflare, as the live test checks it: a session of the owner's account
// from the credentials file PNEUMA_SPACE_CF_CREDENTIALS names, signed out at the end. Of the apps in
// the space it reads, removes and purges only its own: named under the test's `pbs-…` prefix and
// managed by pneuma-base. It browses their addresses as a signed-in browser does. It prints nothing:
// not the key, not the cookie.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

export const CREDENTIALS = process.env.PNEUMA_SPACE_CF_CREDENTIALS ?? null

/** Why the live test cannot run, for its skip message; null when it can. */
export async function unavailable(): Promise<string | null> {
  if (CREDENTIALS === null) return '没设 PNEUMA_SPACE_CF_CREDENTIALS：要跑 Cloudflare 上的真实生命周期测试，把它设成 PneumaSpace 的凭据文件的路径'
  try {
    const c = JSON.parse(await readFile(CREDENTIALS, 'utf8'))
    return typeof c.origin === 'string' && typeof c.account === 'string' && typeof c.key === 'string' ? null : `${CREDENTIALS} 里没有 origin、account、key`
  } catch {
    return `读不了 ${CREDENTIALS}，或它不是 JSON`
  }
}

/** A prefix no other run uses: `pbs-` and four letters. */
export const freshPrefix = () => `pbs-${randomBytes(3).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!).slice(0, 4)}`

type App = { id: string; name: string; url: string; status: string; manager: { name: string } | null }

/** The rule for what the test may touch: its own prefix, and managed by pneuma-base. */
const own = (a: App, prefix: string) => a.name.startsWith(`${prefix}-`) && a.manager?.name === 'pneuma-base'

export async function owner() {
  const c = JSON.parse(await readFile(CREDENTIALS as string, 'utf8')) as { origin: string; account: string; key: string; tenantId?: string }
  const origin = new URL(c.origin).origin
  let cookie = ''
  let csrf = ''
  async function api(path: string, body?: unknown): Promise<any> {
    const r = await fetch(`${origin}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-pneuma-space-manager': 'pneuma-base', ...(cookie ? { cookie, 'x-pneuma-space-csrf': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await r.text()
    const value = text ? JSON.parse(text) : null
    if (!r.ok) throw new Error(`${path}：${r.status} ${value?.error?.code ?? ''}`)
    if (path === '/auth/login') cookie = r.headers.get('set-cookie')?.split(';')[0] ?? ''
    return value
  }
  const me = await api('/auth/login', { account: c.account, key: c.key })
  csrf = me.csrf
  const tenant: string = me.tenants.find((t: { id: string }) => t.id === c.tenantId)?.id ?? me.tenants[0].id
  const apps = async (): Promise<App[]> => (await api(`/tenants/${tenant}/apps`)).items
  const pbs = async (prefix: string) => (await apps()).filter((a) => own(a, prefix))

  return {
    origin,
    /** The names of every app in the space. */
    names: async () => (await apps()).map((a) => a.name),
    /** The detail of the test's own app `name` under `prefix`. */
    async detail(prefix: string, name: string): Promise<any> {
      const app = (await pbs(prefix)).find((a) => a.name === name)
      if (app === undefined) throw new Error(`no app ${name} of this test`)
      return api(`/apps/${app.id}`)
    },
    /** Upload tickets the test's own app `name` under `prefix` has used. */
    async tickets(prefix: string, name: string): Promise<number> {
      const app = (await pbs(prefix)).find((a) => a.name === name)
      if (app === undefined) throw new Error(`no app ${name} of this test`)
      return (await api(`/apps/${app.id}/state`)).artifacts.uploads
    },
    /** GET of an address as a browser signed in to this PneumaSpace: the status, the error code or the text. */
    async browse(url: string): Promise<string> {
      const r = await fetch(url, { headers: { cookie, accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
      const text = (await r.text()).trim()
      return r.ok ? `${r.status} ${text}` : `${r.status} ${(/"code":"([a-z_]+)"/.exec(text) ?? [])[1] ?? ''}`.trim()
    },
    /** Removes and purges every app of the test under `prefix`, then waits until the space no longer lists them; answers the names it purged. */
    async purge(prefix: string): Promise<string[]> {
      const mine = await pbs(prefix)
      for (const app of mine) {
        if (app.status !== 'removed' && app.status !== 'purging') await api(`/apps/${app.id}/actions`, { type: 'remove' })
        if (app.status !== 'purging') await api(`/apps/${app.id}/actions`, { type: 'purge', confirmation: app.name })
      }
      // A purge waits for the app's last upload ticket to expire, three minutes after it was given.
      const deadline = Date.now() + 300_000
      while ((await pbs(prefix)).length > 0 && Date.now() < deadline) await sleep(15_000)
      return mine.map((a) => a.name)
    },
    close: () => api('/auth/logout', {}),
  }
}
