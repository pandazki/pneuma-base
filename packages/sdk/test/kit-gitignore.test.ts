// What a bundle's `.gitignore` files leave out of what the deploy kit copies, as storage's content
// rule reads them (core/local/src/rule.rs and the `ignore` crate): the cases its own test runs, and
// the forms gitignore files are written in.
import { describe, expect, it } from 'vitest'
import { ignored, ignoreRules, type IgnoreLevel } from '../src/kit/deploy/gitignore.js'

const at = (base: string, text: string): IgnoreLevel => ({ base, rules: ignoreRules(text) })

describe('the ignore files of a bundle', () => {
  it('lets the nearest ignore file that has a say decide, as storage does', () => {
    const top = at('', '*.log\nbuild/\n')
    const keep = at('keep', '!important.log\n')
    expect(ignored([top], 'a.log', false)).toBe(true)
    expect(ignored([top], 'build', true)).toBe(true)
    expect(ignored([top], 'build', false)).toBe(false)
    expect(ignored([top, keep], 'keep/important.log', false)).toBe(false)
    expect(ignored([top, keep], 'keep/other.log', false)).toBe(true)
    expect(ignored([top, keep], 'keep/notes.md', false)).toBe(false)
  })

  it.each([
    ['a name matches at any depth', 'secret.env', 'deep/in/secret.env', false, true],
    ['a leading slash anchors it to the file’s directory', '/out', 'sub/out', false, false],
    ['a leading slash matches at the top', '/out', 'out', true, true],
    ['a slash inside anchors it', 'docs/draft.md', 'docs/draft.md', false, true],
    ['a slash inside does not match deeper', 'docs/draft.md', 'x/docs/draft.md', false, false],
    ['a star stays in one segment', 'a/*.js', 'a/b/c.js', false, false],
    ['a leading double star matches any depth', '**/cache', 'x/y/cache', true, true],
    ['a middle double star matches no directory or many', 'a/**/b', 'a/b', false, true],
    ['a middle double star matches many', 'a/**/b', 'a/x/y/b', false, true],
    ['a trailing double star matches what is inside', 'dist/**', 'dist/a/b.js', false, true],
    ['a trailing double star does not match the directory', 'dist/**', 'dist', true, false],
    ['a question mark is one character', 'v?.txt', 'v1.txt', false, true],
    ['a class matches its characters', '[ab].txt', 'b.txt', false, true],
    ['a negated class', '[!ab].txt', 'c.txt', false, true],
    ['an escaped hash is a name', '\\#notes', '#notes', false, true],
    ['a comment matches nothing', '#notes', '#notes', false, false],
    ['a trailing space is trimmed', 'a.txt   ', 'a.txt', false, true],
    ['a later negation keeps it', '*.env\n!local.env', 'local.env', false, false],
    ['a later line wins over a negation', '!local.env\n*.env', 'local.env', false, true],
    ['dots are literal', 'a.b', 'axb', false, false],
  ] as const)('%s', (_what, text, path, isDir, expected) => {
    expect(ignored([at('', text)], path, isDir)).toBe(expected)
  })
})
