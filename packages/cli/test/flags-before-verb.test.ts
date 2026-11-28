// An agent sometimes writes a verb's flag before the verb. The command line has always taken that.
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sandbox, tempDir } from './helpers.js'

it('a verb’s own flags may come before the verb', () => {
  const sb = sandbox()
  const lib = join(tempDir(), 'lib')
  const as = (args: string[], input?: string) => sb.run(['--library', lib, '--as', 'codex', '--session', 's1', ...args], input === undefined ? {} : { input })
  expect(sb.run(['init', lib]).code).toBe(0)
  const put = as(['--to', 'notes/a.md', '--generated', 'put', '-'], 'hello\n')
  expect(put.code, put.stderr).toBe(0)
  expect(as(['archive', 'notes/a.md']).code).toBe(0)
  const found = as(['--include-archived', 'find', 'a.md'])
  expect(found.code, found.stderr).toBe(0)
  expect(found.stdout).toContain('_archive/notes/a.md')
})
