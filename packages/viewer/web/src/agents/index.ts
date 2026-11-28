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

/** An icon as the mark draws it: the mark says the name, so the drawing carries none of its own. */
const quiet = (svg: string) => svg.replace(/<title>[^<]*<\/title>/, '').replace('<svg ', '<svg aria-hidden="true" ')

const ICONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
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
  }).map(([product, svg]) => [product, quiet(svg)]),
)

type Mark = { product: string; title: string }
let byName = new Map<string, Mark>()
let version = 0
const listeners = new Set<() => void>()

/** The kernel's table of products and the names each goes by, as the state brings it. */
export function knowAgentMarks(table: readonly { product: string; title: string; names: readonly string[] }[]): void {
  byName = new Map(table.flatMap((m) => m.names.map((n) => [n, { product: m.product, title: m.title }] as const)))
  version++
  for (const listen of listeners) listen()
}

const subscribe = (listen: () => void) => {
  listeners.add(listen)
  return () => listeners.delete(listen)
}

/** The product `name` goes by, matched whole, then by its first word; null for any other name. */
function useMark(name: string): Mark | null {
  useSyncExternalStore(subscribe, () => version)
  const lower = name.toLowerCase()
  return byName.get(lower) ?? byName.get(lower.split(/[^a-z0-9]+/)[0] ?? '') ?? null
}

/** The icon of the product `name` goes by; null for any other name. */
export function useAgentIcon(name: string): string | null {
  const mark = useMark(name)
  return mark === null ? null : (ICONS[mark.product] ?? null)
}

/** The name of the product `name` goes by, as people know it (Claude Code); null for any other name. */
export const useAgentTitle = (name: string): string | null => useMark(name)?.title ?? null
