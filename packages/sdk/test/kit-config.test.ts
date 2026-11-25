// The kit's configuration file: read through the plugin's parser, replaced whole, never left half written.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { configFile } from '../src/kit/index.js'

type Target = { to: string; extra?: string[] }
function parse(raw: unknown): Target {
  const to = (raw as { target?: { to?: unknown } } | null)?.target?.to
  if (typeof to !== 'string') throw new Error('没有 to')
  const extra = (raw as { target: { extra?: unknown } }).target.extra
  return Array.isArray(extra) ? { to, extra: extra.map(String) } : { to }
}

let dir: string
let file: string
beforeEach(() => {
  dir = join(mkdtempSync(join(process.env.PNEUMA_BASE_TEST_TMP ?? tmpdir(), 'pb-config-')), 'plugin')
  file = join(dir, 'config.json')
})

describe('the configuration file', () => {
  it('reads as nothing until written', async () => {
    expect(await configFile(file, parse).read()).toBeNull()
  })

  it('is replaced whole: the last write is what is read, and no temporary file stays', async () => {
    const config = configFile<{ format: 1; target: Target }>(file, (raw) => ({ format: 1, target: parse(raw) }))
    await config.write({ format: 1, target: { to: 'a', extra: ['x'] } })
    await config.write({ format: 1, target: { to: 'b' } })
    expect(await config.read()).toEqual({ format: 1, target: { to: 'b' } })
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify({ format: 1, target: { to: 'b' } }, null, 2)}\n`)
    expect(readdirSync(dir)).toEqual(['config.json'])
  })

  it('throws when the file is not JSON or the parser refuses it', async () => {
    const config = configFile(file, parse)
    await configFile(file, (raw) => raw).write({ target: { to: 1 } })
    await expect(config.read()).rejects.toThrow('没有 to')
    writeFileSync(file, '{"target":')
    await expect(config.read()).rejects.toThrow(SyntaxError)
  })
})
