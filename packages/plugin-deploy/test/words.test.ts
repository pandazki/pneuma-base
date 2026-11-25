// A command target's command is split into argv the way a shell splits plain and quoted words,
// then run without a shell.
import { describe, expect, it } from 'vitest'
import { words } from '../src/targets.js'

describe('splitting a configured command into words', () => {
  it('splits on white space and keeps the placeholders as words', () => {
    expect(words('wrangler pages deploy {dir} --project-name {name}')).toEqual(['wrangler', 'pages', 'deploy', '{dir}', '--project-name', '{name}'])
  })

  it('keeps quoted spaces and backslash-escaped characters in one word', () => {
    expect(words(`node "/a b/pub.js" '{dir}' x\\ y ""`)).toEqual(['node', '/a b/pub.js', '{dir}', 'x y', ''])
  })

  it('takes a backslash literally inside single quotes', () => {
    expect(words(`echo 'a\\b' "c\\"d"`)).toEqual(['echo', 'a\\b', 'c"d'])
  })

  it('refuses an unclosed quote and an empty command', () => {
    expect(() => words(`node "pub.js`)).toThrow()
    expect(() => words('   ')).toThrow()
  })
})
