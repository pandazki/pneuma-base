// This machine's settings, as rows after the library's own on the configuration page. In a browser,
// how the page looks, kept in this browser. In the Mac app, how the app looks and the app's settings
// of this machine, which the app keeps and tells again whenever one changes, wherever it was changed;
// the settings window, from the section's head, has the same and what needs more room.
import { FolderInput, Palette, Power, Settings2, SquareTerminal, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { About } from './blocks'
import { chooseScheme, useSchemeChoice, type SchemeChoice } from './scheme'
import { IN_SHELL, tellShell } from './shell'

/** What the app tells of this machine's settings. */
type Machine = {
  appearance: SchemeChoice
  ownerFiles: boolean
  login: boolean
  loginNote: string | null
  pathLink: string | null
  pathFolder: string | null
  launcherOnPath: boolean
}

const CHOICES: { value: SchemeChoice; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const isChoice = (v: unknown): v is SchemeChoice => v === 'system' || v === 'light' || v === 'dark'

function parse(v: unknown): Machine | null {
  if (typeof v !== 'object' || v === null) return null
  const m = v as Record<string, unknown>
  if (!isChoice(m.appearance)) return null
  const text = (x: unknown) => (typeof x === 'string' ? x : null)
  return { appearance: m.appearance, ownerFiles: m.ownerFiles === true, login: m.login === true, loginNote: text(m.loginNote), pathLink: text(m.pathLink), pathFolder: text(m.pathFolder), launcherOnPath: m.launcherOnPath === true }
}

/** The app's word on this machine's settings, asked once and kept up to date. */
function useMachine(): Machine | null {
  const [machine, setMachine] = useState<Machine | null>(null)
  useEffect(() => {
    const heard = (e: Event) => {
      const m = parse((e as CustomEvent<{ machine?: unknown }>).detail?.machine)
      if (m) setMachine(m)
    }
    window.addEventListener('pneuma-shell', heard)
    tellShell({ type: 'machine' })
    return () => window.removeEventListener('pneuma-shell', heard)
  }, [])
  return machine
}

function Row({ icon: Icon, name, note, about, children }: { icon: LucideIcon; name: string; note?: string | null; about?: string; children: ReactNode }) {
  return (
    <li data-acts="" data-lead="icon">
      <div className="min-w-0 flex-1">
        <div className="list-cell">
          <span className="cell">
            <Icon strokeWidth={1.75} aria-hidden />
            <span>{name}</span>
          </span>
          {about ? <About text={about} title={name} /> : null}
        </div>
        {note ? <p className="list-note">{note}</p> : null}
      </div>
      {children}
    </li>
  )
}

function Appearance({ value, onChange }: { value: SchemeChoice; onChange(choice: SchemeChoice): void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="外观">
      {CHOICES.map((c) => (
        <button key={c.value} type="button" role="radio" aria-checked={c.value === value} onClick={() => onChange(c.value)}>
          {c.label}
        </button>
      ))}
    </div>
  )
}

function Switch({ name, on, disabled = false, onChange }: { name: string; on: boolean; disabled?: boolean; onChange(on: boolean): void }) {
  return <button type="button" role="switch" className="switch" aria-checked={on} aria-label={name} disabled={disabled} onClick={() => onChange(!on)} />
}

function Section({ title, tools, children }: { title: string; tools?: ReactNode; children: ReactNode }) {
  return (
    <section className="section" aria-label={title}>
      <div className="section-head">
        <h3>{title}</h3>
        {tools}
      </div>
      <ul className="card list">{children}</ul>
    </section>
  )
}

function InBrowser() {
  const choice = useSchemeChoice()
  return (
    <Section title="这个浏览器">
      <Row icon={Palette} name="外观">
        <Appearance value={choice} onChange={chooseScheme} />
      </Row>
    </Section>
  )
}

function InShell() {
  const machine = useMachine()
  if (machine === null) return null
  const set = (key: 'ownerFiles' | 'login' | 'pathLink', value: boolean) => tellShell({ type: 'machine-set', key, value })
  const path = machine.pathLink ?? (machine.launcherOnPath ? '已经在 PATH 上' : null)
  return (
    <Section
      title="这台机器"
      tools={
        <button type="button" className="icon-btn" aria-label="在设置窗口里打开" data-tip="在设置窗口里打开" onClick={() => tellShell({ type: 'settings' })}>
          <Settings2 strokeWidth={1.75} aria-hidden />
        </button>
      }
    >
      <Row icon={Palette} name="外观">
        <Appearance value={machine.appearance} onChange={(value) => tellShell({ type: 'machine-set', key: 'appearance', value })} />
      </Row>
      <Row icon={FolderInput} name="直接放进来的文件算主人的" note="在访达里放进来的记成你的" about="开着时，在访达里拷进库、或直接改了的文件，会记成你带进来的、你改的（看到的，不是谁说的）。">
        <Switch name="直接放进来的文件算主人的" on={machine.ownerFiles} onChange={(on) => set('ownerFiles', on)} />
      </Row>
      <Row icon={SquareTerminal} name="在终端里用 pneuma-base" note={path} about="在你 PATH 上的一个文件夹里放一个叫 pneuma-base 的链接，指向本机的命令。放在哪个文件夹，在设置窗口里选。">
        <Switch name="在终端里用 pneuma-base" on={machine.pathLink !== null} disabled={machine.launcherOnPath} onChange={(on) => set('pathLink', on)} />
      </Row>
      <Row icon={Power} name="登录时打开" note={machine.loginNote}>
        <Switch name="登录时打开" on={machine.login} onChange={(on) => set('login', on)} />
      </Row>
    </Section>
  )
}

export function MachineSettings() {
  return IN_SHELL ? <InShell /> : <InBrowser />
}
