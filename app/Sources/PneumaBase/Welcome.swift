import AppKit

/// A place the library can be kept, as `storage list` offers it: a provider this machine has, or an
/// official one not installed yet (`install` is the repository it comes from).
struct StorageChoice: Equatable {
  let name: String
  let summary: String
  let forms: [String]
  let install: String?
  var answersFolders: Bool { forms.contains("path") }
  var title: String { "\(summary)\(install == nil ? "" : " · 未安装")" }
}

/// The first launch, with no library yet: one small window that offers where to keep the library:
/// the providers this machine has, the official ones not installed, and 安装其他存储… (a repository).
/// With one provider it is simply choosing a folder. Choosing one makes a library there, and the main
/// window opens on its home page, where 「快速开始」 takes the owner on.
@MainActor
final class WelcomeWindow: NSObject, NSWindowDelegate {
  private var window: NSWindow?
  private let picker = NSPopUpButton()
  private let choose = NSButton()
  private let other = NSButton()
  private let status = NSTextField(wrappingLabelWithString: "")
  private(set) var choices: [StorageChoice] = []
  var onChoose: ((StorageChoice) -> Void)?
  var onInstallOther: (() -> Void)?
  var onClose: (() -> Void)?

  var isOpen: Bool { window?.isVisible ?? false }

  func show() {
    let window = self.window ?? make()
    NSApp.setActivationPolicy(.regular)
    if !window.isVisible { window.center() }
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    NSApp.activate()
    Log.line("welcome: shown, \(choices.count) place(s) to keep a library")
  }

  func close() {
    window?.orderOut(nil)
  }

  /// The places offered, the first selected; with one, the picker is not shown.
  func offer(_ choices: [StorageChoice]) {
    if window == nil { _ = make() }
    let selected = picker.indexOfSelectedItem
    self.choices = choices
    picker.removeAllItems()
    picker.addItems(withTitles: choices.map(\.title))
    picker.isHidden = choices.count <= 1
    if selected >= 0 && selected < choices.count { picker.selectItem(at: selected) }
    picked()
  }

  /// A line under the buttons: an install under way, or what it answered.
  func say(_ text: String) {
    status.stringValue = text
    status.isHidden = text.isEmpty
  }

  func windowWillClose(_ notification: Notification) { onClose?() }

  private var selected: StorageChoice? {
    let i = picker.indexOfSelectedItem
    return choices.indices.contains(i) ? choices[i] : choices.first
  }

  @objc private func picked() {
    guard let choice = selected else {
      choose.title = "选择文件夹…"
      return
    }
    choose.isEnabled = choice.answersFolders
    choose.title = !choice.answersFolders ? "\(choice.summary) 的地址不是文件夹" : choice.install == nil ? "选择文件夹…" : "安装并选择文件夹…"
  }

  private func make() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 460, height: 360),
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

    func sentence(_ field: NSTextField, _ text: String, _ color: NSColor, size: CGFloat = 13) -> NSTextField {
      field.stringValue = text
      field.font = .systemFont(ofSize: size)
      field.textColor = color
      field.alignment = .center
      field.preferredMaxLayoutWidth = 360
      field.widthAnchor.constraint(equalToConstant: 360).isActive = true
      return field
    }
    let what = sentence(NSTextField(wrappingLabelWithString: ""), "人与 Agent 共用的资料库：导入的资料和生成的内容集中保存，每个条目都记录来源。", .labelColor)
    let how = sentence(NSTextField(wrappingLabelWithString: ""), "选择一个文件夹作为资料库，空文件夹或已有资料的文件夹均可。之后 Pneuma Base 在菜单栏中运行。", .secondaryLabelColor)
    _ = sentence(status, "", .secondaryLabelColor, size: 12)
    status.isHidden = true

    picker.target = self
    picker.action = #selector(picked)
    picker.isHidden = true
    choose.title = "选择文件夹…"
    choose.target = self
    choose.action = #selector(chose)
    choose.bezelStyle = .push
    choose.controlSize = .large
    choose.keyEquivalent = "\r"
    other.title = "安装其他存储…"
    other.target = self
    other.action = #selector(installOther)
    other.isBordered = false
    other.contentTintColor = .linkColor
    other.font = .systemFont(ofSize: 12)

    let stack = NSStackView(views: [icon, title, what, how, picker, choose, other, status])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(14, after: icon)
    stack.setCustomSpacing(6, after: what)
    stack.setCustomSpacing(22, after: how)
    stack.setCustomSpacing(6, after: choose)
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

  @objc private func chose() {
    if let choice = selected { onChoose?(choice) }
  }

  @objc private func installOther() { onInstallOther?() }

  /// What the window offers, in words, for the checks verify.sh runs.
  var textForTest: String {
    var lines = ["places: \(choices.map(\.title).joined(separator: " | "))", "picker: \(picker.isHidden ? "hidden" : "shown")", "button: \(choose.title)", "other: \(other.title)"]
    if !status.isHidden { lines.append("status: \(status.stringValue)") }
    return lines.joined(separator: "\n") + "\n"
  }

  /// A picture of the window with its title bar, for the screenshots verify.sh takes.
  func snapshotForTest(to url: URL) {
    guard let frame = window?.contentView?.superview, let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return Log.line("snap: no welcome window") }
    frame.cacheDisplay(in: frame.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
    Log.line("snap: wrote \(url.lastPathComponent)")
  }
}
