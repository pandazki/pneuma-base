// Injected by the app into the page it shows. It tells the app which areas drag the window (the
// page marks them with data-drag; controls inside stay clickable), keeps the browser's context menu
// off everything but text, fields and links, and says when the page first has its content and when
// that content is first painted on screen.
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

  // Ready: the page shows something and no placeholder is still waiting for its view. The app shows
  // its window then; animation frames run only once the window is on screen, so the second one
  // after that is the first frame painted.
  let ready = false
  const checkReady = () => {
    if (ready) return
    const root = document.getElementById('root')
    if (!root || root.childElementCount === 0 || document.querySelector('.animate-pulse')) return
    ready = true
    post({ type: 'ready' })
    requestAnimationFrame(() => requestAnimationFrame(() => post({ type: 'painted' })))
  }

  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => {
      schedule()
      checkReady()
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
    window.addEventListener('resize', schedule)
    // A marked header inside a scrolling pane moves with it.
    document.addEventListener('scroll', schedule, true)
    schedule()
    checkReady()
  })

  document.addEventListener('contextmenu', (e) => {
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable], a[href]')) return
    if (!window.getSelection()?.isCollapsed) return
    e.preventDefault()
  })
})()
