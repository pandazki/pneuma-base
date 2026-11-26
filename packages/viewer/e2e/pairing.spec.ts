// An agent that is not connected asks to be over the local endpoint; the owner sees it on the home page
// with the same code the agent shows its user, allows it in the browser, and the agent's next poll says
// it is connected under its own name. The 「开始」 step shows the sentence to say, with a copy button.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, tempDir, test } from './support.ts'

test('a pairing asked over the endpoint is allowed on the home page and the agent is connected', async ({ page, pb }) => {
  mkdirSync(join(pb.home, '.claude'))
  const lib = join(tempDir(), 'lib')
  pb.run(['init', lib])
  const { url } = await pb.view(lib)
  const origin = new URL(url).origin
  await page.goto(url)

  const main = page.getByRole('main')
  await expect(main.getByText(`读一下 ${origin}/guide，接上我的 Pneuma Base 库。`)).toBeVisible()

  const asked = await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: 'claude-code', why: '整理这次的调研' }) })
  const { id, code } = (await asked.json()) as { id: string; code: string }

  const decide = main.getByRole('region', { name: '等你决定' })
  await expect(decide).toContainText('Claude Code 想接入这个库：允许吗？')
  await expect(decide).toContainText(code)
  await expect(decide).toContainText('整理这次的调研')
  await expect(decide.getByRole('button', { name: '允许', exact: true })).not.toHaveClass(/btn-primary/)
  await decide.getByRole('button', { name: '允许', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '允许', exact: true }).click()
  await expect(decide.getByRole('status')).toContainText('允许')

  const answer = (await (await fetch(`${origin}/pair/${id}`)).json()) as { state: string; connected: { grant: string } }
  expect(answer.state).toBe('connected')
  expect(answer.connected.grant).toBe('claude-code')
  expect(pb.run(['agent', 'list', '--library', lib]).stdout).toContain('claude-code')
})
