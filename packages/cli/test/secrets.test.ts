// C9 on the command line: the owner sets a plugin's credential from standard input, never from the
// arguments. Where it is kept, that the plugin reads it, that it is refused to agents, listed by name
// only and never in the library are the kernel's (packages/kernel/test/secrets.test.ts).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VAULT, writePlugin } from './fixtures/machine-plugins.js'
import { sandbox } from './helpers.js'

const TOKEN = 'tok-9f2a-never-synced'

describe('secret set', () => {
  it('takes the value from standard input, without a library, and never from the arguments', () => {
    const sb = sandbox()
    const home = join(sb.home, '.pneuma-base')
    writePlugin(join(home, 'plugins', 'vault'), VAULT)

    const fromArgs = sb.run(['secret', 'set', 'vault', 'token', TOKEN])
    expect(fromArgs.code).toBe(1)
    expect(fromArgs.stderr).toContain('多了参数')
    expect(existsSync(join(home, 'secrets'))).toBe(false)

    const r = sb.run(['secret', 'set', 'vault', 'token', '--json'], { input: `${TOKEN}\n` })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).not.toContain(TOKEN)
    expect(readFileSync(join(home, 'secrets', 'vault', 'token'), 'utf8')).toBe(TOKEN)
  })
})
