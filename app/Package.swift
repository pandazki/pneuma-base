// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "PneumaBase",
  platforms: [.macOS("26.0")],
  targets: [
    .executableTarget(name: "PneumaBase", path: "Sources/PneumaBase"),
  ]
)
