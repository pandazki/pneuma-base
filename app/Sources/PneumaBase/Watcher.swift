import CoreServices
import Foundation

/// Watches the current library with FSEvents. Any change at all is told to `onActivity`, so the app
/// can count again what waits for the owner. With 直接放进来的文件算主人的 on, it also records,
/// through the command line, what the owner did to the library outside the tools: a file that
/// appeared is registered as brought by the owner and seen (`put --brought --by owner --observed`), a
/// file changed directly is recorded as a change seen (`say revised --observed`).
///
/// Whether a file is anybody's is the ledger's to say, and it says so with a put in progress taken
/// into account: a put marks its paths before it places anything, and the ledger's standing page
/// leaves a marked path out, and any path a record arrived for while it looked. So the watcher only
/// waits for the library to be quiet, so a copy still being written is not taken half-way, reads the
/// standing page once, and acts on the paths it lists that had an event since it last looked. A
/// put that starts after the look and lands first makes the watcher's own put only a note (已在册).
/// A file an agent wrote in place against its instructions and registers later is taken for the
/// owner's first; the agent's own put then corrects the origin, as an origin seen gives way to one said.
@MainActor
final class Watcher {
  static let quiet: TimeInterval = 3

  let library: URL
  private let root: String
  private let config: Config
  private var stream: FSEventStreamRef?
  private var lastEvent = Date.distantPast
  /// Library paths that had an event since the watcher last looked.
  private var touched: Set<String> = []
  private var timer: Timer?
  private var activityTimer: Timer?
  private var passing = false
  /// 直接放进来的文件算主人的.
  var recordsOwnerFiles: Bool
  var onRecorded: ((_ registered: [String], _ seen: [String]) -> Void)?
  var onActivity: (() -> Void)?

  init(library: URL, config: Config, recordsOwnerFiles: Bool) {
    self.library = library
    // FSEvents reports real paths; `resolvingSymlinksInPath` would turn /private/tmp into /tmp.
    self.root = realpath(library.path, nil).map { p in defer { free(p) }; return String(cString: p) } ?? library.path
    self.config = config
    self.recordsOwnerFiles = recordsOwnerFiles
  }

  func start() {
    var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
    let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
      guard let info else { return }
      let watcher = Unmanaged<Watcher>.fromOpaque(info).takeUnretainedValue()
      let list = Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue() as? [String] ?? []
      MainActor.assumeIsolated { watcher.heard(list.prefix(count)) }
    }
    let flags = UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer)
    guard let stream = FSEventStreamCreate(nil, callback, &context, [root] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.2, flags) else { return }
    FSEventStreamSetDispatchQueue(stream, .main)
    FSEventStreamStart(stream)
    self.stream = stream
    Log.line("watcher: watching \(library.lastPathComponent), owner files \(recordsOwnerFiles ? "on" : "off")")
  }

  func stop() {
    timer?.invalidate()
    activityTimer?.invalidate()
    guard let stream else { return }
    FSEventStreamStop(stream)
    FSEventStreamInvalidate(stream)
    FSEventStreamRelease(stream)
    self.stream = nil
  }

  private func heard(_ paths: ArraySlice<String>) {
    for path in paths {
      guard path == root || path.hasPrefix(root + "/") else { continue }
      let rel = String(path.dropFirst(root.count + 1))
      lastEvent = Date()
      if rel.isEmpty || rel == ".pneuma-base" || rel.hasPrefix(".pneuma-base/") || rel == "PNEUMA-BASE.md" || rel.hasPrefix("_archive/") { continue }
      if (rel as NSString).lastPathComponent == ".DS_Store" { continue }
      touched.insert(rel)
    }
    activityTimer?.invalidate()
    activityTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.onActivity?() }
    }
    if recordsOwnerFiles && !touched.isEmpty { schedule(after: Self.quiet) }
  }

  private func schedule(after seconds: TimeInterval) {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        Task { await self.pass() }
      }
    }
  }

  /// A path counts when it, or a folder it is in, had an event.
  private static func covered(_ path: String, by touched: Set<String>) -> Bool {
    var p = path
    while !p.isEmpty {
      if touched.contains(p) { return true }
      p = (p as NSString).deletingLastPathComponent
    }
    return false
  }

  private func pass() async {
    guard recordsOwnerFiles, !passing, !touched.isEmpty else { return }
    let sinceEvent = Date().timeIntervalSince(lastEvent)
    if sinceEvent < Self.quiet { return schedule(after: max(0.2, Self.quiet - sinceEvent)) }
    passing = true
    defer { passing = false }
    let looking = touched
    touched = []
    Log.line("watcher: looking")
    let result = await runCli(["--library", library.path, "show", "ledger.standing", "--json"], in: library, config: config)
    guard result.json?["outcome"] as? String == "shown", let blocks = result.json?["blocks"] as? [[String: Any]] else {
      Log.line("watcher: no standing page: \(result.err.prefix(200)) \(String(decoding: result.out.prefix(200), as: UTF8.self))")
      touched.formUnion(looking)
      return
    }
    let eligible = { (path: String) in Self.covered(path, by: looking) }
    let unowned = Self.paths(blocks, titled: "没人登记过的").filter(eligible)
    let changed = Self.paths(blocks, titled: "被直接改过的").filter(eligible)
    Log.line("watcher: looked, \(unowned.count) nobody's, \(changed.count) changed directly")

    var registered: [String] = [], seen: [String] = []
    for path in unowned.sorted() {
      var args = ["--library", library.path, "--session", config.session, "put", path, "--brought", "--by", "owner", "--observed", "--note", "自动登记", "--json"]
      if let from = downloadAddress(of: URL(fileURLWithPath: root + "/" + path)) { args += ["--source", from] }
      let r = await runCli(args, in: library, config: config)
      // Someone registered it between the look and this put: the ledger keeps their record and only notes ours.
      let notes = (r.json?["notes"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
      if r.json?["outcome"] as? String != "accepted" { Log.line("watcher: could not register \(path): \(r.err.prefix(200)) \(String(decoding: r.out.prefix(200), as: UTF8.self))") }
      else if notes.contains(where: { $0.hasPrefix("已在册") }) { Log.line("watcher: \(path) was registered meanwhile; only noted") }
      else { registered.append(path) }
    }
    for path in changed.sorted() {
      let r = await runCli(["--library", library.path, "--session", config.session, "say", "revised", path, "--observed", "--json"], in: library, config: config)
      if r.json?["outcome"] as? String == "heard" { seen.append(path) } else { Log.line("watcher: could not record the change to \(path): \(r.err.prefix(200))") }
    }
    Log.line("watcher: registered \(registered) seen \(seen)")
    if !registered.isEmpty || !seen.isEmpty { onRecorded?(registered, seen) }
    if !touched.isEmpty { schedule(after: Self.quiet) }
  }

  /// The paths a section of the ledger's standing page lists: each entry opens the thing's panel.
  private static func paths(_ blocks: [[String: Any]], titled title: String) -> [String] {
    blocks.filter { $0["kind"] as? String == "section" && $0["title"] as? String == title }
      .flatMap { ($0["blocks"] as? [[String: Any]]) ?? [] }
      .flatMap { ($0["items"] as? [[String: Any]]) ?? [] }
      .compactMap { item in
        let cell = item["cell"] as? [String: Any]
        return ((cell?["link"] as? [String: Any])?["params"] as? [String: Any])?["path"] as? String ?? cell?["text"] as? String
      }
  }
}

/// The address macOS recorded when the file was downloaded: the first entry of
/// `com.apple.metadata:kMDItemWhereFroms`, a property list of strings, or plain text if written as such.
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
