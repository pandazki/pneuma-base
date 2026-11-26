import AppKit
import UserNotifications

/// The menu bar item, the app's menus, and the current library with its server and watcher.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, UNUserNotificationCenterDelegate {
  private let config = Config.load()
  private var prefs = Prefs()
  private var statusItem: NSStatusItem?
  private let window = MainWindow()
  private var server: Server?
  private var watcher: Watcher?
  private var recent: [String] = []
  /// The last thing the app itself did, shown at the top of the menu: the system may refuse notifications.
  private var news: String?

  private var current: URL? { prefs.current.map { URL(fileURLWithPath: $0, isDirectory: true) } }

  func applicationDidFinishLaunching(_ notification: Notification) {
    Log.config = config
    Log.line("app: launched, home \(config.home.path), process age \(String(format: "%.0f", processAge() * 1000)) ms")
    prefs = Prefs.load(config)
    if let dir = Config.argument("--library") { remember(URL(fileURLWithPath: (dir as NSString).expandingTildeInPath, isDirectory: true)) }
    NSApp.mainMenu = mainMenu()
    makeStatusItem()
    Log.line("app: status item shown, process age \(String(format: "%.0f", processAge() * 1000)) ms")
    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
      let why = error.map { " (\($0.localizedDescription))" } ?? ""
      DispatchQueue.main.async { MainActor.assumeIsolated { Log.line("app: notifications \(granted ? "allowed" : "not allowed")\(why)") } }
    }
    window.onFiles = { [weak self] urls in self?.bring(urls, from: "窗口") }
    switchTo(current)
    listenForTestCommands()
    if CommandLine.arguments.contains("--open") { openWindow() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    watcher?.stop()
    server?.stop()
    Log.line("app: quit")
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { openWindow() }
    return true
  }

  // MARK: Current library

  private func remember(_ dir: URL) {
    let path = dir.standardizedFileURL.path
    if !prefs.libraries.contains(path) { prefs.libraries.append(path) }
    prefs.current = path
    prefs.save(config)
  }

  /// One server and one watcher, for the current library only.
  private func switchTo(_ library: URL?) {
    if server?.library == library { return }
    watcher?.stop()
    server?.stop()
    watcher = nil
    server = nil
    recent = []
    guard let library, isLibrary(library) else { return }
    let server = Server(library: library, config: config)
    server.onAddress = { [weak self] url in self?.window.serverReady(url) }
    server.start()
    self.server = server
    let watcher = Watcher(library: library, config: config)
    watcher.onRecorded = { [weak self] registered, claimed in self?.recorded(registered, claimed) }
    watcher.start()
    self.watcher = watcher
    refreshRecent()
  }

  @objc func openWindow() {
    guard let library = current, server != nil else { return chooseLibrary() }
    window.open(title: library.lastPathComponent, address: server?.address)
  }

  @objc func chooseLibrary() {
    NSApp.activate()
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.prompt = "打开"
    panel.message = "选一个库，或一个要建成库的文件夹。"
    guard panel.runModal() == .OK, let dir = panel.url else { return }
    Task { await open(dir) }
  }

  private func open(_ dir: URL) async {
    if !isLibrary(dir) {
      let r = await runCli(["init", dir.path, "--json"], in: dir, config: config)
      guard r.json?["outcome"] as? String == "done" else { return alert("没能把这个文件夹建成库", detail: r.err) }
    }
    if window.isOpen, current != dir { window.close() }
    remember(dir)
    switchTo(dir)
    openWindow()
  }

  @objc private func selectLibrary(_ item: NSMenuItem) {
    guard let path = item.representedObject as? String else { return }
    Task { await open(URL(fileURLWithPath: path, isDirectory: true)) }
  }

  // MARK: Bringing files in

  /// Files dropped on the window or the menu bar item: placed in `inbox/` as brought by the owner,
  /// with the download address macOS kept, else the name of the folder they came from.
  private func bring(_ urls: [URL], from place: String) {
    guard let library = current, let watcher else { return }
    watcher.hold()
    Task {
      var placed: [String] = []
      for url in urls {
        let r = await runCli(bringArgs(url, into: library), in: library, config: config)
        if r.json?["outcome"] as? String == "accepted", let path = r.json?["path"] as? String { placed.append(path) } else { Log.line("drop: \(url.lastPathComponent) not placed: \(r.err.prefix(200)) \(String(decoding: r.out.prefix(300), as: UTF8.self))") }
      }
      watcher.release()
      Log.line("drop (\(place)): placed \(placed)")
      if place == "窗口" { window.showInbox() } else if !placed.isEmpty { notify("已放进 inbox/：\(placed.count) 样东西") }
      refreshRecent()
    }
  }

  private func bringArgs(_ url: URL, into library: URL) -> [String] {
    let source = downloadAddress(of: url) ?? url.deletingLastPathComponent().lastPathComponent
    return ["--library", library.path, "--session", config.session, "put", url.path, "--to", inboxPath(for: url.lastPathComponent, in: library),
            "--brought", "--by", "owner", "--source", source, "--note", "拖进来的", "--json"]
  }

  /// `inbox/<name>`, or `inbox/<name> 2.<ext>` and so on when that is taken, as Finder names copies.
  private func inboxPath(for name: String, in library: URL) -> String {
    let inbox = library.appendingPathComponent("inbox")
    let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    var candidate = name, n = 2
    while FileManager.default.fileExists(atPath: inbox.appendingPathComponent(candidate).path) {
      candidate = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
      n += 1
    }
    return "inbox/\(candidate)"
  }

  // MARK: Menu bar item

  private func makeStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.button?.image = NSImage(systemSymbolName: "archivebox", accessibilityDescription: "Pneuma Base")
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    item.button?.window?.registerForDraggedTypes([.fileURL])
    item.button?.window?.delegate = self
    statusItem = item
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    guard menu === statusItem?.menu else { return }
    fillStatusMenu(menu)
    refreshRecent()
  }

  private func fillStatusMenu(_ menu: NSMenu) {
    menu.removeAllItems()
    for path in prefs.libraries {
      let item = NSMenuItem(title: (path as NSString).lastPathComponent, action: #selector(selectLibrary(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = path
      item.state = path == prefs.current ? .on : .off
      item.toolTip = (path as NSString).abbreviatingWithTildeInPath
      menu.addItem(item)
    }
    if !prefs.libraries.isEmpty { menu.addItem(.separator()) }
    menu.addItem(withTitle: "打开窗口", action: #selector(openWindow), keyEquivalent: "").target = self
    menu.addItem(withTitle: "新建或打开一个库…", action: #selector(chooseLibrary), keyEquivalent: "").target = self
    if current != nil {
      menu.addItem(.separator())
      menu.addItem(NSMenuItem.sectionHeader(title: "最近"))
      if let news {
        let item = NSMenuItem(title: news, action: #selector(openWindow), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
      }
      if recent.isEmpty {
        let none = NSMenuItem(title: "这个库里还没有别人做过的事", action: nil, keyEquivalent: "")
        none.isEnabled = false
        menu.addItem(none)
      }
      for line in recent {
        let item = NSMenuItem(title: line, action: #selector(openWindow), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
      }
    }
    menu.addItem(.separator())
    menu.addItem(withTitle: "退出 Pneuma Base", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
  }

  /// The last few things that happened in the library: `check --since` for the last 30 days, which
  /// lists what everyone but the caller, the owner, did.
  private func refreshRecent() {
    guard let library = current else { return }
    let since = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-30 * 86400))
    Task {
      let r = await runCli(["--library", library.path, "check", "--since", since, "--json"], in: library, config: config)
      guard current == library else { return }
      let sections = r.json?["sections"] as? [[String: Any]] ?? []
      let facts = sections.filter { $0["title"] as? String == "自上次以来" }
        .flatMap { (($0["data"] as? [String: Any])?["scenes"] as? [[String: Any]]) ?? [] }
        .flatMap { ($0["facts"] as? [[String: Any]]) ?? [] }
        .sorted { ($0["at"] as? String ?? "") > ($1["at"] as? String ?? "") }
      recent = facts.prefix(5).map { f in
        let when = (f["at"] as? String).flatMap { ISO8601DateFormatter.withFraction.date(from: $0) }
        let ago = when.map { RelativeDateTimeFormatter.chinese.localizedString(for: $0, relativeTo: Date()) } ?? ""
        let text = f["text"] as? String ?? ""
        return "\(f["actor"] as? String ?? "")：\(text.count > 48 ? text.prefix(47) + "…" : text)  ·  \(ago)"
      }
      if statusMenuOpen, let menu = statusItem?.menu { fillStatusMenu(menu) }
    }
  }

  private var statusMenuOpen = false
  func menuWillOpen(_ menu: NSMenu) {
    guard menu === statusItem?.menu else { return }
    statusMenuOpen = true
    statusItem?.button?.image = NSImage(systemSymbolName: "archivebox", accessibilityDescription: "Pneuma Base")
  }
  func menuDidClose(_ menu: NSMenu) { if menu === statusItem?.menu { statusMenuOpen = false } }

  // Files dragged onto the menu bar item reach its window, whose delegate this is.
  func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation {
    guard current != nil, !droppedFiles(info).isEmpty else { return [] }
    statusItem?.button?.highlight(true)
    return .copy
  }

  func draggingExited(_ info: NSDraggingInfo?) { statusItem?.button?.highlight(false) }

  func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    statusItem?.button?.highlight(false)
    let urls = droppedFiles(info)
    guard !urls.isEmpty else { return false }
    bring(urls, from: "菜单栏")
    return true
  }

  private func droppedFiles(_ info: NSDraggingInfo) -> [URL] {
    info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
  }

  // MARK: Notifications

  private func recorded(_ registered: [String], _ claimed: [String]) {
    var parts: [String] = []
    if !registered.isEmpty { parts.append("已登记 \(registered.count) 个文件") }
    if !claimed.isEmpty { parts.append("记下 \(claimed.count) 处你直接做的改动") }
    if !parts.isEmpty { notify(parts.joined(separator: "，")) }
    refreshRecent()
  }

  private func notify(_ body: String) {
    let content = UNMutableNotificationContent()
    content.title = current?.lastPathComponent ?? "Pneuma Base"
    content.body = body
    news = "刚才：\(body)  ·  \(Date().formatted(date: .omitted, time: .shortened))"
    statusItem?.button?.image = NSImage(systemSymbolName: "archivebox.fill", accessibilityDescription: "Pneuma Base：有新消息")
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
      if let error { DispatchQueue.main.async { MainActor.assumeIsolated { Log.line("notify: \(error.localizedDescription)") } } }
    }
    Log.line("notify: \(body)")
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    await MainActor.run { openWindow() }
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .list]
  }

  private func alert(_ text: String, detail: String) {
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = text
    alert.informativeText = String(detail.prefix(600))
    alert.runModal()
  }

  // MARK: Menus

  private func mainMenu() -> NSMenu {
    let bar = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      holder.submenu = menu
      bar.addItem(holder)
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      i.target = target
      return i
    }
    submenu("Pneuma Base", [
      item("关于 Pneuma Base", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("隐藏 Pneuma Base", #selector(NSApplication.hide(_:)), "h"),
      item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("全部显示", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("退出 Pneuma Base", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("文件", [
      item("新建或打开一个库…", #selector(chooseLibrary), "o", target: self),
      .separator(),
      item("关闭窗口", #selector(NSWindow.performClose(_:)), "w"),
    ])
    submenu("编辑", [
      item("撤销", Selector(("undo:")), "z"),
      item("重做", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("剪切", #selector(NSText.cut(_:)), "x"),
      item("拷贝", #selector(NSText.copy(_:)), "c"),
      item("粘贴", #selector(NSText.paste(_:)), "v"),
      item("全选", #selector(NSText.selectAll(_:)), "a"),
      .separator(),
      item("查找…", #selector(showFind), "f", target: self),
      item("查找下一个", #selector(findNext), "g", target: self),
      item("查找上一个", #selector(findPrevious), "g", [.command, .shift], target: self),
    ])
    submenu("显示", [
      item("后退", #selector(goBack), "[", target: self),
      item("前进", #selector(goForward), "]", target: self),
      .separator(),
      item("重新载入", #selector(reloadPage), "r", target: self),
      .separator(),
      item("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    let windowMenu = [
      item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("缩放", #selector(NSWindow.performZoom(_:))),
      .separator(),
      item("前置全部窗口", #selector(NSApplication.arrangeInFront(_:))),
    ]
    submenu("窗口", windowMenu)
    NSApp.windowsMenu = bar.items.last?.submenu
    return bar
  }

  @objc private func showFind() { window.showFind() }
  @objc private func findNext() { window.find(backwards: false) }
  @objc private func findPrevious() { window.find(backwards: true) }
  @objc private func goBack() { window.back() }
  @objc private func goForward() { window.forward() }
  @objc private func reloadPage() { window.reload() }

  // MARK: Test hooks

  /// Lets the measurements and checks drive the app without a person: a distributed notification
  /// named `dev.pneumabase.spike` with object `open`, `close`, `pids`, `park` (moves the window almost
  /// off the screen, still visible to WebKit), `dark`, `light` or `system` (the app's appearance, as a
  /// change of the system's would set it), `hit:<x>,<y>`, `find:<text>`, or `drop:<path>`, which goes
  /// through the same code as a file dropped on the menu bar item.
  private func listenForTestCommands() {
    DistributedNotificationCenter.default().addObserver(forName: Notification.Name("dev.pneumabase.spike"), object: nil, queue: .main) { [weak self] note in
      let command = note.object as? String
      MainActor.assumeIsolated {
        guard let self else { return }
        switch command {
        case "open": self.openWindow()
        case "close": self.window.close()
        case let c? where c.hasPrefix("drop:"): self.bring([URL(fileURLWithPath: String(c.dropFirst(5)))], from: "菜单栏")
        case "park": self.window.park()
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "system": NSApp.appearance = nil
        case let c? where c.hasPrefix("hit:"):
          let xy = c.dropFirst(4).split(separator: ",").compactMap { Double($0) }
          if xy.count == 2 { self.window.hitForTest(x: xy[0], y: xy[1]) }
        case let c? where c.hasPrefix("find:"): self.window.findForTest(String(c.dropFirst(5)))
        case "pids": Log.line("pids: app \(getpid()) server \(self.server?.pid ?? 0) web \(self.window.webContentPid ?? 0)")
        default: break
        }
      }
    }
  }
}

/// Seconds since the kernel started this process.
func processAge() -> TimeInterval {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return 0 }
  let start = info.kp_proc.p_starttime
  return Date().timeIntervalSince1970 - (Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000)
}

extension ISO8601DateFormatter {
  @MainActor static let withFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
}

extension RelativeDateTimeFormatter {
  @MainActor static let chinese: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.unitsStyle = .short
    return f
  }()
}
