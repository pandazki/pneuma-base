import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { meetsNodeFloor, NODE_FLOOR } from '../src/node-floor.js'

const rootFile = (name: string) => readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8')

describe('the oldest Node this runs on', () => {
  it('accepts the floor and anything newer, and refuses anything older', () => {
    for (const version of [`${NODE_FLOOR}.0`, '22.23.5', '24.0.0', '26.13.0']) expect(meetsNodeFloor(version), version).toBe(true)
    for (const version of ['22.17.9', '22.14.0', '20.19.0', '18.20.4']) expect(meetsNodeFloor(version), version).toBe(false)
  })

  it('is the one the package and the README declare', () => {
    expect(JSON.parse(rootFile('package.json')).engines.node).toBe(`>=${NODE_FLOOR}`)
    expect(rootFile('README.md')).toContain(`要 Node ${NODE_FLOOR} 以上`)
  })
})
