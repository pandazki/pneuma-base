import Foundation

/// `pneuma-base view <library> --no-open` as a child: started once, restarted when it dies, stopped
/// when the app quits. A preload makes the child exit when its standard input closes, which happens
/// however the app ends, so a killed app leaves no server behind.
@MainActor
final class Server {
  let library: URL
  private let config: Config
  private var process: Process?
  private var wanted = false
  private var failures = 0
  private var launchedAt = Date()
  /// The page's address, token included; nil while the child starts.
  private(set) var address: URL?
  /// Called with each new address: a restarted child has a new port and token.
  var onAddress: ((URL) -> Void)?

  init(library: URL, config: Config) {
    self.library = library
    self.config = config
  }

  var pid: Int32? { process?.processIdentifier }

  func start() {
    wanted = true
    if process == nil { launch() }
  }

  private func launch() {
    guard let preload = Bundle.main.url(forResource: "parent-watch", withExtension: "mjs") else {
      Log.line("server: parent-watch.mjs missing from the bundle")
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: config.node)
    p.arguments = ["--import", preload.absoluteString, config.cli, "view", library.path, "--no-open"]
    p.environment = config.childEnvironment
    p.currentDirectoryURL = library
    p.standardInput = Pipe()
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    output = ""
    out.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = String(decoding: handle.availableData, as: UTF8.self)
      if chunk.isEmpty { handle.readabilityHandler = nil; return }
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.printed(chunk, by: p) } }
    }
    p.terminationHandler = { [weak self] ended in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.exited(ended) } }
    }
    do {
      try p.run()
    } catch {
      Log.line("server: could not start: \(error)")
      return
    }
    process = p
    launchedAt = Date()
    Log.line("server: started pid \(p.processIdentifier) for \(library.lastPathComponent)")
  }

  /// What the child printed and no line was made of yet.
  private var output = ""

  private func printed(_ chunk: String, by p: Process) {
    guard p === process else { return }
    output += chunk
    while let nl = output.firstIndex(of: "\n") {
      heard(String(output[..<nl]))
      output.removeSubrange(...nl)
    }
  }

  private func heard(_ line: String) {
    guard let range = line.range(of: #"http://127\.0\.0\.1:\d+/\?token=[0-9a-f]+"#, options: .regularExpression),
      let url = URL(string: String(line[range]))
    else { return }
    address = url
    Log.line("server: ready")
    onAddress?(url)
  }

  private func exited(_ p: Process) {
    guard p === process else { return }
    process = nil
    address = nil
    Log.line("server: exited with \(p.terminationStatus)")
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

  /// Stops the child and waits for it, up to two seconds before it is killed.
  func stop() {
    wanted = false
    guard let p = process else { return }
    process = nil
    address = nil
    p.terminate()
    let deadline = Date().addingTimeInterval(2)
    while p.isRunning && Date() < deadline { usleep(10_000) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    Log.line("server: stopped")
  }
}
