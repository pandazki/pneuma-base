// The PneumaSpace the tests publish to: the acceptance stack unless SPACE_ADMIN names another. Every
// app a test publishes is named `pbs-…`, under a prefix of its own, and is removed and purged after.
import { randomBytes } from 'node:crypto'

export const ADMIN = process.env.SPACE_ADMIN ?? 'http://127.0.0.1:18081'
const MANAGER = { 'x-pneuma-space-manager': 'pneuma-base' }

/** Why the stack cannot be used, for a test's skip message; null when it answers. */
export async function unreachable(): Promise<string | null> {
  try {
    const r = await fetch(`${ADMIN}/api/health`, { signal: AbortSignal.timeout(3000) })
    return r.ok ? null : `PneumaSpace ${ADMIN} 答复 ${r.status}`
  } catch (error) {
    return `PneumaSpace ${ADMIN} 不答复（${error instanceof Error ? error.message : String(error)}）；先起验收栈`
  }
}

/** A prefix no other test run uses: `pbs-` and four letters. */
export const freshPrefix = () => `pbs-${randomBytes(3).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!).slice(0, 4)}`

export async function api(method: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(ADMIN + path, { method, headers: MANAGER, signal: AbortSignal.timeout(10_000) })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

/** Removes, then purges, every app whose name starts with `<prefix>-`. */
export async function purge(prefix: string): Promise<void> {
  const apps: { name: string }[] = (await api('GET', '/api/apps')).body
  for (const { name } of apps.filter((a) => a.name.startsWith(`${prefix}-`))) {
    await api('POST', `/api/apps/${name}/remove`)
    await api('POST', `/api/apps/${name}/purge`)
  }
}
