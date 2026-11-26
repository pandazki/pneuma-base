// A plugin's configuration file: read through a parser at the boundary, replaced whole. It is
// configuration, not a record: the last write wins, and nobody reads it half written.
import { isDescribed, isFailure, type Expect, type Place } from '../storage.js'
import type { PluginContext } from '../types.js'

export interface ConfigFile<T> {
  /** The configuration; null when the file is not there. Throws when it is not JSON or `parse` throws. */
  read(): Promise<T | null>
  /** Writes the whole configuration, all of it or none. */
  write(value: T): Promise<void>
}

/** How many times a write expecting what it read meets a newer write, and reads again, before it gives up. */
const TRIES = 3

/**
 * The configuration file `name` in the plugin's own content, `.pneuma-base/<plugin>/<name>`. `parse`
 * takes the JSON and answers the configuration, or throws. A write expects the state the file was
 * read in (nothing there, when it was not); when another write came in between, it reads the state
 * again and writes over it, as the last write wins.
 */
export function configFile<T>(ctx: PluginContext, name: Place, parse: (raw: unknown) => T): ConfigFile<T> {
  const own = ctx.tools.storage.own
  /** The state the file was last read or written in: `empty` when it was not there. */
  let known: Expect | null = null
  const stateNow = async (): Promise<Expect> => {
    const [at] = await own.glance([name])
    return at !== undefined && isDescribed(at) && at.kind !== 'none' && at.token !== undefined ? at.token : 'empty'
  }
  return {
    async read() {
      const answer = await own.read(name)
      if (isFailure(answer)) {
        if (answer.reason !== 'no_such_place') throw new Error(`${name} 读不出来：${answer.reason}`)
        known = 'empty'
        return null
      }
      known = answer.token
      const chunks = [answer.data ?? new Uint8Array()]
      for (let offset = answer.length; offset < answer.size; ) {
        const more = await own.read(name, { offset })
        if (isFailure(more) || more.data === null || more.length === 0) throw new Error(`${name} 读到一半变了`)
        chunks.push(more.data)
        offset += more.length
      }
      return parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    },
    async write(value) {
      const data = `${JSON.stringify(value, null, 2)}\n`
      let expect = known ?? (await stateNow())
      for (let i = 0; i < TRIES; i++) {
        const written = await own.write(name, { data }, expect)
        if (!isFailure(written)) {
          known = written.entry.token ?? null
          return
        }
        if (written.reason !== 'refused') throw new Error(`${name} 写不进去：${written.reason}`)
        expect = await stateNow()
      }
      throw new Error(`${name} 写的时候连续 ${TRIES} 次遇上别处的写入`)
    },
  }
}
