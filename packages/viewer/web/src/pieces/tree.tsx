// Folders as a tree, each with how many things it holds, the chosen one marked. Choosing a folder
// sets the view's parameter to its value, so the view is shown again with it, as a filter does, and
// opens it. A folder with folders in it opens and closes by its arrow; the chosen one shows with
// every folder above it open. One folder is in the Tab order; ↑ ↓ move among the folders shown, →
// opens a folder or steps into it, ← closes it or steps out, Home End go to the ends, Enter or Space choose.
import type { Block, TreeNode } from '@pneuma-base/kernel'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useEnv } from '../env'

type Tree = Extract<Block, { kind: 'tree' }>

/** The values from the top down to the folder with `value`, itself included; empty when no folder has it. */
function pathTo(nodes: readonly TreeNode[], value: string): string[] {
  for (const node of nodes) {
    if (node.value === value) return [node.value]
    const below = pathTo(node.children, value)
    if (below.length > 0) return [node.value, ...below]
  }
  return []
}

/** A folder chosen from the keyboard. The view is shown again with it, in a new tree, which gives it the focus back. */
let refocus: { param: string; value: string } | null = null

/** A folder on screen: where it stands and the folder it is in. */
type Shown = { node: TreeNode; depth: number; parent: string | null }

/** The folders on screen, top to bottom: every folder whose folders above it are all open. */
function shownOf(nodes: readonly TreeNode[], open: ReadonlySet<string>, depth = 1, parent: string | null = null): Shown[] {
  return nodes.flatMap((node) => [{ node, depth, parent }, ...(open.has(node.value) ? shownOf(node.children, open, depth + 1, node.value) : [])])
}

export function TreeView({ block }: { block: Tree }) {
  const { onParam } = useEnv()
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(pathTo(block.nodes, block.selected)))
  const [chosen, setChosen] = useState(block.selected)
  const [cursor, setCursor] = useState<string | null>(null)
  const items = useRef(new Map<string, HTMLLIElement>())
  // Chosen anew from elsewhere, such as the address: open the way down to it.
  if (chosen !== block.selected) {
    setChosen(block.selected)
    setOpen((o) => new Set([...o, ...pathTo(block.nodes, block.selected)]))
  }

  const shown = shownOf(block.nodes, open)
  const roving = shown.find((s) => s.node.value === cursor)?.node.value ?? shown.find((s) => s.node.value === block.selected)?.node.value ?? shown[0]?.node.value
  const setOpenOne = (value: string, to: boolean) =>
    setOpen((o) => {
      const next = new Set(o)
      if (to) next.add(value)
      else next.delete(value)
      return next
    })
  const choose = (node: TreeNode, fromKeys = false) => {
    if (node.children.length > 0) setOpenOne(node.value, true)
    if (node.value === block.selected) return
    refocus = fromKeys ? { param: block.param, value: node.value } : null
    onParam(block.param, node.value)
  }
  useEffect(() => {
    if (refocus?.param !== block.param || refocus.value !== block.selected) return
    refocus = null
    items.current.get(block.selected)?.focus()
  }, [block.param, block.selected])
  const focus = (value: string | null | undefined) => {
    if (value === null || value === undefined) return
    setCursor(value)
    items.current.get(value)?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const at = shown.findIndex((s) => s.node.value === (e.target as HTMLElement).dataset.value)
    const here = shown[at]
    if (!here) return
    const { node } = here
    const isOpen = open.has(node.value) && node.children.length > 0
    switch (e.key) {
      case 'ArrowDown':
        focus(shown[Math.min(shown.length - 1, at + 1)]?.node.value)
        break
      case 'ArrowUp':
        focus(shown[Math.max(0, at - 1)]?.node.value)
        break
      case 'Home':
        focus(shown[0]?.node.value)
        break
      case 'End':
        focus(shown.at(-1)?.node.value)
        break
      case 'ArrowRight':
        if (isOpen) focus(node.children[0]?.value)
        else if (node.children.length > 0) setOpenOne(node.value, true)
        break
      case 'ArrowLeft':
        if (isOpen) setOpenOne(node.value, false)
        else focus(here.parent)
        break
      case 'Enter':
      case ' ':
        choose(node, true)
        break
      default:
        return
    }
    e.preventDefault()
  }

  const item = ({ node, depth }: Shown) => {
    const has = node.children.length > 0
    const isOpen = has && open.has(node.value)
    const Icon = isOpen ? FolderOpen : Folder
    return (
      <li
        key={node.value}
        ref={(el) => {
          if (el) items.current.set(node.value, el)
          else items.current.delete(node.value)
        }}
        role="treeitem"
        className="tree-item"
        aria-level={depth}
        aria-expanded={has ? isOpen : undefined}
        aria-selected={node.value === block.selected}
        data-value={node.value}
        tabIndex={node.value === roving ? 0 : -1}
        onFocus={(e) => e.target === e.currentTarget && setCursor(node.value)}
      >
        <div className="tree-row" onClick={() => choose(node)}>
          <span
            className="tree-chev"
            data-open={isOpen || undefined}
            onClick={
              has
                ? (e) => {
                    e.stopPropagation()
                    setOpenOne(node.value, !isOpen)
                  }
                : undefined
            }
          >
            {has ? <ChevronRight strokeWidth={2} aria-hidden /> : null}
          </span>
          <Icon className="tree-icon" strokeWidth={1.75} aria-hidden />
          <span className="tree-label">{node.label}</span>
          {node.count !== null ? <span className="tree-count">{node.count}</span> : null}
        </div>
        {isOpen ? (
          <ul role="group" className="tree-group">
            {node.children.map((child) => item({ node: child, depth: depth + 1, parent: node.value }))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <ul role="tree" aria-label="文件夹" className="tree" onKeyDown={onKeyDown}>
      {block.nodes.map((node) => item({ node, depth: 1, parent: null }))}
    </ul>
  )
}
