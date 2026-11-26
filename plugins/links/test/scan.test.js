import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sandbox } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('库内链接按实际文件检查，包括未登记的目标和符号链接', async t => {
  const sb = await sandbox({ bare: true, plugins: [dist] })
  t.after(() => sb.cleanup())
  await mkdir(join(sb.library, 'assets'))
  await writeFile(join(sb.library, 'assets/manual.pdf'), 'ok')
  await writeFile(join(sb.work, 'elsewhere.md'), '[库外文档](secret.pdf)')
  await symlink('assets', join(sb.library, 'alias'))
  await symlink('assets/manual.pdf', join(sb.library, 'manual.pdf'))
  await symlink('assets/lost.pdf', join(sb.library, 'dangling.pdf'))
  await symlink(sb.work, join(sb.library, 'outside'))
  await symlink(join(sb.work, 'elsewhere.md'), join(sb.library, 'outside.md'))
  await writeFile(join(sb.library, 'guide.md'), [
    '[目录](assets)', '[新文件](assets/manual.pdf)', '[目录别名](alias/manual.pdf)',
    '[别名下的缺页](alias/missing.pdf)', '[文件别名](manual.pdf)', '[悬空链接](dangling.pdf)',
    '[库外文件](outside/elsewhere.md)', '[库外缺页](outside/missing.pdf)',
    '[使用说明](PNEUMA-BASE.md)', '[库内缺页](.pneuma-base/missing.txt)',
  ].join('\n'))

  const listed = await sb.owner(['links', 'list', '--json'])
  assert.equal(listed.code, 0, listed.stderr)
  assert.deepEqual(listed.json.data.broken.map(row => [row.source, row.target]), [
    ['guide.md', 'alias/missing.pdf'],
    ['guide.md', 'dangling.pdf'],
    ['guide.md', '.pneuma-base/missing.txt'],
  ])
})
