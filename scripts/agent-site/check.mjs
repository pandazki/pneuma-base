#!/usr/bin/env node
// Judges the site story from what is on disk, not from what the agents said.
//   check.mjs declared <library>            prints the library paths declared deployable, one per line
//   check.mjs verdict <library> <online>    prints one line per criterion and exits non-zero when any fails
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [mode, library, online] = process.argv.slice(2)
const pb = (...args) => {
  try {
    return JSON.parse(execFileSync('pneuma-base', [...args, '--library', library, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch (error) {
    return error.stdout ? JSON.parse(error.stdout) : { outcome: 'failed', data: null }
  }
}
const sites = () => pb('deploy', 'list').data ?? []

if (mode === 'declared') {
  const paths = sites().filter((s) => !s.path.startsWith('_archive/')).map((s) => s.path)
  console.log(paths.join('\n'))
  process.exit(paths.length > 0 ? 0 : 1)
}

const factsDir = join(library, '.pneuma-base', 'ledger', 'facts')
const facts = existsSync(factsDir)
  ? readdirSync(factsDir).flatMap((scene) => readdirSync(join(factsDir, scene)).flatMap((f) => readFileSync(join(factsDir, scene, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))))
  : []
const by = (name) => facts.filter((f) => f.actor?.name === name)
const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)])) : [])
const textOf = (dir) => walk(dir).filter((f) => /\.(html?|css|js|md|txt)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n')

const made = by('claude').filter((f) => f.kind === 'item.enter' && f.bundle === true && f.origin?.kind === 'made')
const site = made[0]
const listed = sites()
const entry = site ? listed.find((s) => s.path === site.path) : undefined
const revised = site ? by('codex').filter((f) => f.kind === 'item.revise' && f.item === site.item) : []
const otherSites = by('codex').filter((f) => f.kind === 'item.enter' && f.bundle === true)
const live = entry ? textOf(join(online, entry.site)) : ''
const held = (pb('ledger', 'copies', 'list').data?.copies ?? []).filter((c) => site && c.item === site.item)
const heldText = held.map((c) => textOf(join(library, c.path))).join('\n')
const versions = site ? (pb('version', 'list', site.path).data?.versions ?? []) : []

const rows = [
  ['甲把网站作为一个目录放进了库（做出来的）', made.length >= 1, site?.path ?? '没有'],
  ['甲声明了它可以部署', entry !== undefined, entry ? `${entry.path} · ${entry.status}` : '没有'],
  ['主人打开后它在线', entry?.status === 'published', entry?.url ?? ''],
  ['乙说了在做什么', by('codex').some((f) => f.kind === 'said' && f.flavor === 'doing'), by('codex').find((f) => f.kind === 'said')?.text ?? ''],
  ['乙改的是甲的那个网站，不是另做一个', revised.length >= 1 && otherSites.length === 0, `改了 ${revised.length} 次，另放了 ${otherSites.length} 个目录`],
  ['线上的内容是改后的（周日、三点）', /周日/.test(live) && /(三点|3\s*[点:：]|15[:：]00)/.test(live) && !/周六/.test(live), live.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 80)],
  ['改之前的那一版还取得回', /周六/.test(heldText) || versions.length >= 2, `留存 ${held.length} 份，版本 ${versions.length} 个`],
]
for (const [what, ok, note] of rows) console.log(`${ok ? '过' : '没过'}  ${what}  （${note}）`)
console.log(`甲声明有版本：${versions.length > 0 ? '是' : '否'} · 事实总数：${facts.length}`)
process.exit(rows.every(([, ok]) => ok) ? 0 : 1)
