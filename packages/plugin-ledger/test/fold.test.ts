// The fold into rows is a function of the facts: the ledger rows "each item has exactly one enter" and
// "the view is decided by the files and the facts alone", and ARCHITECTURE.md「存放和行」.
import { describe, expect, it } from 'vitest'
import { conversationOf } from '../src/conversation.js'
import type { SceneRow } from '../src/model.js'
import { sceneText, sceneView } from '../src/views.js'
import { at, basis, codex, enter, f, folded, fp, id, p } from './support.js'

const lookupOf = (rows: Awaited<ReturnType<typeof folded>>) => ({ items: rows.all('items') as never, scenes: rows.all('scenes') as never })

describe('fold', () => {
  it('gives the same rows whatever order the facts come in', async () => {
    const facts = [
      f(1, enter('i_s', 's.md', 's')),
      f(2, enter('i_a', 'a.md', 'a', { kind: 'made', basis: basis([['i_s', 's']]) })),
      f(3, { kind: 'item.move', item: id('i_a'), from: p('a.md'), to: p('b.md'), archive: null }),
      f(4, { kind: 'item.revise', item: id('i_a'), base: fp('a'), fingerprint: fp('a2'), size: 2, held: null, claimed: false }),
      f(5, { kind: 'said', flavor: 'note', text: 'n', about: id('i_a') }),
    ]
    const forward = await folded(facts)
    const backward = await folded([...facts].reverse())
    for (const table of ['items', 'paths', 'history', 'log', 'scenes', 'marks']) expect(backward.all(table)).toEqual(forward.all(table))
  })

  it('takes the current path from the latest enter or move, and the fingerprint from the latest enter or revise', async () => {
    const rows = await folded([
      f(1, enter('i_a', 'a.md', 'a')),
      f(2, { kind: 'item.move', item: id('i_a'), from: p('a.md'), to: p('d/a.md'), archive: null }),
      f(3, { kind: 'item.revise', item: id('i_a'), base: fp('a'), fingerprint: fp('b'), size: 1, held: null, claimed: true }),
    ])
    expect(rows.item('i_a')).toMatchObject({ path: 'd/a.md', fingerprint: fp('b') })
    expect(rows.all('paths')).toEqual(new Map([['d/a.md', { id: 'i_a' }]]))
    expect(rows.versions('i_a').map((v) => [v.fingerprint, v.claimed])).toEqual([[fp('a'), false], [fp('b'), true]])
  })

  it('makes a later enter of a path an item holds an alias, so the item has one enter and every fact lands on it; never onto an item that moved away or was removed', async () => {
    const rows = await folded([
      f(1, enter('i_one', 'shared.md', 's', { kind: 'adopted' })),
      f(2, enter('i_two', 'shared.md', 's', { kind: 'adopted' }), { scene: 's2', actor: codex }),
      f(3, enter('i_b', 'b.md', 'b', { kind: 'made', basis: basis([['i_two', 's']]) }), { scene: 's2', actor: codex }),
      f(4, { kind: 'said', flavor: 'note', text: 'about the alias', about: id('i_two') }),
    ])
    expect(rows.items().map((i) => i.id)).toEqual(['i_b', 'i_one'])
    expect(rows.item('i_b')?.basis.items[0]?.item).toBe('i_one')
    expect(rows.history('i_one').flatMap((h) => (h.kind === 'said' ? [h.text] : []))).toEqual(['about the alias'])

    const gone = await folded([
      f(1, enter('i_a', 'a.md', 'a')),
      f(2, { kind: 'item.move', item: id('i_a'), from: p('a.md'), to: p('b.md'), archive: null }),
      f(3, enter('i_c', 'a.md', 'c')),
      f(4, enter('i_d', 'd.md', 'd')),
      f(5, { kind: 'item.remove', item: id('i_d') }),
      f(6, enter('i_e', 'd.md', 'e')),
    ])
    expect(gone.items().map((i) => i.id)).toEqual(['i_a', 'i_c', 'i_d', 'i_e'])
    expect(gone.path('a.md')).toBe('i_c')
    expect(gone.path('d.md')).toBe('i_e')
    expect(gone.item('i_d')?.removed).toBe(true)
  })

  it('lets an alias that knows the origin fill in an adopted item, and item.basis too', async () => {
    const brought = await folded([f(1, enter('i_a', 'a.md', 'a', { kind: 'adopted' })), f(2, enter('i_x', 'a.md', 'a', { kind: 'brought', source: 'https://x', by: null }))])
    expect(brought.item('i_a')).toMatchObject({ unknownOrigin: false, origin: { kind: 'brought', source: 'https://x' } })
    const based = await folded([f(1, enter('i_a', 'a.md', 'a', { kind: 'adopted' })), f(2, { kind: 'item.basis', item: id('i_a'), fingerprint: fp('a'), basis: basis([['i_s', 's']]) })])
    expect(based.item('i_a')).toMatchObject({ unknownOrigin: false, basis: basis([['i_s', 's']]) })
  })

  it('puts a put’s note on the content that put recorded; an alias giving an adopted item its origin notes the content it registered', async () => {
    const rows = await folded([
      f(1, { ...enter('i_a', 'a.md', 'a'), note: '初稿' }),
      f(2, { kind: 'item.revise', item: id('i_a'), base: fp('a'), fingerprint: fp('b'), size: 1, held: null, claimed: false, note: '重算' }),
      f(3, enter('i_d', 'd.md', 'd', { kind: 'adopted' })),
      f(4, { ...enter('i_x', 'd.md', 'd'), note: '主人给的' }),
    ])
    expect(rows.versions('i_a').map((v) => v.note)).toEqual(['初稿', '重算'])
    expect(rows.versions('i_d').map((v) => v.note)).toEqual(['主人给的'])
  })

  it('keeps the basis across a revise, replacing the rows of the sources it names; item.basis replaces it all', async () => {
    const start = [
      f(1, enter('i_a', 'a.md', 'a', { kind: 'made', basis: basis([['i_s', 's'], ['i_t', 't']], ['said']) })),
      f(2, { kind: 'item.revise', item: id('i_a'), base: fp('a'), fingerprint: fp('a2'), size: 1, basis: basis([['i_t', 't2'], ['i_u', 'u']]), held: null, claimed: false }),
    ]
    expect((await folded(start)).item('i_a')?.basis).toEqual(basis([['i_s', 's'], ['i_t', 't2'], ['i_u', 'u']], ['said']))
    const replaced = await folded([...start, f(3, { kind: 'item.basis', item: id('i_a'), fingerprint: fp('a2'), basis: basis([['i_v', 'v']]) })])
    expect(replaced.item('i_a')?.basis).toEqual(basis([['i_v', 'v']]))
  })

  it('keeps on each source the things made from it, as their bases change', async () => {
    const rows = await folded([
      f(1, enter('i_s', 's.md', 's')),
      f(2, enter('i_t', 't.md', 't')),
      f(3, enter('i_a', 'a.md', 'a', { kind: 'made', basis: basis([['i_s', 's']]) })),
      f(4, { kind: 'item.basis', item: id('i_a'), fingerprint: fp('a'), basis: basis([['i_t', 't']]) }),
    ])
    expect(rows.item('i_s')?.dependents).toEqual([])
    expect(rows.item('i_t')?.dependents).toEqual(['i_a'])
  })

  it('derives the items under a bundle entered later as absorbed into it; they follow its moves and its removal', async () => {
    const bundle = (item: string, path: string) => ({ ...enter(item, path, path), bundle: true as const })
    const facts = [
      f(1, enter('i_a', 'notes/a.md', 'a')),
      f(2, enter('i_deep', 'notes/x/b.md', 'b')),
      f(3, enter('i_beside', 'notes-old.md', 'c')),
      f(4, bundle('i_notes', 'notes')),
      f(5, enter('i_later', 'other/c.md', 'c')),
    ]
    const rows = await folded(facts)
    expect(Object.fromEntries(rows.items().map((item) => [item.id, item.absorbedInto]))).toEqual({ i_a: 'i_notes', i_deep: 'i_notes', i_beside: null, i_notes: null, i_later: null })
    expect(rows.item('i_notes')?.bundle).toBe(true)
    expect(rows.path('notes/a.md')).toBe('i_a')
    // A bundle is one thing: the directories inside it are no open directories.
    expect([...rows.all('dirs').keys()]).toEqual(['other'])

    const archived = await folded([...facts, f(6, { kind: 'item.move', item: id('i_notes'), from: p('notes'), to: p('_archive/notes'), archive: 'in' })])
    expect(archived.item('i_deep')?.path).toBe('_archive/notes/x/b.md')
    expect(archived.path('_archive/notes/x/b.md')).toBe('i_deep')
    expect(archived.path('notes/x/b.md')).toBeUndefined()

    const purged = await folded([...facts, f(6, { kind: 'item.remove', item: id('i_notes') })])
    expect(purged.items().filter((item) => item.removed).map((item) => item.id)).toEqual(['i_a', 'i_deep', 'i_notes'])
  })

  it('gathers each scene: actors, directories, what was said, the items it touched', async () => {
    const rows = await folded([
      f(1, { kind: 'said', flavor: 'doing', text: '选支付服务', about: null }),
      f(2, enter('i_a', 'a.md', 'a')),
      f(3, { kind: 'said', flavor: 'decided', text: '用 Paddle', about: null }),
    ])
    expect(rows.scene('s1')).toMatchObject({ first: at(1), actors: [{ name: 'claude-code' }], cwds: ['/work'], items: ['i_a'], puts: 1, decided: 1, lastDecided: '用 Paddle' })
    expect(rows.scene('s1')?.said.map((s) => s.text)).toEqual(['选支付服务', '用 Paddle'])
  })
})

describe('a scene seen by one agent with and without a grant', () => {
  it('names the agent once in its heading and card', async () => {
    const viaGrant = { kind: 'agent' as const, name: 'claude-code', grant: 'g-1' }
    const rows = await folded([f(1, enter('i_a', 'a.md', 'a')), f(2, enter('i_b', 'b.md', 'b'), { actor: viaGrant }), f(3, enter('i_c', 'c.md', 'c'), { actor: codex })])
    const scene = rows.scene('s1') as SceneRow
    expect(scene.actors).toHaveLength(3)
    expect(sceneText(sceneView(lookupOf(rows), scene, null)).split('\n')[1]).toMatch(/^claude-code、codex · /)
  })
})

describe('the conversation a scene came from', () => {
  it('keeps the last pointer the scene’s facts carry, and resumes it only where it was recorded', async () => {
    const pointing = (fact: ReturnType<typeof f>, path: string, machine: string) => ({ ...fact, where: { ...fact.where, machine, transcript: { path, resume: 'claude --resume s1' } } })
    const rows = await folded([f(1, enter('i_a', 'a.md', 'a')), pointing(f(2, enter('i_b', 'b.md', 'b')), '~/old.jsonl', 'mac-a'), pointing(f(3, enter('i_c', 'c.md', 'c')), '~/s1.jsonl', 'mac-a')])
    const scene = rows.scene('s1') as SceneRow
    expect(scene.transcript).toEqual({ path: '~/s1.jsonl', resume: 'claude --resume s1', machine: 'mac-a' })
    const conversation = conversationOf(scene, 'mac-b')
    expect(conversation).toEqual({ path: '~/s1.jsonl', resume: 'claude --resume s1', machine: 'mac-a', status: 'elsewhere' })
    const text = sceneText(sceneView(lookupOf(rows), scene, conversation))
    expect(text).toContain('对话：~/s1.jsonl（在 mac-a 上，不是这台机器）')
    expect(text).not.toContain('接着聊')
  })
})

describe('what was seen and what was said', () => {
  const owner = { kind: 'owner' as const, name: 'owner', grant: null }
  const seen = (fact: ReturnType<typeof f>) => ({ ...fact, how: 'observed' as const })
  const claim = (second: number, print: string, how: 'observed' | 'reported') => ({
    ...f(second, { kind: 'item.revise', item: id('i_a'), base: fp('a'), fingerprint: fp(print), size: 1, held: null, claimed: true }, how === 'observed' ? { actor: owner } : {}),
    how,
  })

  it('replaces an origin only seen with one said, keeping the seen one, and never the other way round', async () => {
    const said = await folded([seen(f(1, enter('i_a', 'a.md', 'a', { kind: 'brought', source: null, by: 'owner' }), { actor: owner })), f(2, enter('i_x', 'a.md', 'a', { kind: 'made', basis: basis([]) }))])
    expect(said.item('i_a')).toMatchObject({ origin: { kind: 'made' }, entered: { at: at(2) }, earlier: [{ at: at(1), how: 'observed' }] })
    const kept = await folded([f(1, enter('i_a', 'a.md', 'a')), seen(f(2, enter('i_x', 'a.md', 'a', { kind: 'brought', source: null, by: 'owner' }), { actor: owner }))])
    expect(kept.item('i_a')).toMatchObject({ origin: { kind: 'brought', by: null }, entered: { at: at(1) }, earlier: [] })
  })

  it('replaces a change only seen with the claim said for the same content, and keeps a claim said against a later sighting', async () => {
    const replaced = await folded([f(1, enter('i_a', 'a.md', 'a')), claim(2, 'b', 'observed'), claim(3, 'b', 'reported')])
    expect(replaced.versions('i_a')).toMatchObject([{ fingerprint: fp('a') }, { fingerprint: fp('b'), how: 'reported', seen: { actor: owner } }])
    const kept = await folded([f(1, enter('i_a', 'a.md', 'a')), claim(2, 'b', 'reported'), claim(3, 'b', 'observed')])
    expect(kept.versions('i_a')).toMatchObject([{ fingerprint: fp('a') }, { fingerprint: fp('b'), how: 'reported', seen: null }])
  })
})

describe('a thing known by its token', () => {
  it('counts a revise with another token as a new version, and one with the same token as the same, when no fingerprint is known', async () => {
    const tokenEnter = { ...enter('i_a', 'a.md', 'a'), fingerprint: null, token: 't1' }
    const revise = (second: number, token: string) => f(second, { kind: 'item.revise', item: id('i_a'), base: null, fingerprint: null, size: 1, token, held: null, claimed: true })
    const rows = await folded([f(1, tokenEnter), revise(2, 't1'), revise(3, 't2')])
    expect(rows.versions('i_a').map((v) => v.token)).toEqual(['t1', 't2'])
    expect(rows.item('i_a')).toMatchObject({ token: 't2', fingerprint: null })
  })
})
