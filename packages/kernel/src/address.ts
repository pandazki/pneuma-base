// A library's address on this machine, before storage can answer for it: a local path, resolved to the
// real path of the folder (which is how two spellings of one library are one), or made when a library
// is created there. Nothing here reads or writes the library's content or record area: that is
// storage's, through the door (storage.ts).
import { mkdir, realpath } from 'node:fs/promises'

/** The real path of the folder an address names; null when nothing is there. */
export const resolveAddress = (dir: string): Promise<string | null> => realpath(dir).catch(() => null)

/** Makes the folder a library is to be created at, with its parents. */
export const makeAddress = async (dir: string): Promise<string> => {
  await mkdir(dir, { recursive: true })
  return realpath(dir)
}
