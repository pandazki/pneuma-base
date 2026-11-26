// The one file the ledger writes outside the library: the audit export the owner names, created new
// (never over a file that is there) and written a page at a time.
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

export type OutsideFile = { write(text: string): Promise<void>; close(): Promise<void> }

/** Creates the file at the absolute `path`, its directory with it; null when a file is there already. */
export async function createOutside(path: string): Promise<OutsideFile | null> {
  await mkdir(dirname(path), { recursive: true })
  try {
    const handle = await open(path, 'wx')
    return { write: async (text) => void (await handle.write(text)), close: () => handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw error
  }
}
