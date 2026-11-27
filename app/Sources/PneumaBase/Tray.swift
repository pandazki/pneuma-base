import AppKit
import WebKit

/// The menu bar panel: a popover under the icon whose content is the page's panel layout
/// (`?shell=mac&panel=tray`), the home page's blocks drawn small. The web view is made the first
/// time the panel opens and kept, so it opens at once after that; the page asks the server anything
/// only while the panel is on screen. The page tells the app its height, and how many things wait.
@MainActor
final class TrayPanel: NSObject, NSPopoverDelegate, WKScriptMessageHandler, WKNavigationDelegate {
  static let width: CGFloat = 340
  private let popover = NSPopover()
  private var web: WKWebView?
  private var address: URL?
  /// The page's messages other than its height: open, the libraries' menu, quit, how many wait.
  var onMessage: (([String: Any]) -> Void)?

  var isShown: Bool { popover.isShown }
  var webView: WKWebView? { web }

  override init() {
    super.init()
    popover.behavior = .transient
    popover.delegate = self
    popover.contentSize = NSSize(width: Self.width, height: 360)
  }

  /// A click on the icon while the panel is open closes it: the mouse going down outside the panel
  /// has closed it already, so the click that follows must not open it again.
  func toggle(at button: NSStatusBarButton) {
    if popover.isShown { return close() }
    if Date().timeIntervalSince(closedAt) < 0.3 { return }
    show(at: button)
  }

  private var closedAt = Date.distantPast
  func popoverDidClose(_ notification: Notification) { closedAt = Date() }

  func show(at button: NSStatusBarButton) {
    let web = self.web ?? make()
    // Anchored to the menu bar, a popover takes the bar's appearance; the app's, when it has one of its own, wins.
    popover.appearance = NSApp.appearance
    if web.url == nil, let address { load(address) }
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
    NSApp.activate()
    web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('pneuma-shell', { detail: { panel: 'shown' } }))")
    Log.line("tray: shown")
  }

  func close() { popover.performClose(nil) }

  /// The app's appearance changed while the panel is open.
  func followAppearance() { popover.appearance = NSApp.appearance }

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
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: Self.width, height: 360), configuration: config)
    web.setValue(false, forKey: "drawsBackground")
    web.allowsMagnification = false
    web.navigationDelegate = self
    let controller = NSViewController()
    controller.view = web
    popover.contentViewController = controller
    self.web = web
    return web
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    // Only the app's own page speaks to the shell: a plugin's view runs in a frame of it, and must not open files or run a terminal.
    guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    if type == "height", let height = body["height"] as? Double {
      let room = (NSScreen.main?.visibleFrame.height ?? 800) - 60
      popover.contentSize = NSSize(width: Self.width, height: min(max(CGFloat(height), 120), min(room, 640)))
      return
    }
    // A link or a button that leads to the window closes the panel first.
    if type == "open" || type == "quit" || type == "libraries" || type == "choose" { close() }
    onMessage?(body)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Log.line("tray: web content process ended, reloading")
    if let address { load(address) }
  }
}
