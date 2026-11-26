import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One temporary root per test run, removed afterwards. Test helpers create their folders under it.
 * Code run in a test's own process that reads machine state with no home given (the storage door
 * asking which provider a library uses) reads a temporary one, never the real `~/.pneuma-base`.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'pneuma-base-tests-'))
  process.env.PNEUMA_BASE_TEST_TMP = root
  process.env.PNEUMA_BASE_HOME ??= join(root, 'machine-home')
  return () => rmSync(root, { recursive: true, force: true })
}
