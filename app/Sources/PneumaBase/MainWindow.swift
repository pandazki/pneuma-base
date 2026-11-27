import AppKit
import Quartz
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
  /// Whether the page has its content, and what to run in it once it has.
  private var ready = false
  private var pendingScript: String?
  var onFiles: (([URL]) -> Void)?
  /// A message of the page's own for the app: choose files, open, the libraries' menu, quit, and files of the library.
  var onPageMessage: (([String: Any]) -> Void)?
  /// The controller of the system's Quick Look panel, taken by the web view while it has files to show.
  var quickLook: QuickLook?
  /// The window's content: its ground, the system's glass under the page's sidebar, the page on top.
  let glass = GlassContainer()

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

  /// The library folder the page is showing, from its route's `view.dir`, as the library page and
  /// the files page keep it; nil on any other page, or with the window closed.
  var currentFolder: String? {
    guard isOpen, let fragment = webView?.url?.fragment ?? route else { return nil }
    // The page writes its route with URLSearchParams, which writes a space as `+`.
    let query = fragment.replacingOccurrences(of: "+", with: "%20")
    let dir = URLComponents(string: "x:/?\(query)")?.queryItems?.first { $0.name == "view.dir" }?.value
    return dir.flatMap { $0.isEmpty ? nil : $0 }
  }

  /// Opens a link of a block in the page, as a click on it would: given to the page once it is ready.
  func follow(link: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: ["link": link]) else { return }
    let js = "window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: \(String(decoding: data, as: UTF8.self)) }))"
    if ready { webView?.evaluateJavaScript(js) } else { pendingScript = js }
  }

  /// A new library: the page opens on its first page, the home page.
  func forgetRoute() { route = nil }

  /// A line the page shows as its notice: what a drop or the watcher did.
  func notice(tone: String, text: String) {
    tell(["notice": ["tone": tone, "text": text]])
  }

  /// A `pneuma-shell` event in the page with this detail.
  func tell(_ detail: [String: Any]) {
    guard let webView, let data = try? JSONSerialization.data(withJSONObject: detail) else { return }
    webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: \(String(decoding: data, as: UTF8.self)) }))")
  }

  /// The system's context menu at a point of the page, in CSS pixels from its top left.
  func popUp(_ menu: NSMenu, at point: CGPoint) {
    guard let webView else { return }
    menu.popUp(positioning: nil, at: webView.isFlipped ? point : CGPoint(x: point.x, y: webView.bounds.height - point.y), in: webView)
  }

  /// The system's drag of these files out of the window, from the pointer; false without a mouse event to start it from.
  func dragFiles(_ urls: [URL], source: FileDragSource) -> Bool {
    webView?.dragFiles(urls, source: source) ?? false
  }

  static func jsString(_ s: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
    return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
  }

  private func load(_ address: URL) {
    self.address = address
    ready = false
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
    content.addUserScript(Transparency.userScript)
    content.add(WeakHandler(self), name: "shell")
    let web = ShellWebView(frame: window?.contentView?.bounds ?? .zero, configuration: config)
    web.clearBackground()
    web.underPageBackgroundColor = pageColor
    web.allowsMagnification = false
    web.allowsBackForwardNavigationGestures = false
    web.navigationDelegate = self
    web.uiDelegate = self
    web.onFiles = { [weak self] urls in self?.onFiles?(urls) }
    web.dropTarget = { [weak self] in "\(self?.currentFolder ?? "inbox")/" }
    web.quickLook = quickLook
    window?.contentView = glass.hosting(web)
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
    ready = false
    window?.contentView = nil
    requestedAt = nil
    NSApp.setActivationPolicy(.accessory)
    Log.line("window: closed")
  }

  /// The page dims its chrome while the window is not the main window, as the system's own windows do;
  /// a panel taking the keyboard, as Quick Look does, leaves it main.
  func windowDidBecomeKey(_ notification: Notification) { tellWindowState() }
  func windowDidResignKey(_ notification: Notification) { tellWindowState() }
  func windowDidBecomeMain(_ notification: Notification) { tellWindowState() }
  func windowDidResignMain(_ notification: Notification) { tellWindowState() }

  private func tellWindowState() {
    let state = window?.isMainWindow ?? true ? "active" : "inactive"
    webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: { window: '\(state)' } }))")
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    // Only the app's own page speaks to the shell: a plugin's view runs in a frame of it, and must not open files or run a terminal.
    guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "ready":
      ready = true
      show(reason: "ready")
      tellWindowState()
      glass.tellPage()
      if let js = pendingScript {
        pendingScript = nil
        webView?.evaluateJavaScript(js)
      }
    case "painted":
      if let requestedAt { Log.line(String(format: "window: page drawn %.0f ms after open", Date().timeIntervalSince(requestedAt) * 1000)) }
      requestedAt = nil
    case "regions":
      webView?.setRegions(drag: rects(body["drag"]), noDrag: rects(body["nodrag"]))
    case "glass":
      glass.place(body["panes"], postedAt: body["at"] as? Double)
    case "confirm":
      guard let id = body["id"] as? Int, let text = body["text"] as? String, let act = body["act"] as? String else { return }
      confirm(id: id, text: text, act: act, danger: body["danger"] as? Bool ?? false)
    default:
      onPageMessage?(body)
    }
  }

  /// The page's question before an act it cannot undo, as the system's sheet on the window. Return
  /// does not do a dangerous act; Escape and 取消 do nothing. The page hears `{ confirmed: { id, ok } }`.
  private func confirm(id: Int, text: String, act: String, danger: Bool) {
    guard let window else { return tell(["confirmed": ["id": id, "ok": false]]) }
    let alert = NSAlert()
    alert.messageText = text
    let button = alert.addButton(withTitle: act)
    alert.addButton(withTitle: "取消").keyEquivalent = "\u{1b}"
    if danger {
      button.hasDestructiveAction = true
      button.keyEquivalent = ""
    }
    Log.line("sheet: \(text) | \(act)\(danger ? " (danger)" : "") | 取消")
    alert.beginSheetModal(for: window) { [weak self] response in
      self?.tell(["confirmed": ["id": id, "ok": response == .alertFirstButtonReturn]])
    }
  }

  /// The test hooks' click on the sheet's `n`-th button, from 0.
  func answerSheet(_ n: Int) {
    guard let window, let sheet = window.attachedSheet else { return Log.line("sheet: none to answer") }
    window.endSheet(sheet, returnCode: NSApplication.ModalResponse(rawValue: NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + n))
    Log.line("sheet: answered \(n)")
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
let pageColor = NSColor(name: nil) { appearance in
  appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    ? NSColor(srgbRed: 0.055, green: 0.055, blue: 0.063, alpha: 1)
    : NSColor(srgbRed: 0.973, green: 0.973, blue: 0.973, alpha: 1)
}

/// The content controller keeps its handlers strongly; this breaks the cycle with the window.
final class WeakHandler: NSObject, WKScriptMessageHandler {
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
  /// Where files dropped now would go, as the overlay says it.
  var dropTarget: (() -> String)?
  var quickLook: QuickLook?
  /// The latest mouse-down or mouse-dragged event: a drag of files out starts from it.
  private var lastMouse: NSEvent?

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
    lastMouse = event
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

  override func mouseDragged(with event: NSEvent) {
    lastMouse = event
    super.mouseDragged(with: event)
  }

  /// Files dragged out from the pointer, each with its icon: other applications get a copy.
  func dragFiles(_ urls: [URL], source: FileDragSource) -> Bool {
    guard let event = lastMouse, !urls.isEmpty else { return false }
    let p = convert(event.locationInWindow, from: nil)
    let items = urls.enumerated().map { i, url in
      let item = NSDraggingItem(pasteboardWriter: url as NSURL)
      let offset = CGFloat(min(i, 4) * 4)
      item.setDraggingFrame(NSRect(x: p.x - 24 + offset, y: p.y - 24 - offset, width: 48, height: 48), contents: NSWorkspace.shared.icon(forFile: url.path))
      return item
    }
    beginDraggingSession(with: items, event: event, source: source)
    return true
  }

  // The Quick Look panel, on the main thread, finds its controller along the responder chain, which starts here.
  override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { MainActor.assumeIsolated { quickLook?.wanted ?? false } }
  override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) { MainActor.assumeIsolated { quickLook?.begin(panel) } }
  override func endPreviewPanelControl(_ panel: QLPreviewPanel!) { MainActor.assumeIsolated { quickLook?.end(panel) } }

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

  /// A drag of the window's own files coming back over it: no drop, into the library or the page.
  private func own(_ info: NSDraggingInfo) -> Bool { info.draggingSource is FileDragSource }

  override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation {
    if own(info) { return [] }
    guard !files(info).isEmpty else { return super.draggingEntered(info) }
    showOverlay(true)
    return .copy
  }

  override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation {
    if own(info) { return [] }
    return files(info).isEmpty ? super.draggingUpdated(info) : .copy
  }

  override func draggingExited(_ info: NSDraggingInfo?) {
    showOverlay(false)
    super.draggingExited(info)
  }

  override func prepareForDragOperation(_ info: NSDraggingInfo) -> Bool {
    if own(info) { return false }
    return files(info).isEmpty ? super.prepareForDragOperation(info) : true
  }

  override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    if own(info) { return false }
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
      let view = DropOverlay(frame: bounds, target: dropTarget?() ?? "inbox/")
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
  init(frame: NSRect, target: String) {
    super.init(frame: frame)
    wantsLayer = true
    let label = NSTextField(labelWithString: "松开，放进库的 \(target)，记成你带进来的")
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

extension MainWindow {
  /// The page's text as it shows now, written to `url`: verify.sh reads what the owner would see.
  func textForTest(to url: URL) {
    pageText(webView, to: url)
  }

  func snapshotForTest(to url: URL) {
    snapshot(webView, to: url)
  }

  func routeForTest(_ fragment: String) {
    webView?.evaluateJavaScript("location.hash = \(Self.jsString(fragment))")
  }

  /// Runs `js` in the page and logs what it evaluated to, as text on one line.
  func evalForTest(_ js: String) {
    guard let webView else { return Log.line("eval: no page") }
    webView.evaluateJavaScript(js) { result, error in
      MainActor.assumeIsolated {
        let text: String
        if let error, (error as NSError).code != WKError.javaScriptResultTypeIsUnsupported.rawValue {
          text = "error: \(error.localizedDescription)"
        } else if let result, !(result is NSNull) {
          text = result as? String ?? (try? JSONSerialization.data(withJSONObject: result, options: .fragmentsAllowed)).map { String(decoding: $0, as: UTF8.self) } ?? "\(result)"
        } else {
          text = "undefined"
        }
        Log.line("eval: \(text.replacingOccurrences(of: "\n", with: "\\n"))")
      }
    }
  }
}

/// What a test hook writes of a web view: the page's visible text, or a picture of it.
@MainActor
func pageText(_ web: WKWebView?, to url: URL) {
  guard let web else { return Log.line("text: no page") }
  web.evaluateJavaScript("document.body.innerText") { text, error in
    MainActor.assumeIsolated {
      try? ((text as? String) ?? "").write(to: url, atomically: true, encoding: .utf8)
      Log.line("text: wrote \(url.lastPathComponent)\(error.map { " (\($0.localizedDescription))" } ?? "")")
    }
  }
}

/// A page that draws no ground of its own, as the panel's, is laid on `ground`, as the window behind it shows it.
@MainActor
func snapshot(_ web: WKWebView?, to url: URL, ground: NSColor? = nil) {
  guard let web else { return Log.line("snap: no page") }
  var fill: NSColor?
  web.effectiveAppearance.performAsCurrentDrawingAppearance { fill = ground?.usingColorSpace(.sRGB) }
  web.takeSnapshot(with: nil) { shot, error in
    MainActor.assumeIsolated {
      let image = shot.map { shot in
        guard let fill else { return shot }
        return NSImage(size: shot.size, flipped: false) { rect in
          fill.setFill()
          rect.fill()
          shot.draw(in: rect)
          return true
        }
      }
      guard let image, let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
        return Log.line("snap: failed \(error?.localizedDescription ?? "")")
      }
      try? png.write(to: url)
      Log.line("snap: wrote \(url.lastPathComponent)")
    }
  }
}
