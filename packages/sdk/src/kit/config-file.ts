// A plugin's configuration file: read through a parser at the boundary, replaced whole. It is
// configuration, not a record: the last write wins, and nobody reads it half written.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface ConfigFile<T> {
  /** The configuration; null when the file is not there. Throws when it is not JSON or `parse` throws. */
  read(): Promise<T | null>
  /** Writes the whole configuration to a temporary name beside the file, then renames it into place. */
  write(value: T): Promise<void>
}

/** The configuration file at the absolute path `file`. `parse` takes the JSON and answers the configuration, or throws. */
export function configFile<T>(file: string, parse: (raw: unknown) => T): ConfigFile<T> {
  return {
    async read() {
      const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      return text === null ? null : parse(JSON.parse(text))
    },
    async write(value) {
      await mkdir(dirname(file), { recursive: true })
      const tmp = join(dirname(file), `.tmp-${randomBytes(4).toString('hex')}-${basename(file)}`)
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
      await rename(tmp, file)
    },
  }
}
