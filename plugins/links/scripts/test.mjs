import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The SDK creates its sandboxes under os.tmpdir(). Keep even a plain npm test local.
const root = resolve('.local')
const temp = join(root, 'tmp')
const home = join(root, 'home')
const pneumaHome = join(root, 'pneuma-home')
for (const dir of [temp, home, pneumaHome]) mkdirSync(dir, { recursive: true })

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'test/*.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, HOME: home, PNEUMA_BASE_HOME: pneumaHome, TMPDIR: temp, TMP: temp, TEMP: temp },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
