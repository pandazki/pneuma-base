/*! Agent product icons from @lobehub/icons-static-svg 1.106.0 (https://github.com/lobehub/lobe-icons), MIT License, Copyright (c) 2023 LobeHub; see NOTICE.md beside them. The product names and marks are trademarks of their owners. */
// Which agents are drawn as their product's own icon: the table comes from the kernel with the page's
// state (AGENT_MARKS beside the products table), the icons live here. A name the table does not know
// is drawn as its letters (marks.ts).
import { useSyncExternalStore } from 'react'
import antigravity from './antigravity.svg?raw'
import claudeCode from './claude-code.svg?raw'
import claudeDesktop from './claude-desktop.svg?raw'
import cline from './cline.svg?raw'
import codex from './codex.svg?raw'
import cursor from './cursor.svg?raw'
import deepseek from './deepseek.svg?raw'
import geminiCli from './gemini-cli.svg?raw'
import githubCopilot from './github-copilot.svg?raw'
import grok from './grok.svg?raw'
import kimi from './kimi.svg?raw'
import opencode from './opencode.svg?raw'
import qwenCode from './qwen-code.svg?raw'
import windsurf from './windsurf.svg?raw'

const ICONS: Readonly<Record<string, string>> = {
  antigravity,
  'claude-code': claudeCode,
  'claude-desktop': claudeDesktop,
  cline,
  codex,
  cursor,
  deepseek,
  'gemini-cli': geminiCli,
  'github-copilot': githubCopilot,
  grok,
  kimi,
  opencode,
  'qwen-code': qwenCode,
  windsurf,
}

let byName = new Map<string, string>()
let version = 0
const listeners = new Set<() => void>()

/** The kernel's table of products and the names each goes by, as the state brings it. */
export function knowAgentMarks(table: readonly { product: string; names: readonly string[] }[]): void {
  byName = new Map(table.flatMap((m) => m.names.map((n) => [n, m.product] as const)))
  version++
  for (const listen of listeners) listen()
}

const subscribe = (listen: () => void) => {
  listeners.add(listen)
  return () => listeners.delete(listen)
}

/** The icon of the product `name` goes by, matched whole, then by its first word; null for any other name. */
export function useAgentIcon(name: string): string | null {
  useSyncExternalStore(subscribe, () => version)
  const lower = name.toLowerCase()
  const product = byName.get(lower) ?? byName.get(lower.split(/[^a-z0-9]+/)[0] ?? '')
  return product === undefined ? null : (ICONS[product] ?? null)
}
