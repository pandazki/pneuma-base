import Foundation

/// What the app needs to run the command line, fixed at launch.
struct Config: Sendable {
  /// The Node program inside the bundle, next to the app's own executable.
  let node: String
  /// The command line's entry inside the bundle: `Resources/cli/dist/bin.js`.
  let cli: String
  /// `$PNEUMA_BASE_HOME` for every child: `--home`, else the environment's, else `~/.pneuma-base`.
  let home: URL
  /// One scene per run of the app, so what it registers and brings in is grouped in the ledger.
  let session: String
  let started = Date()

  static func load() -> Config {
    let env = ProcessInfo.processInfo.environment
    let home = argument("--home") ?? env["PNEUMA_BASE_HOME"] ?? (env["HOME"] ?? NSHomeDirectory()) + "/.pneuma-base"
    return Config(
      node: Bundle.main.url(forAuxiliaryExecutable: "node")?.path ?? "",
      cli: Bundle.main.resourceURL?.appendingPathComponent("cli/dist/bin.js").path ?? "",
      home: URL(fileURLWithPath: (home as NSString).expandingTildeInPath, isDirectory: true),
      session: UUID().uuidString.lowercased())
  }

  /// Whether the bundle holds what the app runs; a copy built without them cannot do anything.
  var complete: Bool { FileManager.default.isExecutableFile(atPath: node) && FileManager.default.fileExists(atPath: cli) }

  /// The command on this machine that what agent connect writes names: the app points it at its own
  /// Node and command line at each launch.
  var launcher: URL { home.appendingPathComponent("bin/pneuma-base") }

  /// The name of the distributed notification the test hooks listen on, only when the app was started
  /// with `--hooks <name>`; each run gets its own, so a check never drives another copy of the app.
  static var hooksName: String? { argument("--hooks").map { "dev.pneumabase.hooks.\($0)" } }

  /// macOS runs a downloaded app that was opened where it was unpacked from a temporary, read-only
  /// place (App Translocation), which goes away; a launcher pointing there would break.
  static var translocated: Bool { Bundle.main.bundlePath.contains("/AppTranslocation/") }

  static func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
  }

  /// The app is the owner's surface: children get a fixed environment, never the agent-session
  /// variables of whoever launched it, which would make the command line treat them as an agent.
  var childEnvironment: [String: String] {
    let env = ProcessInfo.processInfo.environment
    var out = ["PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "PNEUMA_BASE_HOME": home.path]
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] { out[key] = env[key] }
    return out
  }

  var appDir: URL { home.appendingPathComponent("app", isDirectory: true) }
}

struct CliResult: Sendable {
  let status: Int32
  let out: Data
  let err: String

  var json: [String: Any]? { (try? JSONSerialization.jsonObject(with: out)) as? [String: Any] }
}

/// Runs `pneuma-base <args>` to the end and collects what it printed.
func runCli(_ args: [String], in dir: URL, config: Config) async -> CliResult {
  await withCheckedContinuation { done in
    DispatchQueue.global(qos: .userInitiated).async {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: config.node)
      p.arguments = [config.cli] + args
      p.environment = config.childEnvironment
      p.currentDirectoryURL = dir
      let out = Pipe(), err = Pipe()
      p.standardOutput = out
      p.standardError = err
      p.standardInput = FileHandle.nullDevice
      do { try p.run() } catch {
        done.resume(returning: CliResult(status: -1, out: Data(), err: "\(error)"))
        return
      }
      // Both pipes are drained at once, so a full stderr cannot block the child.
      let errText = Drained()
      let group = DispatchGroup()
      group.enter()
      DispatchQueue.global().async {
        errText.data = err.fileHandleForReading.readDataToEndOfFile()
        group.leave()
      }
      let outData = out.fileHandleForReading.readDataToEndOfFile()
      group.wait()
      p.waitUntilExit()
      done.resume(returning: CliResult(status: p.terminationStatus, out: outData, err: String(decoding: errText.data, as: UTF8.self)))
    }
  }
}

private final class Drained: @unchecked Sendable {
  var data = Data()
}

/// The app's own small preferences file: the libraries it knows, the current one, and this machine's
/// settings. Not in any library.
struct Prefs: Codable {
  var libraries: [String] = []
  var current: String?
  /// 直接放进来的文件算主人的: the watcher registers a file that appeared outside the tools as the
  /// owner's, seen rather than said, and records a direct change as seen. Unset means on.
  var ownerFiles: Bool?
  /// The symbolic link to the launcher that 在终端里用 pneuma-base put on the owner's PATH; unset means off.
  var pathLink: String?

  var watchesOwnerFiles: Bool { ownerFiles ?? true }

  static func url(_ config: Config) -> URL { config.appDir.appendingPathComponent("libraries.json") }

  static func load(_ config: Config) -> Prefs {
    guard let data = try? Data(contentsOf: url(config)) else { return Prefs() }
    return (try? JSONDecoder().decode(Prefs.self, from: data)) ?? Prefs()
  }

  func save(_ config: Config) {
    try? FileManager.default.createDirectory(at: config.appDir, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
    try? encoder.encode(self).write(to: Prefs.url(config), options: .atomic)
  }
}

/// One line per event in `<home>/app/app.log`, with the seconds since launch: the measurements read it.
@MainActor
enum Log {
  static var config: Config?

  static func line(_ text: String) {
    guard let config else { return }
    let since = String(format: "%.3f", Date().timeIntervalSince(config.started))
    let wall = String(format: "%.3f", Date().timeIntervalSince1970)
    let entry = "\(wall) +\(since)s \(text)\n"
    let url = config.appDir.appendingPathComponent("app.log")
    try? FileManager.default.createDirectory(at: config.appDir, withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: url) {
      handle.seekToEndOfFile()
      handle.write(Data(entry.utf8))
      try? handle.close()
    } else {
      try? Data(entry.utf8).write(to: url)
    }
  }
}

func isLibrary(_ dir: URL) -> Bool {
  FileManager.default.fileExists(atPath: dir.appendingPathComponent(".pneuma-base/config.json").path)
}
