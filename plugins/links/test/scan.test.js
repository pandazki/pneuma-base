import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sandbox } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

async function brokenTargets(sb) {
  const listed = await sb.owner(['links', 'list', '--json'])
  assert.equal(listed.code, 0, listed.stderr)
  return listed.json.data.broken.map(row => [row.source, row.target])
}

test('目标按存储看到的检查：没登记的文件和符号链接本身都算在，记录区里的算不在', async t => {
  const sb = await sandbox({ bare: true, plugins: [dist] })
  t.after(() => sb.cleanup())
  await mkdir(join(sb.library, 'assets'))
  await writeFile(join(sb.library, 'assets/manual.pdf'), 'ok')
  await symlink('assets/manual.pdf', join(sb.library, 'manual.pdf'))
  const guide = [
    '[目录](assets)', '[新文件](assets/manual.pdf)', '[文件别名](manual.pdf)', '[缺页](assets/missing.pdf)',
    '[使用说明](PNEUMA-BASE.md)', '[记录区](.pneuma-base/missing.txt)',
  ].join('\n')
  const put = await sb.agent('author', 'seed', ['put', '-', '--to', 'guide.md', '--generated'], { input: guide })
  assert.equal(put.code, 0, put.stderr)

  assert.deepEqual(await brokenTargets(sb), [
    ['guide.md', 'assets/missing.pdf'],
    ['guide.md', '.pneuma-base/missing.txt'],
  ])
})

test('插件装上之前放进来的文档，再放一次才查', async t => {
  const sb = await sandbox({ bare: true })
  t.after(() => sb.cleanup())
  const put = () => sb.agent('author', 'seed', ['put', '-', '--to', 'notes/a.md', '--generated'], { input: '[缺页](b.md)\n' })
  assert.equal((await put()).code, 0)
  assert.equal((await sb.run(['plugin', 'install', dist, '--json'])).json.outcome, 'done')
  assert.equal((await sb.owner(['plugin', 'enable', 'links', '--json'])).json.outcome, 'done')

  assert.deepEqual(await brokenTargets(sb), [])
  assert.equal((await sb.agent('author', 'again', ['put', 'notes/a.md', '--generated'])).code, 0)
  assert.deepEqual(await brokenTargets(sb), [['notes/a.md', 'notes/b.md']])
})
