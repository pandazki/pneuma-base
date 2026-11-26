// Moments in the viewer's local time: short on the page, relative for the recent past, whole on hover.
import { useEffect, useState } from 'react'

const pad = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const MINUTE = 60_000

/** Within the last hour: 刚刚 under a minute, else N 分钟前; null for anything older or in the future. */
function ago(d: Date, now: Date): string | null {
  const ms = now.getTime() - d.getTime()
  if (ms < -MINUTE || ms >= 60 * MINUTE) return null
  return ms < MINUTE ? '刚刚' : `${Math.floor(ms / MINUTE)} 分钟前`
}

/**
 * As short as the distance from now allows: 刚刚 or N 分钟前 within the hour, 今天 and the time, 昨天
 * and the time, the date and the time this year, else the date with its year.
 */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const recent = ago(d, now)
  if (recent) return recent
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay(d, now)) return `今天 ${hm}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `昨天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** For a row under its day's heading: 刚刚 or N 分钟前 within the hour, else the clock time alone. */
export function clockOrAgo(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return ago(d, now) ?? `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The whole moment to the second, local, with its offset from UTC. */
export function fullTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const offset = -d.getTimezoneOffset()
  const hours = Math.floor(Math.abs(offset) / 60)
  const minutes = Math.abs(offset) % 60
  const zone = `UTC${offset >= 0 ? '+' : '-'}${hours}${minutes ? `:${pad(minutes)}` : ''}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${zone}`
}

/** A clock time of today, to the second: 14:05:09. */
export const clockTime = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad).join(':')

/** A moment as the command line writes it, `2026-11-26 07:34Z`, as it appears inside a plugin's words. */
const CLI_MOMENT = /\b(\d{4}-\d\d-\d\d) (\d\d:\d\d)Z\b/g

/** A text with each moment the command line wrote in it put in the viewer's time, short. */
export const localMoments = (text: string, now = new Date()) => text.replace(CLI_MOMENT, (_, date: string, time: string) => shortTime(`${date}T${time}:00Z`, now))

const listeners = new Set<(now: Date) => void>()
let clock: number | undefined

/** Now, kept fresh every half minute by one clock for the whole page, so 3 分钟前 becomes 4 分钟前 without a reload. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    listeners.add(setNow)
    clock ??= window.setInterval(() => {
      const at = new Date()
      for (const listen of listeners) listen(at)
    }, 30_000)
    return () => {
      listeners.delete(setNow)
      if (listeners.size === 0) {
        window.clearInterval(clock)
        clock = undefined
      }
    }
  }, [])
  return now
}
