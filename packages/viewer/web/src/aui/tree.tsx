// affectUI Pro – licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
// Adapted from affectUI's Tree View (clean): rows of one height, 16px a level, a chevron that only
// opens and closes, a count at the end, a branch that grows and shrinks, a guide under each open one,
// and the keys of a tree: ↑ ↓ Home End, → opens or goes in, ← closes or goes out, Enter and Space
// choose, a letter jumps.
import type { Block, TreeNode } from '@pneuma-base/kernel'
import { Folder, FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useEnv } from '../env'

type Tree = Extract<Block, { kind: 'tree' }>
type Entry = { node: TreeNode; depth: number; parent: string | null; kids: Entry[] }

function normalize(nodes: readonly TreeNode[]): { roots: Entry[]; byValue: Map<string, Entry> } {
  const byValue = new Map<string, Entry>()
  const walk = (list: readonly TreeNode[], depth: number, parent: string | null): Entry[] =>
    list.flatMap((node) => {
      if (byValue.has(node.value)) return []
      const e: Entry = { node, depth, parent, kids: [] }
      byValue.set(node.value, e)
      e.kids = walk(node.children, depth + 1, node.value)
      return [e]
    })
  return { roots: walk(nodes, 0, null), byValue }
}

/** The values from the top down to `value`: what is open so the chosen folder shows. */
function pathTo(byValue: Map<string, Entry>, value: string): string[] {
  const out: string[] = []
  for (let e = byValue.get(value); e; e = e.parent === null ? undefined : byValue.get(e.parent)) out.push(e.node.value)
  return out
}

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9 6c0 0 6 4.42 6 6s-6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * Folders, one of them chosen. Choosing one sets the view's parameter `param` to its value, and the
 * view is shown again, as a filter does. The top levels and the way to the chosen folder start open.
 */
export function TreeView({ block }: { block: Tree }) {
  const { onParam } = useEnv()
  const root = useRef<HTMLUListElement>(null)
  const els = useRef(new Map<string, HTMLLIElement>())
  const { roots, byValue } = useMemo(() => normalize(block.nodes), [block.nodes])
  const [open, setOpenSet] = useState<Set<string>>(() => new Set([...roots.map((r) => r.node.value), ...pathTo(byValue, block.selected)]))
  const [focused, setFocused] = useState<string | null>(null)
  // The way to a folder chosen from elsewhere, such as the address, opens too.
  useEffect(() => setOpenSet((o) => new Set([...o, ...pathTo(byValue, block.selected)])), [byValue, block.selected])

  const visible = useMemo(() => {
    const out: Entry[] = []
    const walk = (list: Entry[]) => {
      for (const e of list) {
        out.push(e)
        if (e.kids.length > 0 && open.has(e.node.value)) walk(e.kids)
      }
    }
    walk(roots)
    return out
  }, [roots, open])

  const setOpen = (value: string, to: boolean) =>
    setOpenSet((o) => {
      if (o.has(value) === to) return o
      const next = new Set(o)
      if (to) next.add(value)
      else next.delete(value)
      return next
    })
  const choose = (e: Entry) => {
    if (e.node.value !== block.selected) onParam(block.param, e.node.value)
  }
  const focusOn = (value: string | undefined) => value !== undefined && els.current.get(value)?.focus()
  const stop = (visible.find((e) => e.node.value === focused) ?? visible.find((e) => e.node.value === block.selected) ?? visible[0])?.node.value

  const typed = useRef({ text: '', at: 0 })
  const typeAhead = (key: string, from: number) => {
    const now = Date.now()
    const t = typed.current
    t.text = now - t.at > 700 ? key : t.text + key
    t.at = now
    const q = t.text.toLocaleLowerCase()
    for (let k = 1; k <= visible.length; k++) {
      const e = visible[(from + k) % visible.length]
      if (e && e.node.label.toLocaleLowerCase().startsWith(q)) return focusOn(e.node.value)
    }
  }

  const onKeyDown = (ev: KeyboardEvent<HTMLUListElement>) => {
    const el = ev.target as HTMLElement
    if (el.getAttribute('role') !== 'treeitem' || ev.ctrlKey || ev.metaKey || ev.altKey) return
    const e = byValue.get(el.dataset.value ?? '')
    if (!e) return
    const at = visible.indexOf(e)
    const isOpen = e.kids.length > 0 && open.has(e.node.value)
    let done = true
    switch (ev.key) {
      case 'ArrowDown':
        focusOn(visible[at + 1]?.node.value)
        break
      case 'ArrowUp':
        focusOn(visible[at - 1]?.node.value)
        break
      case 'Home':
        focusOn(visible[0]?.node.value)
        break
      case 'End':
        focusOn(visible.at(-1)?.node.value)
        break
      case 'ArrowRight':
        if (e.kids.length > 0) {
          if (!isOpen) setOpen(e.node.value, true)
          else focusOn(e.kids[0]?.node.value)
        }
        break
      case 'ArrowLeft':
        if (isOpen) setOpen(e.node.value, false)
        else focusOn(e.parent ?? undefined)
        break
      case 'Enter':
      case ' ':
        choose(e)
        break
      default:
        if (ev.key.length === 1 && /\S/.test(ev.key)) typeAhead(ev.key, at)
        else done = false
    }
    if (done) ev.preventDefault()
  }

  const level = (list: Entry[]): ReactNode =>
    list.map((e) => {
      const branch = e.kids.length > 0
      const isOpen = branch && open.has(e.node.value)
      const chosen = e.node.value === block.selected
      const Icon = isOpen ? FolderOpen : Folder
      return (
        <li
          key={e.node.value}
          ref={(el) => {
            if (el) els.current.set(e.node.value, el)
            else els.current.delete(e.node.value)
          }}
          role="treeitem"
          data-value={e.node.value}
          aria-selected={chosen}
          aria-expanded={branch ? isOpen : undefined}
          tabIndex={e.node.value === stop ? 0 : -1}
          className="aui-tree-item"
          onFocus={(ev) => ev.target === ev.currentTarget && setFocused(e.node.value)}
        >
          <div
            className="aui-tree-row"
            style={{ ['--aui-tree-d' as string]: e.depth }}
            onClick={() => {
              choose(e)
              if (branch && !isOpen) setOpen(e.node.value, true)
            }}
          >
            <span
              className="aui-tree-chev"
              aria-hidden="true"
              onClick={
                branch
                  ? (ev) => {
                      // The chevron only opens and closes; it does not choose.
                      ev.stopPropagation()
                      setOpen(e.node.value, !isOpen)
                    }
                  : undefined
              }
            >
              {branch ? <Chevron /> : null}
            </span>
            <span className="aui-tree-icon" aria-hidden="true">
              <Icon strokeWidth={1.75} />
            </span>
            <span className="aui-tree-label" title={e.node.label}>
              {e.node.label}
            </span>
            {e.node.count !== null ? <span className="aui-tree-count">{e.node.count}</span> : null}
          </div>
          {branch ? (
            <div className="aui-tree-fold" data-open={isOpen || undefined}>
              <ul role="group" className="aui-tree-group" style={{ ['--aui-tree-d' as string]: e.depth + 1 }}>
                {level(e.kids)}
              </ul>
            </div>
          ) : null}
        </li>
      )
    })

  return (
    <ul ref={root} role="tree" aria-label="文件夹" className="aui-tree" onKeyDown={onKeyDown}>
      {level(roots)}
    </ul>
  )
}
