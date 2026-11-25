// The frame kit: what a plugin's own page loads, by <script src="/plugin-kit/frame.js">, to live in a
// `custom` block of the management UI. It takes the block's data and the UI's look from the page
// around it, and sends back the only three things a frame may ask for. Typed and documented for
// plugin authors in @pneuma-base/sdk/frame.
;(() => {
  const listeners = []
  let last = null
  const send = (message) => window.parent.postMessage({ pneuma: 1, ...message }, '*')

  window.addEventListener('message', (event) => {
    const m = event.data
    if (event.source !== window.parent || m === null || typeof m !== 'object' || m.pneuma !== 1 || m.type !== 'data') return
    const root = document.documentElement
    for (const [name, value] of Object.entries(m.tokens ?? {})) if (name.startsWith('--')) root.style.setProperty(name, value)
    root.style.colorScheme = m.scheme
    root.dataset.scheme = m.scheme
    last = m
    for (const callback of listeners) callback(m.data, { scheme: m.scheme, actions: m.actions })
  })

  // The content's height, whenever it changes; the first report also tells the page the frame is ready.
  let reported = -1
  const report = () => {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (height === reported) return
    reported = height
    send({ type: 'height', height })
  }
  const observer = new ResizeObserver(report)
  observer.observe(document.documentElement)
  if (document.body) observer.observe(document.body)
  else document.addEventListener('DOMContentLoaded', () => observer.observe(document.body))

  window.pneuma = {
    /** Calls `callback(data, { scheme, actions })` with the block's data now if it came, and each time the view is fetched again. */
    onData(callback) {
      listeners.push(callback)
      if (last !== null) callback(last.data, { scheme: last.scheme, actions: last.actions })
    },
    /** Asks the page to run the block's action `name`; the page confirms it with the person as for any action. */
    run(name, values = {}) {
      send({ type: 'run', name, values })
    },
    /** Opens a view, `{ view, params, target }`, or an outside http or https address given as a string. */
    open(link) {
      send(typeof link === 'string' ? { type: 'open', href: link } : { type: 'open', link })
    },
  }
})()
