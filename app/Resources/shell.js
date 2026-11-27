// Injected by the app into the page it shows. It tells the app which areas drag the window (the
// page marks them with data-drag; controls inside stay clickable) and where the page leaves a pane
// clear for the system's glass (data-glass), keeps the browser's context menu off everything but
// text, fields and links, and says when the page first has its content and when that content is
// first painted on screen.
;(() => {
  const post = (message) => window.webkit?.messageHandlers?.shell?.postMessage(message)
  const CONTROLS = 'button, a, input, select, textarea, label, [role="button"], [role="radio"], [role="tab"], [tabindex]:not([tabindex="-1"])'
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return [r.x, r.y, r.width, r.height]
  }

  let last = ''
  const report = () => {
    const areas = [...document.querySelectorAll('[data-drag]')]
    const drag = areas.map(box)
    const nodrag = areas.flatMap((a) => [...a.querySelectorAll(CONTROLS)]).map(box)
    const json = JSON.stringify([drag, nodrag])
    if (json === last) return
    last = json
    post({ type: 'regions', drag, nodrag })
  }
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      report()
    })
  }

  // The panes left clear for the glass, `[x, y, width, height, radius]`, posted from a ResizeObserver:
  // it runs after layout and before paint, so the app moves the glass in the frame the page moves,
  // while the sidebar's edge is dragged or the sidebar folds. `at` lets a measurement time the trip.
  let lastGlass = ''
  const glass = () => {
    const panes = [...document.querySelectorAll('[data-glass]')].map((el) => [...box(el), parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0])
    const json = JSON.stringify(panes)
    if (json === lastGlass) return
    lastGlass = json
    post({ type: 'glass', panes, at: performance.timeOrigin + performance.now() })
  }
  const sizes = new ResizeObserver(glass)
  // A new pane is observed (which reports it); a pane gone is reported at the next frame.
  let panes = 0
  const watchGlass = () => {
    const els = document.querySelectorAll('[data-glass]')
    for (const el of els) sizes.observe(el)
    if (els.length < panes) requestAnimationFrame(glass)
    panes = els.length
  }

  // Ready: the page shows something and no placeholder is still waiting for its view. The app shows
  // its window then; animation frames run only once the window is on screen, so the second one
  // after that is the first frame painted.
  let ready = false
  const checkReady = () => {
    if (ready) return
    const root = document.getElementById('root')
    if (!root || root.childElementCount === 0 || document.querySelector('.loading')) return
    ready = true
    post({ type: 'ready' })
    requestAnimationFrame(() => requestAnimationFrame(() => post({ type: 'painted' })))
  }

  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => {
      schedule()
      watchGlass()
      checkReady()
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
    window.addEventListener('resize', () => {
      schedule()
      glass()
    })
    // A marked header inside a scrolling pane moves with it.
    document.addEventListener('scroll', schedule, true)
    schedule()
    watchGlass()
    checkReady()
  })

  document.addEventListener('contextmenu', (e) => {
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable], a[href]')) return
    if (!window.getSelection()?.isCollapsed) return
    e.preventDefault()
  })
})()
