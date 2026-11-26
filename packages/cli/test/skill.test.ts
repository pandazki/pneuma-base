// C9: one skill for claude and one for codex, each with the library's location and the grant's
// name, front matter name and description, description at most 1536 characters; and the grant's
// local copy.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

let sb: Sandbox
let lib: string
beforeEach(() => {
  sb = sandbox()
  lib = join(tempDir(), 'lib')
  expect(sb.run(['init', lib]).code).toBe(0)
})

function frontMatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) throw new Error('no front matter')
  return Object.fromEntries((match[1] as string).split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
}

describe('skill install', () => {
  for (const [grant, product, agent] of [['claude', 'claude-code', 'claude'], ['codex', 'codex', 'codex']] as const) {
    it(`writes a skill for ${agent} and the grant's local copy`, () => {
      expect(sb.run(['grant', 'issue', grant, '--library', lib, '--agent', product]).code).toBe(0)
      const target = tempDir('pb-skills-')
      const r = sb.run(['skill', 'install', grant, '--agent', agent, '--dir', target, '--json'])
      expect(r.code, r.stderr).toBe(0)

      const skill = readFileSync(join(target, `pneuma-base-${grant}`, 'SKILL.md'), 'utf8')
      const meta = frontMatter(skill)
      expect(meta.name).toBe(`pneuma-base-${grant}`)
      expect(meta.description?.length).toBeGreaterThan(0)
      expect([...(meta.description ?? '')].length).toBeLessThanOrEqual(1536)
      expect(skill).toContain(`${lib}/PNEUMA-BASE.md`)
      expect(skill).toContain(`${join(sb.home, '.pneuma-base', 'bin', 'pneuma-base')} @${grant} start`)
      expect(skill).not.toContain('{{')

      const local = JSON.parse(readFileSync(join(sb.home, '.pneuma-base', 'grants', `${grant}.json`), 'utf8'))
      const config = JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8'))
      expect(local).toEqual({ name: grant, library: lib, grant: config.grants[0].id })
    })
  }

  it('accepts any agent name, defaults --agent to the grant’s agent, and refuses an unknown grant or missing --dir', () => {
    const target = tempDir('pb-skills-')
    expect(sb.run(['skill', 'install', 'nobody', '--agent', 'claude', '--dir', target]).code).toBe(2)
    sb.run(['grant', 'issue', 'agy', '--library', lib, '--agent', 'antigravity'])
    expect(sb.run(['skill', 'install', 'agy']).code).toBe(1)

    const defaulted = sb.run(['skill', 'install', 'agy', '--dir', target, '--json'])
    expect(defaulted.code, defaulted.stderr).toBe(0)
    expect(defaulted.json().text).toContain('已为 antigravity 写好技能')
    expect(existsSync(join(target, 'pneuma-base-agy', 'SKILL.md'))).toBe(true)

    const custom = tempDir('pb-skills-cursor-')
    const explicit = sb.run(['skill', 'install', 'agy', '--agent', 'cursor', '--dir', custom, '--json'])
    expect(explicit.code, explicit.stderr).toBe(0)
    expect(explicit.json().text).toContain('已为 cursor 写好技能')
    expect(existsSync(join(custom, 'pneuma-base-agy', 'SKILL.md'))).toBe(true)
  })
})

describe('grant revoke', () => {
  it('removes the grant and its local copy; a kept copy of a revoked grant is refused', () => {
    sb.run(['grant', 'issue', 'claude', '--library', lib, '--agent', 'claude-code'])
    const file = join(sb.home, '.pneuma-base', 'grants', 'claude.json')
    const r = sb.run(['grant', 'revoke', 'claude', '--library', lib])
    expect(r.code, r.stderr).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(JSON.parse(readFileSync(join(lib, '.pneuma-base', 'config.json'), 'utf8')).grants).toEqual([])
    expect(sb.run(['@claude', 'find']).stdout).toContain('no-such-grant')

    // A local copy kept past the revocation still names the revoked grant's id.
    sb.run(['grant', 'issue', 'other', '--library', lib, '--agent', 'x'])
    const otherFile = join(sb.home, '.pneuma-base', 'grants', 'other.json')
    const copy = readFileSync(otherFile, 'utf8')
    sb.run(['grant', 'revoke', 'other', '--library', lib])
    writeFileSync(otherFile, copy)
    const stale = sb.run(['@other', 'find'])
    expect(stale.code).toBe(2)
    expect(stale.stdout).toContain('grant-revoked')
  })

  it('refuses a grant that does not exist', () => {
    expect(sb.run(['grant', 'revoke', 'nobody', '--library', lib]).code).toBe(2)
  })
})
