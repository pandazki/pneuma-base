// Whoever stays listens; whoever runs once asks with a small budget (tmp/run-7 step 3b).
import { describe, expect, it } from 'vitest'
import { changesSince } from '../src/changes.js'
import { storageOf } from '../src/storage.js'
import { fixture } from './support.js'

/** Asks until `want` holds of what comes back: the listener hears of a write once the file system has told it. */
async function until(f: () => Promise<string[] | null>, want: (places: string[] | null) => boolean): Promise<string[] | null> {
  for (let i = 0; ; i++) {
    const places = await f()
    if (want(places) || i > 100) return places
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('learning what changed', () => {
  it('cannot say within the budget while nobody listens: the asker compares instead', async () => {
    const fx = await fixture()
    const store = storageOf(fx.root)
    const { mark } = await changesSince(store, null)
    fx.write('notes/a.md', 'a')
    expect((await changesSince(store, mark)).places).toBeNull()
  })

  it('says it cannot say for a mark it never handed out', async () => {
    const fx = await fixture()
    expect((await changesSince(storageOf(fx.root), 'not-a-mark')).places).toBeNull()
  })

  // Listening needs a change journal, which only the macOS provider has.
  it.runIf(process.platform === 'darwin')('names what changed since a mark while this process listens, and cannot say once it stops', async () => {
    const fx = await fixture()
    const store = storageOf(fx.root)
    store.listen()
    try {
      let mark = (await changesSince(store, null)).mark
      const ask = async () => {
        const answer = await changesSince(store, mark)
        mark = answer.mark
        return answer.places
      }
      // Live, and past what init wrote, which the system may number after the first mark.
      expect(await until(ask, (p) => p !== null && p.length === 0)).toEqual([])
      fx.write('notes/a.md', 'a')
      const places = await until(ask, (p) => p !== null && p.length > 0)
      expect(places).toContain('notes/a.md')
      expect(await ask()).toEqual([])
    } finally {
      store.unlisten()
    }
    const { mark } = await changesSince(store, null)
    expect(await until(() => changesSince(store, mark).then((a) => a.places), (p) => p === null)).toBeNull()
  })
})
