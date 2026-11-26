// What agents read: a thing's timeline as text and as data. Pure.
import { regionOf, type Instant } from '@pneuma-base/kernel'
import type { Who } from './facts.js'
import { filesOf, latest, type Thing, type Version } from './model.js'
import type { DiskState } from './versions.js'

export const minute = (at: Instant) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`
export const whoText = (by: Who) => (by.kind === 'owner' ? '主人' : by.kind === 'plugin' ? `插件 ${by.name}` : by.name)

/** What a version is besides its number and time, one phrase each. */
export function aboutVersion(v: Version): string[] {
  return [
    whoText(v.by),
    ...(v.note ? [`「${v.note}」`] : []),
    ...(v.via === 'outside' ? ['在工具之外改的'] : []),
    ...(v.same !== null ? [`同第 ${v.same} 版`] : []),
    ...(v.kept.kind === 'file' ? [] : [`${filesOf(v)} 个文件`]),
    `指纹 ${v.fingerprint.slice(0, 8)}`,
    ...(v.pruned ? ['已清掉，取不回'] : []),
  ]
}

export const archived = (thing: Thing) => regionOf(thing.path) === 'archive'

function stateText(thing: Thing, state: DiskState): string {
  const last = latest(thing)
  if (state === 'missing' || !last) return `${thing.path} 上现在没有东西，可以把某一版放回来。`
  if (state === 'changed') return `当前内容和第 ${last.n} 版不同：在工具之外改过，还没记下，check 会把它记成一版。`
  return `当前内容是第 ${last.n} 版。`
}

/** The timeline, newest first, at most `limit` versions, and how to get an old one back. */
export function timelineText(thing: Thing, state: DiskState, limit = Infinity): string {
  const pruned = thing.versions.filter((v) => v.pruned).length
  const shown = thing.versions.toReversed().slice(0, limit)
  const earlier = thing.versions.length - shown.length
  const restore = archived(thing) ? '要放回旧版，先 unarchive' : `放回来：version restore ${thing.path} --version <n>`
  return [
    `${thing.path}${archived(thing) ? '（已归档）' : ''} 有版本，共 ${thing.versions.length} 版${pruned > 0 ? `（${pruned} 版已清掉）` : ''}。${stateText(thing, state)}`,
    ...shown.map((v) => [`第 ${v.n} 版`, minute(v.at), ...aboutVersion(v)].join(' · ')),
    ...(earlier > 0 ? [`还有更早的 ${earlier} 版，version list ${thing.path} 看全部。`] : []),
    `取到库外：version export ${thing.path} --version <n> --to <库外的路径>；${restore}`,
  ].join('\n')
}

export function timelineData(thing: Thing, state: DiskState) {
  return {
    path: thing.path,
    state,
    versions: thing.versions.map((v) => ({
      n: v.n,
      at: v.at,
      by: whoText(v.by),
      note: v.note,
      via: v.via,
      same: v.same,
      fingerprint: v.fingerprint,
      files: filesOf(v),
      pruned: v.pruned,
    })),
  }
}
