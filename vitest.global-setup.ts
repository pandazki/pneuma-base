import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One temporary root per test run, removed afterwards. Test helpers create their folders under it. */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'pneuma-base-tests-'))
  process.env.PNEUMA_BASE_TEST_TMP = root
  return () => rmSync(root, { recursive: true, force: true })
}
