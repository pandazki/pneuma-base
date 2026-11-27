// A `custom` block: a plugin's own page in a sandboxed frame. The frame gets the block's data, the
// colour scheme, the design tokens and its actions' names; it may ask for three things only, and an
// action it asks for runs exactly as a button's would. ARCHITECTURE.md「插件自己画的页」; the frame's side is
// typed in @pneuma-base/sdk/frame.
import type { Action, Block, Link } from '@pneuma-base/kernel'
import { FRAME_TOKENS } from '@pneuma-base/sdk/frame'
import { PanelTop } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, outsideUrl } from './api'
import { useEnv } from './env'
import { useScheme } from './scheme'

type Custom = Extract<Block, { kind: 'custom' }>

/** What a frame may send. Anything else, or from anywhere else, is ignored. */
type FrameMessage =
  | { type: 'run'; name: string; values: Record<string, unknown> }
  | { type: 'open'; link: Link }
  | { type: 'open'; href: string }
  | { type: 'height'; height: number }

/** How long a frame has to say it is ready, by its first message, before its place says it failed. */
const READY_MS = 5000
const MAX_HEIGHT = 4000

/** The UI's tokens, by the names the page and the frame kit's stylesheet both use, as the sdk lists them for plugin authors. */
const tokens = (): Record<string, string> => {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(FRAME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()]))
}


type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseLink(v: unknown): Link | null {
  if (!isObject(v) || typeof v.view !== 'string' || !isObject(v.params) || !Object.values(v.params).every((p) => typeof p === 'string')) return null
  return { view: v.view, params: v.params as Record<string, string>, target: v.target === 'panel' ? 'panel' : 'main' }
}

/** The frame's message as one of the three it may send, or null. */
function parseMessage(data: unknown): FrameMessage | null {
  if (!isObject(data) || data.pneuma !== 1) return null
  if (data.type === 'height' && typeof data.height === 'number' && Number.isFinite(data.height)) return { type: 'height', height: data.height }
  if (data.type === 'run' && typeof data.name === 'string') return { type: 'run', name: data.name, values: isObject(data.values) ? data.values : {} }
  if (data.type === 'open') {
    const link = parseLink(data.link)
    if (link) return { type: 'open', link }
    const href = typeof data.href === 'string' ? outsideUrl(data.href) : null
    if (href) return { type: 'open', href }
  }
  return null
}

/** The frame's values for the action's own inputs, and nothing else. */
const declared = (action: Action, values: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(action.inputs.flatMap((i) => (typeof values[i.name] === 'string' ? [[i.name, values[i.name] as string]] : [])))

/** Each action as the frame may know it: its label, tone and inputs, never its call. */
const described = (actions: Custom['actions']) => Object.fromEntries(Object.entries(actions).map(([name, a]) => [name, { label: a.label, tone: a.tone, inputs: a.inputs }]))

export function CustomView({ block }: { block: Custom }) {
  const plugin = block.plugin ?? ''
  const src = api.pluginUiUrl(plugin, block.entry)
  return <Frame key={src} block={block} plugin={plugin} src={src} />
}

function Frame({ block, plugin, src }: { block: Custom; plugin: string; src: string }) {
  const env = useEnv()
  const scheme = useScheme()
  const frame = useRef<HTMLIFrameElement | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [height, setHeight] = useState(block.height)
  const latest = useRef({ block, env })
  latest.current = { block, env }

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === null || event.source !== frame.current?.contentWindow) return
      const message = parseMessage(event.data)
      if (message === null) return
      setPhase('ready')
      const { block, env } = latest.current
      switch (message.type) {
        case 'height':
          setHeight(Math.min(MAX_HEIGHT, Math.max(0, Math.ceil(message.height))))
          break
        case 'open':
          if ('link' in message) env.onLink(message.link)
          else window.open(message.href, '_blank', 'noopener,noreferrer')
          break
        case 'run': {
          const action = Object.hasOwn(block.actions, message.name) ? block.actions[message.name] : undefined
          if (action) void env.onAction(action, declared(action, message.values))
          else console.warn(`插件 ${plugin} 的页要做一件这一块没有声明的事：${message.name}`)
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [plugin])

  useEffect(() => {
    if (phase !== 'loading') return
    const timer = window.setTimeout(() => setPhase('failed'), READY_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  // Once it is ready, and again whenever the view was fetched again or the scheme changed.
  useEffect(() => {
    if (phase !== 'ready') return
    frame.current?.contentWindow?.postMessage({ pneuma: 1, type: 'data', data: block.data ?? null, scheme, tokens: tokens(), actions: described(block.actions) }, '*')
  }, [phase, block, scheme])

  if (phase === 'failed') {
    return (
      <div className="empty" role="alert">
        <span className="empty-icon">
          <PanelTop strokeWidth={1.75} aria-hidden />
        </span>
        <p className="empty-title">插件 {plugin} 的页没能打开</p>
        <p className="empty-hint">
          <span className="font-mono text-[12px]">{block.entry}</span> 没有加载，或者 {READY_MS / 1000} 秒内没有说它准备好了。页面的其余部分不受影响。
        </p>
        <p className="empty-hint whitespace-pre-line text-ink-2">{block.text}</p>
      </div>
    )
  }
  return (
    <div className={phase === 'loading' ? 'loading skeleton' : undefined}>
      <iframe
        ref={frame}
        src={src}
        title={`插件 ${plugin} 的页`}
        aria-label={block.text}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={`-mx-px block w-[calc(100%+2px)] max-w-none border-0 ${phase === 'ready' ? '' : 'opacity-0'}`}
        style={{ height }}
      />
    </div>
  )
}
