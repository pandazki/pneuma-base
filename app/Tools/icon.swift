// Draws the spike's app icon and writes it as an .icns file: swift Tools/icon.swift <out.icns>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let set = FileManager.default.temporaryDirectory.appendingPathComponent("PneumaBase-\(getpid()).iconset")
try? FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)

func png(_ pixels: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(pixels) / 1024
  let tile = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
  let shape = NSBezierPath(roundedRect: tile, xRadius: 185 * s, yRadius: 185 * s)
  NSGradient(starting: NSColor(srgbRed: 0.33, green: 0.55, blue: 0.98, alpha: 1), ending: NSColor(srgbRed: 0.17, green: 0.33, blue: 0.86, alpha: 1))!.draw(in: shape, angle: -90)
  let config = NSImage.SymbolConfiguration(pointSize: 430 * s, weight: .medium).applying(.init(paletteColors: [.white]))
  if let symbol = NSImage(systemSymbolName: "archivebox.fill", accessibilityDescription: nil)?.withSymbolConfiguration(config) {
    let size = symbol.size
    symbol.draw(in: NSRect(x: tile.midX - size.width / 2, y: tile.midY - size.height / 2, width: size.width, height: size.height))
  }
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for points in [16, 32, 128, 256, 512] {
  try png(points).write(to: set.appendingPathComponent("icon_\(points)x\(points).png"))
  try png(points * 2).write(to: set.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", set.path, "-o", out.path]
try iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: set)
exit(iconutil.terminationStatus)
