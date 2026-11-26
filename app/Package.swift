// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "PneumaBase",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "PneumaBase", path: "Sources/PneumaBase"),
  ]
)
