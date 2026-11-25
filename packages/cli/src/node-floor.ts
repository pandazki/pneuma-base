/**
 * The oldest Node this runs on. Below it the bundled sqlite has no FTS5, so the search plugin
 * cannot index; it is also the oldest release the whole test suite was run on.
 */
export const NODE_FLOOR = '22.18'

export function meetsNodeFloor(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  const [floorMajor = 0, floorMinor = 0] = NODE_FLOOR.split('.').map(Number)
  return major > floorMajor || (major === floorMajor && minor >= floorMinor)
}
