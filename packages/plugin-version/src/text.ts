// What agents read: a thing's timeline as text and as data. Pure.
import { regionOf, type Instant } from '@pneuma-base/kernel'
import type { Who } from './facts.js'
import { filesOf, latest, type Thing, type Version } from './model.js'
import type { DiskState } from './versions.js'

export const minute = (at: Instant) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`
/** Who recorded a version; `owner`: how the owner is named, 所有者 in text, 我 on the pages. */
export const whoText = (by: Who, owner = '所有者') => (by.kind === 'owner' ? owner : by.kind === 'plugin' ? `插件 ${by.name}` : by.name)

/** What a version is besides its number and time, one phrase each. */
export function aboutVersion(v: Version, owner?: string): string[] {
  return [
    whoText(v.by, owner),
    ...(v.note ? [`「${v.note}」`] : []),
    ...(v.via === 'outside' ? ['外部修改'] : []),
    ...(v.same !== null ? [`与版本 ${v.same} 相同`] : []),
    ...(v.kept.kind === 'file' ? [] : [`${filesOf(v)} 个文件`]),
    `内容哈希 ${v.fingerprint.slice(0, 8)}`,
    ...(v.pruned ? ['已清除，不可恢复'] : []),
  ]
}

export const archived = (thing: Thing) => regionOf(thing.path) === 'archive'

function stateText(thing: Thing, state: DiskState): string {
  const last = latest(thing)
  if (state === 'missing' || !last) return `${thing.path} 当前不存在，可恢复任一版本。`
  if (state === 'changed') return `当前内容与版本 ${last.n} 不同：已被外部修改，尚未记录，check 时记录为新版本。`
  return `当前内容为版本 ${last.n}。`
}

/** The timeline, newest first, at most `limit` versions, and how to get an old one back. */
export function timelineText(thing: Thing, state: DiskState, limit = Infinity): string {
  const pruned = thing.versions.filter((v) => v.pruned).length
  const shown = thing.versions.toReversed().slice(0, limit)
  const earlier = thing.versions.length - shown.length
  const restore = archived(thing) ? '恢复旧版本前，请先执行 unarchive' : `恢复：version restore ${thing.path} --version <n>`
  return [
    `${thing.path}${archived(thing) ? '（已归档）' : ''} 已启用版本管理，共 ${thing.versions.length} 个版本${pruned > 0 ? `（${pruned} 个已清除）` : ''}。${stateText(thing, state)}`,
    ...shown.map((v) => [`版本 ${v.n}`, minute(v.at), ...aboutVersion(v)].join(' · ')),
    ...(earlier > 0 ? [`另有更早的 ${earlier} 个版本，用 version list ${thing.path} 查看全部。`] : []),
    `导出：version export ${thing.path} --version <n> --to <外部路径>；${restore}`,
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
