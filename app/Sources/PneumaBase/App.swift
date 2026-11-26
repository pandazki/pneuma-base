import AppKit
import UserNotifications

/// The menu bar item with its panel, the app's menus, the first-launch window, and the current
/// library with its server and watcher. The app keeps no state of a library: everything it does to
/// one goes through the command line, and it only remembers which libraries this machine knows and
/// its own settings.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSMenuItemValidation, NSWindowDelegate, UNUserNotificationCenterDelegate {
  private let config = Config.load()
  private var prefs = Prefs()
  private var statusItem: NSStatusItem?
  private let window = MainWindow()
  private let tray = TrayPanel()
  private let welcome = WelcomeWindow()
  private var server: Server?
  private var watcher: Watcher?
  /// How many things wait for the owner in the current library: the dot on the icon.
  private var waiting = 0
  private var counting = false
  private var countAgain = false
  private var countTimer: Timer?

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
    window.onFiles = { [weak self] urls in self?.bring(urls, into: self?.window.currentFolder, from: "窗口") }
    window.onPageMessage = { [weak self] body in self?.pageSaid(body) }
    tray.onMessage = { [weak self] body in self?.pageSaid(body) }
    welcome.onChoose = { [weak self] in self?.chooseLibrary() }
    welcome.onClose = { [weak self] in if self?.window.isOpen == false { NSApp.setActivationPolicy(.accessory) } }
    countTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.countWaiting() } }
    switchTo(current)
    listenForTestCommands()
    if !hasLibrary { welcome.show() } else if CommandLine.arguments.contains("--open") { openWindow() }
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

  private var hasLibrary: Bool { current.map(isLibrary) ?? false }

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
    setWaiting(0)
    guard let library, isLibrary(library) else { return tray.forget() }
    let server = Server(library: library, config: config)
    server.onAddress = { [weak self] url in
      self?.window.serverReady(url)
      self?.tray.serverReady(url)
    }
    server.start()
    self.server = server
    let watcher = Watcher(library: library, config: config, recordsOwnerFiles: prefs.watchesOwnerFiles)
    watcher.onRecorded = { [weak self] registered, seen in self?.recorded(registered, seen) }
    watcher.onActivity = { [weak self] in self?.countWaiting() }
    watcher.start()
    self.watcher = watcher
    countWaiting()
  }

  @objc func openWindow() {
    guard let library = current, server != nil else { return hasLibrary ? chooseLibrary() : welcome.show() }
    window.open(title: library.lastPathComponent, address: server?.address)
  }

  @objc func chooseLibrary() {
    NSApp.activate()
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.prompt = "就用这个文件夹"
    panel.message = "选一个库，或一个要建成库的文件夹。"
    guard panel.runModal() == .OK, let dir = panel.url else { return }
    Task { await open(dir) }
  }

  /// A folder the owner chose: made a library if it is not one, then the main window on its home page.
  private func open(_ dir: URL) async {
    if !isLibrary(dir) {
      let r = await runCli(["init", dir.path, "--json"], in: dir.deletingLastPathComponent(), config: config)
      guard r.json?["outcome"] as? String == "done" else { return alert("没能把这个文件夹建成库", detail: r.err) }
      Log.line("app: made \(dir.lastPathComponent) a library")
    }
    if window.isOpen, current != dir { window.close() }
    if current != dir { window.forgetRoute() }
    remember(dir)
    switchTo(dir)
    welcome.close()
    openWindow()
  }

  @objc private func selectLibrary(_ item: NSMenuItem) {
    guard let path = item.representedObject as? String else { return }
    Task { await open(URL(fileURLWithPath: path, isDirectory: true)) }
  }

  // MARK: Bringing files in

  /// Files dropped on the window or the menu bar item, or chosen in the page: put through the command
  /// line as brought by the owner, into `folder` (the folder the page shows, else inbox/), with the
  /// download address macOS kept, else the name of the folder they came from. The put marks its
  /// paths while it works, so the watcher leaves them alone.
  private func bring(_ urls: [URL], into folder: String?, from place: String) {
    guard let library = current, hasLibrary else { return }
    let folder = folder ?? "inbox"
    Task {
      var placed: [String] = []
      for url in urls {
        let r = await runCli(bringArgs(url, to: freePath(for: url.lastPathComponent, in: folder, of: library), in: library), in: library, config: config)
        if r.json?["outcome"] as? String == "accepted", let path = r.json?["path"] as? String { placed.append(path) } else { Log.line("drop: \(url.lastPathComponent) not placed: \(r.err.prefix(200)) \(String(decoding: r.out.prefix(300), as: UTF8.self))") }
      }
      Log.line("drop (\(place)): placed \(placed)")
      guard !placed.isEmpty else { return }
      let text = placed.count == 1 ? "已放进 \(placed[0])，记成你带进来的" : "已放进 \(folder)/：\(placed.count) 样东西，记成你带进来的"
      if window.isOpen { window.notice(tone: "good", text: text) } else { notify(text) }
      countWaiting()
    }
  }

  private func bringArgs(_ url: URL, to path: String, in library: URL) -> [String] {
    let source = downloadAddress(of: url) ?? url.deletingLastPathComponent().lastPathComponent
    return ["--library", library.path, "--session", config.session, "put", url.path, "--to", path,
            "--brought", "--by", "owner", "--source", source, "--note", "拖进来的", "--json"]
  }

  /// `<folder>/<name>`, or `<folder>/<name> 2.<ext>` and so on when that is taken, as Finder names copies.
  private func freePath(for name: String, in folder: String, of library: URL) -> String {
    let dir = library.appendingPathComponent(folder)
    let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    var candidate = name, n = 2
    while FileManager.default.fileExists(atPath: dir.appendingPathComponent(candidate).path) {
      candidate = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
      n += 1
    }
    return "\(folder)/\(candidate)"
  }

  /// Files or folders the owner picks after the page's 选择….
  private func chooseFiles(into folder: String) {
    guard hasLibrary else { return }
    NSApp.activate()
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = true
    panel.prompt = "放进库里"
    panel.message = "选的文件和文件夹会放进 \(folder)/，记成你带进来的。"
    guard panel.runModal() == .OK, !panel.urls.isEmpty else { return }
    bring(panel.urls, into: folder, from: "选择")
  }

  // MARK: The page's messages

  /// What the page asks of the app, from the window or the menu bar panel.
  private func pageSaid(_ body: [String: Any]) {
    switch body["type"] as? String {
    case "choose": chooseFiles(into: (body["to"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "inbox")
    case "open":
      openWindow()
      if let link = body["link"] as? [String: Any] { window.follow(link: link) }
    case "libraries": showMenu()
    case "quit": NSApp.terminate(nil)
    case "waiting": if let count = body["count"] as? Int { setWaiting(count) }
    default: break
    }
  }

  // MARK: Menu bar item

  private func makeStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.button?.image = Self.icon(dot: false)
    item.button?.target = self
    item.button?.action = #selector(statusClicked)
    item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
    item.button?.window?.registerForDraggedTypes([.fileURL])
    item.button?.window?.delegate = self
    statusItem = item
  }

  /// A click opens the panel; a right click or a Control-click, the menu of libraries.
  @objc private func statusClicked() {
    let event = NSApp.currentEvent
    if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true { return showMenu() }
    guard hasLibrary, let button = statusItem?.button else { return welcome.show() }
    tray.toggle(at: button)
  }

  private func showMenu() {
    guard let button = statusItem?.button else { return }
    let menu = NSMenu()
    for path in prefs.libraries {
      let item = NSMenuItem(title: (path as NSString).lastPathComponent, action: #selector(selectLibrary(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = path
      item.state = path == prefs.current ? .on : .off
      item.toolTip = (path as NSString).abbreviatingWithTildeInPath
      menu.addItem(item)
    }
    if !prefs.libraries.isEmpty { menu.addItem(.separator()) }
    menu.addItem(withTitle: "新建或打开一个库…", action: #selector(chooseLibrary), keyEquivalent: "").target = self
    menu.addItem(withTitle: "打开窗口", action: #selector(openWindow), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(ownerFilesItem())
    menu.addItem(.separator())
    menu.addItem(withTitle: "退出 Pneuma Base", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    // Shown the way a status item shows its own menu, so the system places it.
    statusItem?.menu = menu
    button.performClick(nil)
    statusItem?.menu = nil
  }

  /// The icon, with a dot when something waits for the owner. A template, so it follows the menu bar.
  private static func icon(dot: Bool) -> NSImage? {
    guard let symbol = NSImage(systemSymbolName: "archivebox", accessibilityDescription: dot ? "Pneuma Base：有事等你" : "Pneuma Base") else { return nil }
    guard dot else { return symbol }
    let size = NSSize(width: 20, height: 18)
    let image = NSImage(size: size, flipped: false) { rect in
      let s = symbol.size
      symbol.draw(in: NSRect(x: (rect.width - s.width) / 2 - 1, y: (rect.height - s.height) / 2, width: s.width, height: s.height))
      let spot = NSRect(x: rect.width - 7, y: rect.height - 7, width: 6, height: 6)
      NSGraphicsContext.current?.compositingOperation = .destinationOut
      NSBezierPath(ovalIn: spot.insetBy(dx: -1.5, dy: -1.5)).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      NSColor.black.setFill()
      NSBezierPath(ovalIn: spot).fill()
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = symbol.accessibilityDescription
    return image
  }

  private func setWaiting(_ count: Int) {
    guard count != waiting else { return }
    waiting = count
    statusItem?.button?.image = Self.icon(dot: count > 0)
    statusItem?.button?.toolTip = count > 0 ? "\(count) 件事等你决定" : nil
    Log.line("dot: \(count) waiting")
  }

  /// Counts what waits for the owner: the asks on the home page, as `show home` gives them. Run when
  /// the library changed, after a drop, and every minute; one run at a time.
  private func countWaiting() {
    guard let library = current, hasLibrary else { return }
    if counting { countAgain = true; return }
    counting = true
    Task {
      let r = await runCli(["--library", library.path, "show", "home", "--json"], in: library, config: config)
      counting = false
      if current == library, r.json?["outcome"] as? String == "shown" { setWaiting(Self.asks(in: r.json?["blocks"] as? [[String: Any]] ?? [])) }
      if countAgain {
        countAgain = false
        countWaiting()
      }
    }
  }

  private static func asks(in blocks: [[String: Any]]) -> Int {
    blocks.reduce(0) { n, block in
      let inner = (block["blocks"] as? [[String: Any]] ?? []) + (block["steps"] as? [[String: Any]] ?? []).flatMap { $0["blocks"] as? [[String: Any]] ?? [] }
      return n + (block["kind"] as? String == "asks" ? (block["asks"] as? [Any])?.count ?? 0 : 0) + asks(in: inner)
    }
  }

  // Files dragged onto the menu bar item reach its window, whose delegate this is.
  func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation {
    guard hasLibrary, !droppedFiles(info).isEmpty else { return [] }
    statusItem?.button?.highlight(true)
    return .copy
  }

  func draggingExited(_ info: NSDraggingInfo?) { statusItem?.button?.highlight(false) }

  func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    statusItem?.button?.highlight(false)
    let urls = droppedFiles(info)
    guard !urls.isEmpty else { return false }
    bring(urls, into: window.currentFolder, from: "菜单栏")
    return true
  }

  private func droppedFiles(_ info: NSDraggingInfo) -> [URL] {
    info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
  }

  // MARK: Machine settings

  private func ownerFilesItem() -> NSMenuItem {
    let item = NSMenuItem(title: "直接放进来的文件算主人的", action: #selector(toggleOwnerFiles), keyEquivalent: "")
    item.target = self
    item.toolTip = "开着时，在访达里拷进库、或直接改了的文件，会记成你带进来的、你改的（看到的，不是谁说的）。"
    return item
  }

  @objc private func toggleOwnerFiles() {
    prefs.ownerFiles = !prefs.watchesOwnerFiles
    prefs.save(config)
    watcher?.recordsOwnerFiles = prefs.watchesOwnerFiles
    Log.line("app: owner files \(prefs.watchesOwnerFiles ? "on" : "off")")
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(toggleOwnerFiles) { item.state = prefs.watchesOwnerFiles ? .on : .off }
    return true
  }

  // MARK: Notifications

  /// What the watcher recorded of the owner's own doing: said in the window if it is open, else as a notification.
  private func recorded(_ registered: [String], _ seen: [String]) {
    var parts: [String] = []
    if !registered.isEmpty { parts.append("已登记 \(registered.count) 个直接放进来的文件，记成你带进来的") }
    if !seen.isEmpty { parts.append("记下 \(seen.count) 处你直接做的改动") }
    guard !parts.isEmpty else { return }
    if window.isOpen { window.notice(tone: "good", text: parts.joined(separator: "；")) } else { notify(parts.joined(separator: "；")) }
  }

  private func notify(_ body: String) {
    let content = UNMutableNotificationContent()
    content.title = current?.lastPathComponent ?? "Pneuma Base"
    content.body = body
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
      ownerFilesItem(),
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
  /// named `Config.hooksName` with object `open`, `close`, `quit`, `pids`, `park` (moves the window
  /// almost off the screen, still visible to WebKit), `dark`, `light` or `system` (the app's
  /// appearance, as a change of the system's would set it), `hit:<x>,<y>`, `find:<text>`,
  /// `library:<folder>` (as if chosen in the first-launch window or 新建或打开一个库…), `drop:<path>`
  /// and `drop-window:<path>` (through the same code as a file dropped on the menu bar item or the
  /// window), `route:<fragment>` (the page's address fragment), `tray` (a click on the icon), `text:<file>` and `text-tray:<file>` (the page's text),
  /// `snap:<file>`, `snap-tray:<file>` and `snap-welcome:<file>` (a picture of it).
  private func listenForTestCommands() {
    DistributedNotificationCenter.default().addObserver(forName: Notification.Name(Config.hooksName), object: nil, queue: .main) { [weak self] note in
      let command = note.object as? String
      MainActor.assumeIsolated {
        guard let self, let command else { return }
        let (verb, rest) = command.firstIndex(of: ":").map { (String(command[..<$0]), String(command[command.index(after: $0)...])) } ?? (command, "")
        let file = URL(fileURLWithPath: rest)
        switch verb {
        case "open": self.openWindow()
        case "close": self.window.close()
        case "quit": NSApp.terminate(nil)
        case "library": Task { await self.open(URL(fileURLWithPath: rest, isDirectory: true)) }
        case "drop": self.bring([file], into: self.window.currentFolder, from: "菜单栏")
        case "drop-window": self.window.onFiles?([file])
        case "route": self.window.routeForTest(rest)
        case "tray": self.statusClicked()
        case "text": self.window.textForTest(to: file)
        case "text-tray": pageText(self.tray.webView, to: file)
        case "snap": self.window.snapshotForTest(to: file)
        case "snap-tray": snapshot(self.tray.webView, to: file, ground: .windowBackgroundColor)
        case "snap-welcome": self.welcome.snapshotForTest(to: file)
        case "park": self.window.park()
        case "dark", "light", "system":
          NSApp.appearance = verb == "system" ? nil : NSAppearance(named: verb == "dark" ? .darkAqua : .aqua)
          self.tray.followAppearance()
        case "hit":
          let xy = rest.split(separator: ",").compactMap { Double($0) }
          if xy.count == 2 { self.window.hitForTest(x: xy[0], y: xy[1]) }
        case "find": self.window.findForTest(rest)
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
