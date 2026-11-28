import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One temporary root per test run, removed afterwards. Test helpers create their folders under it.
 * Code run in a test's own process that reads machine state with no home given (the storage door
 * asking which provider a library uses, the deploy plugin looking for a PneumaSpace installed from
 * this machine) reads a temporary one, never the real `~/.pneuma-base` or the user's home.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'pneuma-base-tests-'))
  process.env.PNEUMA_BASE_TEST_TMP = root
  process.env.PNEUMA_BASE_HOME ??= join(root, 'machine-home')
  // The registry's cache stays where it was, so the slow tests do not download everything again.
  process.env.npm_config_cache ??= join(homedir(), '.npm')
  process.env.HOME = join(root, 'user-home')
  mkdirSync(process.env.HOME)
  return () => rmSync(root, { recursive: true, force: true })
}
