import AppKit

/// The first launch, with no library yet: one small window, two sentences and one button. Choosing a
/// folder makes it a library if it is not one, and the main window opens on its home page, where
/// 「开始」 takes the owner on.
@MainActor
final class WelcomeWindow: NSObject, NSWindowDelegate {
  private var window: NSWindow?
  var onChoose: (() -> Void)?
  var onClose: (() -> Void)?

  var isOpen: Bool { window?.isVisible ?? false }

  func show() {
    let window = self.window ?? make()
    NSApp.setActivationPolicy(.regular)
    if !window.isVisible { window.center() }
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    NSApp.activate()
    Log.line("welcome: shown")
  }

  func close() {
    window?.orderOut(nil)
  }

  func windowWillClose(_ notification: Notification) { onClose?() }

  private func make() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 460, height: 320),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered, defer: true)
    window.isReleasedWhenClosed = false
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.title = "Pneuma Base"
    window.delegate = self

    let icon = NSImageView(image: NSApp.applicationIconImage ?? NSImage())
    icon.imageScaling = .scaleProportionallyUpOrDown
    icon.widthAnchor.constraint(equalToConstant: 64).isActive = true
    icon.heightAnchor.constraint(equalToConstant: 64).isActive = true

    let title = NSTextField(labelWithString: "Pneuma Base")
    title.font = .systemFont(ofSize: 20, weight: .medium)

    func sentence(_ text: String, _ color: NSColor) -> NSTextField {
      let field = NSTextField(wrappingLabelWithString: text)
      field.font = .systemFont(ofSize: 13)
      field.textColor = color
      field.alignment = .center
      field.preferredMaxLayoutWidth = 360
      field.widthAnchor.constraint(equalToConstant: 360).isActive = true
      return field
    }
    let what = sentence("你和你的 agent 共用的资料库：带进来的资料、做出来的东西都放在这里，每样都记得是怎么来的。", .labelColor)
    let how = sentence("选一个文件夹当库，空的或已经放着资料的都行；之后 Pneuma Base 待在菜单栏里。", .secondaryLabelColor)

    let choose = NSButton(title: "选一个文件夹…", target: self, action: #selector(chose))
    choose.bezelStyle = .push
    choose.controlSize = .large
    choose.keyEquivalent = "\r"

    let stack = NSStackView(views: [icon, title, what, how, choose])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(14, after: icon)
    stack.setCustomSpacing(6, after: what)
    stack.setCustomSpacing(22, after: how)
    stack.translatesAutoresizingMaskIntoConstraints = false

    let content = NSView()
    content.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: 8),
    ])
    window.contentView = content
    self.window = window
    return window
  }

  @objc private func chose() { onChoose?() }

  /// A picture of the window with its title bar, for the screenshots verify.sh takes.
  func snapshotForTest(to url: URL) {
    guard let frame = window?.contentView?.superview, let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return Log.line("snap: no welcome window") }
    frame.cacheDisplay(in: frame.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
    Log.line("snap: wrote \(url.lastPathComponent)")
  }
}
