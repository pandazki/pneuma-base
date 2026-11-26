import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sandbox } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

async function openLibrary(t) {
  const sb = await sandbox({ bare: true, plugins: [dist] })
  t.after(() => sb.cleanup())
  return sb
}

function success(result) {
  assert.equal(result.code, 0, result.stderr || result.stdout)
  return result.json
}

async function put(sb, path, input) {
  const result = await sb.agent('author', 'seed', [
    'put', '-', '--to', path, '--made', '--json',
  ], { input })
  assert.equal(success(result).outcome, 'accepted')
}

async function check(sb, flags = []) {
  const result = await sb.agent('reader', 'review', ['check', ...flags, '--json'])
  const checked = success(result)
  assert.deepEqual(checked.problems, [])
  return checked.sections.find(section => section.plugin === 'links')?.data.broken ?? []
}

async function list(sb) {
  const listed = success(await sb.owner(['links', 'list', '--json']))
  assert.equal(listed.outcome, 'done')
  return listed.data.broken
}

function table(page) {
  assert.equal(page.outcome, 'shown')
  assert.deepEqual(page.problems, [])
  const block = page.blocks.find(block => block.kind === 'table')
  assert.ok(block, '应当显示坏链接表')
  return block
}

const targets = records => records.map(record => record.target).sort()
const cellTexts = row => Object.values(row.cells).map(cell => cell.text).join('\n')

test('同一条坏链接可从 check、主人命令、管理页和源文件面板查到，补齐目标后即时消失', async (t) => {
  const sb = await openLibrary(t)
  const viewer = await sb.viewer()
  assert.ok((await viewer.state()).views.some(view => view.id === 'links.broken' && view.nav))
  assert.deepEqual(await list(sb), [])
  assert.deepEqual(await check(sb), [])
  assert.deepEqual(table(await viewer.view('links.broken')).rows, [])

  await put(sb, 'docs/guide.md', [
    '# 指南', '[条目](../assets/gone.txt#top)', '[已有](home.HTML)',
    '[外部](https://example.org/unreachable)', '[同页](#top)',
  ].join('\n'))
  await put(sb, 'docs/home.HTML', '<a href="./later.md?print=1">下一篇</a>')

  const issues = await list(sb)
  assert.deepEqual(issues.map(({ source, href, target, line }) => [source, href, target, line]).sort(), [
    ['docs/guide.md', '../assets/gone.txt#top', 'assets/gone.txt', 2],
    ['docs/home.HTML', './later.md?print=1', 'docs/later.md', 1],
  ])
  assert.deepEqual(await check(sb), issues)
  const agentText = await sb.agent('reader', 'text', ['check'])
  success(agentText)
  const ownerText = await sb.owner(['links', 'list'])
  success(ownerText)
  for (const issue of issues) {
    for (const output of [agentText.stdout, ownerText.stdout]) {
      assert.ok(output.includes(issue.source), output)
      assert.ok(output.includes(issue.href), output)
    }
  }

  const { rows } = table(await viewer.view('links.broken'))
  assert.equal(rows.length, 2)
  for (const issue of issues) {
    const row = rows.find(row => row.link?.params.path === issue.source)
    assert.ok(row, issue.source)
    assert.deepEqual(row.link, { view: 'item', params: { path: issue.source }, target: 'panel' })
    assert.ok(cellTexts(row).includes(issue.href))
    const detail = table(await viewer.item(row.link.params.path, { plugin: 'links' }))
    assert.equal(detail.rows.length, 1)
    assert.ok(cellTexts(detail.rows[0]).includes(issue.href))
  }

  await put(sb, 'assets/gone.txt', '资料')
  await put(sb, 'docs/later.md', '# 下一篇')
  assert.deepEqual(await check(sb), [])
  assert.deepEqual(await list(sb), [])
  assert.deepEqual(table(await viewer.view('links.broken')).rows, [])
  const cleanItem = await viewer.item('docs/guide.md', { plugin: 'links' })
  assert.deepEqual(cleanItem.problems, [])
  assert.ok(cleanItem.blocks.every(block => block.kind !== 'table' || block.rows.length === 0))
})

test('带标记的目录内按源文件打开面板，归档只改变默认 check 的范围', async (t) => {
  const sb = await openLibrary(t)
  const bundle = join(sb.work, 'site')
  await mkdir(join(bundle, 'assets'), { recursive: true })
  await writeFile(join(bundle, 'assets/logo.svg'), '<svg/>')
  await writeFile(join(bundle, 'index.htm'), '<img src="assets/logo.svg"><a href="help.md">帮助</a>')
  const putBundle = await sb.agent('author', 'seed', [
    'put', bundle, '--to', 'web', '--made', '--json',
  ])
  assert.equal(success(putBundle).outcome, 'accepted')

  assert.deepEqual(targets(await check(sb)), ['web/help.md'])
  const viewer = await sb.viewer()
  const [row] = table(await viewer.view('links.broken')).rows
  assert.deepEqual(row.link, { view: 'item', params: { path: 'web/index.htm' }, target: 'panel' })
  const item = table(await viewer.item(row.link.params.path, { plugin: 'links' }))
  assert.equal(item.rows.length, 1)
  assert.ok(cellTexts(item.rows[0]).includes('help.md'))

  success(await sb.agent('author', 'move', ['archive', 'web', '--json']))
  assert.deepEqual(await check(sb), [])
  const archived = await check(sb, ['--include-archived'])
  assert.deepEqual(targets(archived), ['_archive/web/help.md'])
  assert.deepEqual(await list(sb), archived)
  const archivedRows = table(await viewer.view('links.broken')).rows
  assert.deepEqual(archivedRows.map(row => row.link.params.path), ['_archive/web/index.htm'])
  const archivePanel = table(await viewer.item('_archive/web/index.htm', { plugin: 'links' }))
  assert.equal(archivePanel.rows.length, 1)
})
