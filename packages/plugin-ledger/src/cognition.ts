// The package's own text: what an agent is told of the ledger, beside the code in this package.
import { readFileSync } from 'node:fs'

export const COGNITION = readFileSync(new URL('../cognition/2-ledger-section.md', import.meta.url), 'utf8')
