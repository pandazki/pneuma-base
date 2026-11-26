// Change is learned from storage's cursor, which the kernel keeps per library (tmp/run-7 step 3, item 3).
import { describe, expect, it } from 'vitest'
import { changesSince, learn } from '../src/changes.js'
import { storageOf } from '../src/storage.js'
import { fixture } from './support.js'

/** Asks until a change shows up: the cursor learns of a write once the file system has told it. */
async function until(f: () => Promise<string[] | null>, want: (places: string[] | null) => boolean): Promise<string[] | null> {
  for (let i = 0; ; i++) {
    const places = await f()
    if (want(places) || i > 50) return places
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('the kernel’s cursor', () => {
  it('says it cannot say for an asker with no mark, then names what changed since the mark it handed out', async () => {
    const fx = await fixture()
    const store = storageOf(fx.root)
    const first = await changesSince(store, null)
    expect(first.places).toBeNull()
    let mark = first.mark
    fx.write('notes/a.md', 'a')
    const places = await until(async () => {
      const answer = await changesSince(store, mark)
      mark = answer.mark
      return answer.places
    }, (p) => p !== null && p.some((x) => x.startsWith('notes')))
    expect(places?.some((x) => x === 'notes/a.md' || x === 'notes')).toBe(true)
  })

  it('answers nothing changed while nothing changes', async () => {
    const fx = await fixture()
    const store = storageOf(fx.root)
    let mark = (await changesSince(store, null)).mark
    await until(async () => {
      const answer = await changesSince(store, mark)
      mark = answer.mark
      return answer.places
    }, (p) => p !== null && p.length === 0)
    expect((await changesSince(store, mark)).places).toEqual([])
  })

  it('does not replay a cursor gone stale: an ask after a long quiet says it cannot say', async () => {
    const fx = await fixture()
    const store = storageOf(fx.root)
    await learn(store)
    const later = await learn(store, Date.now() + 11 * 60_000)
    expect(later.sure).toBe(false)
  })

  it('says it cannot say for a mark it never handed out', async () => {
    const fx = await fixture()
    expect((await changesSince(storageOf(fx.root), 'not-a-mark')).places).toBeNull()
  })
})
