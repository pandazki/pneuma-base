// The guide an agent reads to connect itself: a generic one, and one per product of the products
// table. The command line prints it (`pneuma-base guide`) and the endpoint serves the same text
// (`/guide`, `/guide/<product>`). ARCHITECTURE.md section 6.
// CONTRACT STUB: the signature is fixed; the text is written by the kernel workstream.
import type { Env } from './products.js'

/**
 * What the guide is written from. `url`: the origin of the endpoint serving this library
 * (`http://127.0.0.1:<port>`), null when none runs; the guide then gives the command-line forms only.
 */
export type GuideFacts = { root: string; home: string; env: Env; url: string | null }

/**
 * The guide for `product`: its own when the products table has a guide for it, else the generic
 * one (with the name filled in where the generic one says `<产品>`). `product` null: the generic one.
 * The caller has checked `product` against GRANT_NAME.
 */
export function guideText(facts: GuideFacts, product: string | null): string {
  return `# Pneuma Base\n\n(stub) ${facts.root} ${product ?? ''}\n`
}
