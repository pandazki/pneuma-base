import assert from 'node:assert/strict'
import test from 'node:test'
import { extractFileLinks, isDocumentPath } from '../src/links.js'

test('Markdown reports each link or image at its use, including resolved reference links', () => {
  const source = [
    '[one][work] and ![two][WORK]',
    '[spaced](<a b.pdf>) and [brackets](folder/a(b).md "title")',
    '',
    '[work]: ../a%20b.md?preview=1#heading',
    '[unused]: unused.md',
    '',
    '> <aside>',
    '>   <img src="missing&amp;name.png">',
    '> </aside>',
  ].join('\n')
  const links = extractFileLinks('notes/a.MARKDOWN', source)
  assert.deepEqual(links.map(({ line, column, href, target }) => [line, column, href, target]), [
    [1, 1, '../a%20b.md?preview=1#heading', 'a b.md'],
    [1, 17, '../a%20b.md?preview=1#heading', 'a b.md'],
    [2, 1, 'a b.pdf', 'notes/a b.pdf'],
    [2, 25, 'folder/a(b).md', 'notes/folder/a(b).md'],
    [8, 10, 'missing&name.png', 'notes/missing&name.png'],
  ])
})

test('Markdown code, comments, external URLs, directories, self and above-root paths are omitted', () => {
  const source = [
    '[self](./page.md#section) [dir](docs/) [up](..) [root](/root.md) [other](//example.com)',
    '[anchor](#frag) [query](?p=1) [mail](mailto:hi@example.org) [remote](https://example.org/a)',
    '[escape](%2e%2e/%2e%2e/outside) [encoded slash](a%2fb) [encoded NUL](a%00b)',
    '`[in code](missing)`',
    '<!-- <img src="ignored"> -->',
    '```html',
    '<img src="ignored">',
    '```',
    '',
    '    [indented code](ignored)',
    '',
    '[hash](../a%23b%3F.txt?q#top) [bare percent](100%.md)',
  ].join('\n')
  assert.deepEqual(extractFileLinks('notes/page.md', source).map(link => link.target), ['a#b?.txt', 'notes/100%.md'])
})

test('HTML handles resource URLs, entity escapes, srcset, templates and SVG in source order', () => {
  const source = [
    '<BASE href="../assets/">',
    '<link href=layout.css>',
    '<script>let example = \'<img src="in-script">\';</script>',
    '<!-- <a href="comment"> -->',
    '<A HREF="page&amp;two.htm#hello">page</A>',
    '<template><img srcset="data:image/png,abc 1x, thumb.png 2x, big.png 3x"></template>',
    '<svg><use xlink:href="icons.svg#heart"/></svg>',
    '<video poster="cover.png"><source src="clip.mp4"></video>',
    '<object data="guide.pdf"></object><form action="save"></form>',
    '<div constructor __proto__ href="plain-attribute"></div>',
  ].join('\n')
  const links = extractFileLinks('docs/guide/page.HTM', source)
  assert.deepEqual(links.map(link => link.target), [
    'docs/assets/layout.css', 'docs/assets/page&two.htm', 'docs/assets/thumb.png', 'docs/assets/big.png',
    'docs/assets/icons.svg', 'docs/assets/cover.png', 'docs/assets/clip.mp4', 'docs/assets/guide.pdf', 'docs/assets/save',
  ])
  assert.equal(links[1].line, 5)
  assert.equal(links[1].column, 4)
})

test('a base outside the library excludes relative HTML links', () => {
  for (const base of ['https://example.org/docs/', '//example.org/', '../../outside/']) {
    assert.deepEqual(extractFileLinks('notes/index.html', `<a href="x">x</a><base href="${base}">`), [])
  }
  assert.deepEqual(
    extractFileLinks('notes/index.html', '<base href="guide/index.html"><base href="other/"><a href="x">').map(link => link.target),
    ['notes/guide/x'],
  )
})

test('empty, fragment-only and query-only references can refer to another base file', () => {
  const anchors = '<a href="#chapter">section</a><a href="?q=1">query</a><a href="">empty</a>'
  const source = '<base href="../missing.html?preview#top">' + anchors
  assert.deepEqual(extractFileLinks('notes/page.html', source).map(link => [link.href, link.target]), [
    ['#chapter', 'missing.html'], ['?q=1', 'missing.html'], ['', 'missing.html'],
  ])
  assert.deepEqual(extractFileLinks('notes/page.html', anchors), [])
  assert.deepEqual(extractFileLinks('notes/page.html', '<base href="directory/">' + anchors), [])
})

test('declarative refresh includes its relative destination and ignores timed reloads', () => {
  const source = [
    '<meta http-equiv="REFRESH" content="0;url=guide.html">',
    '<meta content="2; URL=\'one &amp; two.htm#title\'" http-equiv=refresh>',
    '<meta http-equiv=refresh content=15>',
    '<meta http-equiv=refresh content="0;url=https://example.org/">',
    '<meta name=description content="0;url=example-only">',
  ].join('\n')
  assert.deepEqual(extractFileLinks('notes/index.html', source).map(link => [link.line, link.target]), [
    [1, 'notes/guide.html'], [2, 'notes/one & two.htm'],
  ])
})

test('inspect noscript fallback links, ignore inert bases, and count each literal use once', () => {
  const source = [
    '<body><noscript><img src="fallback.png"></noscript>',
    '<template><base href="https://example.org/"></template>',
    '<b><a href="one.md">x</b> y</a><a href="one.md">again</a>',
  ].join('\n')
  assert.deepEqual(extractFileLinks('x.html', source).map(link => link.target), ['fallback.png', 'one.md', 'one.md'])
})

test('source file extensions are case-insensitive and targets need no extension', () => {
  for (const ext of ['md', 'markdown', 'MDOWN', 'mkd', 'mkdn', 'mdwn', 'HTM', 'hTmL']) {
    assert.ok(isDocumentPath('a.' + ext))
  }
  assert.equal(isDocumentPath('a.md.bak'), false)
  assert.deepEqual(extractFileLinks('a.txt', '[link](target)'), [])
  assert.equal(extractFileLinks('a.md', '[link](target)')[0].target, 'target')
})
