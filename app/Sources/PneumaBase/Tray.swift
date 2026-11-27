import AppKit
import WebKit

/// The menu bar panel: a borderless panel dropped under the icon, as the system's own menu bar extras
/// are, rounded, with a hairline and a shadow, holding the page's panel layout (`?shell=mac&panel=tray`),
/// the home page's blocks drawn small on the page's own ground. It closes when it stops being the key
/// window (a click anywhere else), on Escape, and on a second click on the icon. The web view is made
/// the first time the panel opens and kept, so it opens at once after that; the page asks the server
/// anything only while the panel is on screen. The page tells the app its height, and how many things wait.
@MainActor
final class TrayPanel: NSObject, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
  static let width: CGFloat = 340
  /// The tallest the panel grows: what fits under the menu bar of a 13-inch display at its larger text size.
  static let tallest: CGFloat = 600
  /// Between the menu bar and the panel's top, in points.
  private static let gap: CGFloat = 6
  private let frame = TrayFrame()
  private var panel: TrayWindow?
  private var web: WKWebView?
  private var address: URL?
  private var height: CGFloat = 360
  /// The page's messages other than its height: open, its 「···」 menu, quit, how many wait.
  var onMessage: (([String: Any]) -> Void)?
  /// With hooks, the height of the room under the menu bar, as a small display would give it.
  var roomForTest: CGFloat? { didSet { if isShown { place() } } }

  var isShown: Bool { panel?.isVisible ?? false }
  var webView: WKWebView? { web }

  /// A click on the icon while the panel is open closes it: the mouse going down outside the panel
  /// has closed it already, so the click that follows must not open it again.
  func toggle(at button: NSStatusBarButton) {
    if isShown { return close() }
    if Date().timeIntervalSince(closedAt) < 0.3 { return }
    show(at: button)
  }

  private var closedAt = Date.distantPast
  /// Where the panel hangs from: the icon's frame on its screen.
  private var anchor: NSRect?

  func show(at button: NSStatusBarButton) {
    let web = self.web ?? make()
    let panel = self.panel ?? makePanel()
    // The app's appearance, when it has one of its own, wins over the menu bar's.
    panel.appearance = NSApp.appearance
    if web.url == nil, let address { load(address) }
    anchor = button.window.map { $0.convertToScreen(button.convert(button.bounds, to: nil)) }
    place()
    panel.alphaValue = 0
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate()
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.12
      panel.animator().alphaValue = 1
    }
    web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: { panel: 'shown' } }))")
    Log.line("tray: shown")
  }

  func close() {
    guard let panel, panel.isVisible else { return }
    panel.orderOut(nil)
    closedAt = Date()
  }

  func windowDidResignKey(_ notification: Notification) { close() }

  /// Under the icon, centred on it, kept on its screen; the top edge stays put as the height changes.
  private func place() {
    guard let panel, let anchor else { return }
    let screen = NSScreen.screens.first { $0.frame.intersects(anchor) } ?? NSScreen.main
    let visible = screen?.visibleFrame ?? anchor
    // As tall as the content, up to what fits under the menu bar on a small display; the page scrolls past that.
    let room = roomForTest ?? (visible.height - 2 * Self.gap)
    let h = min(max(height, 120), min(room, Self.tallest))
    let x = min(max(anchor.midX - Self.width / 2, visible.minX + 8), visible.maxX - 8 - Self.width)
    panel.setFrame(NSRect(x: x, y: anchor.minY - Self.gap - h, width: Self.width, height: h), display: true)
  }

  /// The app's appearance changed while the panel is open.
  func followAppearance() { panel?.appearance = NSApp.appearance }

  /// The app's menu at a point of the page, in its coordinates.
  func popUp(_ menu: NSMenu, at point: CGPoint) {
    guard let web, isShown else { return }
    menu.appearance = NSApp.appearance
    menu.popUp(positioning: nil, at: NSPoint(x: point.x, y: web.isFlipped ? point.y : web.bounds.height - point.y), in: web)
  }

  var appearanceForTest: NSAppearance? { panel?.effectiveAppearance }
  var windowForTest: NSWindow? { panel }

  func evaluateForTest(_ js: String, _ done: @escaping @MainActor (String) -> Void) { evaluate(web, js, done) }

  /// Whether every row can be seen: the panel and its room, and the page scrolled to its end, with the
  /// last row inside the scrolling body; how tall the tallest row is, and how many buttons have words
  /// other than the asks' answers; for verify.sh.
  func fitForTest(to file: URL) {
    let js = """
      (() => {
        const body = document.querySelector('.tray-body')
        if (!body) return 'no panel'
        body.scrollTop = body.scrollHeight
        const box = body.getBoundingClientRect()
        const rows = [...document.querySelectorAll('.tray .feed-row')]
        const last = rows.at(-1)?.getBoundingClientRect()
        const tallest = Math.max(0, ...rows.map((r) => r.getBoundingClientRect().height))
        const words = [...document.querySelectorAll('.tray button')].filter((b) => !b.closest('.asks-answers') && b.innerText.trim() !== '').length
        return ['rows: ' + rows.length, 'scrolls: ' + (body.scrollHeight > body.clientHeight), 'last row inside: ' + (!!last && last.bottom <= box.bottom + 0.5 && last.top >= box.top - 0.5), 'tallest row: ' + Math.round(tallest), 'text buttons: ' + words, 'page height: ' + innerHeight].join('\\n')
      })()
      """
    let panelHeight = panel?.frame.height ?? 0
    let room = roomForTest.map { "\(Int($0))" } ?? "screen"
    evaluate(web, js) { text in
      try? ("panel: \(Int(panelHeight))\nroom: \(room)\n\(text)\n").write(to: file, atomically: true, encoding: .utf8)
      Log.line("tray-fit: wrote \(file.lastPathComponent)")
    }
  }

  /// The server of the current library, at a new address: the page loads from it the next time, or now if made.
  func serverReady(_ address: URL) {
    self.address = address
    if web != nil { load(address) }
  }

  /// No library any more: the panel has nothing to show until there is one.
  func forget() {
    close()
    address = nil
    web?.loadHTMLString("", baseURL: nil)
  }

  private func load(_ address: URL) {
    guard var components = URLComponents(url: address, resolvingAgainstBaseURL: false) else { return }
    components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "shell", value: "mac"), URLQueryItem(name: "panel", value: "tray")]
    if let url = components.url { web?.load(URLRequest(url: url)) }
  }

  private func make() -> WKWebView {
    let config = WKWebViewConfiguration()
    config.userContentController.add(WeakHandler(self), name: "shell")
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: Self.width, height: height), configuration: config)
    web.underPageBackgroundColor = pageColor
    web.allowsMagnification = false
    web.navigationDelegate = self
    self.web = web
    frame.web = web
    return web
  }

  private func makePanel() -> TrayWindow {
    let panel = TrayWindow(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: height), styleMask: [.borderless], backing: .buffered, defer: true)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .popUpMenu
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.moveToActiveSpace, .transient, .ignoresCycle]
    panel.delegate = self
    panel.onEscape = { [weak self] in self?.close() }
    frame.frame = NSRect(x: 0, y: 0, width: Self.width, height: height)
    panel.contentView = frame
    self.panel = panel
    return panel
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    // Only the app's own page speaks to the shell: a plugin's view runs in a frame of it, and must not open files or run a terminal.
    guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    if type == "height", let height = body["height"] as? Double {
      self.height = CGFloat(height)
      if isShown { place() }
      return
    }
    // A link or a button that leads to the window closes the panel first.
    if type == "open" || type == "quit" || type == "choose" { close() }
    onMessage?(body)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Log.line("tray: web content process ended, reloading")
    if let address { load(address) }
  }
}

/// The panel's frame: the web view, rounded as the system's menus are, with a hairline over its edge.
private final class TrayFrame: NSView {
  static let radius: CGFloat = 12
  var web: WKWebView? {
    didSet {
      oldValue?.removeFromSuperview()
      guard let web else { return }
      web.frame = bounds
      web.autoresizingMask = [.width, .height]
      addSubview(web, positioned: .below, relativeTo: nil)
    }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = Self.radius
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
    layer?.borderWidth = 0.5
  }

  convenience init() { self.init(frame: .zero) }
  required init?(coder: NSCoder) { nil }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
  }

  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    effectiveAppearance.performAsCurrentDrawingAppearance { layer?.borderColor = NSColor.separatorColor.cgColor }
  }
}

/// A borderless panel takes the keyboard only when it says it can; Escape closes it.
private final class TrayWindow: NSPanel {
  var onEscape: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override func cancelOperation(_ sender: Any?) { onEscape?() }
}
