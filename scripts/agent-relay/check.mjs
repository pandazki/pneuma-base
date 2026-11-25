#!/usr/bin/env node
// Reads the ledger's fact files and decides whether the relay happened:
// agent B put in something made on the basis of something agent A put in.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [library, nameA, nameB] = process.argv.slice(2)
if (!library || !nameA || !nameB) {
  console.error('usage: check.mjs <library> <agent-A-name> <agent-B-name>')
  process.exit(1)
}
const factsDir = join(library, '.pneuma-base', 'ledger', 'facts')
const facts = []
if (existsSync(factsDir)) {
  for (const scene of readdirSync(factsDir)) {
    for (const file of readdirSync(join(factsDir, scene))) {
      if (!file.endsWith('.jsonl')) continue
      for (const line of readFileSync(join(factsDir, scene, file), 'utf8').split('\n')) {
        if (line.trim()) facts.push(JSON.parse(line))
      }
    }
  }
}
facts.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))

const enters = facts.filter((f) => f.kind === 'item.enter')
const byA = enters.filter((f) => f.actor.name === nameA)
const byB = enters.filter((f) => f.actor.name === nameB)
const itemsOfA = new Set(byA.map((f) => f.item))
const broughtByA = byA.filter((f) => f.origin.kind === 'brought')
// A directory brought in as one thing counts by the files in it: three quotes in one folder are still three quotes.
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (n === '.pneuma-item' ? [] : statSync(join(dir, n)).isDirectory() ? filesIn(join(dir, n)) : [n])) : [])
const broughtFiles = broughtByA.reduce((n, f) => n + (f.bundle ? filesIn(join(library, f.path)).length : 1), 0)
const madeByA = byA.filter((f) => f.origin.kind === 'made')
const basisOf = (f) => (f.origin?.kind === 'made' ? f.origin.basis.items : f.basis?.items ?? []).map((b) => b.item)
const bWrites = facts.filter((f) => f.actor.name === nameB && (f.kind === 'item.enter' || f.kind === 'item.revise' || f.kind === 'item.basis'))
const relayed = bWrites.filter((f) => basisOf(f).some((item) => itemsOfA.has(item)))
const doingA = facts.filter((f) => f.kind === 'said' && f.flavor === 'doing' && f.actor.name === nameA)
const doingB = facts.filter((f) => f.kind === 'said' && f.flavor === 'doing' && f.actor.name === nameB)
const decided = facts.filter((f) => f.kind === 'said' && f.flavor === 'decided')

const rows = [
  ['A 带进来的资料不少于 3 份', broughtFiles >= 3, `${broughtFiles} 份，${broughtByA.length} 样东西`],
  ['A 做出来的条目不少于 1', madeByA.length >= 1, madeByA.length],
  ['A 说了在做什么', doingA.length >= 1, doingA.map((f) => f.text).join(' / ')],
  ['B 说了在做什么', doingB.length >= 1, doingB.map((f) => f.text).join(' / ')],
  ['B 放进了东西', byB.length >= 1, byB.map((f) => f.path).join(', ')],
  ['B 放的东西写明依据了 A 的产出（接力）', relayed.length >= 1, relayed.map((f) => f.path ?? f.item).join(', ')],
]
let ok = true
for (const [label, pass, detail] of rows) {
  if (!pass) ok = false
  console.log(`${pass ? '过' : '没过'}  ${label}  ${detail === '' ? '' : `（${detail}）`}`)
}
console.log(`记下的决定：${decided.map((f) => f.text).join(' / ') || '无'}`)
console.log(`事实总数：${facts.length}`)
process.exit(ok ? 0 : 1)
