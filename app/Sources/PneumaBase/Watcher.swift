import Foundation

/// Watches the current library through storage's own subscription: it starts the library's provider
/// in its long-lived mode (`serve --root <library>`), subscribes from the cursor it last kept, and acts
/// on the places it hears of. It has no event stream of its own. With 直接放进来的文件算主人的 on, it
/// records, through the command line, what the owner did to the library outside the tools: a file
/// that appeared is registered as brought by the owner and seen (`put --imported --by owner --observed`),
/// a file changed directly is recorded as a change seen (`say revised --observed`), and a new directory
/// is registered as one thing only when a probe within its budget finds it small and plain (no project
/// marker at its top); any other directory stays the ledger's question.
///
/// Whether a file is anybody's is the ledger's to say, and it says so with a put in progress taken
/// into account (a put holds its places in storage until its records are written). So the watcher
/// only waits for the library to be quiet, so a copy still being written is not taken half-way, reads
/// the ledger's standing page once, and acts on the paths it lists that it heard of since it last
/// looked. A put that lands between the look and the watcher's own put makes that put only a note
/// (已在册).
@MainActor
final class Watcher {
  static let quiet: TimeInterval = 3
  /// A probe of a new directory counts at most this many entries.
  static let probeBudget = 500
  static let subscription = "subscribe"

  let library: URL
  private let root: String
  private let config: Config
  /// The program of the provider the library uses, as `storage list` names it.
  private let provider: String
  private var process: Process?
  private var input: FileHandle?
  private var unread = Data()
  private var nextId = 1
  private var waiting: [Int: CheckedContinuation<Answer?, Never>] = [:]
  private var wanted = false
  private var failures = 0
  private var launchedAt = Date()
  /// The cursor of the last answer heard: the next subscription starts there, so what changed while nobody listened is heard too.
  private(set) var cursor: String?
  private var lastEvent = Date.distantPast
  /// Library places heard of since the watcher last looked.
  private var touched: Set<String> = []
  private var timer: Timer?
  private var passing = false
  /// 直接放进来的文件算主人的.
  var recordsOwnerFiles: Bool
  var onRecorded: ((_ registered: [String], _ seen: [String]) -> Void)?
  var onCursor: ((String) -> Void)?

  init(library: URL, config: Config, provider: String, cursor: String?, recordsOwnerFiles: Bool) {
    self.library = library
    self.root = realPath(library)
    self.config = config
    self.provider = provider
    self.cursor = cursor
    self.recordsOwnerFiles = recordsOwnerFiles
  }

  var pid: Int32? { process?.processIdentifier }

  func start() {
    wanted = true
    if process == nil { launch() }
  }

  private func launch() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: provider)
    p.arguments = ["serve", "--root", root]
    p.environment = config.childEnvironment
    let stdin = Pipe(), stdout = Pipe()
    p.standardInput = stdin
    p.standardOutput = stdout
    p.standardError = FileHandle.nullDevice
    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      if chunk.isEmpty { handle.readabilityHandler = nil; return }
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.read(chunk, from: p) } }
    }
    p.terminationHandler = { [weak self] ended in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.exited(ended) } }
    }
    do {
      try p.run()
    } catch {
      Log.line("watcher: could not start \(provider): \(error)")
      return
    }
    process = p
    input = stdin.fileHandleForWriting
    unread = Data()
    launchedAt = Date()
    var subscribe: [String: Any] = ["id": Self.subscription, "op": "subscribe"]
    if let cursor { subscribe["cursor"] = cursor }
    send(subscribe)
    Log.line("watcher: subscribed to \(library.lastPathComponent) through pid \(p.processIdentifier), owner files \(recordsOwnerFiles ? "on" : "off")")
  }

  /// Ends the subscription: the provider cancels it when its input closes, and exits. Waits up to two seconds before it is stopped.
  func stop() {
    wanted = false
    timer?.invalidate()
    guard let p = process else { return }
    process = nil
    try? input?.close()
    input = nil
    let deadline = Date().addingTimeInterval(2)
    while p.isRunning && Date() < deadline { usleep(10_000) }
    if p.isRunning { p.terminate() }
    for (_, waiter) in waiting { waiter.resume(returning: nil) }
    waiting = [:]
    Log.line("watcher: stopped")
  }

  private func exited(_ p: Process) {
    guard p === process else { return }
    process = nil
    input = nil
    for (_, waiter) in waiting { waiter.resume(returning: nil) }
    waiting = [:]
    Log.line("watcher: provider exited with \(p.terminationStatus)")
    guard wanted else { return }
    failures = Date().timeIntervalSince(launchedAt) > 10 ? 1 : failures + 1
    let delay = min(0.25 * pow(2, Double(failures)), 10)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.wanted, self.process == nil else { return }
        self.launch()
      }
    }
  }

  private func send(_ request: [String: Any]) {
    guard let input, let data = try? JSONSerialization.data(withJSONObject: request) else { return }
    try? input.write(contentsOf: data + Data("\n".utf8))
  }

  /// One answer line, handed from the reader to whoever asked on the main actor.
  struct Answer: @unchecked Sendable { let json: [String: Any] }

  /// One of storage's read-only operations on the same process, answered by id.
  func ask(_ op: String, _ body: [String: Any]) async -> [String: Any]? {
    guard process != nil else { return nil }
    let id = nextId
    nextId += 1
    let answer = await withCheckedContinuation { waiter in
      waiting[id] = waiter
      send(body.merging(["id": id, "op": op]) { a, _ in a })
    }
    return answer?.json
  }

  /// An answer line may come in many chunks, and one chunk may hold many lines.
  private func read(_ chunk: Data, from p: Process) {
    guard p === process else { return }
    unread.append(chunk)
    while let nl = unread.firstIndex(of: 0x0A) {
      let line = unread[unread.startIndex..<nl]
      unread.removeSubrange(unread.startIndex...nl)
      if let answer = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { heard(answer) }
    }
  }

  private func heard(_ answer: [String: Any]) {
    if let id = answer["id"] as? Int, let waiter = waiting.removeValue(forKey: id) { return waiter.resume(returning: Answer(json: answer)) }
    guard answer["id"] as? String == Self.subscription else { return }
    guard let progress = answer["progress"] as? [String: Any] else {
      // The subscription itself ended: this volume keeps no history to listen to, or it was cancelled.
      return Log.line("watcher: subscription ended: \(answer["reason"] as? String ?? answer["outcome"] as? String ?? "?")")
    }
    if let next = progress["cursor"] as? String, next != cursor {
      cursor = next
      onCursor?(next)
    }
    guard progress["outcome"] as? String == "done" else {
      return Log.line("watcher: storage cannot say what changed before \(cursor ?? "now"); listening on")
    }
    let places = (progress["places"] as? [String] ?? []).filter { place in
      !(place.isEmpty || place == "PNEUMA-BASE.md" || place == "_archive" || place.hasPrefix("_archive/"))
    }
    guard !places.isEmpty else { return }
    lastEvent = Date()
    touched.formUnion(places)
    Log.line("watcher: heard \(places.count) place(s): \(places.prefix(3).joined(separator: ", "))\(places.count > 3 ? ", …" : "")")
    if recordsOwnerFiles { schedule(after: Self.quiet) }
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

  /// A path counts when it, or a folder it is in, was heard of.
  private static func covered(_ path: String, by touched: Set<String>) -> Bool {
    var p = path
    while !p.isEmpty {
      if touched.contains(p) { return true }
      p = (p as NSString).deletingLastPathComponent
    }
    return false
  }

  /// A directory counts when it, or anything in it, was heard of.
  private static func heardIn(_ dir: String, _ touched: Set<String>) -> Bool {
    touched.contains(dir) || touched.contains { $0.hasPrefix(dir + "/") }
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
    let result = await runCli(["--library", library.path, "show", "ledger.status", "--json"], in: library, config: config)
    guard result.json?["outcome"] as? String == "shown", let blocks = result.json?["blocks"] as? [[String: Any]] else {
      Log.line("watcher: no standing page: \(result.err.prefix(200)) \(String(decoding: result.out.prefix(200), as: UTF8.self))")
      touched.formUnion(looking)
      return
    }
    let unowned = Self.paths(blocks, titled: "没人登记过的").filter { Self.covered($0, by: looking) }
    let dirs = Self.paths(blocks, titled: "没登记的目录").filter { Self.heardIn($0, looking) }
    let changed = Self.paths(blocks, titled: "被直接改过的").filter { Self.covered($0, by: looking) }
    Log.line("watcher: looked, \(unowned.count) nobody's, \(dirs.count) new folder(s), \(changed.count) changed directly")

    var small: [String] = []
    for dir in dirs.sorted() {
      let probe = await ask("probe", ["place": dir, "budget": Self.probeBudget])
      let markers = probe?["markers"] as? [String] ?? []
      if probe?["outcome"] as? String == "done", probe?["exceeded"] as? Bool == false, markers.isEmpty {
        small.append(dir)
      } else {
        let files = probe?["files"] as? Int ?? 0
        Log.line("watcher: \(dir)/ is a question: \(probe?["exceeded"] as? Bool == true ? "at least " : "")\(files) files, markers \(markers)")
      }
    }

    var registered: [String] = [], seen: [String] = []
    for path in unowned.sorted() + small {
      var args = ["--library", library.path, "--session", config.session, "put", path, "--imported", "--by", "owner", "--observed", "--note", "自动登记", "--json"]
      if let from = await whereFrom(path) { args += ["--source", from] }
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

  /// The address macOS recorded when a file in the library was downloaded, as storage's `macos` facet gives it.
  private func whereFrom(_ place: String) async -> String? {
    let entries = await ask("glance", ["places": [place], "facets": ["macos"]])?["entries"] as? [[String: Any]]
    let macos = (entries?.first?["facets"] as? [String: Any])?["macos"] as? [String: Any]
    return (macos?["where_from"] as? [String])?.first { !$0.isEmpty }
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
