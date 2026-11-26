// A put lands its file before its record. The kernel marks the path while the put runs, and check
// leaves a path being put out of 没人登记过的 and 被直接改过的. Sampled the way
// app/experiments/put-race.mjs measured the gap: check runs over and over while an agent puts files
// one after another, new ones and new content over ones it put before.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sandbox, tempDir, type Sandbox } from './helpers.js'

/** The command line, without waiting: its exit code and standard output. */
function run(sb: Sandbox, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((done, fail) => {
    const child = sb.start(args)
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.on('error', fail)
    child.on('exit', (code) => done({ code: code ?? -1, stdout }))
  })
}

it('check never reports a path being put as nobody’s or as changed directly', async () => {
  const sb = sandbox()
  const lib = join(tempDir(), 'lib')
  const outside = tempDir('pb-outside-')
  expect(sb.run(['init', lib]).code).toBe(0)
  const puts = 40
  // A few MB, so the gap between the file and its record is not only the record's own few milliseconds.
  const body = (i: number, round: number) => `${round}:${i}\n`.repeat(400_000)
  let putting = true
  const agent = (...args: string[]) => run(sb, ['--library', lib, '--as', 'race-agent', '--session', 'race', 'put', ...args])
  const putter = (async () => {
    for (let i = 0; i < puts; i++) {
      // Of every four puts, the third moves the thing put before it and the fourth gives new content to it.
      const from = join(outside, `p${i}.txt`)
      const r =
        i % 4 === 2
          ? await agent(`race/${i - 1}.txt`, '--to', `race/moved/${i - 1}.txt`)
          : (writeFileSync(from, body(i, 1)), await agent(from, '--to', `race/${i % 4 === 3 ? `moved/${i - 2}` : i}.txt`, '--made'))
      expect(r.code, r.stdout).toBe(0)
    }
    putting = false
  })()
  const reported: string[] = []
  let samples = 0
  const sampler = async () => {
    while (putting) {
      const r = await run(sb, ['--library', lib, 'check', '--json'])
      samples++
      for (const s of JSON.parse(r.stdout).sections as { title: string; data: { shown: unknown[] } }[]) {
        if (STRAYS.includes(s.title)) reported.push(...s.data.shown.map((row) => `${s.title} ${JSON.stringify(row)}`))
      }
    }
  }
  await Promise.all([putter, sampler(), sampler(), sampler()])
  expect(samples).toBeGreaterThan(puts)
  expect(reported).toEqual([])
  // No sample took a move for one it saw: the only moves on record are the agent's own.
  const rows = JSON.parse(sb.run(['--library', lib, 'show', 'ledger.activity', '--json']).stdout).blocks.find((b: any) => b.kind === 'feed').groups.flatMap((g: any) => g.rows)
  const moves = rows.filter((row: any) => row.text.startsWith('挪 '))
  expect(moves.map((row: any) => row.actor.name)).toEqual(Array(puts / 4).fill('race-agent'))
}, 180_000)

const STRAYS = ['没人登记过的', '被直接改过的', '不在了的', '挪过的']
