import AppKit

/// A library place as a file of this machine, as storage described it.
struct LocalFile: Sendable {
  let place: String
  let url: URL
  let isDirectory: Bool
  /// Only a placeholder is here: its content is elsewhere, and nothing may read it.
  let placeholder: Bool
  /// Storage's state token for the place.
  let token: String?

  /// The places of a `glance` asked with `facets: ["fs.path"]` that are files or directories of this
  /// machine, in the order asked. A store without local files would read each into a temporary file
  /// here instead (storage's `read`); a place with neither is skipped and logged.
  @MainActor
  static func from(_ glance: [String: Any]?, places: [String]) -> [LocalFile] {
    let entries = glance?["entries"] as? [[String: Any]] ?? []
    var seen = Set<String>()
    var files: [LocalFile] = []
    for place in places where seen.insert(place).inserted {
      guard let entry = entries.first(where: { $0["place"] as? String == place }) else {
        Log.line("files: \(place) skipped: storage did not describe it")
        continue
      }
      let kind = entry["kind"] as? String
      let facets = entry["facets"] as? [String: Any]
      guard kind == "file" || kind == "dir" else {
        Log.line("files: \(place) skipped: \(kind ?? "no kind")")
        continue
      }
      guard let path = (facets?["fs"] as? [String: Any])?["path"] as? String else {
        Log.line("files: \(place) skipped: no fs.path")
        continue
      }
      files.append(LocalFile(place: place, url: URL(fileURLWithPath: path, isDirectory: kind == "dir"), isDirectory: kind == "dir",
                             placeholder: facets?["placeholder"] != nil, token: entry["token"] as? String))
    }
    return files
  }
}

/// The page's own entry of the context menu.
struct PageMenuItem {
  let id: String
  let label: String
  let danger: Bool
}

/// What the window's page asks of the shell about files of the library, parsed once here; the
/// TypeScript side is `ShellMessage` in `packages/viewer/web/src/shell.ts`.
enum FileMessage {
  case preview([String], at: Int)
  case launch([String])
  case reveal([String])
  case copyPath([String])
  case menu([String], at: CGPoint, items: [PageMenuItem])
  case thumbnails([(path: String, token: String?)], px: Int)
  case drag([String])
  case selection(Int)
  case reopen(url: URL?, run: (command: String, cwd: String)?, reveal: String?)
  /// An absolute path the page was given as a local cell: only the current library's folder or a place in it.
  case revealLocal(String)

  init?(_ body: [String: Any]) {
    let paths = body["paths"] as? [String] ?? []
    let number = { (key: String) in (body[key] as? NSNumber)?.doubleValue ?? 0 }
    switch body["type"] as? String {
    case "preview": self = .preview(paths, at: Int(number("at")))
    case "launch": self = .launch(paths)
    case "reveal": self = .reveal(paths)
    case "copy-path": self = .copyPath(paths)
    case "menu":
      let items = (body["items"] as? [[String: Any]] ?? []).compactMap { item -> PageMenuItem? in
        guard let id = item["id"] as? String, let label = item["label"] as? String else { return nil }
        return PageMenuItem(id: id, label: label, danger: item["danger"] as? Bool == true)
      }
      self = .menu(paths, at: CGPoint(x: number("x"), y: number("y")), items: items)
    case "thumbnails":
      let items = (body["items"] as? [[String: Any]] ?? []).compactMap { item -> (path: String, token: String?)? in
        (item["path"] as? String).map { ($0, item["token"] as? String) }
      }
      self = .thumbnails(items, px: Int(number("px")))
    case "drag": self = .drag(paths)
    case "selection": self = .selection(Int(number("count")))
    case "reopen":
      let run = (body["run"] as? [String: Any]).flatMap { r -> (command: String, cwd: String)? in
        guard let command = r["command"] as? String, let cwd = r["cwd"] as? String else { return nil }
        return (command, cwd)
      }
      self = .reopen(url: (body["url"] as? String).flatMap(URL.init(string:)), run: run, reveal: (body["reveal"] as? String).flatMap { $0.isEmpty ? nil : $0 })
    case "reveal-local": guard let path = body["path"] as? String else { return nil }
      self = .revealLocal(path)
    default: return nil
    }
  }
}

/// Every act of the shell that reaches outside the app. With `--hooks` the recording one is used, so a
/// check launches nothing.
@MainActor
protocol Opener {
  /// Each with its default application; a directory in Finder.
  func open(_ files: [URL])
  func open(_ files: [URL], with app: URL)
  func reveal(_ files: [URL])
  func open(url: URL)
  /// A `.command` file, which runs in the application that handles them, the default terminal.
  func run(_ commandFile: URL)
  func copy(_ text: String)
}

@MainActor
struct SystemOpener: Opener {
  func open(_ files: [URL]) { files.forEach { NSWorkspace.shared.open($0) } }

  func open(_ files: [URL], with app: URL) {
    NSWorkspace.shared.open(files, withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
      if let error { DispatchQueue.main.async { MainActor.assumeIsolated { Log.line("opener: open-with \(app.lastPathComponent) failed: \(error.localizedDescription)") } } }
    }
  }

  func reveal(_ files: [URL]) { NSWorkspace.shared.activateFileViewerSelecting(files) }
  func open(url: URL) { NSWorkspace.shared.open(url) }
  func run(_ commandFile: URL) { NSWorkspace.shared.open(commandFile) }

  func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
}

/// Logs one line per act and does nothing outside the app.
@MainActor
struct RecordingOpener: Opener {
  private static func paths(_ files: [URL]) -> String { files.map(\.path).joined(separator: " | ") }

  func open(_ files: [URL]) { Log.line("opener: open \(Self.paths(files))") }
  func open(_ files: [URL], with app: URL) { Log.line("opener: open-with \(app.path) :: \(Self.paths(files))") }
  func reveal(_ files: [URL]) { Log.line("opener: reveal \(Self.paths(files))") }
  func open(url: URL) { Log.line("opener: url \(url.absoluteString)") }

  func run(_ commandFile: URL) {
    let text = (try? String(contentsOf: commandFile, encoding: .utf8)) ?? ""
    Log.line("opener: run \(commandFile.path)\n\(text.trimmingCharacters(in: .newlines))")
  }

  func copy(_ text: String) { Log.line("opener: copy \(text)") }
}

/// What the window's page asks of the shell about files of the library: the system's Quick Look,
/// opening, revealing, copying paths, the context menu, thumbnails, dragging out, and opening a
/// conversation again. Library paths become files of this machine through storage only (`resolve`).
@MainActor
final class FileActions {
  let quickLook = QuickLook()
  private let window: MainWindow
  private let opener: any Opener
  private let thumbnails: Thumbnails
  private let hooks: Bool
  private let resolve: @MainActor ([String]) async -> [LocalFile]
  /// The current library's folder, for the thumbnails' cache.
  private let library: @MainActor () -> URL?
  private let dragSource = FileDragSource()
  /// How many places the page has selected, for the app's menus.
  private(set) var selection = 0
  /// The latest preview asked for: an older one resolved later is dropped.
  private var previewAsked = 0
  /// With hooks the context menu is not popped up: it is kept for `menu-pick:`.
  private var keptMenu: NSMenu?

  init(window: MainWindow, config: Config, hooks: Bool, resolve: @escaping @MainActor ([String]) async -> [LocalFile], library: @escaping @MainActor () -> URL?) {
    self.window = window
    self.opener = hooks ? RecordingOpener() : SystemOpener()
    self.thumbnails = Thumbnails(config: config)
    self.hooks = hooks
    self.resolve = resolve
    self.library = library
    quickLook.onPreviewing = { [weak window] on in window?.tell(["previewing": on]) }
    quickLook.onKey = { [weak window] key, shift in window?.tell(["key": key, "shift": shift]) }
    thumbnails.prune()
  }

  /// Handles a file message of the window's page; false when the message is not one.
  func handle(_ body: [String: Any]) -> Bool {
    guard let message = FileMessage(body) else { return false }
    switch message {
    case .preview(let paths, let at): Task { await preview(paths, at: at) }
    case .launch(let paths): act(on: paths) { [opener] in opener.open($0) }
    case .reveal(let paths): act(on: paths) { [opener] in opener.reveal($0) }
    case .copyPath(let paths): act(on: paths) { [opener] in opener.copy($0.map(\.path).joined(separator: "\n")) }
    case .menu(let paths, let point, let items): Task { menu(await resolve(paths), at: point, items: items) }
    case .thumbnails(let items, let px): Task { await thumbnails(items, px: px) }
    case .drag(let paths): Task { drag(await resolve(paths)) }
    case .selection(let count): selection = count
    case .reopen(let url, let run, let reveal): reopen(url: url, run: run, reveal: reveal)
    case .revealLocal(let path): revealLocal(path)
    }
    return true
  }

  /// Shows the library's folder, or a place in it, in Finder; a path anywhere else is refused.
  private func revealLocal(_ path: String) {
    guard let root = library()?.standardizedFileURL.path else { return Log.line("reveal-local: no library") }
    let asked = URL(fileURLWithPath: path).standardizedFileURL.path
    guard asked == root || asked.hasPrefix(root + "/") else { return Log.line("reveal-local: refused \(path)") }
    opener.reveal([URL(fileURLWithPath: asked)])
  }

  /// Acts on the files these places are, when there are any.
  private func act(on paths: [String], _ act: @escaping @MainActor ([URL]) -> Void) {
    Task {
      let urls = await resolve(paths).map(\.url)
      if !urls.isEmpty { act(urls) }
    }
  }

  /// A command of the app's menus for the page's selection.
  func command(_ name: String) { window.tell(["command": name]) }

  private func preview(_ paths: [String], at: Int) async {
    previewAsked += 1
    let asked = previewAsked
    guard !paths.isEmpty else {
      Log.line("preview: close")
      return quickLook.close()
    }
    let files = await resolve(paths)
    guard asked == previewAsked else { return }
    guard !files.isEmpty else { return quickLook.close() }
    let wanted = paths.indices.contains(at) ? paths[at] : nil
    let index = files.firstIndex { $0.place == wanted } ?? min(max(at, 0), files.count - 1)
    Log.line("preview: \(files.map(\.url.path).joined(separator: " | ")) at \(index)")
    quickLook.show(files.map(\.url), at: index)
  }

  // MARK: The context menu

  /// The system's menu for these files at a point of the page: the shell's own entries, then the page's.
  private func menu(_ files: [LocalFile], at point: CGPoint, items: [PageMenuItem]) {
    let urls = files.map(\.url)
    let menu = NSMenu()
    menu.autoenablesItems = false
    if !urls.isEmpty {
      menu.addItem(Self.entry("打开") { [weak self] in self?.command("open") })
      menu.addItem(openWith(urls))
      menu.addItem(.separator())
      menu.addItem(Self.entry("快速查看") { [weak self] in self?.command("preview") })
      menu.addItem(Self.entry("在访达中显示") { [weak self] in self?.opener.reveal(urls) })
      menu.addItem(Self.entry("复制路径") { [weak self] in self?.opener.copy(urls.map(\.path).joined(separator: "\n")) })
    }
    for (i, item) in items.enumerated() {
      let firstDanger = item.danger && !items[..<i].contains { $0.danger }
      if i == 0 ? !urls.isEmpty : firstDanger { menu.addItem(.separator()) }
      menu.addItem(Self.entry(item.label) { [weak self] in self?.window.tell(["menu": item.id]) })
    }
    guard !menu.items.isEmpty else { return }
    Log.line("menu: \(menu.items.map { $0.isSeparatorItem ? "—" : $0.title }.joined(separator: " | "))")
    if hooks { keptMenu = menu } else { window.popUp(menu, at: point) }
  }

  /// 打开方式: the applications the system offers for the first file, the default one first, then
  /// the others by name, one entry per application however many copies of it this machine has.
  private func openWith(_ urls: [URL]) -> NSMenuItem {
    let holder = NSMenuItem(title: "打开方式", action: nil, keyEquivalent: "")
    let submenu = NSMenu()
    submenu.autoenablesItems = false
    let preferred = NSWorkspace.shared.urlForApplication(toOpen: urls[0])
    var seen = Set<String>()
    let apps = ([preferred].compactMap { $0 } + NSWorkspace.shared.urlsForApplications(toOpen: urls[0]))
      .filter { seen.insert(Bundle(url: $0)?.bundleIdentifier ?? $0.standardizedFileURL.path).inserted }
      .map { (url: $0, name: FileManager.default.displayName(atPath: $0.path)) }
    let others = apps.dropFirst(preferred == nil ? 0 : 1).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    for (i, app) in (apps.prefix(preferred == nil ? 0 : 1) + others).enumerated() {
      if i == 1, preferred != nil { submenu.addItem(.separator()) }
      let item = Self.entry(i == 0 && preferred != nil ? "\(app.name)（默认）" : app.name) { [weak self] in self?.opener.open(urls, with: app.url) }
      if let icon = NSWorkspace.shared.icon(forFile: app.url.path).copy() as? NSImage {
        icon.size = NSSize(width: 16, height: 16)
        item.image = icon
      }
      submenu.addItem(item)
    }
    holder.submenu = submenu
    Log.line("menu: 打开方式 \(submenu.items.map { $0.isSeparatorItem ? "—" : $0.title }.joined(separator: " | "))")
    return holder
  }

  private static func entry(_ title: String, _ run: @escaping @MainActor () -> Void) -> NSMenuItem {
    let action = MenuAction(run)
    let item = NSMenuItem(title: title, action: #selector(MenuAction.perform(_:)), keyEquivalent: "")
    // The item holds its target only weakly; the represented object keeps it.
    item.target = action
    item.representedObject = action
    return item
  }

  /// `menu-pick:<title>`: performs the entry of the kept menu with this title, a page entry by its label.
  func pick(_ title: String) {
    let items = (keptMenu?.items ?? []).flatMap { [$0] + ($0.submenu?.items ?? []) }
    guard let action = items.first(where: { $0.title == title })?.representedObject as? MenuAction else {
      return Log.line("menu-pick: no entry \(title)")
    }
    keptMenu = nil
    action.run()
  }

  // MARK: Thumbnails

  private func thumbnails(_ items: [(path: String, token: String?)], px: Int) async {
    let kept = Array(items.prefix(Thumbnails.most))
    if items.count > kept.count { Log.line("thumbnails: \(items.count - kept.count) beyond the first \(Thumbnails.most) ignored") }
    guard let library = library() else { return }
    let files = Dictionary(await resolve(kept.map(\.path)).map { ($0.place, $0) }) { a, _ in a }
    let jobs = kept.compactMap { ask in files[ask.path].map { Thumbnails.Job(path: ask.path, token: ask.token, file: $0) } }
    let counts = await thumbnails.make(jobs, library: realPath(library), px: px) { [weak window] job, src in
      window?.tell(["thumbnail": ["path": job.path, "token": job.token.map { $0 as Any } ?? NSNull(), "src": src]])
    }
    Log.line("thumbnails: asked \(items.count), kept \(kept.count), cached \(counts.cached), made \(counts.made), icons \(counts.icons), placeholders \(counts.placeholders)")
  }

  // MARK: Dragging out

  private func drag(_ files: [LocalFile]) {
    let urls = files.map(\.url)
    guard !urls.isEmpty else { return }
    Log.line("drag: offers \(urls.map(\.absoluteString).joined(separator: " ")) as copy")
    if hooks { return }
    if !window.dragFiles(urls, source: dragSource) { Log.line("drag: no mouse event to start from") }
  }

  // MARK: Opening a conversation again

  /// The first way that works: the URL when an application handles it; the resume command in the
  /// default terminal when its directory is still there; the transcript in Finder when it is still there.
  private func reopen(url: URL?, run: (command: String, cwd: String)?, reveal: String?) {
    if let url, NSWorkspace.shared.urlForApplication(toOpen: url) != nil {
      Log.line("reopen: url \(url.absoluteString)")
      return opener.open(url: url)
    }
    var isDir: ObjCBool = false
    if let run, FileManager.default.fileExists(atPath: run.cwd, isDirectory: &isDir), isDir.boolValue {
      do {
        let file = try Self.commandFile(run)
        Log.line("reopen: run \(run.command) in \(run.cwd)")
        return opener.run(file)
      } catch {
        Log.line("reopen: no command file: \(error.localizedDescription)")
      }
    }
    if let reveal, FileManager.default.fileExists(atPath: reveal) {
      Log.line("reopen: reveal \(reveal)")
      return opener.reveal([URL(fileURLWithPath: reveal)])
    }
    Log.line("reopen: nothing to open")
  }

  /// A `.command` file that runs `command` in `cwd`, in the app's folder under the temporary
  /// directory; the ones written before are removed.
  private static func commandFile(_ run: (command: String, cwd: String)) throws -> URL {
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appendingPathComponent("dev.pneumabase.reopen", isDirectory: true)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    for old in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where old.pathExtension == "command" {
      try? fm.removeItem(at: old)
    }
    let file = dir.appendingPathComponent("resume-\(UUID().uuidString.prefix(8).lowercased()).command")
    let quoted = "'" + run.cwd.replacingOccurrences(of: "'", with: "'\\''") + "'"
    try "#!/bin/sh\ncd \(quoted) || exit 1\nexec \(run.command)\n".write(to: file, atomically: true, encoding: .utf8)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
    return file
  }
}

/// A menu entry's action.
@MainActor
final class MenuAction: NSObject {
  let run: @MainActor () -> Void
  init(_ run: @escaping @MainActor () -> Void) { self.run = run }
  @objc func perform(_ sender: Any?) { run() }
}

/// The source of a drag of files out of the window: Finder and other applications get a copy, and
/// the window does not take its own drag back as a drop.
@MainActor
final class FileDragSource: NSObject, NSDraggingSource {
  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    context == .outsideApplication ? .copy : []
  }
}
