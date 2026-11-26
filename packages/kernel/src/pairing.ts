// Pairing: an agent that is not connected asks to be, the owner allows it with one click, and it is
// connected under its own name by `agent connect`. Pairings are machine state (an agent not yet
// connected has no identity in a library): `$PNEUMA_BASE_HOME/pairings/`. ARCHITECTURE.md section 6.
// CONTRACT STUB: the types and signatures are fixed; the kernel workstream implements them.
import type { Way } from './products.js'
import type { Instant } from '@pneuma-base/sdk'

/** `p-` and 8 hexadecimal digits. */
export type PairingId = string & { readonly __brand: 'PairingId' }

export type PairingDecision = { outcome: 'connected'; at: Instant; grant: string; way: Way } | { outcome: 'declined'; at: Instant; reason: string | null }

/** `code`: what the agent shows its user and the owner sees on the home page, `NNN-NNN`. `via`: which face it came in by. */
export type Pairing = {
  format: 1
  id: PairingId
  code: string
  product: string
  why: string
  library: string
  at: Instant
  expires: Instant
  via: 'http' | 'command-line'
  decision: PairingDecision | null
}

/** Derived, never stored: a waiting pairing past `expires` is expired. */
export type PairingState = 'waiting' | 'expired' | 'connected' | 'declined'

export type PairRequest = { home: string; library: string; product: string; why: string; via: Pairing['via']; now: Instant }

/** `again`: the same product already waits on the same library; its pairing is answered again, code unchanged. `text`: what to tell the agent. */
export type PairRequested =
  | { outcome: 'requested'; pairing: Pairing; again: boolean; text: string }
  | { outcome: 'refused'; reason: 'usage' | 'too-many' | 'not-a-library'; text: string }

/** What a connected agent is told: its grant, the command it runs, its MCP addresses, what to read next. */
export type Connected = {
  grant: string
  way: Way
  /** `<launcher> @<grant>`: the command every verb is run with. */
  command: string
  mcp: { url: string | null; stdio: string }
  /** `<library>/PNEUMA-BASE.md` */
  read: string
  next: string
}

/** What `GET /pair/<id>` and `pneuma-base pair status <id>` answer. `text`: the same in words, for the agent. */
export type PairingAnswer = {
  id: PairingId
  state: PairingState
  product: string
  code: string
  expires: Instant
  text: string
  connected: Connected | null
  declined: { reason: string | null } | null
}

export async function requestPairing(req: PairRequest): Promise<PairRequested> {
  return { outcome: 'refused', reason: 'usage', text: `(stub) ${req.product}` }
}

/** Null when no pairing has this id. */
export async function pairingAnswer(home: string, id: string, now: Instant): Promise<PairingAnswer | null> {
  void home
  void id
  void now
  return null
}
