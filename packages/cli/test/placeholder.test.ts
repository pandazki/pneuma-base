// A file whose content a sync service keeps elsewhere, with only a placeholder on this machine: both
// faces say where the content is and how large, and fetch it when asked, the page with one button.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Action, Block } from '@pneuma-base/sdk'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './helpers.js'

const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const realCore = fileURLToPath(new URL('../../../core/target/release/pneuma-base-core', import.meta.url))

/**
 * A storage program standing in for a sync service over the real one: a file named *.placeholder that
 * has not been fetched carries the placeholder facet, and a read of it without `fetch` answers
 * `elsewhere`; a read with `fetch` is written to `FETCHED`, and the file is here from then on.
 */
const PROXY = `#!/usr/bin/env node
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const real = spawn(process.env.REAL_CORE, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] })
const fetched = () => fs.readFileSync(process.env.FETCHED, 'utf8').split('\\n')
const away = (place) => typeof place === 'string' && place.endsWith('.placeholder') && !fetched().includes(place)
const FACET = { provider: 'icloud', size_elsewhere: 4096 }
const asked = new Map()
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line)
  if (r.op === 'read' && away(r.place)) {
    if (r.fetch !== true) return process.stdout.write(JSON.stringify({ id: r.id, outcome: 'failed', reason: 'elsewhere', size: 4096 }) + '\\n')
    fs.appendFileSync(process.env.FETCHED, r.place + '\\n')
  }
  if (r.op === 'glance') asked.set(r.id, r.places)
  real.stdin.write(line + '\\n')
}).on('close', () => real.stdin.end())
createInterface({ input: real.stdout }).on('line', (line) => {
  const a = JSON.parse(line)
  const places = asked.get(a.id)
  if (places && Array.isArray(a.entries)) {
    asked.delete(a.id)
    a.entries.forEach((e, i) => {
      if (e && e.kind === 'file' && away(places[i])) e.facets = { ...(e.facets || {}), placeholder: FACET }
    })
  }
  if (Array.isArray(a.entries)) for (const e of a.entries) if (e && e.kind === 'file' && away(e.place)) e.facets = { ...(e.facets || {}), placeholder: FACET }
  process.stdout.write(JSON.stringify(a) + '\\n')
})
real.on('exit', (code) => process.exit(code ?? 0))
`

let sb: Sandbox
let fetched: string

const agent = async (args: string[]) => {
  const r = await sb.agent('claude-code', 's1', args)
  expect(r.code, `${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0)
  return r.stdout
}

const blocksIn = (blocks: readonly Block[]): Block[] => blocks.flatMap((b) => (b.kind === 'section' ? [b, ...blocksIn(b.blocks)] : [b]))
const actionsIn = (blocks: readonly Block[]): Action[] => blocksIn(blocks).flatMap((b) => (b.kind === 'actions' ? b.actions : b.kind === 'section' ? b.actions : []))

beforeAll(async () => {
  const dir = tempDir('pb-placeholder-')
  const proxy = join(dir, 'core')
  writeFileSync(proxy, PROXY)
  chmodSync(proxy, 0o755)
  fetched = join(dir, 'fetched.txt')
  writeFileSync(fetched, '')
  sb = await sandbox({ cli, env: { PNEUMA_BASE_CORE: proxy, REAL_CORE: realCore, FETCHED: fetched } })
  for (const name of ['report', 'notes']) {
    const r = await sb.agent('claude-code', 's1', ['put', '-', '--to', `cloud/${name}.placeholder`, '--made'], { input: `the bytes of the ${name}\n` })
    expect(r.code, r.stdout + r.stderr).toBe(0)
  }
})

afterAll(async () => {
  await sb.cleanup()
})

describe('a file with only a placeholder on this machine', () => {
  it('is fetched by the one button of its panel, and its preview is there after', async () => {
    const viewer = await sb.viewer()
    const before = await viewer.item('cloud/report.placeholder')
    if (before.outcome !== 'shown') throw new Error(JSON.stringify(before))
    const fields = blocksIn(before.blocks).flatMap((b) => (b.kind === 'fields' ? b.fields : []))
    expect(fields.find((f) => f.label === '这台机器上')?.value.text).toBe('内容在 iCloud 上，4.0 KB')
    expect(blocksIn(before.blocks).some((b) => b.kind === 'preview')).toBe(false)
    const fetch = actionsIn(before.blocks).filter((a) => a.label === '取回内容')
    expect(fetch).toHaveLength(1)
    expect(readFileSync(fetched, 'utf8')).toBe('')

    const done = await viewer.act(fetch[0] as Action)
    expect(done.tone).toBe('good')
    expect(done.result.content).toMatchObject({ kind: 'text', text: 'the bytes of the report\n' })
    expect(readFileSync(fetched, 'utf8')).toBe('cloud/report.placeholder\n')

    const after = await viewer.item('cloud/report.placeholder')
    if (after.outcome !== 'shown') throw new Error(JSON.stringify(after))
    expect(blocksIn(after.blocks).filter((b) => b.kind === 'preview')).toEqual([{ kind: 'preview', path: 'cloud/report.placeholder' }])
    expect(actionsIn(after.blocks).some((a) => a.label === '取回内容')).toBe(false)
  })

  it('is fetched by inspect --content --fetch, and inspect --content says where it is until then', async () => {
    const elsewhere = await agent(['inspect', 'cloud/notes.placeholder', '--content'])
    expect(elsewhere).toContain('内容在 iCloud 上，4.0 KB。取回来：inspect cloud/notes.placeholder --content --fetch')
    expect(readFileSync(fetched, 'utf8')).not.toContain('cloud/notes.placeholder')

    const got = await agent(['inspect', 'cloud/notes.placeholder', '--content', '--fetch'])
    expect(got).toContain('内容（UTF-8 文字，')
    expect(got).toContain('the bytes of the notes')
    expect(readFileSync(fetched, 'utf8')).toContain('cloud/notes.placeholder\n')
  })

  it('refuses --fetch without --content', async () => {
    const r = await sb.agent('claude-code', 's1', ['inspect', 'cloud/notes.placeholder', '--fetch'])
    expect(r.code).toBe(1)
    expect(r.stderr + r.stdout).toContain('--fetch 跟 --content 一起写')
  })
})
