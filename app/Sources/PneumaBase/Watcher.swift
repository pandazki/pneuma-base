import CoreServices
import Foundation

/// Watches the current library with FSEvents and records, through the command line, what the owner
/// did to it outside the command line: a file that appeared is registered as brought by the owner,
/// a file changed directly is claimed as the owner's change.
///
/// An agent's put moves its file into place before the ledger records it, so for a moment the file
/// is in the library and nobody registered it. The rule that keeps such a file from being taken for
/// the owner's: only paths that had an event while watching count; a check runs only after the whole
/// library, `.pneuma-base/` included, has been quiet for `quiet` seconds and no put of the app's own
/// is in flight; and a path is acted on only when two such checks, at least `quiet` seconds apart,
/// both list it, with the same size and modification time. Its weakness: it goes by time. An agent
/// that writes into the library with its own tools and registers more than that later has its file
/// taken for the owner's.
@MainActor
final class Watcher {
  static let quiet: TimeInterval = 3

  let library: URL
  private let root: String
  private let config: Config
  private var stream: FSEventStreamRef?
  private var lastEvent = Date.distantPast
  /// Library paths that had an event since watching began and are not settled yet.
  private var touched: Set<String> = []
  private var sightings: [String: Sighting] = [:]
  private var timer: Timer?
  private var passing = false
  private var holds = 0
  var onRecorded: ((_ registered: [String], _ claimed: [String]) -> Void)?

  private struct Sighting {
    let size: Int
    let modified: Date
    let at: Date
    func same(as other: Sighting) -> Bool { size == other.size && modified == other.modified }
  }

  init(library: URL, config: Config) {
    self.library = library
    // FSEvents reports real paths; `resolvingSymlinksInPath` would turn /private/tmp into /tmp.
    self.root = realpath(library.path, nil).map { p in defer { free(p) }; return String(cString: p) } ?? library.path
    self.config = config
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
    Log.line("watcher: watching \(library.lastPathComponent)")
  }

  func stop() {
    timer?.invalidate()
    guard let stream else { return }
    FSEventStreamStop(stream)
    FSEventStreamInvalidate(stream)
    FSEventStreamRelease(stream)
    self.stream = nil
  }

  /// Around a put of the app's own: no check runs while one is in flight.
  func hold() { holds += 1 }
  func release() {
    holds -= 1
    lastEvent = Date()
    schedule(after: Self.quiet)
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
    if !touched.isEmpty || !sightings.isEmpty { schedule(after: Self.quiet) }
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
  private func eligible(_ path: String) -> Bool {
    var p = path
    while !p.isEmpty {
      if touched.contains(p) { return true }
      p = (p as NSString).deletingLastPathComponent
    }
    return false
  }

  private func sighting(_ path: String) -> Sighting? {
    guard let a = try? FileManager.default.attributesOfItem(atPath: root + "/" + path) else { return nil }
    return Sighting(size: (a[.size] as? NSNumber)?.intValue ?? 0, modified: a[.modificationDate] as? Date ?? .distantPast, at: Date())
  }

  private func pass() async {
    guard !passing, !touched.isEmpty || !sightings.isEmpty else { return }
    let sinceEvent = Date().timeIntervalSince(lastEvent)
    if holds > 0 || sinceEvent < Self.quiet { return schedule(after: max(0.2, Self.quiet - sinceEvent)) }
    passing = true
    defer { passing = false }
    let checkedAt = Date()
    let result = await runCli(["--library", library.path, "check", "--json"], in: library, config: config)
    guard let sections = result.json?["sections"] as? [[String: Any]] else {
      Log.line("watcher: check failed: \(result.err.prefix(200))")
      return schedule(after: Self.quiet)
    }
    // Something moved while the check ran: its answer may already be stale.
    if lastEvent > checkedAt || holds > 0 { return schedule(after: Self.quiet) }
    let unowned = Self.paths(sections, titled: "没人登记过的").filter(eligible)
    let changed = Self.paths(sections, titled: "被直接改过的").filter(eligible)
    let listed = Set(unowned + changed)

    var register: [String] = [], claim: [String] = []
    for path in listed {
      guard let now = sighting(path) else { continue }
      if let first = sightings[path], first.same(as: now), now.at.timeIntervalSince(first.at) >= Self.quiet {
        if unowned.contains(path) { register.append(path) } else { claim.append(path) }
        sightings[path] = nil
      } else if sightings[path].map({ !$0.same(as: now) }) ?? true {
        sightings[path] = now
      }
    }
    sightings = sightings.filter { listed.contains($0.key) }
    touched = touched.filter { t in sightings.keys.contains { $0 == t || $0.hasPrefix(t + "/") } }
    if !sightings.isEmpty { schedule(after: Self.quiet) }
    guard !register.isEmpty || !claim.isEmpty else { return }

    var registered: [String] = [], claimed: [String] = []
    for path in register.sorted() {
      var args = ["--library", library.path, "--session", config.session, "put", path, "--brought", "--by", "owner", "--note", "自动登记", "--json"]
      if let from = downloadAddress(of: URL(fileURLWithPath: root + "/" + path)) { args += ["--source", from] }
      let r = await runCli(args, in: library, config: config)
      // Someone registered it between the check and this put: the ledger keeps their record and only notes ours.
      let notes = (r.json?["notes"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
      if r.json?["outcome"] as? String != "accepted" { Log.line("watcher: could not register \(path): \(r.err.prefix(200))") }
      else if notes.contains(where: { $0.hasPrefix("已在册") }) { Log.line("watcher: \(path) was registered meanwhile; only noted") }
      else { registered.append(path) }
    }
    for path in claim.sorted() {
      let r = await runCli(["--library", library.path, "--session", config.session, "say", "revised", path, "--json"], in: library, config: config)
      if r.json?["outcome"] as? String == "heard" { claimed.append(path) } else { Log.line("watcher: could not claim \(path): \(r.err.prefix(200))") }
    }
    Log.line("watcher: registered \(registered) claimed \(claimed)")
    onRecorded?(registered, claimed)
  }

  private static func paths(_ sections: [[String: Any]], titled title: String) -> [String] {
    sections.filter { $0["title"] as? String == title && $0["plugin"] as? String == "ledger" }
      .flatMap { ($0["data"] as? [[String: Any]]) ?? [] }
      .compactMap { $0["path"] as? String }
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
