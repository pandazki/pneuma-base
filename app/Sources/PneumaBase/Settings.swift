import AppKit
import ServiceManagement
import SwiftUI

/// This machine's settings, in the settings window (⌘,), and as rows of the configuration page in the
/// app. The two conveniences are off until the owner turns them on: `pneuma-base` on the PATH of the
/// owner's own terminal, and opening at login. 外观 and 直接放进来的文件算主人的 are here too, and in the menus.
@MainActor
final class MachineSettings: ObservableObject {
  let launcher: URL
  @Published var appearance: Appearance { didSet { if appearance != oldValue { onAppearance?(appearance) } } }
  @Published var ownerFiles: Bool { didSet { if ownerFiles != oldValue { onOwnerFiles?(ownerFiles) } } }
  /// The symbolic link to the launcher the app put in a folder on the owner's PATH, if it did.
  @Published private(set) var link: String?
  /// The folders on the owner's PATH that the owner can write, in PATH order; nil until looked up.
  @Published private(set) var folders: [String]?
  @Published var folder = ""
  /// The launcher's own folder is on the owner's PATH already: nothing to link.
  @Published private(set) var launcherOnPath = false
  @Published private(set) var pathNote: String?
  @Published private(set) var login = SMAppService.mainApp.status
  @Published private(set) var loginNote: String?
  var onAppearance: ((Appearance) -> Void)?
  var onOwnerFiles: ((Bool) -> Void)?
  var onLink: ((String?) -> Void)?

  init(launcher: URL, appearance: Appearance, ownerFiles: Bool, link: String?) {
    self.launcher = launcher
    self.appearance = appearance
    self.ownerFiles = ownerFiles
    self.link = link.flatMap { (try? FileManager.default.destinationOfSymbolicLink(atPath: $0)) == launcher.path ? $0 : nil }
  }

  /// Looks the owner's PATH up again: their login shell's, as their terminal has it.
  func refresh() {
    login = SMAppService.mainApp.status
    let launcherDir = launcher.deletingLastPathComponent().path
    Task {
      let path = await Self.ownersPath()
      launcherOnPath = path.contains(launcherDir)
      let found = path.filter { $0 != launcherDir && Self.writableFolder($0) }
      folders = found
      if !found.contains(folder) { folder = found.first ?? "" }
      Log.line("settings: PATH folders \(found)")
    }
  }

  // MARK: pneuma-base on PATH

  /// The line to add to the owner's shell profile when no folder on their PATH can be written.
  var profileLine: String { "export PATH=\"\(launcher.deletingLastPathComponent().path):$PATH\"" }

  var profileFile: String {
    switch (ProcessInfo.processInfo.environment["SHELL"].map { ($0 as NSString).lastPathComponent }) ?? "zsh" {
    case "bash": "~/.bash_profile"
    case "zsh": "~/.zshrc"
    default: "你的 shell 的配置文件"
    }
  }

  /// Puts a symbolic link named `pneuma-base` to the launcher in `dir`, unless something else has that name there.
  @discardableResult
  func link(in dir: String) -> Bool {
    let path = (dir as NSString).appendingPathComponent("pneuma-base")
    let fm = FileManager.default
    if let to = try? fm.destinationOfSymbolicLink(atPath: path) {
      guard to == launcher.path else { return refuse("\(path) 已经有一个指向别处的 pneuma-base，没有动它。") }
    } else if fm.fileExists(atPath: path) {
      return refuse("\(path) 已经有一个 pneuma-base，不是这里放的，没有动它。")
    } else {
      do { try fm.createSymbolicLink(atPath: path, withDestinationPath: launcher.path) } catch { return refuse("没能在 \(dir) 里放链接：\(error.localizedDescription)") }
    }
    link = path
    pathNote = nil
    onLink?(path)
    Log.line("settings: linked \(path)")
    return true
  }

  /// Takes the link out again, only if it still leads to the launcher.
  func unlink() {
    guard let path = link else { return }
    if (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) == launcher.path { try? FileManager.default.removeItem(atPath: path) }
    link = nil
    pathNote = nil
    onLink?(nil)
    Log.line("settings: unlinked \(path)")
  }

  private func refuse(_ note: String) -> Bool {
    pathNote = note
    Log.line("settings: \(note)")
    return false
  }

  // MARK: Open at login

  func setLogin(_ on: Bool) {
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      loginNote = nil
    } catch {
      loginNote = "系统没有答应：\(error.localizedDescription)"
    }
    login = SMAppService.mainApp.status
    if login == .requiresApproval { loginNote = "要在「系统设置 › 通用 › 登录项」里允许 Pneuma Base。" }
    Log.line("settings: login item \(login.rawValue)\(loginNote.map { " (\($0))" } ?? "")")
  }

  var loginWord: String {
    switch login {
    case .enabled: "开着"
    case .requiresApproval: "等你在系统设置里允许"
    default: "关着"
    }
  }

  // MARK: The owner's PATH

  /// The PATH the owner's terminal has: their login shell's, asked with a time limit; the app's own
  /// when the shell does not answer.
  nonisolated static func ownersPath() async -> [String] {
    await withCheckedContinuation { done in
      DispatchQueue.global().async {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: loginShell())
        p.arguments = ["-ilc", "printf '\\n%s' \"$PATH\""]
        p.standardInput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        let out = Pipe()
        p.standardOutput = out
        let fallback = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        guard (try? p.run()) != nil else { return done.resume(returning: fallback) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { if p.isRunning { p.terminate() } }
        let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        let last = text.split(separator: "\n").last.map(String.init) ?? ""
        let dirs = last.split(separator: ":").map(String.init)
        var seen = Set<String>()
        done.resume(returning: (p.terminationStatus == 0 && !dirs.isEmpty ? dirs : fallback).filter { seen.insert($0).inserted })
      }
    }
  }

  nonisolated private static func loginShell() -> String {
    if let shell = ProcessInfo.processInfo.environment["SHELL"], !shell.isEmpty { return shell }
    if let entry = getpwuid(getuid()), let shell = entry.pointee.pw_shell { return String(cString: shell) }
    return "/bin/zsh"
  }

  nonisolated private static func writableFolder(_ path: String) -> Bool {
    var isDir: ObjCBool = false
    return path.hasPrefix("/") && FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue && FileManager.default.isWritableFile(atPath: path)
  }

  /// The settings in words, for verify.sh.
  var text: String {
    [
      "外观：\(appearance.word)",
      "直接放进来的文件算主人的：\(ownerFiles ? "开着" : "关着")",
      "在终端里用 pneuma-base：\(link.map { "开着，\($0)" } ?? "关着")",
      "PATH 上能放的文件夹：\((folders ?? []).joined(separator: "、"))",
      "登录时打开：\(loginWord)",
      "本机的命令：\(launcher.path)",
    ].joined(separator: "\n") + "\n"
  }
}

private func tilde(_ path: String) -> String { (path as NSString).abbreviatingWithTildeInPath }

struct SettingsView: View {
  @ObservedObject var model: MachineSettings

  var body: some View {
    Form {
      Section {
        Picker("外观", selection: $model.appearance) {
          ForEach(Appearance.allCases, id: \.self) { Text($0.word).tag($0) }
        }
        .pickerStyle(.segmented)
      }
      Section {
        Toggle("直接放进来的文件算主人的", isOn: $model.ownerFiles)
        note("开着时，在访达里拷进库、或直接改了的文件，会记成你带进来的、你改的（看到的，不是谁说的）。")
      }
      Section {
        Toggle("在终端里用 pneuma-base", isOn: Binding(get: { model.link != nil }, set: { on in
          if on { model.link(in: model.folder) } else { model.unlink() }
        }))
        .disabled(model.link == nil && (model.folders ?? []).isEmpty)
        if let link = model.link {
          note("在 \(tilde(link)) 放了一个链接，指向本机的命令。关掉就拿走它。")
        } else if model.launcherOnPath {
          note("\(tilde(model.launcher.deletingLastPathComponent().path)) 已经在你的 PATH 上，终端里直接用 pneuma-base。")
        } else if let folders = model.folders, !folders.isEmpty {
          Picker("放进", selection: $model.folder) {
            ForEach(folders, id: \.self) { Text(tilde($0)).tag($0) }
          }
          note("在你选的文件夹里放一个叫 pneuma-base 的链接，指向本机的命令。这些是你 PATH 上你能写的文件夹。")
        } else if model.folders != nil {
          note("你的 PATH 上没有你能写的文件夹。要在终端里用，把这一行加进 \(model.profileFile)，再开一个终端：")
          HStack {
            Text(model.profileLine).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            Spacer()
            Button("拷贝") {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(model.profileLine, forType: .string)
            }
          }
        }
        if let problem = model.pathNote { note(problem).foregroundStyle(.red) }
      }
      Section {
        Toggle("登录时打开", isOn: Binding(get: { model.login == .enabled || model.login == .requiresApproval }, set: { model.setLogin($0) }))
        if let problem = model.loginNote { note(problem) }
      }
      Section {
        LabeledContent("本机的命令") { Text(tilde(model.launcher.path)).font(.system(.callout, design: .monospaced)).textSelection(.enabled) }
        note("接上的 agent 按这个路径运行 pneuma-base。应用每次启动时让它指向自己带的 Node 和命令行，所以挪动或更新应用之后再打开一次就好。")
      }
    }
    .formStyle(.grouped)
    .frame(width: 480)
    .fixedSize(horizontal: false, vertical: true)
  }

  private func note(_ text: String) -> Text {
    Text(text).font(.callout).foregroundStyle(.secondary)
  }
}

/// The settings window: one, made on first use, kept.
@MainActor
final class SettingsWindow: NSObject, NSWindowDelegate {
  private var window: NSWindow?
  let model: MachineSettings
  var onClose: (() -> Void)?

  init(model: MachineSettings) {
    self.model = model
  }

  var isOpen: Bool { window?.isVisible ?? false }

  func show() {
    model.refresh()
    let window = self.window ?? make()
    NSApp.setActivationPolicy(.regular)
    if !window.isVisible { window.center() }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
    Log.line("settings: shown")
  }

  func windowWillClose(_ notification: Notification) { onClose?() }

  private func make() -> NSWindow {
    let window = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(model: model)))
    window.styleMask = [.titled, .closable]
    window.title = "设置"
    window.isReleasedWhenClosed = false
    window.delegate = self
    self.window = window
    return window
  }

  /// A picture of the window with its title bar, for the screenshots verify.sh takes.
  func snapshotForTest(to url: URL) {
    guard let frame = window?.contentView?.superview, let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return Log.line("snap: no settings window") }
    frame.cacheDisplay(in: frame.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
    Log.line("snap: wrote \(url.lastPathComponent)")
  }
}
