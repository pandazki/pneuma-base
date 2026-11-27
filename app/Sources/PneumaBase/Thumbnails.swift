import AppKit
import CryptoKit
import QuickLookThumbnailing
import UniformTypeIdentifiers

/// Thumbnails for the page's icon view, made by the system: a directory gets the folder icon; a
/// placeholder the icon of its type from its name, its content never touched; any other file the
/// system's thumbnail, or the icon of its type when the system makes none. Kept in
/// `$PNEUMA_BASE_HOME/app/cache/thumbnails/<library>/<place, token, px>.png`; a hit touches the file,
/// and entries not touched for 30 days are removed at launch.
@MainActor
final class Thumbnails {
  /// The most places one request is answered for.
  static let most = 50
  /// How many are made at once.
  static let together = 4
  nonisolated static let kept: TimeInterval = 30 * 24 * 3600

  struct Job: Sendable {
    /// As the page named it and its token, echoed in the answer.
    let path: String
    let token: String?
    let file: LocalFile
  }

  struct Counts {
    var cached = 0, made = 0, icons = 0
    var placeholders: [String] = []
  }

  private enum Source: Sendable { case cache, made, icon, placeholder }
  private struct Made: Sendable { let png: Data?; let source: Source }

  private let root: URL

  init(config: Config) {
    root = config.appDir.appendingPathComponent("cache/thumbnails", isDirectory: true)
  }

  /// Removes, in the background, the entries not touched for 30 days.
  func prune() {
    let root = root
    Task.detached(priority: .background) {
      let fm = FileManager.default
      let before = Date().addingTimeInterval(-Self.kept)
      var removed = 0
      for library in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
        for entry in (try? fm.contentsOfDirectory(at: library, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
          let touched = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
          if touched < before, (try? fm.removeItem(at: entry)) != nil { removed += 1 }
        }
      }
      if removed > 0 { await MainActor.run { Log.line("thumbnails: removed \(removed) not used for 30 days") } }
    }
  }

  /// Makes the thumbnails off the main thread, a few at a time, and answers each as it comes.
  func make(_ jobs: [Job], library: String, px: Int, answer: @escaping @MainActor (Job, String) -> Void) async -> Counts {
    let px = min(max(px, 16), 1024)
    let dir = root.appendingPathComponent(Self.hash(library), isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var counts = Counts()
    await withTaskGroup(of: (Int, Made).self) { group in
      var next = 0
      func start() {
        guard next < jobs.count else { return }
        let i = next, file = jobs[i].file
        next += 1
        group.addTask { (i, await Self.render(file, px: px, in: dir)) }
      }
      for _ in 0..<Self.together { start() }
      for await (i, made) in group {
        switch made.source {
        case .cache: counts.cached += 1
        case .made: counts.made += 1
        case .icon: counts.icons += 1
        case .placeholder:
          counts.icons += 1
          counts.placeholders.append(jobs[i].path)
        }
        if let png = made.png { answer(jobs[i], "data:image/png;base64," + png.base64EncodedString()) }
        start()
      }
    }
    return counts
  }

  private nonisolated static func render(_ file: LocalFile, px: Int, in dir: URL) async -> Made {
    if file.isDirectory { return Made(png: png(NSWorkspace.shared.icon(for: .folder), px: px), source: .icon) }
    let type = UTType(filenameExtension: file.url.pathExtension) ?? .data
    if file.placeholder { return Made(png: png(NSWorkspace.shared.icon(for: type), px: px), source: .placeholder) }
    let cached = file.token.map { dir.appendingPathComponent(hash("\(file.place)\u{0}\($0)\u{0}\(px)") + ".png") }
    if let cached, let data = try? Data(contentsOf: cached) {
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: cached.path)
      return Made(png: data, source: .cache)
    }
    let request = QLThumbnailGenerator.Request(fileAt: file.url, size: CGSize(width: px, height: px), scale: 1, representationTypes: .thumbnail)
    let thumbnail = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request)
    let made = thumbnail.flatMap { NSBitmapImageRep(cgImage: $0.cgImage).representation(using: .png, properties: [:]) }
    let result = made.map { Made(png: $0, source: .made) } ?? Made(png: png(NSWorkspace.shared.icon(for: type), px: px), source: .icon)
    if let cached, let png = result.png { try? png.write(to: cached, options: .atomic) }
    return result
  }

  /// An icon drawn at `px` by `px` pixels.
  private nonisolated static func png(_ image: NSImage, px: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: rep)
    else { return nil }
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    image.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
  }

  private nonisolated static func hash(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
  }
}
