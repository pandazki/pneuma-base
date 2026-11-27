import AppKit
import WebKit

/// Whether the system's glass is drawn. It is not when the owner's settings reduce transparency or
/// raise contrast, or a test hook says so; the window and the menu bar panel then fall back to
/// opaque grounds with a border, and their pages too (`data-transparency`, because this WebKit does
/// not answer prefers-reduced-transparency).
extension WKWebView {
  /// Stops the web view drawing its own ground, so the system's glass under it shows where the page
  /// draws nothing. This is WebKit's private `drawsBackground` key (KVC reaches `_setDrawsBackground:`):
  /// AppKit's WKWebView has no public switch. The public one is SwiftUI's `WebView` with
  /// `webViewContentBackground(.hidden)`, which hands out no WKWebView; the shell's script messages,
  /// user scripts, navigation delegate, context menu, drag and drop and Quick Look would all move onto
  /// `WebPage`. Should the key go, the check keeps the web view's own ground: an opaque sidebar, no crash.
  func clearBackground() {
    guard responds(to: Selector(("_setDrawsBackground:"))) else { return }
    setValue(false, forKey: "drawsBackground")
  }
}

@MainActor
enum Transparency {
  /// The test hooks' stand-in for the system's setting, which they must not change.
  static var forcedReduced = false {
    didSet { NotificationCenter.default.post(name: didChange, object: nil) }
  }
  static let didChange = Notification.Name("dev.pneumabase.transparency")
  private static var observing = false

  static var reduced: Bool {
    let ws = NSWorkspace.shared
    return forcedReduced || ws.accessibilityDisplayShouldReduceTransparency || ws.accessibilityDisplayShouldIncreaseContrast
  }

  /// What the page is told: `glass`, the system's glass is under it; `reduced`, it is not.
  static var word: String { reduced ? "reduced" : "glass" }

  /// Set before the page's first frame, so the page starts right; changes come as `pneuma-shell` events.
  static var userScript: WKUserScript {
    WKUserScript(source: "document.documentElement.dataset.transparency = '\(word)'", injectionTime: .atDocumentStart, forMainFrameOnly: true)
  }

  static var event: String { "window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: { transparency: '\(word)' } }))" }

  /// Calls `change` whenever the answer may have changed: the system's display options or the hook's flag.
  static func observe(_ change: @escaping @MainActor () -> Void) {
    if !observing {
      observing = true
      NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { NotificationCenter.default.post(name: didChange, object: nil) }
      }
    }
    NotificationCenter.default.addObserver(forName: didChange, object: nil, queue: .main) { _ in MainActor.assumeIsolated { change() } }
  }
}

/// The main window's content: the window's ground, a pane of the system's glass where the page leaves
/// one clear (the sidebar; shell.js reports its box), and the page on top. The ground is drawn here,
/// not by the page, so a live resize never shows the desktop through an edge the page has not drawn
/// yet; it has a hole where the glass is. The window is clear, so the glass shows what is behind it,
/// as a sidebar did before the system's own sidebars took the window's content instead. In full
/// screen nothing is behind: the window is opaque and the glass takes the ground's colour. With
/// transparency reduced there is no glass and no hole: the page draws its own ground and an opaque
/// sidebar with a border.
@MainActor
final class GlassContainer: NSView {
  private let ground = GroundView()
  private(set) var panes: [NSGlassEffectView] = []
  private(set) weak var web: WKWebView?
  /// A colourful view behind everything, put there by a test hook to stand for the desktop.
  private var backdrop: NSView?
  /// How long after the page posted a pane's box the glass took it, in milliseconds, while a test measures.
  var latencies: [Double]?

  override var isFlipped: Bool { true }

  init() {
    super.init(frame: .zero)
    ground.frame = bounds
    ground.autoresizingMask = [.width, .height]
    addSubview(ground)
    Transparency.observe { [weak self] in
      self?.update()
      self?.web?.evaluateJavaScript(Transparency.event)
    }
    for name in [NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.update() }
      }
    }
  }

  required init?(coder: NSCoder) { nil }

  /// The container with `web` on top, filling it: what the window's content view becomes.
  func hosting(_ web: WKWebView) -> NSView {
    self.web?.removeFromSuperview()
    web.frame = bounds
    web.autoresizingMask = [.width, .height]
    addSubview(web)
    self.web = web
    return self
  }

  /// Tells the page what it is drawn on: after it loads, as the user script's value may be older.
  func tellPage() { web?.evaluateJavaScript(Transparency.event) }

  /// The page's panes, `[x, y, width, height, radius]` in CSS pixels from its top left, which are
  /// points here. Taken at once, with no animation, in the same pass as the page's own frame.
  func place(_ value: Any?, postedAt: Double?) {
    let boxes = (value as? [[Double]] ?? []).filter { $0.count == 5 }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    while panes.count > boxes.count { panes.removeLast().removeFromSuperview() }
    while panes.count < boxes.count {
      let pane = NSGlassEffectView()
      // The glass takes its shape from its content: an empty view of its size.
      let content = NSView()
      content.autoresizingMask = [.width, .height]
      pane.contentView = content
      // Its height follows the window's at once; the page's next box confirms it.
      pane.autoresizingMask = [.height]
      addSubview(pane, positioned: .above, relativeTo: ground)
      panes.append(pane)
    }
    for (pane, box) in zip(panes, boxes) {
      pane.frame = CGRect(x: box[0], y: box[1], width: box[2], height: box[3])
      pane.contentView?.frame = pane.bounds
      pane.cornerRadius = box[4]
    }
    update()
    CATransaction.commit()
    if let postedAt, latencies != nil { latencies?.append(Date().timeIntervalSince1970 * 1000 - postedAt) }
  }

  override func resizeSubviews(withOldSize oldSize: NSSize) {
    super.resizeSubviews(withOldSize: oldSize)
    cutGround()
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    update()
  }

  /// The window, the glass and the ground, as transparency and full screen now say.
  func update() {
    let glass = !Transparency.reduced
    for pane in panes { pane.isHidden = !glass }
    cutGround()
    guard let window else { return }
    let clear = glass && !window.styleMask.contains(.fullScreen)
    window.isOpaque = !clear
    window.backgroundColor = clear ? .clear : pageColor
  }

  private func cutGround() {
    ground.holes = panes.filter { !$0.isHidden }.map { ($0.frame, $0.cornerRadius) }
  }

  /// The test hooks' desktop: a colourful view behind the window's content, seen only through the glass.
  func setBackdrop(_ on: Bool) {
    backdrop?.removeFromSuperview()
    backdrop = nil
    guard on else { return }
    let view = DesktopView(frame: bounds)
    view.autoresizingMask = [.width, .height]
    addSubview(view, positioned: .below, relativeTo: ground)
    backdrop = view
  }
}

/// The window's ground, the page's own colour, with holes where the glass is.
private final class GroundView: NSView {
  var holes: [(CGRect, CGFloat)] = [] {
    didSet { if !holes.elementsEqual(oldValue, by: { $0.0 == $1.0 && $0.1 == $1.1 }) { needsLayout = true } }
  }
  private var shape: CAShapeLayer { layer as! CAShapeLayer }

  override var isFlipped: Bool { true }
  override func makeBackingLayer() -> CALayer {
    let layer = CAShapeLayer()
    layer.fillRule = .evenOdd
    return layer
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layerContentsRedrawPolicy = .never
  }

  required init?(coder: NSCoder) { nil }

  override func setFrameSize(_ size: NSSize) {
    super.setFrameSize(size)
    needsLayout = true
  }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let path = CGMutablePath()
    path.addRect(bounds)
    for (rect, radius) in holes { path.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)) }
    shape.path = path
    effectiveAppearance.performAsCurrentDrawingAppearance { shape.fillColor = pageColor.cgColor }
    CATransaction.commit()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsLayout = true
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// The menu bar panel's frame: one pane of the system's glass under the page, as the system's own menu
/// bar extras have; with transparency reduced, an opaque ground with a border instead. The page stays
/// where it is above either: a web view moved between views stops drawing.
@MainActor
final class TrayFrame: NSView {
  static let radius: CGFloat = 20
  private let glass = NSGlassEffectView()
  private let plain = NSView()
  private var backdrop: NSView?
  var web: WKWebView? {
    didSet {
      oldValue?.removeFromSuperview()
      guard let web else { return }
      web.frame = bounds
      web.autoresizingMask = [.width, .height]
      addSubview(web)
    }
  }

  init() {
    super.init(frame: .zero)
    for view in [glass, plain] {
      view.frame = bounds
      view.autoresizingMask = [.width, .height]
      addSubview(view)
    }
    // The glass takes its shape from its content: an empty view of its size.
    let content = NSView()
    content.autoresizingMask = [.width, .height]
    glass.contentView = content
    glass.cornerRadius = Self.radius
    plain.wantsLayer = true
    plain.layer?.cornerRadius = Self.radius
    plain.layer?.cornerCurve = .continuous
    plain.layer?.borderWidth = 1
    Transparency.observe { [weak self] in
      self?.arrange()
      self?.web?.evaluateJavaScript(Transparency.event)
    }
    arrange()
  }

  required init?(coder: NSCoder) { nil }

  /// Whether the frame is glass now: what the test hooks report.
  var isGlass: Bool { !glass.isHidden }
  var glassRadius: CGFloat { glass.cornerRadius }

  private func arrange() {
    glass.isHidden = Transparency.reduced
    plain.isHidden = !Transparency.reduced
    paint()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    paint()
  }

  private func paint() {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      plain.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
      plain.layer?.borderColor = NSColor.separatorColor.cgColor
    }
  }

  /// The test hooks' desktop behind the panel.
  func setBackdrop(_ on: Bool) {
    backdrop?.removeFromSuperview()
    backdrop = nil
    guard on else { return }
    let view = DesktopView(frame: bounds)
    view.autoresizingMask = [.width, .height]
    addSubview(view, positioned: .below, relativeTo: nil)
    backdrop = view
  }
}

/// A colourful stand-in for a desktop picture, with sharp shapes so the glass's blur shows.
private final class DesktopView: NSView {
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    let base = CAGradientLayer()
    base.colors = [NSColor.systemIndigo, .systemPurple, .systemPink, .systemOrange].map(\.cgColor)
    base.startPoint = CGPoint(x: 0, y: 1)
    base.endPoint = CGPoint(x: 1, y: 0)
    base.frame = CGRect(x: 0, y: 0, width: 3000, height: 2000)
    layer?.addSublayer(base)
    let shapes: [(CGFloat, CGFloat, CGFloat, NSColor)] = [(40, 120, 180, .systemTeal), (160, 420, 140, .systemYellow), (60, 620, 90, .white), (220, 260, 60, .systemGreen), (900, 300, 260, .systemBlue)]
    for (x, y, d, color) in shapes {
      let dot = CALayer()
      dot.frame = CGRect(x: x, y: y, width: d, height: d)
      dot.cornerRadius = d / 2
      dot.backgroundColor = color.cgColor
      layer?.addSublayer(dot)
    }
    for i in 0..<60 {
      let line = CALayer()
      line.frame = CGRect(x: CGFloat(i) * 36, y: 0, width: 6, height: 2000)
      line.backgroundColor = NSColor.black.withAlphaComponent(0.18).cgColor
      layer?.addSublayer(line)
    }
  }

  required init?(coder: NSCoder) { nil }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// MARK: What the test hooks call

/// `glass:<what>`, from the test hooks: `reduce` and `normal` (the shell's own stand-in for the
/// system's setting), `backdrop` and `backdrop:off` (a colourful desktop behind the window and the
/// panel), `report:<file>` (what is glass, where, and what the page drew), `capture:<file>` and
/// `capture-tray:<file>` (a picture of the window or the panel as the screen shows it),
/// `resize:<width>,<height>`, `frames:<file>` (frame times while the sidebar's edge is dragged, while
/// it folds, and while the main panel scrolls with and without the palette open).
@MainActor
func glassForTest(_ command: String, window: MainWindow, tray: TrayPanel) {
  let (what, arg) = command.firstIndex(of: ":").map { (String(command[..<$0]), String(command[command.index(after: $0)...])) } ?? (command, "")
  switch what {
  case "reduce": Transparency.forcedReduced = true
  case "normal": Transparency.forcedReduced = false
  case "backdrop":
    window.glass.setBackdrop(arg != "off")
    tray.frame.setBackdrop(arg != "off")
  case "report": glassReport(window.glass, tray: tray.frame, to: URL(fileURLWithPath: arg))
  case "capture": captureWindow(window.glass.window, to: URL(fileURLWithPath: arg))
  case "capture-tray": captureWindow(tray.frame.window, to: URL(fileURLWithPath: arg))
  case "resize":
    let wh = arg.split(separator: ",").compactMap { Double($0) }
    guard wh.count == 2, let w = window.glass.window else { return }
    w.setFrame(NSRect(x: w.frame.minX, y: w.frame.maxY - wh[1], width: wh[0], height: wh[1]), display: true)
    Log.line("glass: resized to \(Int(wh[0]))x\(Int(wh[1]))")
  case "frames": FrameMeter.run(window.glass, to: URL(fileURLWithPath: arg))
  default: Log.line("glass: no such hook \(what)")
  }
}

private func box(_ r: CGRect, _ radius: CGFloat) -> String {
  "\(Int(r.minX.rounded())),\(Int(r.minY.rounded())),\(Int(r.width.rounded())),\(Int(r.height.rounded())) r\(Int(radius.rounded()))"
}

/// Lines a check can match: the window's state, each pane of glass, the ground's holes, the panel's
/// frame, and what the page says it drew: its sidebar's box and ground, and the glass material its floating layers wear.
@MainActor
private func glassReport(_ glass: GlassContainer, tray: TrayFrame, to url: URL) {
  var lines = [
    "window: \(glass.window?.isOpaque == false ? "clear" : "opaque")",
    "transparency: \(Transparency.word)",
  ]
  lines += glass.panes.map { "pane: \(box($0.frame, $0.cornerRadius)) \($0.isHidden ? "hidden" : "glass")" }
  lines.append("tray: \(tray.web == nil ? "not made" : tray.isGlass ? "glass r\(Int(tray.glassRadius))" : "opaque")")
  let js = """
    (() => {
      const side = document.querySelector('[data-glass]'), r = side?.getBoundingClientRect(), cs = side && getComputedStyle(side)
      const probe = document.createElement('div'); probe.className = 'glass'; document.body.append(probe)
      const g = getComputedStyle(probe), material = [g.backdropFilter || g.webkitBackdropFilter, g.backgroundColor].join(' '); probe.remove()
      return [
        'page transparency: ' + (document.documentElement.dataset.transparency ?? 'none'),
        'page sidebar: ' + (r ? [r.x, r.y, r.width, r.height].map(Math.round).join(',') + ' r' + Math.round(parseFloat(cs.borderTopLeftRadius)) : 'none'),
        'page sidebar ground: ' + (cs?.backgroundColor ?? 'none'),
        'page ground: ' + getComputedStyle(document.body).backgroundColor,
        'page glass: ' + material,
      ].join('\\n')
    })()
    """
  guard let web = glass.web else {
    try? (lines + ["page: none"]).joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    return Log.line("glass: wrote \(url.lastPathComponent)")
  }
  web.evaluateJavaScript(js) { result, _ in
    MainActor.assumeIsolated {
      try? (lines + [(result as? String) ?? "page: no answer"]).joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
      Log.line("glass: wrote \(url.lastPathComponent)")
    }
  }
}

/// A picture of one of the app's own windows as the screen shows it, glass and all: the window server
/// composites the glass, so a view's own drawing cannot show it. `CGWindowListCreateImage` is marked
/// obsolete in the SDK for ScreenCaptureKit, which lists windows only with the screen-recording
/// permission; for the app's own window this call needs none, so it is looked up by name.
@MainActor
func captureWindow(_ window: NSWindow?, to url: URL) {
  typealias Create = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
  guard let window, window.isVisible, let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else {
    return Log.line("capture: no window")
  }
  // This window alone (including-window), without its shadow, at the screen's resolution.
  let image = unsafeBitCast(symbol, to: Create.self)(.null, 1 << 3, UInt32(window.windowNumber), 1 << 0 | 1 << 3)?.takeRetainedValue()
  guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return Log.line("capture: failed") }
  try? png.write(to: url)
  Log.line("capture: wrote \(url.lastPathComponent)")
}

/// Frame times of the page (its animation frames) and of the shell (the display's frames as the main
/// thread sees them) while the sidebar's edge is dragged by real mouse events, while the sidebar folds
/// and unfolds, and while the main panel scrolls with and without the palette open; and how long the
/// glass took to follow the page's boxes.
@MainActor
final class FrameMeter: NSObject {
  private static var running: FrameMeter?
  private let glass: GlassContainer
  private let url: URL
  private var link: CADisplayLink?
  private var ticks: [Double] = []
  /// The drag in progress: where it started in the window, how many frames it lasts, which frame it is at.
  private var drag: (start: NSPoint, frames: Int, at: Int)?
  private var dragDone: CheckedContinuation<Void, Never>?
  private var lines: [String] = []

  static func run(_ glass: GlassContainer, to url: URL) {
    guard running == nil, glass.web != nil, let window = glass.window else { return Log.line("frames: not now") }
    let meter = FrameMeter(glass: glass, url: url)
    running = meter
    let hz = window.screen?.maximumFramesPerSecond ?? 60
    meter.lines.append("display: \(hz) Hz, a frame every \(String(format: "%.1f", 1000 / Double(hz))) ms; the page's frames counted long past 1.5 of WebKit's 60 Hz, the shell's past 1.5 of the display's")
    Task { @MainActor in
      await meter.measure(nominal: 1000 / Double(hz))
      try? meter.lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
      Log.line("frames: wrote \(url.lastPathComponent)")
      running = nil
    }
  }

  private init(glass: GlassContainer, url: URL) {
    self.glass = glass
    self.url = url
  }

  private func js(_ source: String) async -> String? {
    guard let web = glass.web else { return nil }
    return await withCheckedContinuation { (done: CheckedContinuation<String?, Never>) in
      web.evaluateJavaScript(source) { result, _ in done.resume(returning: result.map { "\($0)" }) }
    }
  }

  private func pause(_ seconds: Double) async { try? await Task.sleep(for: .seconds(seconds)) }

  /// Records page and shell frames and the glass's delays around `body`.
  private func recorded(_ name: String, nominal: Double, _ body: () async -> String?) async {
    // In a function: a top-level `const` would be declared again by the next scenario's script, which then throws.
    _ = await js("(() => { const frames = []; window.__pbFrames = frames; const run = (window.__pbRun ?? 0) + 1; window.__pbRun = run; (function f(t) { if (window.__pbRun !== run) return; frames.push(t); requestAnimationFrame(f) })(performance.now()) })(); 0")
    ticks = []
    glass.latencies = []
    let link = glass.displayLink(target: self, selector: #selector(tick(_:)))
    link.add(to: .main, forMode: .common)
    self.link = link
    let note = await body()
    link.invalidate()
    self.link = nil
    let page = (await js("window.__pbRun += 1; JSON.stringify(window.__pbFrames)")).flatMap { try? JSONDecoder().decode([Double].self, from: Data($0.utf8)) } ?? []
    var line = "\(name): page \(Self.stats(Array(page.dropFirst()), nominal: Self.pageFrame)); shell \(Self.stats(ticks, nominal: nominal))"
    if let lat = glass.latencies, !lat.isEmpty {
      let sorted = lat.sorted()
      line += String(format: "; glass took the page's box %.1f ms after it was posted (median), %.1f max, %d boxes", sorted[sorted.count / 2], sorted.last ?? 0, sorted.count)
    }
    if let note { line += "; \(note)" }
    glass.latencies = nil
    lines.append(line)
  }

  /// WebKit draws a page at most 60 times a second, whatever the display does.
  private static let pageFrame = 1000.0 / 60

  private static func stats(_ stamps: [Double], nominal: Double) -> String {
    let gaps = zip(stamps.dropFirst(), stamps).map { $0 - $1 }.sorted()
    guard !gaps.isEmpty else { return "no frames" }
    let long = gaps.filter { $0 > nominal * 1.5 }.count
    return String(format: "%d frames, median %.1f ms, p95 %.1f, max %.1f, %d longer than 1.5 frames", gaps.count + 1, gaps[gaps.count / 2], gaps[min(gaps.count - 1, Int(Double(gaps.count) * 0.95))], gaps.last ?? 0, long)
  }

  private func measure(nominal: Double) async {
    // The sidebar's edge, by real mouse events through the window: out 120 points and back over 1.5 seconds.
    if let at = await js("(() => { const r = document.querySelector('.resizer-side')?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2].join(',') : '' })()"),
       case let xy = at.split(separator: ",").compactMap({ Double($0) }), xy.count == 2, let web = glass.web {
      let p = NSPoint(x: xy[0], y: web.isFlipped ? xy[1] : web.bounds.height - xy[1])
      let start = web.convert(p, to: nil)
      // The first click on a window behind another only brings it forward.
      glass.window?.makeKeyAndOrderFront(nil)
      await pause(0.3)
      await recorded("drag the sidebar's edge", nominal: nominal) {
        post(.leftMouseDown, at: start)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
          dragDone = done
          drag = (start, Int(1.5 * 1000 / nominal), 0)
        }
        post(.leftMouseUp, at: start)
        await pause(0.3)
        return nil
      }
    } else {
      lines.append("drag the sidebar's edge: no edge on the page")
    }
    for (name, state) in [("fold the sidebar", "收起侧栏"), ("unfold the sidebar", "展开侧栏")] {
      await recorded(name, nominal: nominal) {
        _ = await js("document.querySelector('[aria-label=\"\(state)\"]')?.click(); 0")
        await pause(0.7)
        return nil
      }
    }
    let scroll = """
      (() => { const m = document.querySelector('.main'), max = m.scrollHeight - m.clientHeight, t0 = performance.now(); let dir = 1
        const step = (t) => { if (t - t0 > 2000) return; m.scrollTop = Math.max(0, Math.min(max, m.scrollTop + dir * 8)); if (m.scrollTop >= max || m.scrollTop <= 0) dir = -dir; requestAnimationFrame(step) }
        requestAnimationFrame(step); return max })()
      """
    let key = "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); 0"
    await recorded("scroll the main panel", nominal: nominal) {
      let range = await js(scroll)
      await pause(2.2)
      return "scrolling \(range ?? "?") px up and down"
    }
    _ = await js(key)
    await pause(0.5)
    await recorded("scroll the main panel, palette open", nominal: nominal) {
      let range = await js(scroll)
      await pause(2.2)
      let open = await js("String(!!document.querySelector('.palette'))")
      return "scrolling \(range ?? "?") px up and down, palette open: \(open ?? "?")"
    }
    _ = await js(key)
    await pause(0.3)
  }

  @objc private func tick(_ link: CADisplayLink) {
    ticks.append(link.timestamp * 1000)
    guard var d = drag else { return }
    d.at += 1
    let dx = 120 * sin(Double.pi * Double(d.at) / Double(d.frames))
    post(.leftMouseDragged, at: NSPoint(x: d.start.x + dx, y: d.start.y))
    drag = d.at >= d.frames ? nil : d
    if d.at >= d.frames {
      dragDone?.resume()
      dragDone = nil
    }
  }

  private func post(_ type: NSEvent.EventType, at point: NSPoint) {
    guard let window = glass.window,
          let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
    else { return }
    NSApp.postEvent(event, atStart: false)
  }
}
