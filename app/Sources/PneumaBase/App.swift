import AppKit
import Combine
import UserNotifications

/// The menu bar item with its panel, the app's menus, the first-launch window, and the current
/// library with its server and watcher. The app keeps no state of a library: everything it does to
/// one goes through the command line, its watcher reads storage's own subscription, and it only
/// remembers which libraries this machine knows, the cursor its watcher last heard, and its own settings.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSMenuItemValidation, NSWindowDelegate, UNUserNotificationCenterDelegate {
  private let config = Config.load()
  private var prefs = Prefs()
  private var statusItem: NSStatusItem?
  private let window = MainWindow()
  private let tray = TrayPanel()
  private let welcome = WelcomeWindow()
  private var settings: SettingsWindow?
  private var server: Server?
  private var watcher: Watcher?
  /// How many things wait for the owner in the current library: the dot on the icon.
  private var waiting = 0
  private var counting = false
  private var countAgain = false
  private var countTimer: Timer?
  /// The server's summary of what its pages show, last read: when it changes (a record written, a pairing asked), the dot is counted again.
  private var rev: String?
  private var revTimer: Timer?
  private var revAsking = false
  private var cursorSave: Timer?
  /// What the window's page asks of the shell about files of the library.
  private lazy var files = FileActions(window: window, config: config, hooks: Config.hooksName != nil, resolve: { [weak self] places in
    guard let self, let library = self.current, self.hasLibrary else { return [] }
    return LocalFile.from(await self.glance(places, facets: ["fs.path"], in: library), places: places)
  }, library: { [weak self] in self?.current })
  /// Library places whose glance answers carry a `placeholder` facet (`fake-placeholder:`): a real placeholder cannot be made in a check.
  private var fakePlaceholders: Set<String> = []
  /// Any change of this machine's settings, wherever made, reaches the configuration page's rows.
  private var machineWatch: AnyCancellable?
  /// With hooks the panel's menu is not popped up, being modal: it is kept for `menu-pick:`.
  private var keptPanelMenu: NSMenu?

  private var current: URL? { prefs.current.map { URL(fileURLWithPath: $0, isDirectory: true) } }

  func applicationDidFinishLaunching(_ notification: Notification) {
    Log.config = config
    Log.line("app: launched, home \(config.home.path), process age \(String(format: "%.0f", processAge() * 1000)) ms")
    prefs = Prefs.load(config)
    NSApp.appearance = (prefs.appearance ?? .system).appearance
    makeSettings()
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
    window.quickLook = files.quickLook
    window.onPageMessage = { [weak self] body in
      guard let self, !self.files.handle(body) else { return }
      self.pageSaid(body)
    }
    tray.onMessage = { [weak self] body in self?.pageSaid(body) }
    welcome.onChoose = { [weak self] choice in self?.chooseFolder(in: choice) }
    welcome.onInstallOther = { [weak self] in self?.installOther() }
    welcome.onClose = { [weak self] in if self?.window.isOpen == false { NSApp.setActivationPolicy(.accessory) } }
    countTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.countWaiting() } }
    revTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.askRev() } }
    if Config.hooksName != nil { listenForTestCommands() }
    guard config.complete else { return alert("Pneuma Base 不完整", detail: "应用缺少内置的 Node 或命令行工具，无法运行。请重新下载，或运行 app/build.sh 重新构建。") }
    if Config.translocated { warnTranslocated() }
    Task { await installLauncher() }
    Task {
      await switchTo(current)
      if !hasLibrary { await showWelcome() } else if CommandLine.arguments.contains("--open") { openWindow() }
    }
  }

  /// Points the launcher at this app's own Node and command line, at every launch: what connected
  /// agents run names the launcher, so moving or updating the app keeps them working.
  private func installLauncher() async {
    let r = await runCli(["launcher", "install", "--json"], in: FileManager.default.homeDirectoryForCurrentUser, config: config)
    let changed = (r.json?["data"] as? [String: Any])?["changed"] as? Bool
    Log.line(changed.map { "launcher: \($0 ? "written" : "unchanged") \(config.launcher.path)" } ?? "launcher: not written: \(r.err.prefix(300))")
  }

  /// Opened where it was unpacked, a downloaded app runs from a temporary place that goes away when it
  /// quits, and the launcher would point there.
  private func warnTranslocated() {
    Log.line("app: translocated, at \(Bundle.main.bundlePath)")
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = "请将 Pneuma Base 移动到「应用程序」文件夹后再打开"
    alert.informativeText = "应用当前从解压位置直接打开，macOS 在临时位置运行它。已连接的 Agent 按固定路径调用应用；应用退出后临时位置失效，Agent 将无法调用。"
    alert.addButton(withTitle: "退出")
    alert.addButton(withTitle: "暂不移动")
    if alert.runModal() == .alertFirstButtonReturn { NSApp.terminate(nil) }
  }

  private func makeSettings() {
    let model = MachineSettings(launcher: config.launcher, appearance: prefs.appearance ?? .system, ownerFiles: prefs.watchesOwnerFiles, link: prefs.pathLink)
    model.onAppearance = { [weak self] choice in self?.setAppearance(choice) }
    model.onOwnerFiles = { [weak self] on in
      guard let self else { return }
      self.prefs.ownerFiles = on
      self.prefs.save(self.config)
      self.watcher?.recordsOwnerFiles = on
      Log.line("app: owner files \(on ? "on" : "off")")
    }
    model.onLink = { [weak self] link in
      guard let self else { return }
      self.prefs.pathLink = link
      self.prefs.save(self.config)
    }
    let window = SettingsWindow(model: model)
    window.onClose = { [weak self] in
      guard let self, !self.window.isOpen, !self.welcome.isOpen else { return }
      NSApp.setActivationPolicy(.accessory)
    }
    settings = window
    machineWatch = model.objectWillChange.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.tellMachine() } }
    }
  }

  @objc func openSettings() { settings?.show() }

  /// The owner chose how the app looks: the window, the panel, the sheets and menus and the pages follow at once, and the choice is kept.
  private func setAppearance(_ choice: Appearance) {
    prefs.appearance = choice == .system ? nil : choice
    prefs.save(config)
    NSApp.appearance = choice.appearance
    tray.followAppearance()
    if settings?.model.appearance != choice { settings?.model.appearance = choice }
    Log.line("app: appearance \(choice.rawValue)")
  }

  /// This machine's settings as the configuration page's rows draw them.
  private func machineState() -> [String: Any] {
    guard let model = settings?.model else { return [:] }
    return [
      "appearance": model.appearance.rawValue,
      "ownerFiles": model.ownerFiles,
      "login": model.login == .enabled || model.login == .requiresApproval,
      "loginNote": model.loginNote ?? NSNull(),
      "pathLink": model.link ?? NSNull(),
      "pathFolder": model.folder.isEmpty ? NSNull() : model.folder,
      "launcherOnPath": model.launcherOnPath,
    ]
  }

  private func tellMachine() { window.tell(["machine": machineState()]) }

  /// A row of the configuration page changed a setting of this machine.
  private func setMachine(_ key: String, _ value: Any?) {
    guard let model = settings?.model else { return }
    switch key {
    case "appearance": if let word = value as? String, let choice = Appearance(rawValue: word) { model.appearance = choice }
    case "ownerFiles": if let on = value as? Bool { model.ownerFiles = on }
    case "login": if let on = value as? Bool { model.setLogin(on) }
    case "pathLink":
      // Turning it on needs a folder on the owner's PATH: with none known yet, the settings window chooses one.
      if value as? Bool == true { if model.folder.isEmpty { openSettings() } else { model.link(in: model.folder) } } else { model.unlink() }
    default: Log.line("machine: no setting \(key)")
    }
    tellMachine()
  }

  // MARK: Appearance and the panel's menu

  private func appearanceItem() -> NSMenuItem {
    let item = NSMenuItem(title: "外观", action: nil, keyEquivalent: "")
    let menu = NSMenu()
    let chosen = prefs.appearance ?? .system
    for choice in Appearance.allCases {
      let entry = NSMenuItem(title: choice.word, action: #selector(pickAppearance(_:)), keyEquivalent: "")
      entry.target = self
      entry.representedObject = choice.rawValue
      entry.state = choice == chosen ? .on : .off
      menu.addItem(entry)
    }
    item.submenu = menu
    return item
  }

  @objc private func pickAppearance(_ item: NSMenuItem) {
    guard let word = item.representedObject as? String, let choice = Appearance(rawValue: word) else { return }
    setAppearance(choice)
  }

  private func librariesItem() -> NSMenuItem {
    let item = NSMenuItem(title: "资料库", action: nil, keyEquivalent: "")
    let menu = NSMenu()
    for path in prefs.libraries {
      let entry = NSMenuItem(title: (path as NSString).lastPathComponent, action: #selector(selectLibrary(_:)), keyEquivalent: "")
      entry.target = self
      entry.representedObject = path
      entry.state = path == prefs.current ? .on : .off
      entry.toolTip = (path as NSString).abbreviatingWithTildeInPath
      menu.addItem(entry)
    }
    if !prefs.libraries.isEmpty { menu.addItem(.separator()) }
    menu.addItem(withTitle: "新建或打开资料库…", action: #selector(chooseLibrary), keyEquivalent: "").target = self
    item.submenu = menu
    return item
  }

  /// The panel's 「···」: how the app looks, the libraries, the settings, quitting; at that point of the panel.
  private func showPanelMenu(at point: CGPoint) {
    let menu = NSMenu()
    menu.addItem(appearanceItem())
    menu.addItem(librariesItem())
    menu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",").target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "退出 Pneuma Base", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    if Config.hooksName != nil {
      keptPanelMenu = menu
      let titles = menu.items.flatMap { [$0] + ($0.submenu?.items ?? []) }.map(\.title).filter { !$0.isEmpty }
      return Log.line("panel-menu: \(titles.joined(separator: " | "))")
    }
    tray.popUp(menu, at: point)
  }

  /// Performs the kept panel menu's entry with this title; false when there is none.
  private func pickPanelMenu(_ title: String) -> Bool {
    guard let menu = keptPanelMenu, let item = menu.items.flatMap({ [$0] + ($0.submenu?.items ?? []) }).first(where: { $0.title == title }), let action = item.action else { return false }
    keptPanelMenu = nil
    NSApp.sendAction(action, to: item.target, from: item)
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let watcher, let cursor = watcher.cursor { keep(cursor, of: watcher.library) }
    watcher?.stop()
    server?.stop()
    Log.line("app: quit")
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { openWindow() }
    return true
  }

  // MARK: Current library

  /// The current library, as storage confirmed it when the app switched to it.
  private var hasLibrary = false

  private func remember(_ dir: URL) {
    let path = dir.standardizedFileURL.path
    if !prefs.libraries.contains(path) { prefs.libraries.append(path) }
    prefs.current = path
    prefs.save(config)
  }

  /// One server and one watcher, for the current library only, once storage says the folder is one.
  private func switchTo(_ library: URL?) async {
    if server?.library == library { return }
    watcher?.stop()
    server?.stop()
    watcher = nil
    server = nil
    hasLibrary = false
    setWaiting(0)
    guard let library, await isLibrary(library, config: config) else { return tray.forget() }
    // Another switch may have come while storage was asked.
    guard current?.standardizedFileURL.path == library.standardizedFileURL.path, server == nil else { return }
    hasLibrary = true
    let server = Server(library: library, config: config)
    server.onAddress = { [weak self] url in
      self?.window.serverReady(url)
      self?.tray.serverReady(url)
    }
    server.start()
    self.server = server
    rev = nil
    Task { await watch(library) }
    countWaiting()
  }

  /// The watcher of the current library: the provider it uses, as `storage list` names it, started in
  /// its long-lived mode and subscribed from the cursor kept for this library.
  private func watch(_ library: URL) async {
    guard let program = await providerProgram(for: library, config: config) else { return }
    guard server?.library == library, watcher == nil else { return }
    let watcher = Watcher(library: library, config: config, provider: program, cursor: prefs.cursors?[library.standardizedFileURL.path], recordsOwnerFiles: prefs.watchesOwnerFiles)
    watcher.onRecorded = { [weak self] registered, seen in self?.recorded(registered, seen) }
    watcher.onCursor = { [weak self] cursor in self?.keepSoon(cursor, of: library) }
    watcher.start()
    self.watcher = watcher
  }

  /// The watcher's cursor for a library, kept in the app's preferences so the next subscription hears what changed meanwhile.
  private func keep(_ cursor: String, of library: URL) {
    var cursors = prefs.cursors ?? [:]
    cursors[library.standardizedFileURL.path] = cursor
    prefs.cursors = cursors
    prefs.save(config)
  }

  private func keepSoon(_ cursor: String, of library: URL) {
    var cursors = prefs.cursors ?? [:]
    cursors[library.standardizedFileURL.path] = cursor
    prefs.cursors = cursors
    guard cursorSave == nil else { return }
    cursorSave = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.cursorSave = nil
        self.prefs.save(self.config)
      }
    }
  }

  /// Asks the server for its summary; a new one means something the dot may count changed.
  private func askRev() {
    guard !revAsking, let address = server?.address, var parts = URLComponents(url: address, resolvingAgainstBaseURL: false) else { return }
    parts.path = "/api/rev"
    guard let url = parts.url else { return }
    revAsking = true
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      let seen = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }?["rev"] as? String
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self else { return }
          self.revAsking = false
          guard let seen, seen != self.rev else { return }
          let first = self.rev == nil
          self.rev = seen
          if !first { self.countWaiting() }
        }
      }
    }.resume()
  }

  @objc func openWindow() {
    guard let library = current, server != nil else {
      if hasLibrary { chooseLibrary() } else { Task { await showWelcome() } }
      return
    }
    window.open(title: library.lastPathComponent, address: server?.address)
  }

  @objc func chooseLibrary() { chooseFolder(in: nil) }

  /// A folder the owner chooses for a library, kept by `choice` (the local folder when none): an
  /// official provider not installed is installed first.
  private func chooseFolder(in choice: StorageChoice?) {
    Task {
      if let repository = choice?.install {
        welcome.say("正在安装 \(repository)…")
        let r = await runCli(["storage", "install", repository, "--json"], in: config.home, config: config)
        welcome.say("")
        guard r.json?["outcome"] as? String == "done" else { return alert("无法安装 \(repository)", detail: (r.json?["text"] as? String) ?? r.err) }
        await refreshChoices()
      }
      NSApp.activate()
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.canCreateDirectories = true
      panel.prompt = "使用此文件夹"
      panel.message = "选择资料库，或选择要初始化为资料库的文件夹。"
      guard panel.runModal() == .OK, let dir = panel.url else { return }
      await open(dir, provider: choice?.name)
    }
  }

  /// The places to keep a library this machine offers: its providers, then the official ones not installed.
  private func refreshChoices() async {
    let r = await runCli(["storage", "list", "--json"], in: config.home, config: config)
    let data = r.json?["data"] as? [String: Any]
    let installed = (data?["providers"] as? [[String: Any]] ?? []).compactMap { p -> StorageChoice? in
      guard let name = p["name"] as? String else { return nil }
      let summary = (p["origin"] as? [String: Any])?["kind"] as? String == "built-in" ? "本机文件夹" : name
      return StorageChoice(name: name, summary: summary, forms: p["addresses"] as? [String] ?? [], install: nil)
    }
    let official = (data?["official"] as? [[String: Any]] ?? []).compactMap { o -> StorageChoice? in
      guard let name = o["name"] as? String, let repository = o["repository"] as? String else { return nil }
      return StorageChoice(name: name, summary: o["summary"] as? String ?? name, forms: o["addresses"] as? [String] ?? [], install: repository)
    }
    let choices = installed + official
    welcome.offer(choices.isEmpty ? [StorageChoice(name: "local-folder", summary: "本机文件夹", forms: ["path"], install: nil)] : choices)
  }

  private func showWelcome() async {
    await refreshChoices()
    welcome.show()
  }

  /// 安装其他存储…: a provider from a GitHub repository. The command line says what a provider is and
  /// names the version and checksum; the owner accepts it here, and the install runs with that checksum.
  private func installOther() {
    NSApp.activate()
    let ask = NSAlert()
    ask.messageText = "安装其他存储"
    ask.informativeText = "输入 GitHub 仓库：owner/repo 或 owner/repo@版本。"
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
    field.placeholderString = "owner/repo"
    ask.accessoryView = field
    ask.addButton(withTitle: "继续")
    ask.addButton(withTitle: "取消")
    ask.window.initialFirstResponder = field
    guard ask.runModal() == .alertFirstButtonReturn else { return }
    let repository = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !repository.isEmpty else { return }
    Task { await install(["storage", "install", repository, "--json"], naming: repository) }
  }

  /// Runs an install; a refusal that carries an offer (the trust statement, and the call that accepts it) is asked of the owner, and the offer run when accepted.
  private func install(_ args: [String], naming repository: String) async {
    welcome.say("正在安装 \(repository)…")
    let r = await runCli(args, in: config.home, config: config)
    welcome.say("")
    let text = (r.json?["text"] as? String) ?? r.err
    if r.json?["outcome"] as? String == "done" {
      await refreshChoices()
      welcome.say(text)
      return
    }
    guard let offer = r.json?["offer"] as? [String: Any], let call = offer["call"] as? [String: Any], let command = call["command"] as? String else {
      return alert("无法安装 \(repository)", detail: text)
    }
    NSApp.activate()
    let confirm = NSAlert()
    confirm.messageText = "安装 \(repository)？"
    confirm.informativeText = offer["confirm"] as? String ?? text
    confirm.addButton(withTitle: offer["label"] as? String ?? "安装")
    confirm.addButton(withTitle: "取消")
    guard confirm.runModal() == .alertFirstButtonReturn else { return }
    let callArgs = call["args"] as? [String: Any]
    var words = command.split(separator: " ").map(String.init) + (callArgs?["positional"] as? [String] ?? [])
    for (flag, value) in (callArgs?["flags"] as? [String: Any] ?? [:]).sorted(by: { $0.key < $1.key }) {
      words += value as? Bool == true ? ["--\(flag)"] : (value as? [String] ?? []).flatMap { ["--\(flag)", $0] }
    }
    await install(words + ["--json"], naming: repository)
  }

  /// A folder the owner chose: made a library if it is not one, kept by `provider` when one was chosen,
  /// then the main window on its home page.
  private func open(_ dir: URL, provider: String? = nil) async {
    if !(await isLibrary(dir, config: config)) {
      let r = await runCli(["init", dir.path, "--json"] + (provider.map { ["--provider", $0] } ?? []), in: dir.deletingLastPathComponent(), config: config)
      guard r.json?["outcome"] as? String == "done" else { return alert("无法初始化资料库", detail: (r.json?["text"] as? String) ?? r.err) }
      Log.line("app: made \(dir.lastPathComponent) a library with \((r.json?["data"] as? [String: Any])?["provider"] as? String ?? "?")")
    }
    if window.isOpen, current != dir { window.close() }
    if current != dir { window.forgetRoute() }
    remember(dir)
    await switchTo(dir)
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
        let r = await runCli(bringArgs(url, to: await freePath(for: url.lastPathComponent, in: folder, of: library), in: library), in: library, config: config)
        if r.json?["outcome"] as? String == "accepted", let path = r.json?["path"] as? String { placed.append(path) } else { Log.line("drop: \(url.lastPathComponent) not placed: \(r.err.prefix(200)) \(String(decoding: r.out.prefix(300), as: UTF8.self))") }
      }
      Log.line("drop (\(place)): placed \(placed)")
      guard !placed.isEmpty else { return }
      let text = placed.count == 1 ? "已添加 \(placed[0])，标记为我导入" : "已添加到 \(folder)/：\(placed.count) 个条目，标记为我导入"
      if window.isOpen { window.notice(tone: "good", text: text) } else { notify(text) }
      countWaiting()
    }
  }

  private func bringArgs(_ url: URL, to path: String, in library: URL) -> [String] {
    let source = downloadAddress(of: url) ?? url.deletingLastPathComponent().lastPathComponent
    return ["--library", library.path, "--session", config.session, "put", url.path, "--to", path,
            "--imported", "--by", "owner", "--source", source, "--note", "拖入的文件", "--json"]
  }

  /// `<folder>/<name>`, or `<folder>/<name> 2.<ext>` and so on when that is taken, as Finder names copies:
  /// the first that storage says holds nothing, asked a page of names at a time. Without an answer, the
  /// name itself, and the put says what is there.
  private func freePath(for name: String, in folder: String, of library: URL) async -> String {
    let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    let named = { (n: Int) in "\(folder)/\(n == 1 ? name : ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")" }
    for first in stride(from: 1, to: 1000, by: Self.namesAsked) {
      let places = (first..<first + Self.namesAsked).map(named)
      guard let entries = await glance(places, in: library)?["entries"] as? [[String: Any]] else { break }
      if let free = entries.first(where: { $0["kind"] as? String == "none" })?["place"] as? String { return free }
    }
    return named(1)
  }

  /// How many names one look at a dropped file's place asks storage about.
  private static let namesAsked = 50

  /// Storage's `glance` of these places, with these facets: through the watcher's provider when it
  /// runs, else a run of the provider's program.
  private func glance(_ places: [String], facets: [String] = [], in library: URL) async -> [String: Any]? {
    let body: [String: Any] = facets.isEmpty ? ["places": places] : ["places": places, "facets": facets]
    var answer: [String: Any]? = nil
    if watcher?.library == library { answer = await watcher?.ask("glance", body) }
    if answer == nil { answer = await askStorage("glance", body, of: library, config: config) }
    guard !fakePlaceholders.isEmpty, var entries = answer?["entries"] as? [[String: Any]] else { return answer }
    for i in entries.indices where fakePlaceholders.contains(entries[i]["place"] as? String ?? "") {
      var facets = entries[i]["facets"] as? [String: Any] ?? [:]
      facets["placeholder"] = [String: Any]()
      entries[i]["facets"] = facets
    }
    answer?["entries"] = entries
    return answer
  }

  /// Files or folders the owner picks after the page's 选择….
  private func chooseFiles(into folder: String) {
    guard hasLibrary else { return }
    NSApp.activate()
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = true
    panel.prompt = "添加到资料库"
    panel.message = "所选文件和文件夹将添加到 \(folder)/，标记为我导入。"
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
    case "waiting": if let count = body["count"] as? Int { setWaiting(count) }
    case "panel-menu": showPanelMenu(at: CGPoint(x: (body["x"] as? NSNumber)?.doubleValue ?? 0, y: (body["y"] as? NSNumber)?.doubleValue ?? 0))
    case "machine":
      settings?.model.refresh()
      tellMachine()
    case "machine-set": if let key = body["key"] as? String { setMachine(key, body["value"]) }
    case "settings": openSettings()
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
    guard hasLibrary, let button = statusItem?.button else {
      Task { await showWelcome() }
      return
    }
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
    menu.addItem(withTitle: "新建或打开资料库…", action: #selector(chooseLibrary), keyEquivalent: "").target = self
    menu.addItem(withTitle: "打开主窗口", action: #selector(openWindow), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(appearanceItem())
    menu.addItem(ownerFilesItem())
    menu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "退出 Pneuma Base", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    // Shown the way a status item shows its own menu, so the system places it.
    statusItem?.menu = menu
    button.performClick(nil)
    statusItem?.menu = nil
  }

  /// The icon, with a dot when something waits for the owner. A template, so it follows the menu bar.
  private static func icon(dot: Bool) -> NSImage? {
    let image = NSImage(named: dot ? "TrayWaiting" : "Tray")
    image?.accessibilityDescription = dot ? "Pneuma Base：有待处理事项" : "Pneuma Base"
    return image
  }

  private func setWaiting(_ count: Int) {
    guard count != waiting else { return }
    waiting = count
    statusItem?.button?.image = Self.icon(dot: count > 0)
    statusItem?.button?.toolTip = count > 0 ? "\(count) 项待处理" : nil
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
    let item = NSMenuItem(title: "直接拷入的文件记为我添加", action: #selector(toggleOwnerFiles), keyEquivalent: "")
    item.target = self
    item.toolTip = "启用后，在访达中拷入资料库或直接修改的文件，记为我导入或我修改（检测到）。"
    return item
  }

  @objc private func toggleOwnerFiles() { settings?.model.ownerFiles.toggle() }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(toggleOwnerFiles):
      item.state = prefs.watchesOwnerFiles ? .on : .off
      return true
    case #selector(selectionCommand(_:)): return window.isOpen && files.selection > 0
    case #selector(viewCommand(_:)): return window.isOpen
    default: return true
    }
  }

  // MARK: Notifications

  /// What the watcher recorded of the owner's own doing: said in the window if it is open, else as a notification.
  private func recorded(_ registered: [String], _ seen: [String]) {
    var parts: [String] = []
    if !registered.isEmpty { parts.append("已登记 \(registered.count) 个直接拷入的文件，标记为我导入") }
    if !seen.isEmpty { parts.append("已记录 \(seen.count) 处直接修改，标记为我修改") }
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
      item("设置…", #selector(openSettings), ",", target: self),
      ownerFilesItem(),
      .separator(),
      item("隐藏 Pneuma Base", #selector(NSApplication.hide(_:)), "h"),
      item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("全部显示", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("退出 Pneuma Base", #selector(NSApplication.terminate(_:)), "q"),
    ])
    // A command for the page, named by the item's identifier.
    func command(_ title: String, _ name: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = item(title, action, key, mods, target: self)
      i.identifier = NSUserInterfaceItemIdentifier(name)
      return i
    }
    let up = String(Character(UnicodeScalar(NSUpArrowFunctionKey)!))
    submenu("文件", [
      item("新建或打开资料库…", #selector(chooseLibrary), "o", [.command, .shift], target: self),
      .separator(),
      command("打开", "open", #selector(selectionCommand(_:)), "o"),
      command("快速查看", "preview", #selector(selectionCommand(_:)), "y"),
      command("在访达中显示", "reveal", #selector(selectionCommand(_:)), "r"),
      command("复制路径", "copy-path", #selector(selectionCommand(_:)), "c", [.command, .option]),
      command("重命名", "rename", #selector(selectionCommand(_:))),
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
      command("列表", "list", #selector(viewCommand(_:)), "1"),
      command("图标", "icons", #selector(viewCommand(_:)), "2"),
      .separator(),
      item("后退", #selector(goBack), "[", target: self),
      item("前进", #selector(goForward), "]", target: self),
      command("上一级", "up", #selector(viewCommand(_:)), up),
      .separator(),
      item("重新载入", #selector(reloadPage), "r", [.command, .option], target: self),
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
  /// 打开, 快速查看, 在访达中显示, 复制路径, 重命名: for the page's selection.
  @objc private func selectionCommand(_ item: NSMenuItem) { item.identifier.map { files.command($0.rawValue) } }
  /// 列表, 图标, 上一级: for the page the window shows.
  @objc private func viewCommand(_ item: NSMenuItem) { item.identifier.map { files.command($0.rawValue) } }

  // MARK: Test hooks

  /// Lets the measurements and checks drive the app without a person, only when it was started with
  /// `--hooks <name>`: a distributed notification named `Config.hooksName` with object `open`, `close`, `quit`, `pids`, `park` (moves the window
  /// almost off the screen, still visible to WebKit), `dark`, `light` or `system` (外观, as the menu
  /// chooses it, kept), `text-appearance:<file>` (the appearance as chosen, kept and seen by the app, the
  /// window, the panel and both pages), `hit:<x>,<y>`, `find:<text>`,
  /// `library:<folder>` (as if chosen in the first-launch window or 新建或打开资料库…), `drop:<path>`
  /// and `drop-window:<path>` (through the same code as a file dropped on the menu bar item or the
  /// window), `route:<fragment>` (the page's address fragment), `tray` (a click on the icon), `text:<file>` and `text-tray:<file>` (the page's text),
  /// `snap:<file>`, `snap-tray:<file>`, `snap-welcome:<file>` and `snap-settings:<file>` (a picture of it), `text-welcome:<file>` (what the first-launch window offers),
  /// `capture:<file>` and `capture-tray:<file>` (a picture of the window, its sheet included, or the
  /// panel, as the screen shows them), `resize:<width>,<height>`, `panel-menu` (the panel's 「···」,
  /// kept for `menu-pick:` as the context menu is), `tray-room:<points>` (the room under the menu bar,
  /// as a small display gives it), `tray-fit:<file>` (whether every row of the panel can be seen),
  /// `sheet:<n>` (a click on the sheet's n-th button),
  /// `settings` (the settings window), `path-link:<folder>` and `path-unlink` (as the 安装命令行工具
  /// switch does), `text-settings:<file>` (the settings in words), `eval:<js>` (runs it in the
  /// window's page and logs `eval: <the result as text>`; the checks post the page's messages with it),
  /// `menu-pick:<title>` (with hooks the context menu is not popped up, being modal: its entries are
  /// logged and kept, and this performs the one with that title, a page entry by its label),
  /// `fake-placeholder:<library path>` (from now on the app's glance answers for that place carry a
  /// `placeholder` facet), `owner-files:on` and `owner-files:off` (as the 直接拷入的文件记为我添加 item does).
  /// With hooks, acts that reach outside the app (opening, revealing, the pasteboard, a terminal) are
  /// only logged, as `opener: …`.
  private func listenForTestCommands() {
    guard let name = Config.hooksName else { return }
    DistributedNotificationCenter.default().addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] note in
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
        case "text-welcome": try? self.welcome.textForTest.write(to: file, atomically: true, encoding: .utf8)
        case "settings": self.openSettings()
        case "path-link": self.settings?.model.link(in: rest)
        case "path-unlink": self.settings?.model.unlink()
        case "text-settings": try? self.settings?.model.text.write(to: file, atomically: true, encoding: .utf8)
        case "snap-settings": self.settings?.snapshotForTest(to: file)
        case "park": self.window.park()
        case "dark", "light", "system": Appearance(rawValue: verb).map(self.setAppearance)
        case "text-appearance": self.appearanceForTest(to: file)
        case "panel-menu": self.showPanelMenu(at: .zero)
        case "tray-room": self.tray.roomForTest = Double(rest).map { CGFloat($0) }
        case "tray-fit": self.tray.fitForTest(to: file)
        case "hit":
          let xy = rest.split(separator: ",").compactMap { Double($0) }
          if xy.count == 2 { self.window.hitForTest(x: xy[0], y: xy[1]) }
        case "find": self.window.findForTest(rest)
        case "eval": self.window.evalForTest(rest)
        case "menu-pick": if !self.pickPanelMenu(rest) { self.files.pick(rest) }
        case "fake-placeholder": self.fakePlaceholders.insert(rest)
        case "owner-files": self.settings?.model.ownerFiles = rest == "on"
        case "capture": captureWindow(self.window.windowForTest, to: file)
        case "capture-tray": captureWindow(self.tray.windowForTest, to: file)
        case "resize":
          let wh = rest.split(separator: ",").compactMap { Double($0) }
          if wh.count == 2 { self.window.resizeForTest(width: wh[0], height: wh[1]) }
        case "sheet": self.window.answerSheet(Int(rest) ?? 1)
        case "pids": Log.line("pids: app \(getpid()) server \(self.server?.pid ?? 0) web \(self.window.webContentPid ?? 0) storage \(self.watcher?.pid ?? 0)")
        default: break
        }
      }
    }
  }
}

extension AppDelegate {
  /// The appearance as chosen, kept, and seen by the app, the window, the panel and both pages, for verify.sh.
  fileprivate func appearanceForTest(to file: URL) {
    let name = { (a: NSAppearance?) in a.map { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? "dark" : "light" } ?? "none" }
    var lines = [
      "choice: \((prefs.appearance ?? .system).rawValue)",
      "kept: \((Prefs.load(config).appearance ?? .system).rawValue)",
      "app: \(name(NSApp.effectiveAppearance))",
      "window: \(name(window.appearanceForTest))",
      "tray: \(name(tray.appearanceForTest))",
    ]
    let scheme = "document.documentElement.dataset.scheme || 'none'"
    window.evaluateForTest(scheme) { page in
      lines.append("page: \(page)")
      self.tray.evaluateForTest(scheme) { trayPage in
        lines.append("tray page: \(trayPage)")
        try? (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
        Log.line("appearance: wrote \(file.lastPathComponent)")
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

/// The address macOS recorded when a file outside the library was downloaded, read before it is
/// brought in: the first entry of `com.apple.metadata:kMDItemWhereFroms`, a property list of strings,
/// or plain text if written as such.
func downloadAddress(of url: URL) -> String? {
  let name = "com.apple.metadata:kMDItemWhereFroms"
  let size = getxattr(url.path, name, nil, 0, 0, 0)
  guard size > 0 else { return nil }
  var data = Data(count: size)
  let read = data.withUnsafeMutableBytes { getxattr(url.path, name, $0.baseAddress, size, 0, 0) }
  guard read > 0 else { return nil }
  if let list = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String] {
    return list.first { !$0.isEmpty }
  }
  let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  return text.isEmpty ? nil : text
}
