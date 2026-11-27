// A command target's command is split into argv the way a shell splits plain and quoted words,
// then run without a shell.
import { describe, expect, it } from 'vitest'
import { words } from '../src/targets.js'

describe('splitting a configured command into words', () => {
  it('splits on white space, keeps placeholders, quoted spaces and backslash-escaped characters in one word, and takes a backslash literally inside single quotes', () => {
    const cases: [string, string[]][] = [
      ['wrangler pages deploy {dir} --project-name {name}', ['wrangler', 'pages', 'deploy', '{dir}', '--project-name', '{name}']],
      [`node "/a b/pub.js" '{dir}' x\\ y ""`, ['node', '/a b/pub.js', '{dir}', 'x y', '']],
      [`echo 'a\\b' "c\\"d"`, ['echo', 'a\\b', 'c"d']],
    ]
    expect(cases.map(([command]) => words(command))).toEqual(cases.map(([, argv]) => argv))
  })

  it('refuses an unclosed quote and an empty command', () => {
    expect(() => words(`node "pub.js`)).toThrow()
    expect(() => words('   ')).toThrow()
  })
})
