// Screenshots of the board (light and dark) and of a site's item panel, from the real viewer in
// headless Chrome driven over the DevTools protocol. Publishes three demo sites to PneumaSpace under
// the prefix pbs-shots, sends them some requests, and removes and purges them at the end.
// usage: npm run build && node scripts/shots.mjs <out dir>   (env: SPACE_ADMIN, CHROME)
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { sandbox } from '@pneuma-base/sdk/testkit'

const out = resolve(process.argv[2] ?? 'shots')
const ADMIN = process.env.SPACE_ADMIN ?? 'http://127.0.0.1:18081'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PREFIX = 'pbs-shots'
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
setTimeout(() => (console.error('shots: gave up after 4 minutes'), process.exit(1)), 240_000).unref()

const SITES = {
  notes: { on: true, hits: 14, title: '读书笔记', accent: '#3b6ef5', body: '<p>《设计中的设计》第三章：信息的建筑。</p><p>《写给大家看的设计书》：对齐、重复、对比、亲密。</p>' },
  shop: { on: true, hits: 5, title: '山茶小店', accent: '#c2410c', body: '<p>手作茶具 · 本周上新</p><ul><li>粗陶壶 ¥168</li><li>白瓷杯 ¥42</li></ul>' },
  report: { on: true, hits: 0, title: '十一月周报', accent: '#15803d', body: '<p>本周完成：库的格式、命令行、插件机制。</p><p>下周：查看器和同步。</p>' },
  draft: { on: false, hits: 0, title: '草稿', accent: '#6b7280', body: '<p>还没写完。</p>' },
}
const page = (s) => `<!doctype html><meta charset="utf-8"><title>${s.title}</title><style>body{margin:0;font:18px/1.6 -apple-system,system-ui,sans-serif;color:#1f2937;background:#fafaf9}header{background:${s.accent};color:white;padding:48px 64px}h1{margin:0;font-size:44px}main{padding:32px 64px}</style><header><h1>${s.title}</h1></header><main>${s.body}</main>\n`

const api = async (method, path) => (await fetch(ADMIN + path, { method, headers: { 'x-pneuma-space-manager': 'pneuma-base' } })).json()
async function purge() {
  for (const { name } of (await api('GET', '/api/apps')).filter((a) => a.name.startsWith(`${PREFIX}-`))) {
    await api('POST', `/api/apps/${name}/remove`)
    await api('POST', `/api/apps/${name}/purge`)
  }
}

/** The smallest DevTools protocol client: one browser socket, flat sessions. */
async function chrome() {
  const profile = mkdtempSync(join(tmpdir(), 'space-shots-chrome-'))
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--hide-scrollbars', '--disable-features=IsolateOrigins,site-per-process,IsolateSandboxedIframes', 'about:blank']
  const proc = spawn(CHROME, args, { stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100)
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n')
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)))
  let next = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id))
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const id = ++next
      pending.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)))
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const tab = (method, params) => send(method, params, sessionId)
  const evaluate = async (expression) => (await tab('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value
  const until = async (expression, what) => {
    for (let i = 0; i < 100; i++) if (await evaluate(expression)) return
    else await sleep(150)
    throw new Error(`shots: no ${what}`)
  }
  const shoot = async (file) => writeFileSync(file, Buffer.from((await tab('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  const close = async () => {
    ws.close()
    const exited = new Promise((ok) => proc.once('exit', ok))
    proc.kill()
    await Promise.race([exited, sleep(5000)])
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  return { tab, evaluate, until, shoot, close }
}

mkdirSync(out, { recursive: true })
const sb = await sandbox({ plugins: [dist] })
let browser = null
try {
  await sb.owner(['space', 'target', 'set', '--admin', ADMIN, '--prefix', PREFIX])
  for (const [name, s] of Object.entries(SITES)) {
    mkdirSync(join(sb.work, name))
    writeFileSync(join(sb.work, name, 'index.html'), page(s))
    await sb.agent('claude-code', 's1', ['put', name, '--to', `sites/${name}`, '--made'])
    await sb.agent('claude-code', 's1', ['say', 'deployable', `sites/${name}`])
    if (!s.on) continue
    const url = (await sb.owner(['space', 'on', `sites/${name}`, '--json'])).json.data.url
    for (let i = 0; i < s.hits; i++) await fetch(url)
  }
  writeFileSync(join(sb.work, 'notes', 'index.html'), page({ ...SITES.notes, body: SITES.notes.body + '<p>《看不见的城市》：每座城都是一种记忆。</p>' }))
  await sb.agent('claude-code', 's1', ['put', 'notes', '--to', 'sites/notes', '--made'])
  for (let i = 0; i < 60 && (await api('GET', `/api/usage?app=${PREFIX}-sites-shop`)).buckets?.length === 0; i++) await sleep(1000)

  const viewer = await sb.viewer()
  browser = await chrome()
  const { tab, evaluate, until, shoot } = browser
  await tab('Page.enable')
  await tab('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
  /** The UI opens the first plugin's page; the PneumaSpace page and the board are reached through their entries in the navigation. */
  const openPage = async (title) => {
    await tab('Page.navigate', { url: viewer.url })
    const entry = `[...document.querySelectorAll('nav a, nav button, aside a, aside button')].find((e) => e.textContent.trim() === ${JSON.stringify(title)})`
    await until(`!!${entry}`, `${title} in the navigation`)
    await evaluate(`${entry}.click()`)
  }
  for (const scheme of ['light', 'dark']) {
    await tab('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await openPage('看板')
    await until(`!!document.querySelector('iframe[src*="board.html"]')`, 'board')
    await sleep(2500)
    await evaluate(`(() => { const f = document.querySelector('iframe[src*="board.html"]'); const s = f.closest('section') ?? f; s.scrollIntoView({ block: 'start' }); window.scrollBy(0, -16) })()`)
    await sleep(800)
    await shoot(join(out, `space-board-${scheme}.png`))
  }
  await tab('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await tab('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1240, deviceScaleFactor: 2, mobile: false })
  await openPage('PneumaSpace')
  await until(`[...document.querySelectorAll('tr')].some((r) => r.textContent.includes('sites/notes'))`, 'row of sites/notes')
  await evaluate(`[...document.querySelectorAll('tr')].find((r) => r.textContent.includes('sites/notes')).click()`)
  await until(`!!document.querySelector('iframe[src*="pbs-shots-sites-notes"]')`, 'embedded preview')
  await sleep(2500)
  await evaluate(`[...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === 'PneumaSpace' && e.getBoundingClientRect().left > 700).pop()?.scrollIntoView({ block: 'start' })`)
  await sleep(500)
  await shoot(join(out, 'space-item.png'))
  // The board's switch through the real UI: a click in the board's frame asks the page to run the action.
  // Frames stay in the page's process (site-per-process off), so the board's frame is in the frame tree.
  await openPage('看板')
  await until(`!!document.querySelector('iframe[src*="board.html"]')`, 'board')
  await sleep(1500)
  const frames = []
  const walk = (t) => (frames.push(t.frame), (t.childFrames ?? []).forEach(walk))
  walk((await tab('Page.getFrameTree')).frameTree)
  const board = frames.find((f) => f.url.includes('board.html'))
  if (!board) throw new Error(`shots: no board frame among ${frames.map((f) => f.url).join(' ')}`)
  const { executionContextId } = await tab('Page.createIsolatedWorld', { frameId: board.id })
  await tab('Runtime.evaluate', { contextId: executionContextId, expression: `[...document.querySelectorAll('#off button')].find((b) => b.textContent === '打开').click()` })
  let draft = null
  for (let i = 0; i < 50 && draft?.status !== 'registered'; i++) (await sleep(200), (draft = (await api('GET', '/api/apps')).find((a) => a.name === `${PREFIX}-sites-draft`)))
  console.log(`shots: the board's 打开 on sites/draft, clicked in the UI -> PneumaSpace says ${draft?.status ?? 'no app'}`)
  console.log(`shots: ${['space-board-light.png', 'space-board-dark.png', 'space-item.png'].map((f) => join(out, f)).join(' ')}`)
} finally {
  await purge()
  await browser?.close()
  await sb.cleanup()
}
