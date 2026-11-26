import AppKit
import WebKit

/// The window for the current library: native chrome around the page the server serves. The web
/// view lives only while the window is open, so a closed window costs no web process and no polling.
@MainActor
final class MainWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  private var window: NSWindow?
  private var webView: ShellWebView?
  private var address: URL?
  /// The page's route, kept across closing and reopening: the address fragment.
  private var route: String?
  /// When the window was asked for and is not drawn yet.
  private var requestedAt: Date?
  private var showTimer: Timer?
  var onFiles: (([URL]) -> Void)?

  var isOpen: Bool { window?.isVisible ?? false }

  /// Opens the window, or brings it forward. It is shown once the page has its content, so there is
  /// no blank or white frame; a page that never says so is shown after a second anyway.
  func open(title: String, address: URL?) {
    let window = self.window ?? makeWindow()
    window.title = title
    if window.isVisible {
      bringForward()
      return
    }
    requestedAt = Date()
    Log.line("window: open requested")
    if let address { load(address) }
    showTimer?.invalidate()
    showTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.show(reason: "timeout") }
    }
  }

  /// A new address: the server started, or restarted with a new port and token. The route stays.
  func serverReady(_ address: URL) {
    guard window != nil, webView != nil || requestedAt != nil else { return }
    if let current = webView?.url?.fragment { route = current }
    load(address)
  }

  func close() { window?.performClose(nil) }

  func reload() {
    guard let address else { return }
    if let current = webView?.url?.fragment { route = current }
    load(address)
  }

  func back() { webView?.goBack() }
  func forward() { webView?.goForward() }

  /// After a drop, the files view at the inbox, through the page's own route.
  func showInbox() {
    webView?.evaluateJavaScript("location.hash = 'view=files&view.dir=inbox'")
  }

  private func load(_ address: URL) {
    self.address = address
    let web = webView ?? makeWebView()
    guard var components = URLComponents(url: address, resolvingAgainstBaseURL: false) else { return }
    components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "shell", value: "mac")]
    components.fragment = route
    if let url = components.url { web.load(URLRequest(url: url)) }
  }

  private func show(reason: String) {
    showTimer?.invalidate()
    showTimer = nil
    guard let window, !window.isVisible, let requestedAt else { return }
    Log.line(String(format: "window: shown (%@) %.0f ms after open", reason, Date().timeIntervalSince(requestedAt) * 1000))
    NSApp.setActivationPolicy(.regular)
    bringForward()
  }

  /// Opened from the menu bar or a notification, the app may take focus; when it may not, the
  /// window still comes to the front, without the keyboard.
  private func bringForward() {
    window?.makeKeyAndOrderFront(nil)
    window?.orderFrontRegardless()
    NSApp.activate()
  }

  private func makeWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: true)
    window.isReleasedWhenClosed = false
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    let toolbar = NSToolbar(identifier: "main")
    toolbar.delegate = self
    window.toolbar = toolbar
    window.toolbarStyle = .unified
    window.titlebarSeparatorStyle = .none
    window.backgroundColor = pageColor
    window.minSize = NSSize(width: 720, height: 440)
    window.collectionBehavior = [.fullScreenPrimary]
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("PneumaBaseMain")
    self.window = window
    return window
  }

  private func makeWebView() -> ShellWebView {
    let config = WKWebViewConfiguration()
    let content = config.userContentController
    if let url = Bundle.main.url(forResource: "shell", withExtension: "js"), let source = try? String(contentsOf: url, encoding: .utf8) {
      content.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    content.add(WeakHandler(self), name: "shell")
    let web = ShellWebView(frame: window?.contentView?.bounds ?? .zero, configuration: config)
    web.setValue(false, forKey: "drawsBackground")
    web.underPageBackgroundColor = pageColor
    web.allowsMagnification = false
    web.allowsBackForwardNavigationGestures = false
    web.navigationDelegate = self
    web.uiDelegate = self
    web.onFiles = { [weak self] urls in self?.onFiles?(urls) }
    window?.contentView = web
    // Made first responder now, while the window is not key: becoming key with no first responder
    // selects the first key view as Tab would, and WebKit then puts a focus ring on the first row.
    window?.makeFirstResponder(web)
    webView = web
    return web
  }

  func windowWillClose(_ notification: Notification) {
    endFind()
    if let current = webView?.url?.fragment { route = current }
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "shell")
    webView?.removeFromSuperview()
    webView = nil
    window?.contentView = nil
    requestedAt = nil
    NSApp.setActivationPolicy(.accessory)
    Log.line("window: closed")
  }

  /// The page dims its chrome while the window is not the key window, as the system's own windows do.
  func windowDidBecomeKey(_ notification: Notification) { tellWindowState() }
  func windowDidResignKey(_ notification: Notification) { tellWindowState() }

  private func tellWindowState() {
    let state = window?.isKeyWindow ?? true ? "active" : "inactive"
    webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: { window: '\(state)' } }))")
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "ready":
      show(reason: "ready")
      tellWindowState()
    case "painted":
      if let requestedAt { Log.line(String(format: "window: page drawn %.0f ms after open", Date().timeIntervalSince(requestedAt) * 1000)) }
      requestedAt = nil
    case "regions":
      webView?.setRegions(drag: rects(body["drag"]), noDrag: rects(body["nodrag"]))
    default:
      break
    }
  }

  private func rects(_ value: Any?) -> [CGRect] {
    (value as? [[Double]] ?? []).compactMap { r in r.count == 4 ? CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil }
  }

  /// The page's own address and the frames inside it stay; any other link opens in the browser.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url, action.targetFrame?.isMainFrame ?? false, let address else { return decisionHandler(.allow) }
    if url.host == address.host && url.port == address.port { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if let requestedAt { Log.line(String(format: "window: page loaded %.0f ms after open", Date().timeIntervalSince(requestedAt) * 1000)) }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    Log.line("window: load failed: \(error.localizedDescription)")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Log.line("window: web content process ended, reloading")
    reload()
  }

  var webContentPid: Int32? { (webView?.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value }
}

/// WebKit has no find bar of its own on the Mac: a search field in the toolbar, shown while finding,
/// drives `WKWebView.find`. Return finds the next match, Shift-Return the previous, Escape ends.
extension MainWindow: NSToolbarDelegate, NSSearchFieldDelegate {
  private static let findItem = NSToolbarItem.Identifier("find")

  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    guard id == Self.findItem else { return nil }
    let item = NSSearchToolbarItem(itemIdentifier: id)
    item.searchField.placeholderString = "在这一页里查找"
    item.searchField.sendsWholeSearchString = true
    item.searchField.delegate = self
    item.searchField.target = self
    item.searchField.action = #selector(findFromField(_:))
    return item
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, Self.findItem] }
  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [] }

  private var findField: NSSearchToolbarItem? {
    window?.toolbar?.items.first { $0.itemIdentifier == Self.findItem } as? NSSearchToolbarItem
  }

  func showFind() {
    guard let toolbar = window?.toolbar, window?.isVisible == true else { return }
    if findField == nil {
      toolbar.insertItem(withItemIdentifier: .flexibleSpace, at: 0)
      toolbar.insertItem(withItemIdentifier: Self.findItem, at: 1)
    }
    findField?.beginSearchInteraction()
  }

  func find(backwards: Bool) {
    guard let field = findField?.searchField, !field.stringValue.isEmpty else { return showFind() }
    let config = WKFindConfiguration()
    config.backwards = backwards
    config.wraps = true
    webView?.find(field.stringValue, configuration: config) { result in
      field.textColor = result.matchFound ? .labelColor : .systemRed
    }
  }

  @objc private func findFromField(_ field: NSSearchField) {
    find(backwards: NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false)
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
    endFind()
    return true
  }

  fileprivate func endFind() {
    guard let toolbar = window?.toolbar else { return }
    while !toolbar.items.isEmpty { toolbar.removeItem(at: 0) }
    window?.makeFirstResponder(webView)
  }
}

/// The page's background, so that a resize or the moment before the first paint shows its colour.
private let pageColor = NSColor(name: nil) { appearance in
  appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    ? NSColor(srgbRed: 0.055, green: 0.055, blue: 0.063, alpha: 1)
    : NSColor(srgbRed: 0.973, green: 0.973, blue: 0.973, alpha: 1)
}

/// The content controller keeps its handlers strongly; this breaks the cycle with the window.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: (any WKScriptMessageHandler)?
  init(_ target: any WKScriptMessageHandler) { self.target = target }
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}

/// The page with what a browser does and an app does not taken away: the window drags by the areas
/// the page marks, the browser's context menu items are gone, and files dropped on it go to the library.
final class ShellWebView: WKWebView {
  private var drag: [CGRect] = []
  private var noDrag: [CGRect] = []
  private var overlay: DropOverlay?
  var onFiles: (([URL]) -> Void)?

  func setRegions(drag: [CGRect], noDrag: [CGRect]) {
    self.drag = drag
    self.noDrag = noDrag
  }

  private func pagePoint(_ event: NSEvent) -> CGPoint {
    let p = convert(event.locationInWindow, from: nil)
    return isFlipped ? p : CGPoint(x: p.x, y: bounds.height - p.y)
  }

  /// Whether a press at this point of the page, in CSS pixels from the top left, drags the window.
  func drags(at p: CGPoint) -> Bool {
    drag.contains { $0.contains(p) } && !noDrag.contains { $0.contains(p) }
  }

  override func mouseDown(with event: NSEvent) {
    guard drags(at: pagePoint(event)) else { return super.mouseDown(with: event) }
    if event.clickCount == 2 {
      switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
      case "Minimize": window?.miniaturize(nil)
      case "None": break
      default: window?.zoom(nil)
      }
      return
    }
    window?.performDrag(with: event)
  }

  private static let browserItems: Set<String> = [
    "WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
    "WKMenuItemIdentifierInspectElement", "WKMenuItemIdentifierOpenLinkInNewWindow",
    "WKMenuItemIdentifierDownloadLinkedFile", "WKMenuItemIdentifierOpenImageInNewWindow",
    "WKMenuItemIdentifierDownloadImage", "WKMenuItemIdentifierOpenFrameInNewWindow",
  ]

  override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
    for item in menu.items where Self.browserItems.contains(item.identifier?.rawValue ?? "") { menu.removeItem(item) }
    while let first = menu.items.first, first.isSeparatorItem { menu.removeItem(first) }
    while let last = menu.items.last, last.isSeparatorItem { menu.removeItem(last) }
    super.willOpenMenu(menu, with: event)
  }

  private func files(_ info: NSDraggingInfo) -> [URL] {
    info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
  }

  override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation {
    guard !files(info).isEmpty else { return super.draggingEntered(info) }
    showOverlay(true)
    return .copy
  }

  override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation {
    files(info).isEmpty ? super.draggingUpdated(info) : .copy
  }

  override func draggingExited(_ info: NSDraggingInfo?) {
    showOverlay(false)
    super.draggingExited(info)
  }

  override func prepareForDragOperation(_ info: NSDraggingInfo) -> Bool {
    files(info).isEmpty ? super.prepareForDragOperation(info) : true
  }

  override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    let urls = files(info)
    guard !urls.isEmpty else { return super.performDragOperation(info) }
    showOverlay(false)
    onFiles?(urls)
    return true
  }

  override func concludeDragOperation(_ info: NSDraggingInfo?) {
    showOverlay(false)
    super.concludeDragOperation(info)
  }

  private func showOverlay(_ on: Bool) {
    if on, overlay == nil {
      let view = DropOverlay(frame: bounds)
      view.autoresizingMask = [.width, .height]
      addSubview(view)
      overlay = view
    } else if !on {
      overlay?.removeFromSuperview()
      overlay = nil
    }
  }
}

/// What the window shows while files are dragged over it.
private final class DropOverlay: NSView {
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    let label = NSTextField(labelWithString: "松开，放进库的 inbox/")
    label.font = .systemFont(ofSize: 15, weight: .semibold)
    label.textColor = .controlAccentColor
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)
    NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: centerXAnchor), label.centerYAnchor.constraint(equalTo: centerYAnchor)])
  }

  required init?(coder: NSCoder) { nil }

  override func updateLayer() {
    layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.08).cgColor
    layer?.borderColor = NSColor.controlAccentColor.withAlphaComponent(0.7).cgColor
    layer?.borderWidth = 2
    layer?.cornerRadius = 12
  }

  override var wantsUpdateLayer: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// What the test hooks in App.swift call.
extension MainWindow {
  func park() {
    guard let window, let screen = window.screen ?? NSScreen.main else { return }
    window.setFrameOrigin(NSPoint(x: screen.visibleFrame.maxX - 140, y: screen.visibleFrame.minY - window.frame.height + 90))
  }

  /// Which view gets a click at `x`, `y` points from the window's top left: the web view or the title bar.
  func hitForTest(x: Double, y: Double) {
    guard let window, let frame = window.contentView?.superview else { return }
    let p = NSPoint(x: x, y: window.frame.height - y)
    let hit = frame.hitTest(p).map { String(describing: type(of: $0)) } ?? "nothing"
    Log.line("hit: \(x),\(y) -> \(hit), drags window: \(webView?.drags(at: CGPoint(x: x, y: y)) ?? false)")
  }

  func findForTest(_ text: String) {
    showFind()
    findField?.searchField.stringValue = text
    let config = WKFindConfiguration()
    webView?.find(text, configuration: config) { [weak self] result in
      self?.webView?.evaluateJavaScript("String(window.getSelection())") { sel, _ in
        MainActor.assumeIsolated { Log.line("find: \(text) matched \(result.matchFound), selection \(String(describing: sel))") }
      }
    }
  }
}
