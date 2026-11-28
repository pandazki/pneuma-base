// The usages the ledger's cognition section lists in its table are heard. Its shell examples run in
// description-commands.test.ts, over the assembled description.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sandbox, tempDir } from './helpers.js'

const SECTION = readFileSync(fileURLToPath(new URL('../../plugin-ledger/cognition/2-ledger-section.md', import.meta.url)), 'utf8')

describe('the ledger cognition section', () => {
  it('the usages in its table are heard', () => {
    for (const template of ['`say note "<一句话>"`', '`say note <库内路径> "<备注>"`', '`say basis <库内路径> --from <库内路径…>`', '`put <库内路径> --imported …`', '`say revised <库内路径>`']) {
      expect(SECTION).toContain(template)
    }
    const sb = sandbox()
    const lib = join(tempDir(), 'lib')
    expect(sb.run(['init', lib]).code).toBe(0)
    const run = (args: string[], input?: string) => sb.run(['--library', lib, '--as', 'claude-code', '--session', 's', ...args], { ...(input === undefined ? {} : { input }) })
    expect(run(['put', '-', '--to', 'notes/a.md', '--generated'], 'a').code).toBe(0)
    expect(run(['put', '-', '--to', 'notes/b.md', '--imported'], 'b').code).toBe(0)
    mkdirSync(join(lib, 'inbox'))
    writeFileSync(join(lib, 'inbox/dropped.md'), 'dropped')
    for (const args of [
      ['say', 'note', '一句备注'],
      ['say', 'note', 'notes/a.md', '给 a 的备注'],
      ['say', 'basis', 'notes/a.md', '--from', 'notes/b.md'],
      ['put', 'inbox/dropped.md', '--imported', '--by', 'owner'],
    ]) {
      const r = run([...args, '--json'])
      expect(r.code, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
      expect(r.json().outcome, args.join(' ')).toMatch(/heard|accepted/)
    }
    writeFileSync(join(lib, 'notes/a.md'), 'a, edited by hand')
    expect(run(['say', 'revised', 'notes/a.md', '--json']).json()).toMatchObject({ outcome: 'heard', by: 'ledger' })
  })
})
