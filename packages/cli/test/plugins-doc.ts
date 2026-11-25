// PLUGINS.md as the tests that keep it true read it: its fenced blocks, each with the marker comment
// on the line before it, and a way to run a shell block as written, including one that ends by
// serving the management UI until it is stopped.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const STANDARD = fileURLToPath(new URL('../../../PLUGINS.md', import.meta.url))

/** A fenced block: its info string, its text, the line its opening fence is on, and the marker `<!-- … -->` on the line before, if any. */
export type Fence = { lang: string; body: string; line: number; marker: string | null }

/** The blocks of a Markdown text, outermost only: a block inside a longer fence is part of that block's text. */
export function fences(text: string): Fence[] {
  const lines = text.split('\n')
  const out: Fence[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})(\S*)\s*$/.exec(lines[i] as string)
    if (!open) continue
    const ticks = (open[1] as string).length
    let close = i + 1
    while (close < lines.length && !new RegExp(`^\`{${ticks},}\\s*$`).test(lines[close] as string)) close++
    const before = lines.slice(0, i).reverse().find((l) => l.trim() !== '') ?? ''
    out.push({ lang: open[2] as string, body: lines.slice(i + 1, close).join('\n'), line: i + 1, marker: /^<!-- (\S+) -->$/.exec(before.trim())?.[1] ?? null })
    i = close
  }
  return out
}

/** The marker of a shell block that installs from the registry, so it runs in `pnpm test:slow`. */
export const SLOW = 'test:slow'

/** The marker of a text block right after a shell block: lines that block prints, in order, standard output first. */
export const OUTPUT = 'output'

/** The lines of `block`'s output block that its run did not print, in order; empty when it has none. */
export function unprinted(blocks: readonly Fence[], block: Fence, ran: Ran): string[] {
  const next = blocks[blocks.indexOf(block) + 1]
  if (next?.marker !== OUTPUT) return []
  const printed = `${ran.stdout}\n${ran.stderr}`
  let at = 0
  const missing: string[] = []
  for (const line of next.body.split('\n')) {
    const found = printed.indexOf(line, at)
    if (found === -1) missing.push(line)
    else at = found + line.length
  }
  return missing
}

const ADDRESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/

export type Ran = { code: number; stdout: string; stderr: string }

/**
 * Runs `script` with `sh -e`. A script that prints the UI's address is serving it: `served(url)` checks
 * the page, then the whole process group is stopped and the run counts as ended well. Rejects when
 * the script has neither ended nor served after `timeout` milliseconds.
 */
export function runBlock(script: string, opts: { cwd: string; env: Record<string, string>; timeout: number; served?: (url: string) => Promise<void> }): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn('sh', ['-e', script], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let serving = false
    const stop = () => {
      try {
        process.kill(-(child.pid as number), 'SIGINT')
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          process.kill(-(child.pid as number), 'SIGKILL')
        } catch {
          // already gone
        }
      }, 5_000).unref()
    }
    const timer = setTimeout(() => {
      stop()
      fail(new Error(`the block ran longer than ${opts.timeout / 1000} s\n${stdout}${stderr}`))
    }, opts.timeout)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const match = ADDRESS.exec(stdout)
      if (match === null || serving) return
      serving = true
      ;(async () => {
        const page = await fetch(match[0])
        if (!page.ok) throw new Error(`${match[0]} answered ${page.status}`)
        await opts.served?.(match[0])
      })().then(
        () => stop(),
        (error: Error) => {
          stderr += `\n${error.message}`
          serving = false
          stop()
        },
      )
    })
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: serving ? 0 : (code ?? -1), stdout, stderr })
    })
  })
}

/** Stand-ins for the commands that open a browser, so a block's `pneuma-base view` opens none. */
export const BROWSER_SHIMS = ['open', 'xdg-open']
