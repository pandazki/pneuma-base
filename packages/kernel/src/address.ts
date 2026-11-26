// A library's address on this machine, before storage can answer for it. A local path resolves to the
// real path of the folder (which is how two spellings of one library are one), and is made when a
// library is created there; an address of any other form (`<scheme>://…`) is the provider's to
// answer, and is taken as written. Nothing here reads or writes the library's content or record area:
// that is storage's, through the door (storage.ts).
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { addressForm } from './providers.js'

/** An address as a person typed it: a path from `cwd`, `~` being the home directory; any other form as written. */
export function typedAddress(typed: string, cwd: string): string {
  if (addressForm(typed) !== 'path') return typed
  return resolve(cwd, typed === '~' || typed.startsWith('~/') ? join(homedir(), typed.slice(1)) : typed)
}

/** The address a library there has: the real path of a folder, null when nothing is there; any other form as written. */
export const resolveAddress = (address: string): Promise<string | null> => (addressForm(address) === 'path' ? realpath(address).catch(() => null) : Promise.resolve(address))

/** Makes the folder a library is to be created at, with its parents; any other form is made by its provider. */
export const makeAddress = async (address: string): Promise<string> => {
  if (addressForm(address) !== 'path') return address
  await mkdir(address, { recursive: true })
  return realpath(address)
}
