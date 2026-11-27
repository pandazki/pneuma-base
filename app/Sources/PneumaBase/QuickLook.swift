import AppKit
import Quartz

/// The system's Quick Look panel on files of the library, as a set. The window's web view, its first
/// responder, makes this the panel's controller while it has files to show. While the panel has the
/// keyboard, Space closes it; with one file, an arrow key goes to the page, which moves its selection
/// and asks again, so the panel follows; with several, the panel moves between them itself.
@MainActor
final class QuickLook: NSObject {
  private var items: [URL] = []
  private var index = 0
  private var previewing = false
  var onPreviewing: ((Bool) -> Void)?
  /// An arrow key the panel left to the page: its name as the page's `KeyboardEvent.key`, and Shift.
  var onKey: ((String, Bool) -> Void)?

  /// Whether the controller has files to show: only then does it take the panel.
  var wanted: Bool { !items.isEmpty }

  func show(_ files: [URL], at index: Int) {
    guard !files.isEmpty, let panel = QLPreviewPanel.shared() else { return close() }
    items = files
    self.index = index
    if panel.isVisible {
      panel.reloadData()
      panel.currentPreviewItemIndex = index
    } else {
      panel.makeKeyAndOrderFront(nil)
    }
    set(previewing: panel.isVisible)
  }

  func close() {
    items = []
    if QLPreviewPanel.sharedPreviewPanelExists(), let panel = QLPreviewPanel.shared(), panel.isVisible { panel.orderOut(nil) }
    set(previewing: false)
  }

  /// From the web view's `beginPreviewPanelControl`.
  func begin(_ panel: QLPreviewPanel) {
    panel.dataSource = self
    panel.delegate = self
    panel.reloadData()
    panel.currentPreviewItemIndex = index
  }

  /// From the web view's `endPreviewPanelControl`: the panel closed, by any way.
  func end(_ panel: QLPreviewPanel) {
    panel.dataSource = nil
    panel.delegate = nil
    items = []
    set(previewing: false)
  }

  private func set(previewing on: Bool) {
    guard on != previewing else { return }
    previewing = on
    Log.line("preview: \(on ? "shown" : "closed")")
    onPreviewing?(on)
  }

  private static let arrows: [UInt16: String] = [123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp"]
}

extension QuickLook: @preconcurrency QLPreviewPanelDataSource, @preconcurrency QLPreviewPanelDelegate {
  func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { items.count }

  func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
    items.indices.contains(index) ? items[index] as NSURL : nil
  }

  /// A key the panel does not handle itself.
  func previewPanel(_ panel: QLPreviewPanel!, handle event: NSEvent!) -> Bool {
    guard let event, event.type == .keyDown else { return false }
    if event.charactersIgnoringModifiers == " " {
      close()
      return true
    }
    guard items.count == 1, let key = Self.arrows[event.keyCode] else { return false }
    Log.line("preview: key \(key)")
    onKey?(key, event.modifierFlags.contains(.shift))
    return true
  }
}
